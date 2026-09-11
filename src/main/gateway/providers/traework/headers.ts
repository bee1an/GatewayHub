import { randomBytes, randomUUID } from 'crypto'
import type { TraeWorkAccountConfig, TraeWorkProviderSettings } from '../../types'
import {
  DEFAULT_TRAEWORK_APP_ID,
  DEFAULT_TRAEWORK_IDE_VERSION,
  DEFAULT_TRAEWORK_PACKAGE_TYPE,
  DEFAULT_TRAEWORK_VERSION_CODE
} from './constants'

/**
 * Header set observed in official TraeWork (TRAE SOLO CN) traffic to
 * api5-normal.mchost.guru. The llm_utils_chat endpoint accepts plain JSON and
 * does not require x-request-pin (that pair belongs to the encrypted
 * create_agent_task path).
 */
export function buildTraeWorkHeaders(
  token: string,
  settings: TraeWorkProviderSettings,
  account?: TraeWorkAccountConfig
): Record<string, string> {
  const versionCode = settings.versionCode || DEFAULT_TRAEWORK_VERSION_CODE
  const requestId = randomUUID()
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream, application/json',
    authorization: `Cloud-IDE-JWT ${token}`,
    'x-cloudide-token': token,
    'x-ide-token': token,
    'x-app-id': settings.appId || DEFAULT_TRAEWORK_APP_ID,
    'app-version': settings.ideVersion || DEFAULT_TRAEWORK_IDE_VERSION,
    'x-app-version': 'default',
    'x-app-version-code': versionCode,
    'x-ide-version': settings.ideVersion || DEFAULT_TRAEWORK_IDE_VERSION,
    'x-ide-version-code': versionCode,
    'x-ide-version-type': 'stable',
    'package-type': settings.packageType || DEFAULT_TRAEWORK_PACKAGE_TYPE,
    'x-device-type': inferDeviceType(),
    'x-device-brand': account?.deviceBrand || inferDeviceBrand(),
    'x-device-cpu': process.platform === 'darwin' ? 'Apple' : 'Intel',
    'x-device-id': account?.deviceId || account?.devDeviceId || '',
    'x-machine-id': account?.machineId || '',
    'x-os-version': account?.osVersion || inferOsVersion(),
    'x-uid': account?.userId || '',
    'request-traffic-type': 'prod',
    'X-Trae-Client-Type': 'lite',
    'x-custom-trace-id': randomBytes(16).toString('hex'),
    'x-request-id': requestId,
    'x-trae-request-id': requestId,
    'x-flow-traceparent': `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`,
    'user-agent': 'TraeClient/TTNet'
  }
}

function inferDeviceType(): string {
  if (process.platform === 'darwin') return 'mac'
  if (process.platform === 'win32') return 'windows'
  return 'linux'
}

function inferDeviceBrand(): string {
  return process.platform === 'darwin' ? 'Mac' : process.platform
}

function inferOsVersion(): string {
  return `${process.platform} ${process.arch}`
}
