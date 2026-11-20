/**
 * Cold-start notice wording — the countdown arithmetic and the two honesty
 * rules it exists to keep.
 *
 * What is pinned:
 *
 * - **Coarse, and rounded the safe way.** Under a minute the figure rounds UP
 *   to ten seconds: understating a wait is the dishonest direction for a number
 *   somebody is deciding whether to keep waiting on. Minutes round to nearest,
 *   because ceiling them turns the measured 146 s into "~3 min".
 * - **Past the estimate it stops counting and says so**, rather than sitting at
 *   zero or going negative. That case is expected — a burst of chats queues on
 *   one replica — not exceptional.
 * - **The spoken phrase does not carry the countdown.** An `aria-live` region
 *   that changed every second would interrupt a listener once a second for two
 *   minutes; the announcement is derived from the estimate, which is fixed for
 *   the life of the notice.
 * - **A fallback figure never reads as a local measurement.** That is the whole
 *   reason `basis` rides the wire.
 */
import { describe, it, expect } from 'vitest'
import {
  boxBootText,
  boxNotStartingText,
  boxWaitAnnouncement,
  boxWaitLine,
  boxWaitingText,
  formatFullBootRange,
  COLD_START_HEADLINE,
  coldStartAnnouncement,
  coldStartBasisHint,
  coldStartDetail,
  COLD_START_FULL_BOOT_MS,
  formatColdStartEstimate,
} from '~/lib/cold-start-format'

describe('formatColdStartEstimate', () => {
  it('renders the measured cold start as the owner’s "~2 min"', () => {
    expect(formatColdStartEstimate(146_000)).toBe('2 min')
  })

  it('rounds seconds UP, never down — understating a wait is the dishonest direction', () => {
    expect(formatColdStartEstimate(41_000)).toBe('50 sec')
    expect(formatColdStartEstimate(30_000)).toBe('30 sec')
  })

  it('rounds minutes to nearest, so 146s is not padded to three', () => {
    expect(formatColdStartEstimate(60_000)).toBe('1 min')
    expect(formatColdStartEstimate(89_000)).toBe('1 min')
    expect(formatColdStartEstimate(90_000)).toBe('2 min')
  })

  it('says nothing rather than a figure that would be noise', () => {
    expect(formatColdStartEstimate(0)).toBeNull()
    expect(formatColdStartEstimate(-1000)).toBeNull()
    expect(formatColdStartEstimate(999)).toBeNull()
    expect(formatColdStartEstimate(Number.NaN)).toBeNull()
  })

  it('omits the tilde, which the visible label adds and a screen reader cannot say', () => {
    expect(formatColdStartEstimate(146_000)).not.toContain('~')
  })
})

describe('coldStartDetail', () => {
  it('counts down from the estimate as the wait elapses', () => {
    expect(coldStartDetail(146_000, 0)).toBe('warming up… (estimated time to first token: ~2 min)')
    expect(coldStartDetail(146_000, 100_000)).toBe(
      'warming up… (estimated time to first token: ~50 sec)',
    )
  })

  it('stops counting past the estimate instead of hitting zero or going negative', () => {
    const overrun = coldStartDetail(146_000, 200_000)
    expect(overrun).toBe(
      'warming up… (longer than the usual ~2 min: a start that builds a new GPU snapshot ' +
        'has taken up to ~16 min, more if no GPU is free)',
    )
    expect(overrun).not.toContain('0 sec')
    expect(overrun).not.toContain('-')
  })

  it('states the full-boot case only once the restore estimate has run out', () => {
    // The countdown estimates a snapshot restore; a full boot is the other mode,
    // and the longest one measured (938s) is what the overrun states.
    expect(COLD_START_FULL_BOOT_MS).toBe(938_000)
    expect(coldStartDetail(157_000, 156_000)).not.toContain('snapshot')
    expect(coldStartDetail(157_000, 158_000)).toContain('up to ~16 min')
  })

  it('still says what is happening when there is no figure worth stating', () => {
    expect(coldStartDetail(0, 0)).toBe('warming up…')
  })

  it('keeps the headline free of any number, so it can never read as a promise', () => {
    expect(COLD_START_HEADLINE).toBe('starting GPU')
    expect(COLD_START_HEADLINE).not.toMatch(/\d/)
  })
})

describe('coldStartAnnouncement', () => {
  it('is a complete phrase with the estimate spoken as a word', () => {
    expect(coldStartAnnouncement(146_000)).toBe(
      'Waiting for the self-hosted model to start. Estimated time to first token: about 2 min.',
    )
  })

  it('does not depend on elapsed time — it is announced once and must not change', () => {
    expect(coldStartAnnouncement(146_000)).toBe(coldStartAnnouncement(146_000))
  })

  it('drops the estimate rather than announcing a figure it does not have', () => {
    expect(coldStartAnnouncement(0)).toBe('Waiting for the self-hosted model to start.')
  })
})

describe('coldStartBasisHint', () => {
  it('names the sample count when the figure was measured here', () => {
    expect(coldStartBasisHint('measured', 3)).toContain('3 most recent cold starts')
    expect(coldStartBasisHint('measured', 1)).toContain('1 most recent cold start')
  })

  it('never presents the fallback as something this server measured', () => {
    const hint = coldStartBasisHint('default', 0)
    expect(hint).toContain('has not measured a cold start')
    // ...and says what the fallback IS: a restore figure, with the slower mode named.
    expect(hint).toContain('snapshot restore')
    expect(hint).toContain('build a new one')
    expect(hint).not.toMatch(/median/i)
  })
})

// ============================================================================
// #1057: what Modal says about a box, in words
// ============================================================================
describe('the control-plane wait lines', () => {
  it('states each box’s measured full-boot range in whole minutes', () => {
    expect(formatFullBootRange('large')).toBe('8–16 min') // 505–938 s
    expect(formatFullBootRange('small')).toBe('5–9 min') // 305–552 s
  })

  it('reads a container inside the restore estimate as a restore, past it as a full boot', () => {
    expect(boxBootText('large', 40_000, 157_000)).toBe(
      'booting, likely a snapshot restore — 40 sec of ~3 min (a full boot takes ~8–16 min)',
    )
    expect(boxBootText('large', 6 * 60_000, 157_000)).toBe(
      'booting, a full boot — 6 min of ~8–16 min (a snapshot restore takes ~3 min)',
    )
  })

  it('has no elapsed figure while Modal still lists the container as Pending', () => {
    expect(boxBootText('small', null, 32_000)).toBe(
      'queued by Modal — a snapshot restore takes ~40 sec, a full boot ~5–9 min',
    )
  })

  it('names a boot with no container yet, and one Modal is not starting', () => {
    expect(boxWaitingText(90_000)).toBe('waiting for Modal to start a container — 2 min so far')
    expect(boxNotStartingText(7 * 60_000)).toBe(
      'NOT STARTING — Modal has created no container after 7 min',
    )
  })

  it('offers the user what they can do on a box that is not starting, in the chat', () => {
    const line = boxWaitLine({
      box: 'large',
      phase: 'not-starting',
      elapsedMs: 7 * 60_000,
      restoreEstimateMs: 157_000,
    })
    expect(line).toBe(
      'the 27B: NOT STARTING — Modal has created no container after 7 min. You can stop this turn, wait, or send it again.',
    )
  })

  it('announces a phase, never a counting figure', () => {
    for (const phase of ['waiting', 'booting', 'not-starting'] as const) {
      const said = boxWaitAnnouncement({
        box: 'small',
        phase,
        elapsedMs: 123_456,
        restoreEstimateMs: 32_000,
      })
      expect(said).toContain('the 4B')
      expect(said).not.toMatch(/\d+ (sec|min)/)
    }
  })
})
