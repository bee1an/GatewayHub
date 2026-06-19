import { createCipheriv, createDecipheriv, createHash, randomUUID } from 'crypto'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { GatewayRequestContext, QoderAccountConfig, QoderProviderSettings } from '../../types'
import { estimateTokens, toErrorMessage } from '../../core/utils'
import {
  QODER_CLI_BUSINESS_STAGE,
  QODER_CLI_COMPAT_VERSION,
  QODER_CLI_SESSION_TYPE,
  QODER_CLI_USER_AGENT,
  QODER_DIRECT_MODEL_IDS,
  QODER_KNOWN_MODEL_IDS,
  QODER_LEGACY_MODEL_CONFIGS,
  isQoderLegacyModel,
  normalizeQoderMaxOutputTokens,
  type QoderLegacyModelId
} from './constants'
import { getQoderAuthWasm } from './wasm'

export type QoderChatStreamEvent = {
  raw?: any
  done?: boolean
  text?: string
  finishReason?: string
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    [key: string]: unknown
  }
}

export type QoderCollectedCompletion = {
  completion: any
  text: string
  usage?: QoderChatStreamEvent['usage']
}

export type QoderAccountProfile = {
  email?: string
  name?: string
  subscription?: { title: string; type: string }
  usage?: {
    used: number
    limit: number
    remaining: number
    percentage?: number
    totalUsagePercentage?: number
    percentUsed: number
    isQuotaExceeded: boolean
    usageType?: string
    unit?: string
    resetDate: string
    expiresAt?: string
    upgradeUrl?: string
    isPlanQuotaProrated?: boolean
    overages: number
    overageCap: number
    overageRate: number
    overageCharges: number
  }
  keyInfo: Record<string, any>
}

export class QoderHttpError extends Error {
  readonly status?: number
  readonly code?: string
  readonly body?: string

  constructor(message: string, options?: { status?: number; code?: string; body?: string }) {
    super(message)
    this.name = 'QoderHttpError'
    this.status = options?.status
    this.code = options?.code
    this.body = options?.body
  }
}

const DEFAULT_QODER_MODEL_SERVER_BASE_URL = 'https://api2-v2.qoder.sh'
const DEFAULT_QODER_LEGACY_API_BASE_URL = 'https://api3.qoder.sh'
const DEFAULT_QODER_OPENAPI_BASE_URL = 'https://openapi.qoder.sh'
const MODEL_CHAT_PATH = '/model/v1/chat/completions'
const PERSONAL_TOKEN_EXCHANGE_PATH = '/api/v1/jobToken/exchange'
const DEVICE_TOKEN_REFRESH_PATH = '/api/v1/deviceToken/refresh'
const QUOTA_USAGE_PATH = '/api/v2/quota/usage'
const USER_PLAN_PATH = '/api/v2/user/plan'
const USER_STATUS_PATH = '/api/v3/user/status'
const TOKEN_REFRESH_SKEW_MS = 5 * 60_000

const proxyAgents = new Map<string, ProxyAgent>()
const exchangedPersonalTokens = new Map<string, CachedQoderToken>()

interface CachedQoderToken {
  accessToken: string
  refreshToken?: string
  expiresAtMs?: number
}

interface QoderStoredCredential {
  uid?: string
  name?: string
  email?: string
  security_oauth_token?: string
  access_token?: string
  refresh_token?: string
  expire_time?: number
  refresh_token_expire_time?: number
  login_method?: string
  [key: string]: unknown
}

export function qoderCompletionId(prefix = 'chatcmpl'): string {
  return `${prefix}-${randomUUID().replace(/-/g, '')}`
}

export async function fetchQoderAccountProfile(
  account: QoderAccountConfig,
  settings: QoderProviderSettings
): Promise<QoderAccountProfile> {
  const token = await resolveQoderAccessToken(account, settings)
  const [quotaResult, planResult, statusResult] = await Promise.allSettled([
    fetchQoderOpenApiJson(QUOTA_USAGE_PATH, token, settings),
    fetchQoderOpenApiJson(USER_PLAN_PATH, token, settings),
    fetchQoderOpenApiJson(USER_STATUS_PATH, token, settings)
  ])
  const quota = fulfilledObject(quotaResult)
  const plan = fulfilledObject(planResult)
  const userStatus = fulfilledObject(statusResult)
  const resetAtMs =
    parseQoderExpiresAt(quota?.expiresAt ?? quota?.expires_at) ??
    parseQoderExpiresAt(userStatus?.nextResetAt ?? userStatus?.next_reset_at) ??
    parseQoderExpiresAt(plan?.end_date ?? plan?.endDate)
  const quotaInfo =
    quota?.userQuota && typeof quota.userQuota === 'object' && !Array.isArray(quota.userQuota)
      ? quota.userQuota
      : undefined
  const used = numeric(quotaInfo?.used ?? quota?.used)
  const limit = numeric(quotaInfo?.total ?? quota?.total ?? quota?.limit)
  const remaining = numeric(quotaInfo?.remaining ?? quota?.remaining)
  const quotaPercentage = numeric(quotaInfo?.percentage ?? quota?.percentage)
  const totalUsagePercentage = numeric(
    quota?.totalUsagePercentage ?? quota?.total_usage_percentage ?? quota?.total_percentage
  )
  const percentUsed = normalizeQoderQuotaPercent(
    totalUsagePercentage ??
      quotaPercentage ??
      (used !== undefined && limit ? used / limit : undefined)
  )
  const usageType = pickCredentialString(quota ?? {}, ['usageType', 'usage_type'])
  const unit =
    pickCredentialString(quotaInfo ?? {}, ['unit']) ||
    usageType ||
    pickCredentialString(quota ?? {}, ['unit'])
  const usage =
    used !== undefined && limit !== undefined && limit > 0
      ? {
          used,
          limit,
          remaining: remaining ?? Math.max(0, limit - used),
          percentage: quotaPercentage,
          totalUsagePercentage,
          percentUsed,
          isQuotaExceeded:
            booleanValue(quota?.isQuotaExceeded ?? quota?.is_quota_exceeded) ??
            booleanValue(userStatus?.isQuotaExceeded ?? userStatus?.is_quota_exceeded) ??
            used >= limit,
          usageType,
          unit,
          resetDate: new Date(resetAtMs ?? Date.now()).toISOString(),
          expiresAt: resetAtMs ? new Date(resetAtMs).toISOString() : undefined,
          upgradeUrl: pickCredentialString(quota ?? {}, ['upgradeUrl', 'upgrade_url']),
          isPlanQuotaProrated: booleanValue(
            quota?.isPlanQuotaProrated ?? quota?.is_plan_quota_prorated
          ),
          overages: numeric(quotaInfo?.overages ?? quota?.overages) ?? 0,
          overageCap: numeric(quotaInfo?.overageCap ?? quota?.overage_cap) ?? 0,
          overageRate: numeric(quotaInfo?.overageRate ?? quota?.overage_rate) ?? 0,
          overageCharges: numeric(quotaInfo?.overageCharges ?? quota?.overage_charges) ?? 0
        }
      : undefined
  const title =
    pickCredentialString(plan ?? {}, ['plan_tier_name', 'planTierName']) ||
    pickCredentialString(userStatus ?? {}, ['userTag', 'plan']) ||
    'Qoder'
  const type =
    pickCredentialString(plan ?? {}, ['user_type', 'userType']) ||
    pickCredentialString(userStatus ?? {}, ['userType', 'plan']) ||
    'qoder'

  return {
    email:
      pickCredentialString(userStatus ?? {}, ['email']) ||
      pickCredentialString(plan ?? {}, ['email']) ||
      account.email,
    name: pickCredentialString(userStatus ?? {}, ['name']),
    subscription: { title, type },
    usage,
    keyInfo: {
      quota,
      plan,
      userStatus,
      fetchedAt: new Date().toISOString()
    }
  }
}

export async function* streamQoderChatCompletion(options: {
  account: QoderAccountConfig
  settings: QoderProviderSettings
  body: any
  model: string
  context: GatewayRequestContext
}): AsyncGenerator<QoderChatStreamEvent> {
  if (isQoderLegacyModel(options.model)) {
    yield* streamQoderLegacyChatCompletion({
      ...options,
      model: options.model
    })
    return
  }

  const token = await resolveQoderAccessToken(options.account, options.settings)
  const payload = buildQoderChatPayload(
    options.body,
    options.model,
    options.settings,
    options.context
  )
  const requestId = options.context.requestId || qoderCompletionId('req')
  const sessionId = `ghub-${requestId}`
  const url = `${resolveQoderApiBaseUrl(options.settings)}${MODEL_CHAT_PATH}`
  const requestTimeoutMs =
    Math.max(30, Number(options.settings.firstTokenTimeoutSeconds) || 120) * 1000
  const abort = withTimeoutSignal(options.context.abortSignal, requestTimeoutMs)

  let response: Response
  try {
    response = await qoderFetch(
      url,
      {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Request-ID': requestId,
          'X-Session-ID': sessionId,
          'User-Agent': QODER_CLI_USER_AGENT
        },
        body: JSON.stringify(payload),
        signal: abort.signal
      },
      options.settings.vpnProxyUrl
    )
  } catch (error) {
    abort.cleanup()
    throw normalizeFetchError(error)
  }
  abort.cleanup()

  if (!response.ok) {
    const body = await safeText(response)
    throw new QoderHttpError(`Qoder HTTP ${response.status}: ${body || response.statusText}`, {
      status: response.status,
      body
    })
  }
  if (!response.body) {
    throw new QoderHttpError(`Qoder HTTP ${response.status}: empty response body`, {
      status: response.status
    })
  }

  let completed = false
  try {
    for await (const event of parseQoderSse(
      response.body,
      options.settings.firstTokenTimeoutSeconds,
      options.settings.streamingReadTimeoutSeconds,
      options.context.abortSignal
    )) {
      if (event.done) completed = true
      yield event
    }
  } finally {
    if (!completed) {
      try {
        await response.body.cancel()
      } catch {
        /* ignore */
      }
    }
  }
}

async function* streamQoderLegacyChatCompletion(options: {
  account: QoderAccountConfig
  settings: QoderProviderSettings
  body: any
  model: QoderLegacyModelId
  context: GatewayRequestContext
}): AsyncGenerator<QoderChatStreamEvent> {
  const qoderCliHome = options.account.qoderCliHome?.trim()
  if (!qoderCliHome) {
    throw new QoderHttpError(
      `Qoder model ${options.model} requires an imported qodercli auth bundle; PAT/direct-tier credentials cannot access legacy IDE models.`,
      { status: 401, code: 'missing_qoder_cli_auth' }
    )
  }

  await resolveQoderCliAccessToken(qoderCliHome, options.settings)
  const loaded = await readQoderCliCredential(qoderCliHome)
  const wasm = await getQoderAuthWasm(options.account.qoderCliPath || options.settings.qoderCliPath)
  const runtimeAuth = wasm.generateRuntimeAuthFields(
    JSON.stringify({
      uid: pickCredentialString(loaded.credential, ['uid', 'user_id', 'userId', 'id']) || '',
      organization_id: loaded.credential.organization_id ?? '',
      organization_tags: loaded.credential.organization_tags ?? [],
      data_policy_agreed: loaded.credential.data_policy_agreed ?? true
    })
  )
  const userInfoJson = JSON.stringify({
    uid:
      pickCredentialString(loaded.credential, ['uid', 'user_id', 'userId', 'id']) ||
      options.account.email ||
      options.account.id,
    encrypt_user_info: runtimeAuth.encrypt_user_info || loaded.credential.encrypt_user_info || '',
    key: runtimeAuth.key || loaded.credential.key || '',
    organization_id: loaded.credential.organization_id ?? '',
    organization_tags: loaded.credential.organization_tags ?? [],
    data_policy_agreed: loaded.credential.data_policy_agreed ?? true
  })
  const requestId = options.context.requestId || qoderCompletionId('req')
  const payload = buildQoderLegacyRemoteChatAsk(
    options.body,
    options.model,
    options.settings,
    options.context
  )
  const requestTimeoutMs =
    Math.max(30, Number(options.settings.firstTokenTimeoutSeconds) || 120) * 1000
  const abort = withTimeoutSignal(options.context.abortSignal, requestTimeoutMs)

  let prepared: { url: string; headers: Record<string, string>; body?: string }
  const wasmContext = wasm.createContext({
    machineId: loaded.machineId,
    userInfoJson
  })
  try {
    prepared = wasmContext.prepareInferRequest(
      resolveQoderLegacyApiBaseUrl(),
      JSON.stringify(payload),
      options.model,
      'system'
    )
  } finally {
    wasmContext.free()
  }

  const legacyHeaders: Record<string, string> = {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    'X-Request-ID': requestId,
    ...prepared.headers
  }
  if (!hasHeader(legacyHeaders, 'User-Agent')) legacyHeaders['User-Agent'] = QODER_CLI_USER_AGENT

  let response: Response
  try {
    response = await qoderFetch(
      prepared.url,
      {
        method: 'POST',
        headers: legacyHeaders,
        body: prepared.body ?? JSON.stringify(payload),
        signal: abort.signal
      },
      options.settings.vpnProxyUrl
    )
  } catch (error) {
    abort.cleanup()
    throw normalizeFetchError(error)
  }
  abort.cleanup()

  if (!response.ok) {
    const body = await safeText(response)
    throw new QoderHttpError(
      `Qoder legacy HTTP ${response.status}: ${body || response.statusText}`,
      {
        status: response.status,
        body
      }
    )
  }
  if (!response.body) {
    throw new QoderHttpError(`Qoder legacy HTTP ${response.status}: empty response body`, {
      status: response.status
    })
  }

  let completed = false
  try {
    for await (const event of parseQoderSse(
      response.body,
      options.settings.firstTokenTimeoutSeconds,
      options.settings.streamingReadTimeoutSeconds,
      options.context.abortSignal
    )) {
      if (event.done) completed = true
      yield event
    }
  } finally {
    if (!completed) {
      try {
        await response.body.cancel()
      } catch {
        /* ignore */
      }
    }
  }
}

export async function collectQoderChatCompletion(options: {
  account: QoderAccountConfig
  settings: QoderProviderSettings
  body: any
  model: string
  context: GatewayRequestContext
}): Promise<QoderCollectedCompletion> {
  const id = qoderCompletionId()
  const created = Math.floor(Date.now() / 1000)
  let text = ''
  let finishReason = 'stop'
  let usage: QoderChatStreamEvent['usage']
  const toolCalls = new Map<number, any>()

  for await (const event of streamQoderChatCompletion(options)) {
    if (event.usage) usage = event.usage
    if (event.finishReason) finishReason = normalizeFinishReason(event.finishReason)
    if (event.text) text += event.text
    const choice = event.raw?.choices?.[0]
    const delta = choice?.delta ?? choice?.message ?? {}
    if (Array.isArray(delta?.tool_calls)) {
      for (const item of delta.tool_calls) {
        const index = Number.isInteger(item?.index) ? item.index : toolCalls.size
        const current = toolCalls.get(index) ?? {
          id: item?.id || `call_${qoderCompletionId('tc').replace('tc-', '')}`,
          type: item?.type || 'function',
          function: { name: '', arguments: '' }
        }
        if (item?.id) current.id = item.id
        if (item?.type) current.type = item.type
        if (item?.function?.name) current.function.name += item.function.name
        if (item?.function?.arguments) current.function.arguments += item.function.arguments
        toolCalls.set(index, current)
      }
    }
  }

  const promptTokens =
    numeric(usage?.prompt_tokens) ?? estimateTokens(options.body?.messages ?? options.body)
  const completionTokens = numeric(usage?.completion_tokens) ?? estimateTokens(text)
  const normalizedUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: numeric(usage?.total_tokens) ?? promptTokens + completionTokens,
    ...(usage ?? {})
  }
  const calls = [...toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({
      ...call,
      function: {
        name: call.function.name || 'tool',
        arguments: call.function.arguments || '{}'
      }
    }))

  return {
    text,
    usage: normalizedUsage,
    completion: {
      id,
      object: 'chat.completion',
      created,
      model: options.model,
      choices: [
        {
          index: 0,
          message: calls.length
            ? { role: 'assistant', content: text || null, tool_calls: calls }
            : { role: 'assistant', content: text },
          finish_reason: calls.length ? 'tool_calls' : finishReason
        }
      ],
      usage: normalizedUsage
    }
  }
}

export async function listQoderDirectModels(
  account: QoderAccountConfig,
  settings: QoderProviderSettings
): Promise<string[]> {
  if (!qoderAccountUsesDirectApi(account)) {
    throw missingQoderCredentialError()
  }
  void settings
  // Qoder's direct OpenAI-compatible model endpoint currently accepts tier model keys
  // (auto/lite/efficient/performance/ultimate) but does not expose a stable /models route.
  // Legacy IDE model keys require the imported qodercli auth bundle for request signing, so
  // PAT-only accounts must not advertise models that routing would later reject.
  return account.qoderCliHome?.trim() ? [...QODER_KNOWN_MODEL_IDS] : [...QODER_DIRECT_MODEL_IDS]
}

export function qoderAccountUsesDirectApi(account: QoderAccountConfig): boolean {
  return Boolean(account.personalAccessToken?.trim() || account.qoderCliHome?.trim())
}

async function resolveQoderAccessToken(
  account: QoderAccountConfig,
  settings: QoderProviderSettings
): Promise<string> {
  const personalAccessToken = account.personalAccessToken?.trim()
  if (personalAccessToken) return resolvePersonalAccessToken(personalAccessToken, settings)
  const qoderCliHome = account.qoderCliHome?.trim()
  if (qoderCliHome) return resolveQoderCliAccessToken(qoderCliHome, settings)
  throw missingQoderCredentialError()
}

function missingQoderCredentialError(): QoderHttpError {
  return new QoderHttpError(
    'Qoder direct API requires a Personal Access Token or an imported qodercli auth bundle with a local access token.',
    { status: 401, code: 'missing_token' }
  )
}

async function resolvePersonalAccessToken(
  personalAccessToken: string,
  settings: QoderProviderSettings
): Promise<string> {
  if (looksLikeQoderAccessToken(personalAccessToken)) return personalAccessToken
  const cacheKey = createHash('sha256').update(personalAccessToken).digest('hex')
  const cached = exchangedPersonalTokens.get(cacheKey)
  if (cached && !isTokenExpiring(cached.expiresAtMs)) return cached.accessToken
  const exchanged = await exchangePersonalToken(personalAccessToken, settings)
  exchangedPersonalTokens.set(cacheKey, exchanged)
  return exchanged.accessToken
}

function looksLikeQoderAccessToken(token: string): boolean {
  return /^(dt|jt)-[A-Za-z0-9_-]+$/.test(token)
}

async function resolveQoderCliAccessToken(
  qoderCliHome: string,
  settings: QoderProviderSettings
): Promise<string> {
  const loaded = await readQoderCliCredential(qoderCliHome)
  const accessToken = credentialAccessToken(loaded.credential)
  if (!accessToken) {
    throw new QoderHttpError('Imported Qoder auth bundle does not contain an access token', {
      status: 401,
      code: 'missing_token'
    })
  }

  const expiresAtMs = credentialExpiresAtMs(loaded.credential)
  if (!isTokenExpiring(expiresAtMs)) return accessToken
  if (!loaded.credential.refresh_token) {
    if (!isTokenExpired(expiresAtMs)) return accessToken
    throw new QoderHttpError('Imported Qoder access token is expired and has no refresh token', {
      status: 401,
      code: 'token_expired'
    })
  }

  try {
    const refreshed = await refreshDeviceToken(loaded.credential.refresh_token, settings)
    const next: QoderStoredCredential = {
      ...loaded.credential,
      security_oauth_token: refreshed.accessToken,
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken || loaded.credential.refresh_token,
      expire_time:
        refreshed.expiresAtMs !== undefined
          ? Math.floor(refreshed.expiresAtMs / 1000)
          : loaded.credential.expire_time
    }
    await writeFile(loaded.userPath, encryptQoderCredential(next, loaded.key), { mode: 0o600 })
    return refreshed.accessToken
  } catch (error) {
    if (!isTokenExpired(expiresAtMs)) return accessToken
    throw error
  }
}

function credentialAccessToken(credential: QoderStoredCredential): string | undefined {
  return pickCredentialString(credential, ['access_token', 'security_oauth_token'])
}

function credentialExpiresAtMs(credential: QoderStoredCredential): number | undefined {
  return parseQoderExpiresAt(credential.expire_time)
}

async function readQoderCliCredential(qoderCliHome: string): Promise<{
  credential: QoderStoredCredential
  userPath: string
  key: Buffer
  machineId: string
}> {
  const authDir = join(qoderCliHome, '.qoder', '.auth')
  const userPath = join(authDir, 'user')
  const machinePath = join(authDir, 'machine_id')
  const [blob, machineId] = await Promise.all([
    readFile(userPath, 'utf8'),
    readFile(machinePath, 'utf8')
  ])
  const machineIdText = machineId.trim()
  const keyText = machineIdText.slice(0, 16)
  const key = Buffer.from(keyText)
  if (key.length !== 16) {
    throw new QoderHttpError('Invalid Qoder machine_id in imported auth bundle', {
      status: 401,
      code: 'invalid_auth_bundle'
    })
  }
  const decipher = createDecipheriv('aes-128-cbc', key, key)
  const json = Buffer.concat([
    decipher.update(Buffer.from(blob.trim(), 'base64')),
    decipher.final()
  ]).toString('utf8')
  return {
    credential: JSON.parse(json) as QoderStoredCredential,
    userPath,
    key,
    machineId: machineIdText
  }
}

function encryptQoderCredential(credential: QoderStoredCredential, key: Buffer): string {
  const cipher = createCipheriv('aes-128-cbc', key, key)
  return Buffer.concat([
    cipher.update(JSON.stringify(credential), 'utf8'),
    cipher.final()
  ]).toString('base64')
}

async function exchangePersonalToken(
  personalAccessToken: string,
  settings: QoderProviderSettings
): Promise<CachedQoderToken> {
  const response = await qoderFetch(
    `${resolveQoderOpenApiBaseUrl()}${PERSONAL_TOKEN_EXCHANGE_PATH}`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': QODER_CLI_USER_AGENT
      },
      body: JSON.stringify({ personal_token: personalAccessToken })
    },
    settings.vpnProxyUrl
  )
  const data = await readQoderJsonResponse(response, 'Qoder PAT exchange')
  const accessToken = pickCredentialString(data, ['token', 'device_token', 'access_token'])
  if (!accessToken) {
    throw new QoderHttpError('Qoder PAT exchange response did not contain an access token', {
      status: response.status,
      body: JSON.stringify(redactTokenFields(data)).slice(0, 1000)
    })
  }
  return {
    accessToken,
    refreshToken: pickCredentialString(data, ['refresh_token', 'refreshToken']),
    expiresAtMs:
      parseQoderExpiresAt(
        data.expires_at ?? data.expiresAt ?? data.expire_time ?? data.expireTime
      ) ?? parseQoderExpiresIn(data.expires_in ?? data.expiresIn)
  }
}

async function refreshDeviceToken(
  refreshToken: string,
  settings: QoderProviderSettings
): Promise<CachedQoderToken> {
  const response = await qoderFetch(
    `${resolveQoderOpenApiBaseUrl()}${DEVICE_TOKEN_REFRESH_PATH}`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': QODER_CLI_USER_AGENT
      },
      body: JSON.stringify({ refresh_token: refreshToken })
    },
    settings.vpnProxyUrl
  )
  const data = await readQoderJsonResponse(response, 'Qoder device token refresh')
  const accessToken = pickCredentialString(data, ['device_token', 'token', 'access_token'])
  if (!accessToken) {
    throw new QoderHttpError('Qoder token refresh response did not contain an access token', {
      status: response.status,
      body: JSON.stringify(redactTokenFields(data)).slice(0, 1000)
    })
  }
  return {
    accessToken,
    refreshToken: pickCredentialString(data, ['refresh_token', 'refreshToken']),
    expiresAtMs:
      parseQoderExpiresAt(data.expires_at ?? data.expiresAt ?? data.expire_time) ??
      parseQoderExpiresIn(data.expires_in ?? data.expiresIn)
  }
}

async function readQoderJsonResponse(
  response: Response,
  label: string
): Promise<Record<string, any>> {
  const text = await safeText(response)
  if (!response.ok) {
    throw new QoderHttpError(`${label} HTTP ${response.status}: ${text || response.statusText}`, {
      status: response.status,
      body: text
    })
  }
  try {
    const data = JSON.parse(text || '{}')
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch {
    throw new QoderHttpError(`${label} response is not JSON`, { body: text.slice(0, 500) })
  }
}

async function fetchQoderOpenApiJson(
  path: string,
  token: string,
  settings: QoderProviderSettings
): Promise<Record<string, any>> {
  const timeout = withTimeoutSignal(undefined, 15_000)
  try {
    const response = await qoderFetch(
      `${resolveQoderOpenApiBaseUrl()}${path}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': QODER_CLI_USER_AGENT
        },
        signal: timeout.signal
      },
      settings.vpnProxyUrl
    )
    return readQoderJsonResponse(response, `Qoder ${path}`)
  } finally {
    timeout.cleanup()
  }
}

function fulfilledObject(
  result: PromiseSettledResult<Record<string, any>>
): Record<string, any> | undefined {
  return result.status === 'fulfilled' ? result.value : undefined
}

function normalizeQoderQuotaPercent(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0
  const percent = Math.abs(value!) <= 1 ? value! * 100 : value!
  return Math.round(Math.max(0, Math.min(100, percent)) * 100) / 100
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'y'].includes(normalized)) return true
    if (['false', '0', 'no', 'n'].includes(normalized)) return false
  }
  return undefined
}

function pickCredentialString(input: Record<string, any>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function parseQoderExpiresAt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1000)
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return parseQoderExpiresAt(numeric)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function parseQoderExpiresIn(value: unknown): number | undefined {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Date.now() + Math.floor(n * 1000)
}

function isTokenExpiring(expiresAtMs: number | undefined): boolean {
  return expiresAtMs !== undefined && expiresAtMs - TOKEN_REFRESH_SKEW_MS <= Date.now()
}

function isTokenExpired(expiresAtMs: number | undefined): boolean {
  return expiresAtMs !== undefined && expiresAtMs <= Date.now()
}

function redactTokenFields(value: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = /token|secret|key/i.test(key) && item ? '[redacted]' : item
  }
  return out
}

function buildQoderChatPayload(
  body: any,
  model: string,
  settings: QoderProviderSettings,
  context: GatewayRequestContext
): any {
  const requestId = context.requestId || qoderCompletionId('req')
  const payload: any = {
    model,
    messages: normalizeOpenAIMessages(body?.messages),
    stream: true,
    stream_options: { include_usage: true },
    metadata: {
      context: {
        request_id: requestId,
        request_set_id: requestId,
        session_id: `ghub-${requestId}`,
        task_id: requestId,
        client_type: 'gatewayhub'
      }
    }
  }

  const maxTokens = numeric(body?.max_tokens) ?? defaultMaxTokens(settings.maxOutputTokens)
  if (maxTokens !== undefined) payload.max_tokens = maxTokens
  copyNumber(body, payload, 'temperature')
  copyNumber(body, payload, 'top_p')
  copyNumber(body, payload, 'presence_penalty')
  copyNumber(body, payload, 'frequency_penalty')
  copyNumber(body, payload, 'seed')
  copyIfPresent(body, payload, 'stop')
  copyIfPresent(body, payload, 'response_format')
  copyIfPresent(body, payload, 'tool_choice')
  copyIfPresent(body, payload, 'parallel_tool_calls')
  copyIfPresent(body, payload, 'context_length')
  copyIfPresent(body, payload, 'user')
  copyIfPresent(body, payload, 'reasoning_effort')
  if (Array.isArray(body?.tools)) payload.tools = normalizeOpenAITools(body.tools)

  return payload
}

function buildQoderLegacyRemoteChatAsk(
  body: any,
  model: QoderLegacyModelId,
  settings: QoderProviderSettings,
  context: GatewayRequestContext
): any {
  const requestId = context.requestId || qoderCompletionId('req')
  const sessionId = context.sessionId || requestId
  const modelMeta = QODER_LEGACY_MODEL_CONFIGS[model]
  const normalized = normalizeLegacyMessages(body?.messages)
  const maxTokens = numeric(body?.max_tokens) ?? defaultMaxTokens(settings.maxOutputTokens)
  const parameters: Record<string, any> = {
    max_tokens: maxTokens,
    context_length: numeric(body?.context_length) ?? 200_000
  }
  copyNumber(body, parameters, 'temperature')
  copyNumber(body, parameters, 'top_p')
  copyNumber(body, parameters, 'presence_penalty')
  copyNumber(body, parameters, 'frequency_penalty')
  copyNumber(body, parameters, 'seed')
  copyIfPresent(body, parameters, 'stop')
  copyIfPresent(body, parameters, 'response_format')
  copyIfPresent(body, parameters, 'tool_choice')
  copyIfPresent(body, parameters, 'parallel_tool_calls')
  copyIfPresent(body, parameters, 'user')
  copyIfPresent(body, parameters, 'reasoning_effort')

  return {
    request_id: requestId,
    request_set_id: requestId,
    chat_record_id: requestId,
    session_id: sessionId,
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      text: normalized.lastUserText,
      extra: {
        modelConfig: {
          key: model,
          is_reasoning: modelMeta.is_reasoning
        }
      }
    },
    is_reply: false,
    is_retry: false,
    source: 1,
    version: '3',
    agent_id: 'agent_common',
    task_id: requestId,
    session_type: QODER_CLI_SESSION_TYPE,
    aliyun_user_type: '',
    model_config: {
      key: model,
      display_name: modelMeta.display_name,
      model: '',
      format: 'openai',
      is_vl: modelMeta.is_vl,
      is_reasoning: modelMeta.is_reasoning,
      api_key: '',
      url: '',
      source: 'system',
      max_input_tokens: modelMeta.max_input_tokens
    },
    system: normalized.systemText,
    messages: normalized.messages,
    tools: Array.isArray(body?.tools) ? normalizeOpenAITools(body.tools) : [],
    parameters,
    business: {
      product: 'cli',
      version: QODER_CLI_COMPAT_VERSION,
      type: 'agent',
      id: requestId,
      name: qoderCliBusinessName(normalized.lastUserText),
      begin_at: Date.now(),
      stage: QODER_CLI_BUSINESS_STAGE
    }
  }
}

function hasHeader(headers: Record<string, string>, key: string): boolean {
  const normalized = key.toLowerCase()
  return Object.keys(headers).some((name) => name.toLowerCase() === normalized)
}

function qoderCliBusinessName(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return 'Qoder CLI'
  try {
    const segments = [...new Intl.Segmenter().segment(trimmed)]
    return segments.length > 10
      ? segments
          .slice(0, 10)
          .map((item) => item.segment)
          .join('')
      : trimmed
  } catch {
    return trimmed.slice(0, 80) || 'Qoder CLI'
  }
}

function normalizeOpenAIMessages(messages: any): any[] {
  const source = Array.isArray(messages) ? messages : []
  const normalized = source
    .map((message) => {
      if (!message || typeof message !== 'object') return undefined
      if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) return undefined
      const item: any = { role: message.role }
      const content = normalizeOpenAIContent(message.content ?? message.contents)
      if (content !== undefined) item.content = content
      if (typeof message.name === 'string') item.name = message.name
      if (Array.isArray(message.tool_calls)) item.tool_calls = message.tool_calls
      if (typeof message.tool_call_id === 'string') item.tool_call_id = message.tool_call_id
      if (typeof message.reasoning_content === 'string')
        item.reasoning_content = message.reasoning_content
      if (message.reasoning_item !== undefined) item.reasoning_item = message.reasoning_item
      return item
    })
    .filter((message): message is any => Boolean(message))
  return normalized.length ? normalized : [{ role: 'user', content: 'Hello' }]
}

function normalizeLegacyMessages(messages: any): {
  systemText: string
  messages: any[]
  lastUserText: string
} {
  const source = Array.isArray(messages) ? messages : []
  const systemParts: string[] = []
  const converted: any[] = []
  let lastUserText = ''

  for (const message of source) {
    if (!message || typeof message !== 'object') continue
    if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) continue
    const text = contentToPlainText(message.content ?? message.contents)
    if (message.role === 'system') {
      if (text) systemParts.push(text)
      continue
    }
    if (message.role === 'user' && text) lastUserText = text

    const item: any = { role: message.role }
    const content = normalizeOpenAIContent(message.content ?? message.contents)
    if (content !== undefined) item.content = content
    const contents = legacyContents(message.content ?? message.contents)
    if (contents.length) item.contents = contents
    if (typeof message.name === 'string') item.name = message.name
    if (Array.isArray(message.tool_calls)) item.tool_calls = message.tool_calls
    if (typeof message.tool_call_id === 'string') item.tool_call_id = message.tool_call_id
    if (typeof message.reasoning_content === 'string')
      item.reasoning_content = message.reasoning_content
    if (message.reasoning_item !== undefined) item.reasoning_item = message.reasoning_item
    converted.push(item)
  }

  const systemText =
    systemParts.join('\n\n').trim() || 'You are Qoder CLI, a helpful coding assistant.'
  if (!converted.length) {
    converted.push({
      role: 'user',
      content: 'Hello',
      contents: [{ type: 'text', text: 'Hello' }]
    })
    lastUserText = 'Hello'
  }
  if (!lastUserText) lastUserText = contentToPlainText(converted.at(-1)?.content) || 'Hello'

  return {
    systemText,
    lastUserText,
    messages: [
      {
        role: 'system',
        content: systemText,
        contents: [{ type: 'text', text: systemText }]
      },
      ...converted
    ]
  }
}

function normalizeOpenAIContent(content: any): any {
  if (typeof content === 'string' || content === null) return content
  if (!Array.isArray(content)) return undefined
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return undefined
      if (part.type === 'text') return { type: 'text', text: String(part.text ?? '') }
      if (part.type === 'image_url' && part.image_url?.url) {
        return {
          type: 'image_url',
          image_url: {
            url: String(part.image_url.url),
            ...(part.image_url.detail ? { detail: part.image_url.detail } : {})
          }
        }
      }
      if (part.type === 'input_audio' && part.input_audio?.data) {
        return {
          type: 'input_audio',
          input_audio: {
            data: String(part.input_audio.data),
            format: String(part.input_audio.format || 'wav')
          }
        }
      }
      return undefined
    })
    .filter((part): part is any => Boolean(part))
}

function legacyContents(content: any): any[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return undefined
      if (part.type === 'text') return { type: 'text', text: String(part.text ?? '') }
      if (part.type === 'image_url' && part.image_url?.url) {
        return {
          type: 'image_url',
          image_url: {
            url: String(part.image_url.url),
            ...(part.image_url.detail ? { detail: part.image_url.detail } : {})
          }
        }
      }
      return undefined
    })
    .filter((part): part is any => Boolean(part))
}

function contentToPlainText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      if (part.type === 'text') return String(part.text ?? '')
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function normalizeOpenAITools(tools: any[]): any[] {
  return tools
    .filter((tool) => tool?.type === 'function' && tool.function?.name)
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.function.name,
        ...(tool.function.description ? { description: tool.function.description } : {}),
        ...(tool.function.parameters ? { parameters: tool.function.parameters } : {}),
        ...(tool.function.strict !== undefined ? { strict: tool.function.strict } : {})
      }
    }))
}

async function* parseQoderSse(
  body: ReadableStream<Uint8Array>,
  firstTokenTimeoutSeconds: number,
  idleTimeoutSeconds: number,
  signal?: AbortSignal
): AsyncGenerator<QoderChatStreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let sawFrame = false
  try {
    while (true) {
      const timeoutSeconds = sawFrame ? idleTimeoutSeconds : firstTokenTimeoutSeconds
      const next = await readWithTimeout(
        reader,
        secondsToMs(timeoutSeconds, sawFrame ? 300_000 : 120_000),
        signal
      )
      if (next.done) break
      buffer += decoder.decode(next.value, { stream: true })
      while (true) {
        const separator = findSseSeparator(buffer)
        if (!separator) break
        const frame = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator.length)
        const event = parseSseFrame(frame)
        if (!event) continue
        sawFrame = true
        yield normalizeSseEvent(event)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      const event = parseSseFrame(buffer)
      if (event) yield normalizeSseEvent(event)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* ignore */
    }
  }
}

function normalizeSseEvent(event: { event?: string; data: string }): QoderChatStreamEvent {
  const data = event.data.trim()
  if (!data) return {}
  if (data === '[DONE]') return { done: true }
  let raw: any
  try {
    raw = JSON.parse(data)
  } catch {
    const json = extractFirstJsonValue(data)
    if (json) {
      try {
        raw = JSON.parse(json)
      } catch {
        /* fall through to the normalized error below */
      }
    }
    raw ??= recoverPartialChunk(data)
    if (!raw && event.event !== 'error' && isLikelyPartialQoderChunk(data)) return {}
    if (!raw) {
      throw new QoderHttpError(`Qoder SSE payload is not JSON: ${data.slice(0, 300)}`)
    }
  }
  const legacy = normalizeLegacySseWrapper(raw, event)
  if (legacy) return legacy
  if (event.event === 'error' || raw?.error) {
    const err = raw?.error ?? raw
    throw new QoderHttpError(
      String(err?.message || err?.error || JSON.stringify(err)).slice(0, 1000),
      {
        status: numeric(err?.status ?? err?.statusCode ?? err?.code),
        code: typeof err?.code === 'string' ? err.code : undefined,
        body: JSON.stringify(raw).slice(0, 1000)
      }
    )
  }
  const choice = raw?.choices?.[0]
  const delta = choice?.delta ?? choice?.message ?? {}
  return {
    raw,
    text: typeof delta?.content === 'string' ? delta.content : undefined,
    finishReason:
      typeof choice?.finish_reason === 'string' && choice.finish_reason !== 'null'
        ? choice.finish_reason
        : undefined,
    usage: raw?.usage && typeof raw.usage === 'object' ? raw.usage : undefined
  }
}

function normalizeLegacySseWrapper(
  raw: any,
  event: { event?: string; data: string }
): QoderChatStreamEvent | undefined {
  if (!raw || typeof raw !== 'object' || raw.body === undefined) return undefined
  if (
    raw.statusCodeValue === undefined &&
    raw.statusCode === undefined &&
    raw.status === undefined
  ) {
    return undefined
  }

  const status = numeric(raw.statusCodeValue ?? raw.statusCode ?? raw.status)
  const bodyText =
    typeof raw.body === 'string'
      ? raw.body.trim()
      : raw.body === null || raw.body === undefined
        ? ''
        : JSON.stringify(raw.body)

  if (bodyText === '[EXCEED_QUOTA]') {
    throw new QoderHttpError('Qoder legacy quota exceeded', {
      status: status || 429,
      code: 'quota_exceeded',
      body: bodyText
    })
  }
  if (isLegacyTerminalPayload(bodyText)) {
    return bodyText === '[DONE]' ? { done: true } : {}
  }
  if (status !== undefined && status >= 400) {
    throw new QoderHttpError(`Qoder legacy HTTP ${status}: ${bodyText || event.data}`, {
      status,
      body: bodyText || JSON.stringify(raw).slice(0, 1000)
    })
  }
  if (!bodyText) return {}

  let inner: any
  try {
    inner = JSON.parse(bodyText)
  } catch {
    const json = extractFirstJsonValue(bodyText)
    if (json) {
      try {
        inner = JSON.parse(json)
      } catch {
        /* fall through */
      }
    }
    inner ??= recoverPartialChunk(bodyText)
    if (!inner && isLikelyPartialQoderChunk(bodyText)) return {}
    if (!inner) {
      throw new QoderHttpError(`Qoder legacy SSE body is not JSON: ${bodyText.slice(0, 300)}`)
    }
  }
  if (inner?.error) {
    const err = inner.error
    throw new QoderHttpError(
      String(err?.message || err?.error || JSON.stringify(err)).slice(0, 1000),
      {
        status: numeric(err?.status ?? err?.statusCode ?? err?.code) ?? status,
        code: typeof err?.code === 'string' ? err.code : undefined,
        body: JSON.stringify(inner).slice(0, 1000)
      }
    )
  }
  const choice = inner?.choices?.[0]
  const delta = choice?.delta ?? choice?.message ?? {}
  return {
    raw: inner,
    text: typeof delta?.content === 'string' ? delta.content : undefined,
    finishReason:
      typeof choice?.finish_reason === 'string' && choice.finish_reason !== 'null'
        ? choice.finish_reason
        : undefined,
    usage: inner?.usage && typeof inner.usage === 'object' ? inner.usage : undefined
  }
}

function isLegacyTerminalPayload(value: string): boolean {
  return (
    !value || value === '[DONE]' || value === '[NOT_EXCEED_QUOTA]' || value === '[NOTIFICATIONS]'
  )
}

function recoverPartialChunk(value: string): any | undefined {
  const base = partialChunkBase(value)
  if (!base) return undefined

  const finishReason = matchJsonString(value, 'finish_reason')
  if (finishReason) {
    return {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
    }
  }

  const content = matchJsonString(value, 'content')
  if (content !== undefined) {
    return {
      ...base,
      choices: [{ index: 0, delta: { content }, finish_reason: null }]
    }
  }

  const reasoningContent = matchJsonString(value, 'reasoning_content')
  if (reasoningContent !== undefined) {
    return {
      ...base,
      choices: [{ index: 0, delta: { reasoning_content: reasoningContent }, finish_reason: null }]
    }
  }

  return undefined
}

function partialChunkBase(value: string): any | undefined {
  const trimmed = value.trimStart()
  if (!isLikelyPartialQoderChunk(trimmed)) return undefined
  return {
    id: matchJsonString(trimmed, 'id') || qoderCompletionId(),
    object: matchJsonString(trimmed, 'object') || 'chat.completion.chunk',
    created: numeric(trimmed.match(/"created"\s*:\s*(\d+)/)?.[1]) ?? Math.floor(Date.now() / 1000),
    model: matchJsonString(trimmed, 'model') || 'unknown'
  }
}

function matchJsonString(value: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`"${escaped}"\\s*:\\s*"([^"]+)"`).exec(value)
  return match?.[1]
}

function isLikelyPartialQoderChunk(value: string): boolean {
  const trimmed = value.trimStart()
  return (
    trimmed.startsWith('{') &&
    !/"error"\s*:/.test(trimmed) &&
    (/"id"\s*:\s*"/.test(trimmed) ||
      trimmed.includes('chat.completion') ||
      trimmed.includes('"choices"') ||
      trimmed.includes('"delta"'))
  )
}

function extractFirstJsonValue(value: string): string | undefined {
  const start = value.search(/[[{]/)
  if (start < 0) return undefined
  const stack: string[] = []
  let inString = false
  let escaped = false

  for (let i = start; i < value.length; i++) {
    const ch = value[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      stack.push('}')
      continue
    }
    if (ch === '[') {
      stack.push(']')
      continue
    }
    if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return undefined
      if (!stack.length) return value.slice(start, i + 1)
    }
  }
  return undefined
}

function parseSseFrame(frame: string): { event?: string; data: string } | undefined {
  const data: string[] = []
  let event: string | undefined
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    const index = line.indexOf(':')
    const field = index === -1 ? line : line.slice(0, index)
    const value = index === -1 ? '' : line.slice(index + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (!data.length) return undefined
  return { event, data: data.join('\n') }
}

function findSseSeparator(value: string): { index: number; length: number } | undefined {
  const lf = value.indexOf('\n\n')
  const crlf = value.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return undefined
  if (lf === -1) return { index: crlf, length: 4 }
  if (crlf === -1) return { index: lf, length: 2 }
  return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: NodeJS.Timeout | undefined
  let abortListener: (() => void) | undefined
  try {
    if (signal?.aborted) throw new QoderHttpError('Qoder stream aborted', { code: 'ABORTED' })
    return await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new QoderHttpError(`Qoder stream timeout after ${timeoutMs}ms`, { code: 'TIMEOUT' })
            ),
          timeoutMs
        )
        if (signal) {
          abortListener = () =>
            reject(new QoderHttpError('Qoder stream aborted', { code: 'ABORTED' }))
          signal.addEventListener('abort', abortListener, { once: true })
        }
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && abortListener) signal.removeEventListener('abort', abortListener)
  }
}

async function qoderFetch(url: string, init: RequestInit, proxyUrl?: string): Promise<Response> {
  if (!proxyUrl) return fetch(url, init)
  try {
    const dispatcher = getProxyAgent(proxyUrl)
    return undiciFetch(url, { ...init, dispatcher } as Parameters<
      typeof undiciFetch
    >[1]) as unknown as Promise<Response>
  } catch (error) {
    throw new QoderHttpError(`Qoder proxy setup failed for ${proxyUrl}: ${toErrorMessage(error)}`)
  }
}

function getProxyAgent(proxyUrl: string): ProxyAgent {
  const normalized = proxyUrl.includes('://') ? proxyUrl : `http://${proxyUrl}`
  let agent = proxyAgents.get(normalized)
  if (!agent) {
    agent = new ProxyAgent(normalized)
    proxyAgents.set(normalized, agent)
  }
  return agent
}

function resolveQoderApiBaseUrl(settings: QoderProviderSettings): string {
  const fromHost = process.env.QODER_MODEL_SERVER_HOST?.trim()
  if (fromHost) {
    const host = fromHost.replace(/^https?:\/\//, '').replace(/\/+$/, '')
    return `https://${host}`
  }
  const raw =
    settings.apiBaseUrl?.trim() ||
    process.env.QODER_API_BASE_URL?.trim() ||
    DEFAULT_QODER_MODEL_SERVER_BASE_URL
  return raw.replace(/\/+$/, '')
}

function resolveQoderLegacyApiBaseUrl(): string {
  const fromHost = process.env.QODER_LEGACY_API_HOST?.trim()
  if (fromHost) {
    const host = fromHost.replace(/^https?:\/\//, '').replace(/\/+$/, '')
    return `https://${host}`
  }
  const raw = process.env.QODER_LEGACY_API_BASE_URL?.trim() || DEFAULT_QODER_LEGACY_API_BASE_URL
  return raw.replace(/\/+$/, '')
}

function resolveQoderOpenApiBaseUrl(): string {
  const raw = process.env.QODER_OPENAPI_BASE_URL?.trim() || DEFAULT_QODER_OPENAPI_BASE_URL
  return raw.replace(/\/+$/, '')
}

function withTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const abortFromParent = (): void => controller.abort(signal?.reason)
  if (signal?.aborted) controller.abort(signal.reason)
  else signal?.addEventListener('abort', abortFromParent, { once: true })
  const timer = setTimeout(() => {
    controller.abort(
      new QoderHttpError(`Qoder request timeout after ${timeoutMs}ms`, { code: 'TIMEOUT' })
    )
  }, timeoutMs)
  timer.unref?.()
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abortFromParent)
    }
  }
}

function normalizeFetchError(error: unknown): Error {
  if (error instanceof QoderHttpError) return error
  if (error instanceof Error && error.name === 'AbortError') {
    return new QoderHttpError('Qoder request aborted or timed out', { code: 'ABORTED' })
  }
  return error instanceof Error ? error : new Error(toErrorMessage(error))
}

async function safeText(response: Response): Promise<string> {
  try {
    return redactSecrets((await response.text()).slice(0, 1000))
  } catch {
    return ''
  }
}

function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/((?:Cosy-Key|Cosy-MachineToken|Cosy-MachineId)\s*[:=]\s*)[^\s,;"]+/gi, '$1[redacted]')
    .replace(
      /("(?:access|refresh|device|personal|security_oauth)_?token"\s*:\s*")[^"]+(")/gi,
      '$1[redacted]$2'
    )
    .replace(/((?:access|refresh|device|personal|security_oauth)_?token=)[^&\s]+/gi, '$1[redacted]')
}

function defaultMaxTokens(value: unknown): number {
  return normalizeQoderMaxOutputTokens(value) === '32k' ? 32768 : 16384
}

function normalizeFinishReason(value: string): string {
  if (value === 'tool_calls' || value === 'length' || value === 'content_filter') return value
  return 'stop'
}

function copyNumber(source: any, target: any, key: string): void {
  const value = numeric(source?.[key])
  if (value !== undefined) target[key] = value
}

function copyIfPresent(source: any, target: any, key: string): void {
  if (source?.[key] !== undefined) target[key] = source[key]
}

function numeric(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function secondsToMs(value: unknown, fallbackMs: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallbackMs
  return Math.max(1_000, Math.trunc(n * 1000))
}
