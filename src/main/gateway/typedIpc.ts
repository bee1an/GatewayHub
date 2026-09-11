import { registerIpcMain, tipc } from '@egoist/tipc/main'
import { notifyDaemonReload } from '../../cli/daemon/controller'
import { gatewayHubService } from './service'
import { getGatewayStatusForUi } from './ipc'
import { portSchema } from './ipcSchemas'

const t = tipc.create()

export const typedGatewayRouter = t.router({
  typedGateway: {
    status: t.procedure.action(async () => getGatewayStatusForUi()),
    getPricing: t.procedure.action(async () => gatewayHubService.getPricing()),
    setPort: t.procedure.input<unknown>().action(async ({ input }) => {
      const result = await gatewayHubService.setPort(portSchema.parse(input))
      await notifyDaemonReload().catch(() => false)
      return result
    })
  }
})

export function registerTypedGatewayIpc(): void {
  registerIpcMain(typedGatewayRouter)
}
