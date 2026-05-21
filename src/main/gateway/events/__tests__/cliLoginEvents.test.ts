import { describe, it, expect, beforeEach } from 'vitest'
import {
  emitCliLoginEvent,
  setCliLoginSink,
  clearCliLoginSink,
  type CliLoginOutputEvent
} from '../cliLoginEvents'

beforeEach(() => clearCliLoginSink())

describe('cliLoginEvents', () => {
  it('default sink swallows events without throwing', () => {
    expect(() => emitCliLoginEvent({ type: 'stdout', text: 'hello' })).not.toThrow()
  })

  it('routes events to the active sink', () => {
    const events: CliLoginOutputEvent[] = []
    setCliLoginSink({ emit: (e) => events.push(e) })
    emitCliLoginEvent({ type: 'stdout', text: 'a' })
    emitCliLoginEvent({ type: 'exit', code: 0, imported: true })
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ type: 'stdout', text: 'a' })
  })

  it('clearCliLoginSink stops further delivery', () => {
    const events: CliLoginOutputEvent[] = []
    setCliLoginSink({ emit: (e) => events.push(e) })
    emitCliLoginEvent({ type: 'stdout', text: '1' })
    clearCliLoginSink()
    emitCliLoginEvent({ type: 'stdout', text: '2' })
    expect(events).toEqual([{ type: 'stdout', text: '1' }])
  })

  it('catches sink errors so emitters cannot crash', () => {
    setCliLoginSink({
      emit: () => {
        throw new Error('boom')
      }
    })
    expect(() => emitCliLoginEvent({ type: 'stdout', text: 'x' })).not.toThrow()
  })
})
