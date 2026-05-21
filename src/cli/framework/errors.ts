export const ExitCode = {
  Success: 0,
  GeneralError: 1,
  UsageError: 2,
  DaemonUnreachable: 3,
  LockBusy: 4,
  UserCancelled: 5
} as const

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode]

export class CliError extends Error {
  readonly code: ExitCodeValue
  readonly errorCode: string

  constructor(
    message: string,
    options?: { code?: ExitCodeValue; errorCode?: string; cause?: unknown }
  ) {
    super(message)
    this.name = 'CliError'
    this.code = options?.code ?? ExitCode.GeneralError
    this.errorCode = options?.errorCode ?? 'CLI_ERROR'
    if (options?.cause instanceof Error) this.stack += `\nCaused by: ${options.cause.stack}`
  }
}

export function isCliError(err: unknown): err is CliError {
  return err instanceof CliError
}
