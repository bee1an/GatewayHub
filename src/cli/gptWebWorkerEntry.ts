import { runGptWebWorkerCli } from './commands/gptWebWorker'
import { toErrorMessage } from '../main/gateway/core/utils'

runGptWebWorkerCli().catch((error) => {
  process.stdout.write(
    `${JSON.stringify({ type: 'error', message: toErrorMessage(error).slice(0, 1200) })}\n`
  )
  process.exitCode = 1
})
