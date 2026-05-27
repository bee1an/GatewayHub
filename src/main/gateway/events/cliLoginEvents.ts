import { redactString } from '../core/redact'

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

function sanitizeEvent(event: CliLoginOutputEvent): CliLoginOutputEvent {
  switch (event.type) {
    case 'stdout':
    case 'stderr':
      return { type: event.type, text: redactString(event.text) }
    case 'error':
      return { type: 'error', message: redactString(event.message) }
    case 'exit':
      return event.error ? { ...event, error: redactString(event.error) } : event
    default:
      return event
  }
}

export function emitCliLoginEvent(event: CliLoginOutputEvent): void {
  try {
    current.emit(sanitizeEvent(event))
  } catch (err) {
    console.warn('[GatewayHub] cliLoginSink emit failed', err)
  }
}
