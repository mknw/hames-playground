/**
 * The routine trigger registry (#131): parse/serialize round-trips, the
 * interval floor, and the schedule-vs-event split that keeps the tick
 * kind-agnostic.
 */

import { describe, it, expect } from 'vitest'
import {
  MIN_INTERVAL_SECONDS,
  RoutineTriggerError,
  TRIGGER_KINDS,
  TRIGGER_SPECS,
  getTriggerSpec,
  isScheduled,
  isTriggerKind,
  nextDueAt,
  parseTrigger,
  serializeTrigger,
  type RoutineTrigger,
} from '../../../lib/routines/triggers'

describe('registry shape', () => {
  it('registers exactly the three kinds the issue asks for', () => {
    expect(TRIGGER_KINDS).toEqual(['interval', 'session_start', 'session_end'])
  })

  it('keys every spec by its own kind (no copy-paste drift)', () => {
    for (const kind of TRIGGER_KINDS) {
      expect(TRIGGER_SPECS[kind].kind).toBe(kind)
      expect(TRIGGER_SPECS[kind].label).toBeTruthy()
    }
  })

  it('classifies kinds by how they fire', () => {
    expect(TRIGGER_SPECS.interval.fires).toBe('schedule')
    expect(TRIGGER_SPECS.session_start.fires).toBe('event')
    expect(TRIGGER_SPECS.session_end.fires).toBe('event')
  })

  it('rejects an unregistered kind', () => {
    expect(isTriggerKind('webhook')).toBe(false)
    expect(() => getTriggerSpec('webhook')).toThrow(RoutineTriggerError)
    expect(() => parseTrigger('webhook', {})).toThrow(/Unknown routine trigger kind/)
  })
})

describe('parse / serialize', () => {
  it('round-trips an interval trigger through its persisted config', () => {
    const trigger = parseTrigger('interval', { intervalSeconds: 900 })
    expect(trigger).toEqual({ kind: 'interval', intervalSeconds: 900 })
    expect(serializeTrigger(trigger)).toEqual({ intervalSeconds: 900 })
    expect(parseTrigger('interval', serializeTrigger(trigger))).toEqual(trigger)
  })

  it('accepts a numeric string (JSON bodies and form fields are stringy)', () => {
    expect(parseTrigger('interval', { intervalSeconds: '300' })).toEqual({
      kind: 'interval',
      intervalSeconds: 300,
    })
  })

  it('floors fractional seconds', () => {
    expect(parseTrigger('interval', { intervalSeconds: 90.7 })).toEqual({
      kind: 'interval',
      intervalSeconds: 90,
    })
  })

  it('rejects an interval below the floor', () => {
    expect(() => parseTrigger('interval', { intervalSeconds: MIN_INTERVAL_SECONDS - 1 })).toThrow(
      new RegExp(`at least ${MIN_INTERVAL_SECONDS}`),
    )
    expect(() => parseTrigger('interval', { intervalSeconds: 0 })).toThrow(RoutineTriggerError)
    expect(() => parseTrigger('interval', { intervalSeconds: -60 })).toThrow(RoutineTriggerError)
  })

  it('rejects a missing or non-numeric interval', () => {
    expect(() => parseTrigger('interval', {})).toThrow(/numeric intervalSeconds/)
    expect(() => parseTrigger('interval', { intervalSeconds: 'soon' })).toThrow(RoutineTriggerError)
    expect(() => parseTrigger('interval', { intervalSeconds: Infinity })).toThrow(
      RoutineTriggerError,
    )
  })

  it('rejects a non-object config', () => {
    expect(() => parseTrigger('interval', 'nope')).toThrow(/must be an object/)
    expect(() => parseTrigger('interval', [1, 2])).toThrow(/must be an object/)
  })

  it('parses the event kinds with no config at all', () => {
    expect(parseTrigger('session_start', undefined)).toEqual({ kind: 'session_start' })
    expect(parseTrigger('session_end', null)).toEqual({ kind: 'session_end' })
    // Extra config on an event kind is ignored, not an error — forward-compatible.
    expect(parseTrigger('session_end', { stray: 1 })).toEqual({ kind: 'session_end' })
    expect(serializeTrigger({ kind: 'session_start' })).toEqual({})
  })
})

describe('nextDueAt', () => {
  const HOUR = 3600

  it('adds the interval to the reference timestamp', () => {
    const trigger: RoutineTrigger = { kind: 'interval', intervalSeconds: HOUR }
    expect(nextDueAt(trigger, 1_000_000)).toBe(1_000_000 + HOUR * 1000)
  })

  it('returns null for event-driven kinds so the scheduler skips them', () => {
    expect(nextDueAt({ kind: 'session_start' }, 0)).toBeNull()
    expect(nextDueAt({ kind: 'session_end' }, 0)).toBeNull()
    expect(isScheduled({ kind: 'session_start' })).toBe(false)
    expect(isScheduled({ kind: 'interval', intervalSeconds: HOUR })).toBe(true)
  })
})
