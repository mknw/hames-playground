/**
 * Preview-header formatting — the countdown arithmetic and the compact number
 * rendering.
 *
 * These are the two things in the strip that are easy to get quietly wrong: a
 * countdown that goes negative or drifts in a backgrounded tab, and a number
 * whose width changes as it grows (which shoves the controls beside it
 * sideways once a second). Both are pure, so both are pinned here rather than
 * through a rendered component.
 */
import { describe, it, expect } from 'vitest'
import {
  TIER_LABELS,
  formatCompactNumber,
  formatCountdown,
  formatShare,
  remainingSeconds,
} from '../../lib/preview-header-format'

describe('formatCountdown', () => {
  it('is always m:ss, so the field never changes width', () => {
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(9)).toBe('0:09')
    expect(formatCountdown(59)).toBe('0:59')
    expect(formatCountdown(60)).toBe('1:00')
    expect(formatCountdown(180)).toBe('3:00')
    expect(formatCountdown(3599)).toBe('59:59')
  })

  it('clamps a negative remainder to zero rather than rendering "-0:-1"', () => {
    expect(formatCountdown(-1)).toBe('0:00')
    expect(formatCountdown(-999)).toBe('0:00')
  })

  it('caps a nonsense delay so the field cannot widen past 5 characters', () => {
    // A real production delay is minutes; the cap only guards a bad env value.
    expect(formatCountdown(10_000_000)).toBe('99:59')
    expect(formatCountdown(10_000_000)).toHaveLength(5)
  })

  it('truncates rather than rounds, so it never shows a second that has passed', () => {
    expect(formatCountdown(59.9)).toBe('0:59')
  })
})

describe('remainingSeconds — ticking between polls', () => {
  const AT = 1_000_000

  it('subtracts elapsed wall-clock from the value the server computed', () => {
    expect(remainingSeconds(180, AT, AT)).toBe(180)
    expect(remainingSeconds(180, AT, AT + 30_000)).toBe(150)
  })

  it('resumes on the right number after a throttled tab skipped its ticks', () => {
    // The failure this prevents: counting local intervals instead of clock
    // time, so a backgrounded tab comes back showing far too much left.
    expect(remainingSeconds(180, AT, AT + 170_000)).toBe(10)
  })

  it('floors at zero instead of counting into the negative', () => {
    expect(remainingSeconds(180, AT, AT + 181_000)).toBe(0)
    expect(remainingSeconds(180, AT, AT + 10_000_000)).toBe(0)
  })

  it('passes null through — there is nothing to count down when cold', () => {
    expect(remainingSeconds(null, AT, AT + 5_000)).toBeNull()
  })

  it('ignores a clock that went backwards rather than inventing time', () => {
    expect(remainingSeconds(180, AT, AT - 60_000)).toBe(180)
  })
})

describe('formatCompactNumber', () => {
  it('renders small counts exactly', () => {
    expect(formatCompactNumber(0)).toBe('0')
    expect(formatCompactNumber(7)).toBe('7')
    expect(formatCompactNumber(999)).toBe('999')
  })

  it('compacts at each scale', () => {
    expect(formatCompactNumber(1_000)).toBe('1k')
    expect(formatCompactNumber(1_250)).toBe('1.2k')
    expect(formatCompactNumber(999_999)).toBe('999.9k')
    expect(formatCompactNumber(2_500_000)).toBe('2.5M')
    expect(formatCompactNumber(1_200_000_000)).toBe('1.2B')
  })

  it('rounds DOWN, so a counter never reads higher than what was spent', () => {
    expect(formatCompactNumber(1_299)).toBe('1.2k')
    expect(formatCompactNumber(1_999)).toBe('1.9k')
  })

  it('refuses to render a value it cannot mean', () => {
    expect(formatCompactNumber(-1)).toBe('—')
    expect(formatCompactNumber(Number.NaN)).toBe('—')
    expect(formatCompactNumber(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('formatShare', () => {
  it('renders a share as a whole percentage', () => {
    expect(formatShare(0)).toBe('0%')
    expect(formatShare(0.5)).toBe('50%')
    expect(formatShare(1)).toBe('100%')
    expect(formatShare(0.333)).toBe('33%')
  })

  it('distinguishes "nothing yet" from "none of it" — null is not 0%', () => {
    // The whole reason the server sends null: 0% would read as a measurement
    // that the self-hosted box handled none of today's calls.
    expect(formatShare(null)).toBe('—')
  })

  it('clamps out-of-range input rather than rendering 140%', () => {
    expect(formatShare(1.4)).toBe('100%')
    expect(formatShare(-0.2)).toBe('0%')
  })
})

describe('TIER_LABELS', () => {
  it('names both positions in words a preview user can act on', () => {
    // The switch has to be self-explanatory without documentation, which means
    // the label leads with the property, not the vendor.
    expect(TIER_LABELS.verda).toBe('Private (Verda)')
    expect(TIER_LABELS.anthropic).toBe('Anthropic')
  })
})
