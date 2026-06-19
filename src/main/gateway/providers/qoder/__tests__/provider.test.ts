import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCipheriv } from 'crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { GatewayLogger } from '../../../core/logger'
import type { QoderProviderConfig, QoderProviderState } from '../../../types'
import { QoderProvider } from '../provider'
import {
  QODER_CLI_BUSINESS_STAGE,
  QODER_CLI_COMPAT_VERSION,
  QODER_CLI_USER_AGENT
} from '../constants'

vi.mock('../wasm', () => ({
  getQoderAuthWasm: vi.fn(async () => ({
    generateRuntimeAuthFields: () => ({ encrypt_user_info: 'enc-user', key: 'enc-key' }),
    createContext: () => ({
      prepareInferRequest: (baseUrl: string, bodyJson: string, model: string, source: string) => ({
        url: `${baseUrl}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`,
        headers: {
          Authorization: 'Bearer legacy-token',
          'X-Model-Key': model,
          'X-Model-Source': source
        },
        body: bodyJson
      }),
      free: () => undefined
    })
  }))
}))

const config = (): QoderProviderConfig => ({
  enabled: true,
  routeName: 'qoder',
  settings: {
    apiBaseUrl: 'https://qoder.test',
    // Deliberately invalid: provider requests must not spawn qodercli.
    qoderCliPath: '/definitely/not/qodercli',
    vpnProxyUrl: '',
    firstTokenTimeoutSeconds: 5,
    streamingReadTimeoutSeconds: 5,
    maxRetries: 2,
    maxOutputTokens: '16k'
  }
})

function state(): QoderProviderState {
  return { accounts: {}, currentAccountIndex: 0, logs: [] }
}

const postBodies: any[] = []
const legacyBodies: any[] = []
const legacyHeaders: Record<string, string>[] = []
let fetchMock: ReturnType<typeof vi.fn>
const tempDirs: string[] = []
let mergeDoneIntoUsageFrame = false
let truncateTerminalUsageFrame = false
let insertPartialNoiseFrames = false
let stallChatStream = false

function headerValue(headers: HeadersInit | undefined, key: string): string {
  if (!headers) return ''
  if (headers instanceof Headers) return headers.get(key) || ''
  if (Array.isArray(headers)) {
    return headers.find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] || ''
  }
  return String((headers as Record<string, string>)[key] || '')
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function qoderSse(
  model: string,
  options?: {
    mergeDoneIntoUsageFrame?: boolean
    truncateTerminalUsageFrame?: boolean
    insertPartialNoiseFrames?: boolean
  }
): Response {
  const chunks = [
    {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    },
    {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: { content: 'Hello ' }, finish_reason: null }]
    },
    {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: { content: 'from Qoder' }, finish_reason: null }]
    },
    {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    },
    {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
    }
  ]
  const frames = chunks.map((chunk, index) => {
    if (options?.truncateTerminalUsageFrame && index === chunks.length - 1) {
      return `data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":1,"model":"${model}","choices":[{"index":0,"finish_reason":"stop"}],"usage":{"completion_tokens_\n\n`
    }
    const frame = `data: ${JSON.stringify(chunk)}\n\n`
    if (options?.mergeDoneIntoUsageFrame && index === chunks.length - 1) {
      return `data: ${JSON.stringify(chunk)}\ndata: [DONE]\n\n`
    }
    return frame
  })
  const prefix = options?.insertPartialNoiseFrames
    ? [
        'data: {"id":"partial","objec\n\n',
        'data: {"id":"partial","object":"chat.completion.chunk","created":1\n\n',
        'data: {"id":"partial","object":"chat.completion.chunk","created":1,"model":"auto","choices":[{"index":0,"delta":{"role":"assistant","reasoning_item":{"encrypted_content":"abc\n\n'
      ].join('')
    : ''
  return new Response(
    `${prefix}${frames.join('')}${
      options?.mergeDoneIntoUsageFrame || options?.truncateTerminalUsageFrame
        ? ''
        : 'data: [DONE]\n\n'
    }`,
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    }
  )
}

function stalledQoderSse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start() {
        /* keep the upstream read pending until the caller aborts */
      }
    }),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    }
  )
}

function qoderLegacySse(model: string): Response {
  const chunks = [
    {
      id: 'chatcmpl-legacy',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    },
    {
      id: 'chatcmpl-legacy',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: { content: 'Hello ' }, finish_reason: null }]
    },
    {
      id: 'chatcmpl-legacy',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: { content: 'from Qoder' }, finish_reason: null }]
    },
    {
      id: 'chatcmpl-legacy',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    },
    {
      id: 'chatcmpl-legacy',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
    }
  ]
  const frames = chunks
    .map(
      (chunk) =>
        `data: ${JSON.stringify({
          statusCode: 200,
          statusCodeValue: 200,
          body: JSON.stringify(chunk)
        })}\n\n`
    )
    .join('')
  return new Response(
    `${frames}data: ${JSON.stringify({
      statusCode: 200,
      statusCodeValue: 200,
      body: '[DONE]'
    })}\n\n`,
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    }
  )
}

async function writeQoderCliCredential(credential: Record<string, unknown>): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'gatewayhub-qoder-test-'))
  tempDirs.push(home)
  const authDir = join(home, '.qoder', '.auth')
  await mkdir(authDir, { recursive: true })
  const machineId = '1234567890abcdef'
  const key = Buffer.from(machineId)
  const cipher = createCipheriv('aes-128-cbc', key, key)
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(credential), 'utf8'),
    cipher.final()
  ]).toString('base64')
  await writeFile(join(authDir, 'machine_id'), machineId)
  await writeFile(join(authDir, 'user'), encrypted)
  return home
}

describe('qoder/provider', () => {
  beforeEach(() => {
    postBodies.length = 0
    legacyBodies.length = 0
    legacyHeaders.length = 0
    mergeDoneIntoUsageFrame = false
    truncateTerminalUsageFrame = false
    insertPartialNoiseFrames = false
    stallChatStream = false
    vi.stubEnv('QODER_OPENAPI_BASE_URL', 'https://qoder.test')
    vi.stubEnv('QODER_LEGACY_API_BASE_URL', 'https://qoder-legacy.test')
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const auth = headerValue(init?.headers, 'Authorization')
      if (url === 'https://qoder.test/api/v1/jobToken/exchange') {
        const body = JSON.parse(String(init?.body || '{}'))
        if (body.personal_token === 'bad-token') {
          return new Response('unauthorized token', { status: 401 })
        }
        return jsonResponse({
          token: `dt-${body.personal_token}`,
          refresh_token: `drt-${body.personal_token}`,
          expires_in: 3600
        })
      }
      if (url === 'https://qoder.test/api/v1/deviceToken/refresh') {
        const body = JSON.parse(String(init?.body || '{}'))
        if (body.refresh_token === 'drt-bad-token') {
          return new Response('unauthorized token', { status: 401 })
        }
        return jsonResponse({
          device_token: 'dt-refreshed-token',
          refresh_token: body.refresh_token,
          expires_in: 3600
        })
      }
      if (url === 'https://qoder.test/api/v2/quota/usage') {
        if (
          !['Bearer dt-good-token', 'Bearer dt-cli-token', 'Bearer dt-refreshed-token'].includes(
            auth
          )
        ) {
          return new Response('unauthorized token', { status: 401 })
        }
        return jsonResponse({
          usageType: 'credits',
          totalUsagePercentage: 0.28,
          isQuotaExceeded: false,
          expiresAt: 2_000_000_000_000,
          upgradeUrl: 'https://qoder.com/pricing?client=qoder',
          isPlanQuotaProrated: false,
          userQuota: {
            total: 300,
            used: 83,
            remaining: 217,
            percentage: 0.28,
            unit: 'credits'
          }
        })
      }
      if (url === 'https://qoder.test/api/v2/user/plan') {
        if (
          !['Bearer dt-good-token', 'Bearer dt-cli-token', 'Bearer dt-refreshed-token'].includes(
            auth
          )
        ) {
          return new Response('unauthorized token', { status: 401 })
        }
        return jsonResponse({
          user_type: 'personal_professional_trial',
          plan_tier_name: 'Pro Trial',
          end_date: 2_000_000_000_000
        })
      }
      if (url === 'https://qoder.test/api/v3/user/status') {
        if (
          !['Bearer dt-good-token', 'Bearer dt-cli-token', 'Bearer dt-refreshed-token'].includes(
            auth
          )
        ) {
          return new Response('unauthorized token', { status: 401 })
        }
        return jsonResponse({
          name: 'Qoder User',
          email: 'user@example.com',
          userType: 'personal_professional_trial',
          userTag: 'Pro Trial',
          nextResetAt: 2_000_000_000_000
        })
      }
      if (
        url ===
        'https://qoder-legacy.test/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'
      ) {
        legacyBodies.push(JSON.parse(String(init?.body || '{}')))
        legacyHeaders.push({
          authorization: auth,
          model: headerValue(init?.headers, 'X-Model-Key'),
          source: headerValue(init?.headers, 'X-Model-Source'),
          userAgent: headerValue(init?.headers, 'User-Agent')
        })
        if (auth !== 'Bearer legacy-token') {
          return new Response('unauthorized token', { status: 401 })
        }
        return qoderLegacySse(legacyHeaders.at(-1)?.model || 'qmodel_latest')
      }
      if (url === 'https://qoder.test/model/v1/chat/completions') {
        postBodies.push(JSON.parse(String(init?.body || '{}')))
        if (
          !['Bearer dt-good-token', 'Bearer dt-cli-token', 'Bearer dt-refreshed-token'].includes(
            auth
          )
        ) {
          return new Response('unauthorized token', { status: 401 })
        }
        if (stallChatStream) return stalledQoderSse()
        return qoderSse(postBodies.at(-1)?.model || 'auto', {
          mergeDoneIntoUsageFrame,
          truncateTerminalUsageFrame,
          insertPartialNoiseFrames
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('validates the personal access token through the direct Qoder API', async () => {
    const provider = new QoderProvider(config(), state(), new GatewayLogger(), vi.fn())
    await provider.initialize([
      { id: 'bad', enabled: true, label: 'Bad', personalAccessToken: 'bad-token' },
      { id: 'good', enabled: true, label: 'Good', personalAccessToken: 'good-token' }
    ])

    const bad = await provider.testAccount('bad')
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain('401')

    const good = await provider.testAccount('good')
    expect(good.ok).toBe(true)
    expect(good.models).toContain('auto')
    expect(good.authType).toBe('qoder-personal-access-token')
  })

  it('serves OpenAI chat completions with direct API multi-account failover', async () => {
    const provider = new QoderProvider(config(), state(), new GatewayLogger(), vi.fn())
    await provider.initialize([
      { id: 'bad', enabled: true, label: 'Bad', personalAccessToken: 'bad-token' },
      { id: 'good', enabled: true, label: 'Good', personalAccessToken: 'good-token' }
    ])

    const response = await provider.chatCompletions(
      {
        model: 'gpt-4o',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }]
      },
      { requestId: 'req-openai', apiFormat: 'openai' }
    )

    expect(response.status).toBe(200)
    expect((response.body as any).model).toBe('auto')
    expect((response.body as any).choices[0].message.content).toBe('Hello from Qoder')
    expect(postBodies[0]).toMatchObject({
      model: 'auto',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }]
    })
    expect(postBodies[0]).not.toHaveProperty('prompt')

    const status = await provider.getStatus()
    const bad = (status as any).accounts.find((a: any) => a.id === 'bad')
    const good = (status as any).accounts.find((a: any) => a.id === 'good')
    expect(bad.stats.failedRequests).toBe(1)
    expect(good.stats.successfulRequests).toBe(1)
    expect((status as any).message).toContain('direct credential')
  })

  it('normalizes stale qwen model cache before listing models', async () => {
    const providerState = state()
    providerState.accounts.stale = {
      failures: 0,
      lastFailureAt: 0,
      lastSuccessAt: 0,
      modelsCachedAt: Date.now(),
      modelIds: ['qwen3.7-max', 'qwen3.7-plus'],
      status: 'available',
      statusUpdatedAt: 0,
      stats: { totalRequests: 0, successfulRequests: 0, failedRequests: 0 }
    }
    const provider = new QoderProvider(config(), providerState, new GatewayLogger(), vi.fn())
    await provider.initialize([
      {
        id: 'stale',
        enabled: true,
        label: 'Stale',
        authType: 'qoder-cli-auth',
        qoderCliHome: '/tmp/qoder-home'
      }
    ])

    const status = await provider.getStatus()
    const account = (status as any).accounts.find((a: any) => a.id === 'stale')
    expect(account.models).toContain('qmodel_latest')
    expect(account.models).toContain('qmodel')
    expect(account.models).not.toContain('qwen3.7-max')

    const models = (await provider.listModels()).map((m) => m.id)
    expect(models).toContain('qmodel_latest')
    expect(models).toContain('qmodel')
    expect(models).toContain('qwen3.7-max')
    expect(models).toContain('qwen3.7-plus')
  })

  it('does not advertise legacy IDE models for PAT-only accounts', async () => {
    const provider = new QoderProvider(config(), state(), new GatewayLogger(), vi.fn())
    await provider.initialize([
      { id: 'good', enabled: true, label: 'Good', personalAccessToken: 'good-token' }
    ])

    const models = (await provider.listModels()).map((m) => m.id)

    expect(models).toEqual(['auto', 'efficient', 'lite', 'performance', 'ultimate'])
    expect(models).not.toContain('qmodel_latest')
    expect(models).not.toContain('qwen3.7-max')
  })

  it('aborts non-stream upstream reads when the client disconnects', async () => {
    stallChatStream = true
    const provider = new QoderProvider(config(), state(), new GatewayLogger(), vi.fn())
    await provider.initialize([
      { id: 'good', enabled: true, label: 'Good', personalAccessToken: 'good-token' }
    ])
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(new Error('client closed')), 20)

    const response = await provider.chatCompletions(
      {
        model: 'auto',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }]
      },
      { requestId: 'req-abort', apiFormat: 'openai', abortSignal: abort.signal }
    )
    clearTimeout(timer)

    expect(response.status).toBe(499)
    expect((response.body as any).error.type).toBe('client_aborted')
  })

  it('uses imported qodercli auth bundles by reading the local token directly', async () => {
    const qoderCliHome = await writeQoderCliCredential({
      access_token: 'dt-cli-token',
      security_oauth_token: 'dt-cli-token',
      refresh_token: 'drt-cli-token',
      expire_time: Math.floor(Date.now() / 1000) + 3600
    })
    const provider = new QoderProvider(config(), state(), new GatewayLogger(), vi.fn())
    await provider.initialize([
      {
        id: 'cli',
        enabled: true,
        label: 'CLI Login',
        authType: 'qoder-cli-auth',
        qoderCliHome
      }
    ])

    const test = await provider.testAccount('cli')
    expect(test.ok).toBe(true)
    expect(test.authType).toBe('qoder-cli-auth')

    const response = await provider.chatCompletions(
      {
        model: 'auto',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }]
      },
      { requestId: 'req-cli-login', apiFormat: 'openai' }
    )

    expect(response.status).toBe(200)
    expect((response.body as any).choices[0].message.content).toBe('Hello from Qoder')
    expect(postBodies.at(-1)).toMatchObject({ model: 'auto' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://qoder.test/model/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer dt-cli-token',
          'User-Agent': QODER_CLI_USER_AGENT
        })
      })
    )
  })

  it('returns Qoder quota usage for the gateway account panel', async () => {
    const qoderCliHome = await writeQoderCliCredential({
      access_token: 'dt-cli-token',
      security_oauth_token: 'dt-cli-token',
      refresh_token: 'drt-cli-token',
      expire_time: Math.floor(Date.now() / 1000) + 3600
    })
    const provider = new QoderProvider(config(), state(), new GatewayLogger(), vi.fn())
    await provider.initialize([
      {
        id: 'cli',
        enabled: true,
        label: 'CLI Login',
        authType: 'qoder-cli-auth',
        qoderCliHome
      }
    ])

    const info = await provider.getAccountInfo('cli')

    expect(info.subscription).toMatchObject({
      title: 'Pro Trial',
      type: 'personal_professional_trial'
    })
    expect(info.email).toBe('user@example.com')
    expect(info.usage).toMatchObject({
      used: 83,
      limit: 300,
      remaining: 217,
      percentage: 0.28,
      totalUsagePercentage: 0.28,
      percentUsed: 28,
      isQuotaExceeded: false,
      usageType: 'credits',
      unit: 'credits',
      resetDate: new Date(2_000_000_000_000).toISOString(),
      expiresAt: new Date(2_000_000_000_000).toISOString(),
      upgradeUrl: 'https://qoder.com/pricing?client=qoder',
      isPlanQuotaProrated: false
    })
    expect(info.keyInfo.quota.userQuota.remaining).toBe(217)
  })

  it('routes qwen3.7-max compatibility aliases through the legacy signed direct API', async () => {
    const qoderCliHome = await writeQoderCliCredential({
      uid: 'u-cli',
      access_token: 'dt-cli-token',
      security_oauth_token: 'dt-cli-token',
      refresh_token: 'drt-cli-token',
      expire_time: Math.floor(Date.now() / 1000) + 3600,
      data_policy_agreed: true,
      organization_tags: []
    })
    const providerState = state()
    providerState.accounts.cli = {
      failures: 0,
      lastFailureAt: 0,
      lastSuccessAt: 0,
      modelsCachedAt: Date.now(),
      modelIds: ['lite', 'efficient', 'auto', 'performance', 'ultimate'],
      status: 'available',
      statusUpdatedAt: 0,
      stats: { totalRequests: 0, successfulRequests: 0, failedRequests: 0 }
    }
    const provider = new QoderProvider(config(), providerState, new GatewayLogger(), vi.fn())
    await provider.initialize([
      {
        id: 'cli',
        enabled: true,
        label: 'CLI Login',
        authType: 'qoder-cli-auth',
        qoderCliHome,
        qoderCliPath: '/mock/qodercli'
      }
    ])

    const response = await provider.chatCompletions(
      {
        model: 'qoder/qwen3.7-max',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }]
      },
      {
        requestId: 'req-qwen-max',
        sessionId: '07cb83c1-633f-4e3a-a6d9-df922c642292',
        apiFormat: 'openai'
      }
    )

    expect(response.status).toBe(200)
    expect((response.body as any).model).toBe('qmodel_latest')
    expect((response.body as any).choices[0].message.content).toBe('Hello from Qoder')
    expect(postBodies.length).toBe(0)
    expect(legacyHeaders[0]).toMatchObject({
      authorization: 'Bearer legacy-token',
      model: 'qmodel_latest',
      source: 'system',
      userAgent: QODER_CLI_USER_AGENT
    })
    expect(JSON.stringify(legacyBodies[0])).not.toContain('GatewayHub')
    expect(legacyBodies[0]).toMatchObject({
      request_id: 'req-qwen-max',
      request_set_id: 'req-qwen-max',
      chat_record_id: 'req-qwen-max',
      task_id: 'req-qwen-max',
      session_id: '07cb83c1-633f-4e3a-a6d9-df922c642292',
      session_type: 'qodercli',
      aliyun_user_type: '',
      business: {
        product: 'cli',
        version: QODER_CLI_COMPAT_VERSION,
        type: 'agent',
        id: 'req-qwen-max',
        name: 'hello',
        stage: QODER_CLI_BUSINESS_STAGE
      },
      model_config: {
        key: 'qmodel_latest',
        display_name: 'Qwen3.7-Max',
        source: 'system'
      },
      system: expect.stringContaining('helpful coding assistant')
    })
    expect(legacyBodies[0].messages[0]).toMatchObject({
      role: 'system',
      contents: [{ type: 'text', text: expect.any(String) }]
    })
    expect(legacyBodies[0].messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'hello',
      contents: [{ type: 'text', text: 'hello' }]
    })

    const followup = await provider.chatCompletions(
      {
        model: 'qoder/qwen3.7-max',
        stream: false,
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'Hello from Qoder' },
          { role: 'user', content: 'continue' }
        ]
      },
      {
        requestId: 'req-qwen-max-followup',
        sessionId: '07cb83c1-633f-4e3a-a6d9-df922c642292',
        apiFormat: 'openai'
      }
    )

    expect(followup.status).toBe(200)
    expect(legacyBodies[1]).toMatchObject({
      request_id: 'req-qwen-max-followup',
      chat_record_id: 'req-qwen-max-followup',
      task_id: 'req-qwen-max-followup',
      session_id: '07cb83c1-633f-4e3a-a6d9-df922c642292',
      business: { id: 'req-qwen-max-followup' }
    })
  })

  it('serves Anthropic messages by adapting through OpenAI chat completions', async () => {
    const provider = new QoderProvider(config(), state(), new GatewayLogger(), vi.fn())
    await provider.initialize([
      { id: 'good', enabled: true, label: 'Good', personalAccessToken: 'good-token' }
    ])

    const response = await provider.messages(
      {
        model: 'claude-3-haiku',
        stream: false,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }]
      },
      { requestId: 'req-anthropic', apiFormat: 'anthropic' }
    )

    expect(response.status).toBe(200)
    expect((response.body as any).type).toBe('message')
    expect((response.body as any).model).toBe('efficient')
    expect((response.body as any).content[0].text).toBe('Hello from Qoder')
  })

  it('streams OpenAI SSE chunks from the direct API', async () => {
    const provider = new QoderProvider(config(), state(), new GatewayLogger(), vi.fn())
    await provider.initialize([
      { id: 'good', enabled: true, label: 'Good', personalAccessToken: 'good-token' }
    ])

    const response = await provider.chatCompletions(
      {
        model: 'auto',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }]
      },
      { requestId: 'req-stream', apiFormat: 'openai' }
    )

    const chunks: string[] = []
    for await (const chunk of response.stream!) chunks.push(String(chunk))
    expect(chunks.join('')).toContain('Hello ')
    expect(chunks.join('')).toContain('from Qoder')
    expect(chunks.join('')).toContain('data: [DONE]')
  })

  it('tolerates Qoder usage JSON and DONE marker in one SSE frame', async () => {
    mergeDoneIntoUsageFrame = true
    const provider = new QoderProvider(config(), state(), new GatewayLogger(), vi.fn())
    await provider.initialize([
      { id: 'good', enabled: true, label: 'Good', personalAccessToken: 'good-token' }
    ])

    const response = await provider.chatCompletions(
      {
        model: 'auto',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }]
      },
      { requestId: 'req-merged-done', apiFormat: 'openai' }
    )

    expect(response.status).toBe(200)
    expect((response.body as any).choices[0].message.content).toBe('Hello from Qoder')
    expect((response.body as any).usage.total_tokens).toBe(7)
  })

  it('recovers truncated Qoder terminal usage chunks without emitting stream errors', async () => {
    truncateTerminalUsageFrame = true
    const provider = new QoderProvider(config(), state(), new GatewayLogger(), vi.fn())
    await provider.initialize([
      { id: 'good', enabled: true, label: 'Good', personalAccessToken: 'good-token' }
    ])

    const response = await provider.chatCompletions(
      {
        model: 'auto',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }]
      },
      { requestId: 'req-truncated-terminal', apiFormat: 'openai' }
    )

    const chunks: string[] = []
    for await (const chunk of response.stream!) chunks.push(String(chunk))
    const output = chunks.join('')
    expect(output).toContain('Hello ')
    expect(output).toContain('from Qoder')
    expect(output).toContain('data: [DONE]')
    expect(output).not.toContain('server_error')
  })

  it('skips malformed partial Qoder chunks without failing non-stream collection', async () => {
    insertPartialNoiseFrames = true
    const provider = new QoderProvider(config(), state(), new GatewayLogger(), vi.fn())
    await provider.initialize([
      { id: 'good', enabled: true, label: 'Good', personalAccessToken: 'good-token' }
    ])

    const response = await provider.chatCompletions(
      {
        model: 'auto',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }]
      },
      { requestId: 'req-partial-noise', apiFormat: 'openai' }
    )

    expect(response.status).toBe(200)
    expect((response.body as any).choices[0].message.content).toBe('Hello from Qoder')
  })
})
