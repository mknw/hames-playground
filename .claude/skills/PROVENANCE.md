# PROVENANCE

Upstream pins and adaptation records for the vendored material that lives **in
this repo**. Full licence texts: [`NOTICE.md`](NOTICE.md).

> **The generic skill set was extracted (2026-08-17).** The bare-name skills
> (writing-for-agents, grilling, grill-me, diagnosing-bugs, codebase-design,
> wizard, resolving-merge-conflicts, domain-modeling,
> improve-codebase-architecture, council, intent-driven-development,
> loop-design-check, agent-architecture-audit, living-docs-governance) now live
> in `~/Code/muster-skills`, installed globally via `~/.claude/skills`
> symlinks, with attribution carried in that repo's README. Their per-wave
> provenance history up to the extraction is preserved in this file's git
> history (see the version merged by PR #176–#181). What follows covers only
> what still ships with this repo.

## Conventions

- Every vendored or derivative file carries an attribution comment naming its
  upstream and pointing here.
- Pins are upstream commits at vendoring time; check the pinned commit first
  when refreshing a file against its upstream.

## Sources

| Upstream repo                                                                                     | Licence                       | Pinned commit          |
| ------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------- |
| [`mattpocock/skills`](https://github.com/mattpocock/skills)                                       | MIT © 2026 Matt Pocock        | `068b6e0` (2026-08-15) |
| [`affaan-m/ECC`](https://github.com/affaan-m/ECC)                                                 | MIT © 2026 Affaan Mustafa     | `50743ce` (2026-08-16) |
| [`nextlevelbuilder/ui-ux-pro-max-skill`](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | MIT © 2024 Next Level Builder | `a38d04c` (2026-08-14) |
| [`DietrichGebert/ponytail`](https://github.com/DietrichGebert/ponytail)                           | MIT © 2026 DietrichGebert     | `2ed6c52` (2026-08-08) |

## Sub-agents (`.claude/agents/`)

Both from `affaan-m/ECC` @ `50743ce`, model-invoked as `subagent_type`:

| Our path                             | Upstream path                     | Adapted |
| ------------------------------------ | --------------------------------- | ------- |
| `../agents/code-reviewer.md`         | `agents/code-reviewer.md`         | yes     |
| `../agents/silent-failure-hunter.md` | `agents/silent-failure-hunter.md` | yes     |

Adaptations: the React/Next.js patterns block and the "AI-Generated Code Review
Addendum" are deleted from `code-reviewer` (SolidJS repo; the section could only
produce false positives). The "Prompt Defense Baseline" preamble is deleted from
both (no-op under `writing-for-agents`' test). `model: sonnet` → `model: opus`
in both (standing repo preference).

## `kg-code-review` — extracted (2026-08-22)

Generalized into `reviewing-changes` in
[muster-skills](https://github.com/mknw/muster-skills), whose `NOTICE.md`
carries its upstream notices (`mattpocock/skills` two-axis structure;
`affaan-m/ECC` reviewer discipline by delegation). The repo-specific facts the
skill's body used to hardcode now live as pointers in
[`docs/reviewing.md`](../../docs/reviewing.md).

## `kg-dtalk-ui` — derivative work

The skill is ours (recipes measured from `app/uno.config.ts` and `app/src`);
two files inside it are rewrites of `nextlevelbuilder/ui-ux-pro-max-skill`
@ `a38d04c` material:

| Our path                        | Upstream path                                                     | Notes                                                                                       |
| ------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `kg-dtalk-ui/A11Y-CHECKLIST.md` | `.claude/skills/ui-ux-pro-max/references/quick-reference.md` §1–2 | Rule IDs + WCAG levels preserved verbatim; guidance rewritten for attributify/Ark UI        |
| `kg-dtalk-ui/GRAPH-VIZ.md`      | `.claude/skills/ui-ux-pro-max/data/charts.csv` row 16             | Thresholds/colours/a11y fallbacks carried faithfully; mapped onto Cytoscape.js + this repo |

Deliberately not vendored from that source (do not re-litigate): its search
tool and `--stack uno` (there "uno" = .NET Uno Platform, not UnoCSS), and the
`--design-system` palette generator (would fight `app/uno.config.ts`).

## `CLAUDE.md` — Code minimalism section

Adapted, in our own words, from `DietrichGebert/ponytail` @ `2ed6c52` (the
minimalism ladder). Licence text in `NOTICE.md`.

## Docs outside `.claude/`

| Our path                     | Upstream path                                                       | Adapted                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `../../docs/adr/README.md`    | `mattpocock/skills` @ `068b6e0`, `skills/engineering/domain-modeling/ADR-FORMAT.md` (body format, gate) + `affaan-m/ECC` @ `50743ce`, `skills/architecture-decision-records/SKILL.md` (index table, lifecycle statuses) | Reconciled from both sources into one format |
| `../../docs/agents/AGENT-BRIEF.md` | `mattpocock/skills` @ `068b6e0`, `skills/engineering/triage/AGENT-BRIEF.md` | Extended for this repo's dispatch/issue surfaces |
