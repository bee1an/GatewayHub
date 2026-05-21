export type CliLoginOutputEvent =
  | { type: 'stdout' | 'stderr'; text: string }
  | { type: 'exit'; code: number | null; imported?: boolean; error?: string }
  | { type: 'error'; message: string }

export interface CliLoginEventSink {
  emit(event: CliLoginOutputEvent): void
}

const noopSink: CliLoginEventSink = { emit: () => {} }

let current: CliLoginEventSink = noopSink

export function setCliLoginSink(sink: CliLoginEventSink): void {
  current = sink ?? noopSink
}

export function clearCliLoginSink(): void {
  current = noopSink
}

export function emitCliLoginEvent(event: CliLoginOutputEvent): void {
  try {
    current.emit(event)
  } catch (err) {
    console.warn('[GatewayHub] cliLoginSink emit failed', err)
  }
}
