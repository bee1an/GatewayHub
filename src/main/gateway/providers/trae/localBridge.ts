import { execFile } from 'child_process'
import { access } from 'fs/promises'
import { randomUUID } from 'crypto'
import { promisify } from 'util'
import type { TraeAccountConfig, TraeProviderSettings, UsageStats } from '../../types'
import type { GatewayToolCall } from './streaming'
import { toErrorMessage } from '../../core/utils'
import {
  DEFAULT_TRAE_LOCAL_APP_PATH,
  DEFAULT_TRAE_LOCAL_DEBUG_PORT,
  normalizeTraeModel
} from './constants'
import { anthropicToTraeMessages, openAiToTraeMessages } from './converters'

const execFileAsync = promisify(execFile)
const TRAE_PROJECT_ID = 'GatewayHub'
const TRAE_WORKSPACE = '/Users/bee/j/GatewayHub'

export interface TraeLocalChatOptions {
  settings: TraeProviderSettings
  account: TraeAccountConfig
  token: string
  model: string
  body: any
  format: 'openai' | 'anthropic'
}

export interface TraeLocalChatResult {
  text: string
  usage?: UsageStats
  toolCalls?: GatewayToolCall[]
  actualModel: string
}

interface TraeDebugPage {
  type: string
  title?: string
  url?: string
  webSocketDebuggerUrl?: string
}

export async function runTraeLocalChat(
  options: TraeLocalChatOptions
): Promise<TraeLocalChatResult> {
  const port = Number(options.settings.localDebugPort || DEFAULT_TRAE_LOCAL_DEBUG_PORT)
  await ensureTraeDebugPort(options.settings, port)

  const actualModel = toTraeLocalChatModel(options.model)
  const params = {
    connectSessionId: await findConnectSessionId(),
    projectId: TRAE_PROJECT_ID,
    workspaceFolder: TRAE_WORKSPACE,
    model: actualModel,
    prompt: buildPrompt(options.body, options.format),
    account: {
      email: options.account.email || options.account.label || '',
      token: options.token,
      userId: options.account.userId || '',
      countryCode: options.account.countryCode || 'US'
    }
  }

  const evaluated = await evaluateInTrae(
    port,
    `(${injectedTraeChat.toString()})(${JSON.stringify(params)})`,
    {
      timeoutMs: Math.max(90_000, (options.settings.streamingReadTimeoutSeconds || 120) * 1000)
    }
  )

  if (!evaluated || typeof evaluated !== 'object') {
    throw new Error('Trae local bridge returned an empty result')
  }
  if (evaluated.error) {
    throw new Error(`Trae local bridge failed: ${evaluated.error}`)
  }

  const text = extractTraeLocalChatText(evaluated.events || [])
  if (!text.trim()) {
    const lastError = (evaluated.events || [])
      .map((event: any) => event?.message)
      .filter(Boolean)
      .at(-1)
    throw new Error(`Trae local bridge produced no text${lastError ? `: ${lastError}` : ''}`)
  }

  return {
    text: text.trim(),
    usage: extractTraeLocalUsage(evaluated.events || []),
    actualModel
  }
}

export function toTraeLocalChatModel(model: string): string {
  const normalized = normalizeTraeModel(model)
  // The official local Agent path resolves chat through chat_v3/builder_v3. On the
  // current international build, plain gemini_2.5_flash exists in get_detail_param
  // for legacy chat but not in chat_v3, while the IDE maps the usable free path to
  // gemini_2.5_flash_premium and charges 0.000 in token_usage for this account.
  if (normalized === 'gemini_2.5_flash') return 'gemini_2.5_flash_premium'
  return normalized
}

export function extractTraeLocalChatText(events: any[]): string {
  let fallback = ''
  for (const event of events) {
    const payload = event?.payload
    if (!payload || typeof payload !== 'object') continue

    if (event.event === 'text_message') {
      const text = pickString(payload, ['text', 'content', 'response', 'delta'])
      if (text) fallback += text
    }

    if (event.event === 'plan_item') {
      const tool = payload.tool_call_info
      const summary =
        tool?.name === 'finish'
          ? pickString(tool.params, ['summary', 'response', 'content']) ||
            pickString(tool.result?.data, ['summary', 'response', 'content'])
          : ''
      if (summary) return summary
      if (typeof payload.thought === 'string' && payload.thought.trim()) {
        fallback = payload.thought
      }
    }
  }
  return fallback
}

function extractTraeLocalUsage(events: any[]): UsageStats | undefined {
  const tokenUsage = events
    .map((event) => (event?.event === 'token_usage' ? event.payload : undefined))
    .filter(Boolean)
    .at(-1)
  if (!tokenUsage) return undefined
  return {
    inputTokens: Number(tokenUsage.prompt_tokens ?? tokenUsage.input_tokens ?? 0) || 0,
    outputTokens: Number(tokenUsage.completion_tokens ?? tokenUsage.output_tokens ?? 0) || 0,
    cacheReadTokens: Number(tokenUsage.cache_read_input_tokens ?? 0) || undefined,
    cacheWrite5mTokens: Number(tokenUsage.cache_creation_input_tokens ?? 0) || undefined,
    estimated: false
  }
}

function pickString(value: any, keys: string[]): string {
  if (!value || typeof value !== 'object') return ''
  for (const key of keys) {
    const item = value[key]
    if (typeof item === 'string' && item.trim()) return item
  }
  return ''
}

function buildPrompt(body: any, format: 'openai' | 'anthropic'): string {
  const messages = format === 'openai' ? openAiToTraeMessages(body) : anthropicToTraeMessages(body)
  const userMessages = messages.filter((message) => message.role === 'user')
  if (messages.length === 1 && userMessages.length === 1) return userMessages[0].content
  return messages
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .filter(Boolean)
    .join('\n\n')
}

async function ensureTraeDebugPort(settings: TraeProviderSettings, port: number): Promise<void> {
  if (await canReadDebugPort(port)) return

  const appPath = settings.localAppPath || DEFAULT_TRAE_LOCAL_APP_PATH
  await access(appPath).catch(() => {
    throw new Error(`Trae app not found at ${appPath}; set providers.trae.settings.localAppPath`)
  })

  await execFileAsync('open', [
    '-na',
    appPath,
    '--args',
    `--remote-debugging-port=${port}`,
    TRAE_WORKSPACE
  ]).catch((error) => {
    throw new Error(`Failed to launch Trae with remote debugging: ${toErrorMessage(error)}`)
  })

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await canReadDebugPort(port)) return
    await sleep(500)
  }
  throw new Error(`Trae remote debugging port ${port} is not reachable`)
}

async function canReadDebugPort(port: number): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(`http://127.0.0.1:${port}/json/version`, 1000)
    return response.ok
  } catch {
    return false
  }
}

async function evaluateInTrae(
  port: number,
  expression: string,
  options?: { timeoutMs?: number }
): Promise<any> {
  const targets = (await fetchJson(`http://127.0.0.1:${port}/json/list`, 2000)) as TraeDebugPage[]
  const page = targets.find(
    (target) =>
      target.type === 'page' &&
      target.webSocketDebuggerUrl &&
      (target.url?.includes('/workbench.html') || target.title)
  )
  if (!page?.webSocketDebuggerUrl) {
    throw new Error(`No debuggable Trae workbench page found on port ${port}`)
  }

  const WebSocketCtor = (globalThis as any).WebSocket
  if (!WebSocketCtor) throw new Error('Global WebSocket is not available in this Node runtime')

  const ws: any = new WebSocketCtor(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map<number, (value: any) => void>()
  ws.onmessage = (event: any) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    }
  }
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = (event: any) => reject(new Error(`CDP websocket error: ${toErrorMessage(event)}`))
  })

  try {
    const call = (method: string, params: any) =>
      new Promise<any>((resolve) => {
        const requestId = ++id
        pending.set(requestId, resolve)
        ws.send(JSON.stringify({ id: requestId, method, params }))
      })
    const response = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      timeout: options?.timeoutMs ?? 120_000
    })
    if (response?.result?.exceptionDetails) {
      throw new Error(JSON.stringify(response.result.exceptionDetails))
    }
    return response?.result?.result?.value
  } finally {
    await closeWebSocket(ws)
  }
}

async function closeWebSocket(ws: any): Promise<void> {
  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    const timer = setTimeout(finish, 1000)
    ws.onclose = () => {
      clearTimeout(timer)
      finish()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      finish()
    }
    try {
      ws.onmessage = undefined
      ws.close()
    } catch {
      clearTimeout(timer)
      finish()
    }
  })
}

async function fetchJson(url: string, timeoutMs: number): Promise<any> {
  const response = await fetchWithTimeout(url, timeoutMs)
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
  return response.json()
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function findConnectSessionId(): Promise<string> {
  // The renderer will accept any current ai-agent connect_session_id, but using a
  // stable UUID keeps ai-agent command callbacks routed to this bridge connection.
  return randomUUID()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function injectedTraeChat(params: any): Promise<any> {
  const makeUuid = () =>
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
      const rand = (Math.random() * 16) | 0
      return (char === 'x' ? rand : (rand & 3) | 8).toString(16)
    })
  const makeObjectId = () =>
    Array.from({ length: 24 }, () => Math.floor(Math.random() * 16).toString(16)).join('')

  const commandResult = (commandId: string, args: any[] | null) => {
    if (commandId === 'icube.event.getABTestConfigByKey') {
      try {
        const parsed = JSON.parse(args?.[0] || '{}')
        return parsed.defaultValue ?? null
      } catch {
        return null
      }
    }
    if (commandId === 'icube.common.commands.tooling.getSandboxCliPath') return ''
    if (commandId === 'icube.common.commands.getAppPrivacyMode') return false
    if (commandId === 'icube.ai.agent.sql.log.enable') return false
    if (commandId === 'icube.cloudide.aiSessionID') return params.connectSessionId
    return null
  }

  const makeEnvelope = (service: string, method: string, data: any, chatSessionId = '') => ({
    service,
    method,
    data,
    user_info: {
      name: params.account.email || '',
      token: params.account.token || '',
      region: params.account.countryCode || 'US',
      is_internal: false,
      user_id: params.account.userId || '',
      scope: ''
    },
    common_params: { agent_type: data?.agent_type || '', shell_execute_strategy: '' },
    streamlined_common_params: { agent_type: data?.agent_type || '', shell_execute_strategy: '' },
    client_info: {
      connect_session_id: params.connectSessionId,
      project_id: params.projectId,
      chat_session_id: chatSessionId,
      version_code: 20260509,
      workspace_folder: params.workspaceFolder,
      icube_language: 'zh-CN',
      device_id: '0',
      workspace_id: params.projectId,
      workspace_folders: [params.workspaceFolder],
      user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      agent_task_service_strategy: 'cloud_agent',
      enable_llm_utils_cloud: false,
      is_evaluation: false,
      is_worktree: false,
      is_workspace_folder_changed: false,
      enable_browser_tools: false,
      authorized_services: ''
    }
  })

  return new Promise((resolve) => {
    const result: any = { events: [], commands: [], error: '', streamId: '' }
    const vscode = (globalThis as any).vscode
    if (!vscode?.ahaIpc?.connect) {
      resolve({ error: 'window.vscode.ahaIpc is not available' })
      return
    }

    let client: any
    const pending: Record<string, (value: any) => void> = {}
    let nextId = 1
    const sendRequest = (method: string, packet: any, timeoutMs: number) =>
      new Promise<any>((requestResolve, requestReject) => {
        const id = String(nextId++)
        pending[id] = requestResolve
        client.send(JSON.stringify({ jsonrpc: '2.0', method, params: [packet], id }))
        setTimeout(() => {
          if (pending[id]) {
            delete pending[id]
            requestReject(new Error(`${method} timeout`))
          }
        }, timeoutMs)
      })

    const onMessage = (rawInput: any) => {
      try {
        const raw = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput)
        const message = JSON.parse(raw)
        if (message.method === 'execute_command') {
          const packet = Array.isArray(message.params) ? message.params[0] : message.params
          const command = packet?.params || {}
          result.commands.push(command.command_id)
          client.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                results: commandResult(command.command_id, command.args),
                base_resp: { status_message: 'ok', status_code: 0, extra: null }
              }
            })
          )
          return
        }
        if (message.id && pending[message.id]) {
          pending[message.id](message)
          delete pending[message.id]
          return
        }
        if (result.streamId && message.method === `rpc.stream.${result.streamId}`) {
          const inner = message.params?.data?.params
          const event = inner?.data?.event
          const payload = inner?.data?.payload
          result.events.push({ event, payload, code: inner?.code, message: inner?.message })
        }
      } catch (error: any) {
        result.error = error?.message || String(error)
      }
    }

    void (async () => {
      try {
        client = await vscode.ahaIpc.connect('ai-agent')
        client.on('message', onMessage)
        client.on('disconnect', () => {
          if (!result.error) result.error = 'ai-agent disconnected'
        })

        const createPacket = {
          packet_type: 'request',
          channel_id: makeUuid(),
          session_id: params.connectSessionId,
          params: makeEnvelope('chat', 'create_session', {
            project_id: params.projectId,
            session_type: 'side_chat'
          })
        }
        const created = await sendRequest('request', createPacket, 10_000)
        const chatSessionId =
          created?.result?.params?.data?.session?.session_id ||
          created?.result?.params?.data?.session_id ||
          makeObjectId()

        const messageId = makeObjectId()
        const modelInfo = {
          provider: '',
          config_name: params.model,
          display_model_name: params.model,
          multimodal: true,
          ak: '',
          use_remote_service: true,
          is_preset: true,
          config_source: 1,
          base_url: '',
          context_window_size: 1000000,
          region: params.account.countryCode || 'US',
          sk: '',
          auth_type: 0,
          max_tokens: 8192,
          max_turn: 35,
          prompt_max_tokens: 30000
        }
        const chatData = {
          agent_type: 'chat',
          session_id: chatSessionId,
          message_id: messageId,
          mention_context: {
            only_mention: false,
            hash_workspace: false,
            hash_folder: false,
            hash_files: [],
            hash_terminals: [],
            hash_symbols: [],
            hash_folders: [],
            hash_webs: [],
            hash_docs: [],
            hash_web_elements: [],
            hash_logs: [],
            hash_figma: [],
            hash_lint_error_flag: false,
            hash_rule_files: [],
            auto_rule_count: 0,
            agents_md_count: 0,
            claude_md_count: 0,
            hash_problem_items: [],
            hash_problem_files: []
          },
          model_name: params.model,
          custom_model: modelInfo,
          terminal_context: [],
          message_content: [{ type: 'text', text_content: params.prompt }],
          code_selections: [],
          scene_location: 2,
          parsed_query: [],
          multi_media: [],
          workspace_folders: [params.workspaceFolder],
          active_text_editor: null,
          is_workspace_folder_changed: false,
          asr_times: 0,
          is_in_plan_mode: false,
          is_in_spec_mode: false,
          ask_question_config: { feature_available: true, ide_enable: false, solo_enable: false },
          project_id: params.projectId
        }
        const chatPacket = {
          packet_type: 'request',
          channel_id: makeUuid(),
          session_id: params.connectSessionId,
          params: makeEnvelope('chat', 'chat', chatData, chatSessionId)
        }
        const streamResponse = await sendRequest('request_stream', chatPacket, 10_000)
        result.streamId = streamResponse?.result?.streamId || ''
        const deadline = Date.now() + 90_000
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200))
          if (result.events.some((item: any) => item.event === 'done')) break
          if (result.events.some((item: any) => item.code && item.code !== 0)) break
        }
        resolve(result)
      } catch (error: any) {
        resolve({ ...result, error: error?.message || String(error) })
      } finally {
        try {
          client?.off('message', onMessage)
        } catch {
          /* ignore */
        }
        try {
          client?.disconnect()
        } catch {
          /* ignore */
        }
      }
    })()
  })
}
