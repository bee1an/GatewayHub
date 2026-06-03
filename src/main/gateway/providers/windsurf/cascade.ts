import type { UsageStats, WindsurfProviderSettings } from '../../types'
import { estimateTokens, toErrorMessage } from '../../core/utils'
import type { WindsurfCapturedCascadeEdit, WindsurfLanguageServerClient } from './connect'
import {
  dedupeToolCalls,
  normalizeGatewayToolCalls,
  splitInlineToolCalls,
  type GatewayToolCall
} from './toolCalls'

export interface WindsurfImageAttachment {
  mimeType?: string
  base64Data?: string
  caption?: string
  sourceUrl?: string
}

export interface WindsurfPromptPayload {
  prompt: string
  images?: WindsurfImageAttachment[]
}

export interface WindsurfCascadeResult {
  cascadeId: string
  text: string
  usage: UsageStats
  toolCalls?: GatewayToolCall[]
  workspaceEdits?: WindsurfWorkspaceEditState[]
}

export interface WindsurfCascadeStreamEvent {
  cascadeId: string
  text?: string
  textDelta?: string
  usage?: UsageStats
  toolCalls?: GatewayToolCall[]
  workspaceEdits?: WindsurfWorkspaceEditState[]
  done?: boolean
}

export interface WindsurfWorkspaceEditState {
  repoRoot?: string
  numAdditions?: number
  numDeletions?: number
  edits?: any[]
  captured?: boolean
}

const SOURCE = 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT'
const TRAJECTORY_TYPE = 'CORTEX_TRAJECTORY_TYPE_USER_MAINLINE'
const IDLE_STATUS = 'CASCADE_RUN_STATUS_IDLE'

export async function runWindsurfCascade(
  client: WindsurfLanguageServerClient,
  payload: WindsurfPromptPayload,
  model: string,
  settings: WindsurfProviderSettings
): Promise<WindsurfCascadeResult> {
  const context = await startCascadeAndSend(client, payload, model, settings, true)
  return waitForCascadeResult(client, context.cascadeId, context.prompt, context.requestTimeoutMs)
}

export async function* runWindsurfCascadeStream(
  client: WindsurfLanguageServerClient,
  payload: WindsurfPromptPayload,
  model: string,
  settings: WindsurfProviderSettings
): AsyncGenerator<WindsurfCascadeStreamEvent, WindsurfCascadeResult, unknown> {
  const context = await startCascadeAndSend(client, payload, model, settings, false)
  const deadline = Date.now() + context.requestTimeoutMs
  let lastTrajectory: any
  let emittedText = ''
  let lastResult: Omit<WindsurfCascadeResult, 'cascadeId'> | null = null
  while (Date.now() < deadline) {
    const response = await client.unary(
      'GetCascadeTrajectory',
      { cascadeId: context.cascadeId },
      Math.min(30_000, Math.max(1000, deadline - Date.now()))
    )
    lastTrajectory = response
    const result = extractWindsurfCascadeResult(response, context.prompt)
    if (result) {
      lastResult = result
      const resultWithCapturedEdits = withCapturedEdits(result, client, context.cascadeId)
      const delta = nextAppendOnlyDelta(emittedText, resultWithCapturedEdits.text)
      if (delta) {
        emittedText += delta
        yield {
          cascadeId: context.cascadeId,
          text: emittedText,
          textDelta: delta,
          usage: resultWithCapturedEdits.usage,
          toolCalls: resultWithCapturedEdits.toolCalls,
          workspaceEdits: resultWithCapturedEdits.workspaceEdits
        }
      }
      if (isCascadeIdle(response)) {
        const finalResult = { cascadeId: context.cascadeId, ...resultWithCapturedEdits }
        yield { cascadeId: context.cascadeId, ...resultWithCapturedEdits, done: true }
        return finalResult
      }
    }
    const errorMessage = extractWindsurfCascadeError(response)
    if (errorMessage) throw new Error(`Windsurf Cascade error: ${errorMessage}`)
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  if (lastResult) {
    const resultWithCapturedEdits = withCapturedEdits(lastResult, client, context.cascadeId)
    const finalResult = { cascadeId: context.cascadeId, ...resultWithCapturedEdits }
    yield { cascadeId: context.cascadeId, ...resultWithCapturedEdits, done: true }
    return finalResult
  }
  throw new Error(
    `Windsurf Cascade produced no planner response: ${summarizeTrajectory(lastTrajectory)}`
  )
}

export async function getWindsurfUserModels(
  client: WindsurfLanguageServerClient,
  settings: WindsurfProviderSettings
): Promise<string[]> {
  const timeoutMs = Math.max(20, settings.launchTimeoutSeconds || 20) * 1000
  const response = await client.unary('GetUserStatus', { metadata: client.metadata() }, timeoutMs)
  if (response?.userStatus) {
    await client.unary(
      'UpdatePanelStateWithUserStatus',
      { metadata: client.metadata(), userStatus: response.userStatus },
      timeoutMs
    )
  }
  return extractWindsurfModelIds(response)
}

export function extractWindsurfModelIds(response: any): string[] {
  const configs = [
    ...(response?.userStatus?.cascadeModelConfigData?.clientModelConfigs || []),
    ...(response?.planInfo?.cascadeModelConfigData?.clientModelConfigs || [])
  ]
  const models = configs
    .filter(isUsableWindsurfModelConfig)
    .map((item: any) => item?.modelUid || item?.modelInfo?.modelUid || item?.label)
    .filter((value: any): value is string => typeof value === 'string' && value.trim().length > 0)
  return [...new Set(models)].sort()
}

function isUsableWindsurfModelConfig(item: any): boolean {
  if (!item || typeof item !== 'object') return false
  if (item.disabled === true) return false
  // BYOK entries can be listed as non-disabled even when this Windsurf account
  // has no provider API key configured. Sending them to Cascade fails with
  // "model requires BYOK", so do not advertise them as GatewayHub-routable.
  if (item.pricingType === 'MODEL_PRICING_TYPE_BYOK') return false
  return true
}

export function extractWindsurfCascadeResult(
  trajectoryResponse: any,
  prompt: string
): Omit<WindsurfCascadeResult, 'cascadeId'> | null {
  const trajectory = trajectoryResponse?.trajectory || trajectoryResponse
  const steps = Array.isArray(trajectory?.steps) ? trajectory.steps : []
  let plannerStep: any
  for (const step of steps) {
    if (step?.plannerResponse || step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
      plannerStep = step
    }
  }
  if (!plannerStep) return null
  const response =
    plannerStep.plannerResponse?.modifiedResponse ?? plannerStep.plannerResponse?.response
  if (typeof response !== 'string') return null
  const inline = splitInlineToolCalls(response)
  const toolCalls = dedupeToolCalls([
    ...extractStructuredToolCalls(plannerStep),
    ...inline.toolCalls
  ])
  const workspaceEdits = extractWorkspaceEdits(trajectoryResponse)
  return {
    text: inline.text,
    usage: usageFromTrajectory(trajectory, plannerStep, prompt, inline.text),
    toolCalls: toolCalls.length ? toolCalls : undefined,
    workspaceEdits: workspaceEdits.length ? workspaceEdits : undefined
  }
}

export function extractWindsurfCascadeError(trajectoryResponse: any): string | null {
  const trajectory = trajectoryResponse?.trajectory || trajectoryResponse
  const steps = Array.isArray(trajectory?.steps) ? trajectory.steps : []
  for (const step of steps) {
    const message = pickErrorMessage(step?.error) || pickErrorMessage(step?.errorMessage)
    if (message) return message
    if (typeof step?.type === 'string' && step.type.includes('ERROR')) {
      return summarizeTrajectory(trajectoryResponse)
    }
  }
  return null
}

function buildCascadeConfig(model: string): any {
  return { plannerConfig: { conversational: {}, requestedModelUid: model } }
}

async function startCascadeAndSend(
  client: WindsurfLanguageServerClient,
  payload: WindsurfPromptPayload,
  model: string,
  settings: WindsurfProviderSettings,
  blocking: boolean
): Promise<{ cascadeId: string; prompt: string; requestTimeoutMs: number }> {
  const prompt = payload.prompt.trim()
  if (!prompt) throw new Error('Windsurf request prompt is empty')
  const shortTimeoutMs = Math.max(20, settings.launchTimeoutSeconds || 20) * 1000
  const requestTimeoutMs =
    Math.max(30, settings.firstTokenTimeoutSeconds + settings.streamingReadTimeoutSeconds) * 1000
  const status = await client.unary(
    'GetUserStatus',
    { metadata: client.metadata() },
    shortTimeoutMs
  )
  if (!status?.userStatus) throw new Error('Windsurf GetUserStatus did not return userStatus')
  await client.unary(
    'UpdatePanelStateWithUserStatus',
    { metadata: client.metadata(), userStatus: status.userStatus },
    shortTimeoutMs
  )
  const started = await client.unary(
    'StartCascade',
    { metadata: client.metadata(), source: SOURCE, trajectoryType: TRAJECTORY_TYPE },
    shortTimeoutMs
  )
  const cascadeId = started?.cascadeId
  if (typeof cascadeId !== 'string' || !cascadeId) {
    throw new Error('Windsurf StartCascade did not return cascadeId')
  }
  await sendUserCascadeMessage(client, cascadeId, payload, model, blocking, requestTimeoutMs)
  return { cascadeId, prompt, requestTimeoutMs }
}

async function sendUserCascadeMessage(
  client: WindsurfLanguageServerClient,
  cascadeId: string,
  payload: WindsurfPromptPayload,
  model: string,
  blocking: boolean,
  timeoutMs: number
): Promise<void> {
  const imageData = toCascadeImages(payload.images)
  const body = (includeImages: boolean) => ({
    metadata: client.metadata(),
    cascadeId,
    items: [{ text: payload.prompt.trim() }],
    ...(includeImages && imageData.length ? { images: imageData } : {}),
    cascadeConfig: buildCascadeConfig(model),
    blocking
  })
  try {
    await client.unary('SendUserCascadeMessage', body(true), timeoutMs)
  } catch (error) {
    if (!imageData.length || !shouldRetryWithoutNativeImages(error)) throw error
    await client.unary('SendUserCascadeMessage', body(false), timeoutMs)
  }
}

export function toCascadeImages(images?: WindsurfImageAttachment[]): any[] {
  return (images || [])
    .filter((image) => image.base64Data?.trim())
    .map((image) => ({
      base64Data: image.base64Data!.trim(),
      mimeType: image.mimeType || 'image/png',
      ...(image.caption ? { caption: image.caption } : {})
    }))
}

async function waitForCascadeResult(
  client: WindsurfLanguageServerClient,
  cascadeId: string,
  prompt: string,
  timeoutMs: number
): Promise<WindsurfCascadeResult> {
  const deadline = Date.now() + timeoutMs
  let lastTrajectory: any
  while (Date.now() < deadline) {
    const response = await client.unary(
      'GetCascadeTrajectory',
      { cascadeId },
      Math.min(30_000, Math.max(1000, deadline - Date.now()))
    )
    lastTrajectory = response
    const result = extractWindsurfCascadeResult(response, prompt)
    if (result) return { cascadeId, ...withCapturedEdits(result, client, cascadeId) }
    const errorMessage = extractWindsurfCascadeError(response)
    if (errorMessage) throw new Error(`Windsurf Cascade error: ${errorMessage}`)
    if (isCascadeIdle(response)) break
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(
    `Windsurf Cascade produced no planner response: ${summarizeTrajectory(lastTrajectory)}`
  )
}

function usageFromTrajectory(
  trajectory: any,
  step: any,
  prompt: string,
  response: string
): UsageStats {
  const metadata = step?.metadata || {}
  const modelUsage = metadata.modelUsage || trajectory?.generatorMetadata?.at?.(-1)?.modelUsage
  const cacheWriteTokens =
    numeric(metadata.cacheWriteTokens) ||
    numeric(modelUsage?.cacheWriteTokens) ||
    numeric(modelUsage?.cacheWriteInputTokens)
  const inputTokens =
    numeric(metadata.inputTokens) || numeric(modelUsage?.inputTokens) || estimateTokens(prompt)
  const outputTokens =
    numeric(metadata.outputTokens) || numeric(modelUsage?.outputTokens) || estimateTokens(response)
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: numeric(metadata.cacheReadTokens) || numeric(modelUsage?.cacheReadTokens),
    cacheWrite5mTokens: cacheWriteTokens,
    estimated: !numeric(metadata.outputTokens) && !numeric(modelUsage?.outputTokens)
  }
}

function extractStructuredToolCalls(step: any): GatewayToolCall[] {
  const planner = step?.plannerResponse || {}
  const metadata = step?.metadata || {}
  return normalizeGatewayToolCalls([
    ...(Array.isArray(planner.toolCalls) ? planner.toolCalls : []),
    ...(Array.isArray(planner.tool_calls) ? planner.tool_calls : []),
    ...(metadata.toolCall ? [metadata.toolCall] : []),
    ...(metadata.tool_call ? [metadata.tool_call] : []),
    ...(Array.isArray(metadata.toolCallChoices) ? metadata.toolCallChoices : []),
    ...(Array.isArray(metadata.tool_call_choices) ? metadata.tool_call_choices : [])
  ])
}

function extractWorkspaceEdits(response: any): WindsurfWorkspaceEditState[] {
  const direct = response?.workspaceEdits || response?.workspace_edits
  const trajectory = response?.trajectory || response
  const nested = trajectory?.workspaceEdits || trajectory?.workspace_edits
  return [...arrayOfObjects(direct), ...arrayOfObjects(nested)]
    .map((edit) => ({
      repoRoot: stringValue(edit.repoRoot ?? edit.repo_root),
      numAdditions: numeric(edit.numAdditions ?? edit.num_additions),
      numDeletions: numeric(edit.numDeletions ?? edit.num_deletions),
      edits: Array.isArray(edit.edits) ? edit.edits : undefined
    }))
    .filter((edit) => edit.repoRoot || edit.numAdditions || edit.numDeletions || edit.edits?.length)
}

function withCapturedEdits(
  result: Omit<WindsurfCascadeResult, 'cascadeId'>,
  client: WindsurfLanguageServerClient,
  cascadeId: string
): Omit<WindsurfCascadeResult, 'cascadeId'> {
  const getCapturedCascadeEdits = (client as any).getCapturedCascadeEdits
  if (typeof getCapturedCascadeEdits !== 'function') return result
  const capturedEdits = capturedEditsToWorkspaceState(
    getCapturedCascadeEdits.call(client, cascadeId)
  )
  if (!capturedEdits.length) return result
  return {
    ...result,
    workspaceEdits: [...(result.workspaceEdits || []), ...capturedEdits]
  }
}

function capturedEditsToWorkspaceState(
  edits: WindsurfCapturedCascadeEdit[]
): WindsurfWorkspaceEditState[] {
  if (!edits.length) return []
  const grouped = new Map<string, WindsurfCapturedCascadeEdit[]>()
  for (const edit of edits) {
    const key = edit.gitWorktreePath || fileUriToDirectory(edit.uri) || '(unknown workspace)'
    grouped.set(key, [...(grouped.get(key) || []), edit])
  }
  return [...grouped.entries()].map(([repoRoot, group]) => ({
    repoRoot,
    numAdditions: group.reduce((sum, edit) => sum + countLines(edit.targetContent), 0),
    numDeletions: 0,
    captured: true,
    edits: group.map((edit) => ({
      uri: edit.uri,
      targetContent: edit.targetContent,
      cascadeId: edit.cascadeId,
      gitWorktreePath: edit.gitWorktreePath,
      notebookCell: edit.notebookCell,
      receivedAt: edit.receivedAt
    }))
  }))
}

function fileUriToDirectory(uri?: string): string | undefined {
  if (!uri?.startsWith('file://')) return undefined
  try {
    const path = decodeURIComponent(new URL(uri).pathname)
    return path.slice(0, Math.max(1, path.lastIndexOf('/')))
  } catch {
    return undefined
  }
}

function countLines(value?: string): number {
  if (!value) return 0
  return value.split(/\r\n|\r|\n/).length
}

function arrayOfObjects(value: any): any[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : []
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isCascadeIdle(response: any): boolean {
  const status =
    response?.status ||
    response?.runStatus ||
    response?.run_status ||
    response?.trajectory?.status ||
    response?.trajectory?.runStatus ||
    response?.trajectory?.run_status
  return status === IDLE_STATUS || String(status || '').endsWith('_IDLE')
}

function nextAppendOnlyDelta(previous: string, next: string): string {
  if (!previous) return next
  if (next.startsWith(previous)) return next.slice(previous.length)
  return ''
}

function shouldRetryWithoutNativeImages(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase()
  return (
    message.includes('image') ||
    message.includes('unknown field') ||
    message.includes('invalid json') ||
    message.includes('cannot parse') ||
    message.includes('unsupported') ||
    message.includes('http 400')
  )
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value))
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.max(0, Math.round(parsed))
  }
  return undefined
}

function pickErrorMessage(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 500)
  if (!value || typeof value !== 'object' || depth > 4) return undefined
  const record = value as Record<string, unknown>
  for (const key of ['userErrorMessage', 'message', 'shortError', 'description']) {
    const direct = pickErrorMessage(record[key], depth + 1)
    if (direct) return direct
  }
  for (const nested of Object.values(record)) {
    const message = pickErrorMessage(nested, depth + 1)
    if (message) return message
  }
  return undefined
}

function summarizeTrajectory(value: any): string {
  try {
    const steps = value?.trajectory?.steps || []
    return JSON.stringify(
      steps.map((step: any) => ({
        type: step?.type,
        status: step?.status,
        error: step?.error || step?.errorMessage
      }))
    ).slice(0, 500)
  } catch (error) {
    return toErrorMessage(error)
  }
}
