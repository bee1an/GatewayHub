import {
  fetchConduitToken,
  fetchModels,
  fetchSentinelTokens,
  streamConversation
} from '../../main/gateway/providers/gptWeb/http'
import type { GptWebAccountConfig, GptWebProviderSettings } from '../../main/gateway/types'
import { toErrorMessage } from '../../main/gateway/core/utils'

type WorkerInput =
  | {
      kind: 'models'
      account: GptWebAccountConfig
      settings: GptWebProviderSettings
    }
  | {
      kind: 'chat-stream'
      account: GptWebAccountConfig
      settings: GptWebProviderSettings
      body: Record<string, unknown>
    }

export async function runGptWebWorkerCli(): Promise<void> {
  process.env.GATEWAYHUB_GPT_WEB_NODE_BRIDGE = '1'
  const input = JSON.parse(await readStdin()) as WorkerInput
  const ctx = { account: input.account, settings: input.settings }

  try {
    if (input.kind === 'models') {
      const models = await fetchModels(ctx)
      process.stdout.write(JSON.stringify({ ok: true, models }))
      return
    }

    if (input.kind === 'chat-stream') {
      const sentinelTokens = await fetchSentinelTokens(ctx)
      const conduitToken = await fetchConduitToken(ctx, input.body, sentinelTokens)
      for await (const line of streamConversation(ctx, input.body, sentinelTokens, conduitToken)) {
        process.stdout.write(`${JSON.stringify({ type: 'line', line })}\n`)
      }
      process.stdout.write(`${JSON.stringify({ type: 'done' })}\n`)
      return
    }

    throw new Error(`Unknown GptWeb worker input kind: ${(input as { kind?: string }).kind}`)
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ type: 'error', message: toErrorMessage(error).slice(0, 1200) })}\n`
    )
    process.exitCode = 1
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}
