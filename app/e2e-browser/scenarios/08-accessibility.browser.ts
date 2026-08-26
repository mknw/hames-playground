/**
 * Scenario 8 — axe-core over the same three surfaces, in both themes.
 *
 * ## Why gated on serious/critical only
 *
 * axe reports four impact levels and the two low ones are dominated, on any real
 * codebase, by findings that need a design decision rather than a fix — a landmark
 * that is arguably a region, a heading level that reads fine to a person. Gating
 * on them buys a red suite and a habit of ignoring it. Gating on
 * `serious`/`critical` buys the two categories that describe something a person
 * using a screen reader or a keyboard genuinely cannot do: an unnamed control,
 * text that does not meet contrast, a form field with no label.
 *
 * `kg-dtalk-ui`'s `A11Y-CHECKLIST.md` is the reference this is scoped against,
 * and reading it alongside this file is the point: the checklist covers 26 rules
 * across WCAG A/AA/AAA and Apple HIG, and axe can decide roughly the third of them
 * that a machine can decide. What is DELIBERATELY NOT GATED is listed in
 * {@link NOT_GATED} — not as an apology, but because a gate whose gaps are
 * unstated reads as a claim it does not make.
 *
 * ## The known-open list is exact, in both directions
 *
 * The checklist already records the debt this app carries: 6 of 60 buttons in
 * `app/src/components` have an `aria-label`, two focus styles exist across the
 * whole component tree, and there is no skip link. So a gate that failed on any
 * serious finding would be red on the day it landed and would tell nobody
 * anything.
 *
 * Instead {@link KNOWN_OPEN} records, per surface and theme, exactly which rule
 * ids fire — and the assertion is an EQUALITY, which is what makes it work in both
 * directions:
 *
 *  - a NEW serious/critical violation fails, which is the regression gate;
 *  - a FIXED one also fails, with a message saying to delete the line, so the
 *    list cannot quietly become a permanent excuse. That is the same shape as the
 *    ReDoS corpus's terminal-run exemption list: the audit trail is a diff, not a
 *    silence.
 *
 * Every entry needs a reason. An entry with no reason is a violation someone
 * decided not to look at.
 */
import AxeBuilder from '@axe-core/playwright'
import { test, expect } from '../lib/fixtures'
import { SURFACES, THEMES } from '../lib/surfaces'

/** The impacts that fail a run. See the header. */
const GATED_IMPACTS = new Set(['serious', 'critical'])

/**
 * What this pass does NOT gate on, stated so the coverage claim is honest.
 *
 *  - **`minor` and `moderate` impacts.** Reported by axe, ignored here. Most need
 *    a design decision, and a gate people ignore is worse than no gate.
 *  - **Everything axe cannot decide**, which is most of `A11Y-CHECKLIST.md`:
 *    whether the tab order follows the VISUAL order, whether a focus ring is
 *    visible enough (`focus-appearance` is WCAG 2.2 AAA and the checklist itself
 *    says note it, do not gate on it), whether a hue carries meaning on its own,
 *    whether a modal has an escape route, pointer target sizes, reduced-motion
 *    behaviour, and whether an `aria-label` that EXISTS actually describes the
 *    control. A machine can find a missing name; only a person can find a wrong
 *    one.
 *  - **Anything outside the three surfaces.** The graph canvas, the Data Stash,
 *    the terminal, the observability panel and the dashboard are unvisited — the
 *    same gap `surfaces.ts` records for the visual pass, and for the same reason.
 *  - **Keyboard operation.** axe reads the accessibility tree; it does not press
 *    Tab. Nothing here would catch a control that is reachable and does nothing.
 */
const NOT_GATED = [
  'minor and moderate impacts',
  'every checklist rule a machine cannot decide (tab order, focus visibility, ' +
    'colour-not-only, escape routes, target sizes, reduced motion, whether a name is RIGHT)',
  'every surface outside surfaces.ts',
  'keyboard operation',
] as const

/**
 * Serious/critical rule ids that fire TODAY, per `surface:theme`, each with why
 * it is not fixed here.
 *
 * Recorded from a real run on 2026-08-26. The assertion below is an equality, so
 * this list is maintained by the suite rather than by discipline: adding a
 * violation fails, and fixing one fails too, with a message saying to delete the
 * line.
 *
 * These are the app's existing accessibility debt, already measured and written up
 * in `A11Y-CHECKLIST.md`. Fixing them is UI work with its own review, not
 * something to smuggle into the commit that adds the gate — the gate's job is to
 * stop the list growing.
 */
const KNOWN_OPEN: Record<string, readonly string[]> = {
  // Present on all three surfaces in both themes, because all three are the same
  // document with the same chrome around them.
  //
  //  - `button-name` (critical): icon-only buttons with no accessible name. The
  //    checklist measured it — 6 of 60 buttons in `app/src/components` carry an
  //    `aria-label`, 39 carry a `title`, which is not a substitute — and calls it
  //    "the single most-violated rule in the codebase". Fixing it is a pass over
  //    the component tree with its own review; naming the buttons wrongly is worse
  //    than not naming them, so it is not a commit to smuggle in here.
  //  - `color-contrast` (serious): `ui-text-tertiary` on the tier switch's own
  //    labels. The checklist already records `dark-text-tertiary` (#71717a) as a
  //    MUTED LABEL colour that fails as body copy — this is that judgement showing
  //    up as a machine finding, and changing it is a palette decision.
  //  - `document-title` (serious): the app renders no `<title>` at all. This is the
  //    cheapest fix on the list and it is a real WCAG A failure on every route —
  //    flagged for its own change rather than recorded as acceptable.
  //  - `label-title-only` (serious): the composer is a `placeholder`-only field
  //    (`form-labels` in the checklist: "a bare `<input placeholder="…">` has no
  //    label"). Also cheap, also its own change.
  'header-strip:dark': ['button-name', 'color-contrast', 'document-title', 'label-title-only'],
  'header-strip:light': ['button-name', 'color-contrast', 'document-title', 'label-title-only'],

  // Plus, wherever a scrolling list is on screen:
  //  - `scrollable-region-focusable` (serious): the thread list and the transcript
  //    scroll but take no keyboard focus, so a keyboard user cannot scroll them.
  //    A `tabindex="0"` on a scroll container is a real fix with a real
  //    consequence for the tab order, which is `keyboard-nav` on the checklist and
  //    a thing a person has to try rather than a line to add.
  'sidebar-with-rows:dark': [
    'button-name',
    'color-contrast',
    'document-title',
    'label-title-only',
    'scrollable-region-focusable',
  ],
  'sidebar-with-rows:light': [
    'button-name',
    'color-contrast',
    'document-title',
    'label-title-only',
    'scrollable-region-focusable',
  ],
  'chat-view:dark': [
    'button-name',
    'color-contrast',
    'document-title',
    'label-title-only',
    'scrollable-region-focusable',
  ],
  'chat-view:light': [
    'button-name',
    'color-contrast',
    'document-title',
    'label-title-only',
    'scrollable-region-focusable',
  ],
}

for (const theme of THEMES) {
  for (const surface of SURFACES) {
    test(`${surface.name} has no new serious accessibility violations in ${theme}`, async ({
      page,
      appUrl,
    }, testInfo) => {
      await surface.reach(page, appUrl, theme)

      // Scanned on the WHOLE page rather than clipped to the surface, even though
      // the surface is what drove the state. Several of the rules that matter are
      // about relationships (a label for a field, a name from a heading), and a
      // subtree scan can report a violation that only exists because the scan cut
      // the relationship in half.
      const results = await new AxeBuilder({ page }).analyze()

      const gated = results.violations.filter((v) => GATED_IMPACTS.has(v.impact ?? ''))
      const firing = [...new Set(gated.map((v) => v.id))].sort()
      const known = [...(KNOWN_OPEN[`${surface.name}:${theme}`] ?? [])].sort()

      // The full detail goes in the report as an attachment rather than in the
      // failure message: the message has to be readable in a terminal, and one
      // axe violation carries every offending node with its selector and its
      // failure summary.
      if (gated.length > 0) {
        await testInfo.attach(`axe-${surface.name}-${theme}.json`, {
          body: JSON.stringify(gated, null, 2),
          contentType: 'application/json',
        })
      }

      const detail = gated
        .map(
          (v) =>
            `  ${v.impact}  ${v.id}: ${v.help}\n` +
            v.nodes
              .slice(0, 3)
              .map((n) => `      ${n.target.join(' ')}`)
              .join('\n'),
        )
        .join('\n')

      expect(
        firing,
        `serious/critical accessibility violations on ${surface.name} in ${theme} do not ` +
          'match what is recorded as known-open.\n\n' +
          `${detail || '  (none)'}\n\n` +
          'If a rule is NEW: fix it, or add it to KNOWN_OPEN with a reason. If a rule was ' +
          'FIXED: delete its line from KNOWN_OPEN — this equality is what stops that list ' +
          `becoming a permanent excuse. Not gated here: ${NOT_GATED.join('; ')}.`,
      ).toEqual(known)
    })
  }
}
