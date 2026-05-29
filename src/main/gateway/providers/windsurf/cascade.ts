import type { UsageStats, WindsurfProviderSettings } from '../../types'
import { estimateTokens, toErrorMessage } from '../../core/utils'
import type { WindsurfLanguageServerClient } from './connect'

export interface WindsurfPromptPayload {
  prompt: string
}

export interface WindsurfCascadeResult {
  cascadeId: string
  text: string
  usage: UsageStats
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
  await client.unary(
    'SendUserCascadeMessage',
    {
      metadata: client.metadata(),
      cascadeId,
      items: [{ text: prompt }],
      cascadeConfig: buildCascadeConfig(model),
      blocking: true
    },
    requestTimeoutMs
  )
  return waitForCascadeResult(client, cascadeId, payload.prompt, requestTimeoutMs)
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
    .map((item: any) => item?.modelUid || item?.modelInfo?.modelUid || item?.label)
    .filter((value: any): value is string => typeof value === 'string' && value.trim().length > 0)
  return [...new Set(models)].sort()
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
  return { text: response, usage: usageFromTrajectory(trajectory, plannerStep, prompt, response) }
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
    if (result) return { cascadeId, ...result }
    const errorMessage = extractWindsurfCascadeError(response)
    if (errorMessage) throw new Error(`Windsurf Cascade error: ${errorMessage}`)
    if (response?.status === IDLE_STATUS) break
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
  const inputTokens =
    numeric(metadata.inputTokens) || numeric(modelUsage?.inputTokens) || estimateTokens(prompt)
  const outputTokens =
    numeric(metadata.outputTokens) || numeric(modelUsage?.outputTokens) || estimateTokens(response)
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: numeric(metadata.cacheReadTokens) || numeric(modelUsage?.cacheReadTokens),
    estimated: !numeric(metadata.outputTokens) && !numeric(modelUsage?.outputTokens)
  }
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
