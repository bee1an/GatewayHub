import { randomBytes } from 'crypto'
import type { TraeProviderSettings } from '../../types'

export const TRAE_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8'
export const TRAE_VERSION_CODE = '20260509'

export function buildTraeIdeHeaders(
  token: string,
  settings: Pick<TraeProviderSettings, 'ideVersion'>
): Record<string, string> {
  return {
    authorization: `Cloud-IDE-JWT ${token}`,
    'x-cloudide-token': token,
    'x-app-id': TRAE_APP_ID,
    'x-app-version': 'default',
    'x-ide-version': settings.ideVersion || '3.5.60',
    'x-ide-version-code': TRAE_VERSION_CODE,
    'x-app-version-code': TRAE_VERSION_CODE,
    'x-device-type': inferTraeDeviceType(),
    'request-traffic-type': 'prod',
    'x-custom-trace-id': randomHex(16),
    'x-flow-traceparent': `00-${randomHex(16)}-${randomHex(8)}-01`
  }
}

function inferTraeDeviceType(): string {
  if (process.platform === 'darwin') return 'mac'
  if (process.platform === 'win32') return 'windows'
  return 'linux'
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}
