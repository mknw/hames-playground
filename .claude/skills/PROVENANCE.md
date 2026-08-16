# PROVENANCE

Where every vendored file under `.claude/skills/` and `.claude/agents/` came
from, which upstream commit it was taken at, and what we changed. Full licence
texts: [`NOTICE.md`](NOTICE.md). The programme this implements:
[`docs/plan/skills-adoption.md`](../../docs/plan/skills-adoption.md).

**The pin lives here and nowhere else.** The per-file attribution comment
carries repo, path, author and licence, but no SHA — so bumping a pin is a
one-place edit in the tables below.

## Conventions

- **Bundle** — `generic` means a bare-named, stack-agnostic skill that is a
  candidate for the open-source split; `project` means a `kg-`-prefixed skill
  that encodes something only true of this repo and never ships.
- **Invocation** — `model` (no `disable-model-invocation` key) or `user`
  (`disable-model-invocation: true`). This flag is **preserved from upstream on
  every file**: a `Call the Skill tool with "X"` line fails _silently_ if X is
  user-invoked, so the flag is correctness, not cosmetics.
- **Formatting** — vendored files keep their upstream formatting verbatim.
  Prettier is deliberately **not** run over them; the only differences from
  upstream are the attribution comment and the adaptations listed below, so a
  future `git diff <pin>..HEAD` against the upstream path stays readable.
- Vendored `.sh` files carry the attribution as a `#` comment after the
  shebang rather than as an HTML comment, for the obvious reason.

## Refresh procedure

Pinned commit, manual diff review, no automation, on demand — run it when
there is a reason to (a relevant upstream release note, or a skill
misbehaving), not on a schedule:

```sh
git clone --filter=blob:none https://github.com/<repo> /tmp/<name>
git -C /tmp/<name> diff <pinned-sha>..HEAD -- <upstream-path>
```

Read the diff, re-apply our adaptations by hand on top of anything worth
taking, bump the row. One PR per source repo, so a bad refresh reverts cleanly.

## Sources

| Upstream repo                                                                                     | Licence                       | Pinned commit          |
| ------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------- |
| [`mattpocock/skills`](https://github.com/mattpocock/skills)                                       | MIT © 2026 Matt Pocock        | `068b6e0` (2026-08-15) |
| [`affaan-m/ECC`](https://github.com/affaan-m/ECC)                                                 | MIT © 2026 Affaan Mustafa     | `50743ce` (2026-08-16) |
| [`nextlevelbuilder/ui-ux-pro-max-skill`](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | MIT © 2024 Next Level Builder | `a38d04c` (2026-08-14) |
| [`DietrichGebert/ponytail`](https://github.com/DietrichGebert/ponytail)                           | MIT © 2026 DietrichGebert     | `2ed6c52` (2026-08-08) |

Only sources with rows in a wave section below have material vendored today.

---

## Wave 1 — the generic core

`chore(skills): track .claude/skills + adopt the generic core`

All rows: upstream `mattpocock/skills` @ `068b6e0`, bundle `generic`.

| Our path                                        | Upstream path                                                      | Invocation | Adapted        |
| ----------------------------------------------- | ------------------------------------------------------------------ | ---------- | -------------- |
| `writing-for-agents/SKILL.md`                   | `skills/productivity/writing-for-agents/SKILL.md`                  | model      | no             |
| `writing-for-agents/SKILL-MECHANICS.md`         | `skills/productivity/writing-for-agents/SKILL-MECHANICS.md`        | —          | no             |
| `grilling/SKILL.md`                             | `skills/productivity/grilling/SKILL.md`                            | model      | no             |
| `grill-me/SKILL.md`                             | `skills/productivity/grill-me/SKILL.md`                            | **user**   | no             |
| `diagnosing-bugs/SKILL.md`                      | `skills/engineering/diagnosing-bugs/SKILL.md`                      | model      | **yes** — A, B |
| `diagnosing-bugs/scripts/hitl-loop.template.sh` | `skills/engineering/diagnosing-bugs/scripts/hitl-loop.template.sh` | —          | no             |
| `codebase-design/SKILL.md`                      | `skills/engineering/codebase-design/SKILL.md`                      | model      | no             |
| `codebase-design/DEEPENING.md`                  | `skills/engineering/codebase-design/DEEPENING.md`                  | —          | no             |
| `codebase-design/DESIGN-IT-TWICE.md`            | `skills/engineering/codebase-design/DESIGN-IT-TWICE.md`            | —          | **yes** — A    |
| `wizard/SKILL.md`                               | `skills/engineering/wizard/SKILL.md`                               | model      | no             |
| `wizard/template.sh`                            | `skills/engineering/wizard/template.sh`                            | —          | no             |
| `resolving-merge-conflicts/SKILL.md`            | `skills/engineering/resolving-merge-conflicts/SKILL.md`            | model      | **yes** — C    |

Every file also carries the two-line attribution comment; that is not counted
as an adaptation.

### Adaptations

**A — `CONTEXT.md` → `GLOSSARY.md`.** Upstream reads a project glossary at
`CONTEXT.md`. This repo's glossary will be `GLOSSARY.md` (user decision,
overriding OQ‑1 in the plan, which proposed `CONTEXT.md`). Both call sites were
retargeted, and both are phrased to **degrade gracefully**: the file does not
exist yet — Wave 2 creates it — so each site tells the agent to name the
missing file and carry on rather than stall or invent a substitute.

- `diagnosing-bugs/SKILL.md`, the exploration line: now points at `GLOSSARY.md`
  and at `docs/adr/` (also a Wave 2 artifact), with "either may not exist yet".
- `codebase-design/DESIGN-IT-TWICE.md` §2: the sub-agent brief now names
  `GLOSSARY.md`, with an explicit fallback to architecture vocabulary alone.

Both are **data hooks**, not skill dependencies — a generic skill naming a
stable project-supplied path — so they survive the open-source split intact.

**B — `diagnosing-bugs` Phase 1 loop menu.** Added one line naming this repo's
tightest feedback loops (`pnpm vitest run <file>`; `pnpm exec tsc --noEmit
--project tsconfig.json`, both from `ui/`). A cache of a non-obvious lookup —
the `ui/` cwd requirement — so it earns its load.

**C — `resolving-merge-conflicts` step 4.** Sharpened "discover the project's
automated checks" into the named commands, in order, with the `ui/` cwd stated.
Same rationale as B.

> B and C are the only stack-specific lines in the Wave 1 set. They name a
> package manager and a test runner, not a framework, so the set stays
> portable — but they are the two lines to re-check at open-source split time.

### Not vendored from these skill directories

Each upstream skill folder also carries an `agents/openai.yaml` (Codex-format
manifest). Not copied: Claude Code does not read it, and it would be a second
copy of the frontmatter to keep in sync.

### Declined from `mattpocock/skills`

Recorded so it is not re-litigated: `code-review` (superseded by the planned
`kg-code-review`), `triage` / `to-tickets` / `to-spec` / `wayfinder` (depend on
a setup scaffold and label vocabulary we are not adopting), `setup-pre-commit`
(`.githooks` + lint-staged + the CI gate already exist), `research` (the
`codebase-researcher` agent), `handoff` / `claude-handoff` (Orca +
`worktree-lanes`), `implement`, `prototype`, `setup-ts-deep-modules`, `tdd`,
`ask-matt`, `migrate-to-shoehorn`, `scaffold-exercises`, and
`git-guardrails-claude-code` (a hooks installer — excluded by the no-hooks
constraint).

`multica-ai/andrej-karpathy-skills` was reviewed and **skipped entirely**: no
LICENSE file at `2c60614`, so all-rights-reserved by default and not vendorable.

---

## Wave 6 — `kg-dtalk-ui`

`chore(skills): kg-dtalk-ui styleguide`

`kg-dtalk-ui` is **ours** — a project styleguide of recipes and rules derived by
reading `ui/uno.config.ts` and measuring the real duplication in `ui/src`.
Bundle `project` (the `kg-` prefix; it never ships with the open-source split).
Invocation: **model**. Two pieces inside it are vendored, which makes the skill a
**derivative work**, and every file carries an attribution comment naming the
source.

All vendored rows: upstream `nextlevelbuilder/ui-ux-pro-max-skill` @ `a38d04c`.

| Our path                        | Upstream path                                                     | Vendored?         | Adapted        |
| ------------------------------- | ----------------------------------------------------------------- | ----------------- | -------------- |
| `kg-dtalk-ui/SKILL.md`          | —                                                                 | no — written here | —              |
| `kg-dtalk-ui/A11Y-CHECKLIST.md` | `.claude/skills/ui-ux-pro-max/references/quick-reference.md` §1–2 | **yes**           | **yes** — D, E |
| `kg-dtalk-ui/GRAPH-VIZ.md`      | `.claude/skills/ui-ux-pro-max/data/charts.csv` row 16             | **yes**           | **yes** — F    |

### Adaptations

**D — WCAG §1–2 rewritten in this stack's syntax.** Upstream ships §1
"Accessibility (CRITICAL)" (25 rules) and §2 "Touch & Interaction (CRITICAL)"
(17 rules) as flat `id` — `prose` bullets. **Rule IDs and WCAG conformance
levels are preserved verbatim**, so `git diff a38d04c..HEAD` against the upstream
path stays readable; the guidance column is rewritten as attributify /
Ark UI / this-repo instructions, with concrete file:line anchors.

**E — the six native-only §2 rules are grouped, not dropped.** `gesture-conflicts`,
`standard-gestures`, `system-gestures`, `haptic-feedback`, `safe-area-awareness`
and `swipe-clarity` cannot fire on a desktop web app. They are kept **by ID** in
a single closing line rather than expanded — the diff-against-upstream property
survives at one line of cost, instead of six rules of dead context.

**F — charts.csv row 16 → prose.** The row's `Data Volume Threshold`,
`Color Guidance`, `Accessibility Risk`, `Accessibility Notes`, `A11y Fallback`
and `Library Recommendation` cells are carried faithfully (≤100 SVG / 101–500
Canvas / >500 clustering-or-LOD; edges `#90A4AE` @60%; highlight `#F59E0B`; the
adjacency view as the accessible source of truth; focus-reveals / Enter-drills /
move-buttons-replace-drag). What is added is the mapping onto Cytoscape.js and
onto this repo's actual graph components, including the current gaps stated as
gaps.

**Formatting exception to the convention above.** Neither vendored file is a
verbatim copy — both are rewrites that preserve upstream's identifiers, not its
prose — so the "keep upstream formatting" rule has nothing to preserve. All
three files are prettier-formatted like any other document we author.
`NOTICE.md` already carried this source's full MIT text from Wave 1; nothing
was added to it.

### Deliberately **not** vendored from this source

Recorded so it is not re-litigated (plan §2.3):

- **The search tool and `--stack uno`.** In that repo `uno` is the .NET **Uno
  Platform** (XAML/WinUI), not UnoCSS. An agent auto-detecting "uno" from
  `package.json` would get C#/XAML guidance.
- **The `--design-system` generator.** It always generates a _fresh_ palette from
  its 192-product database, with no flag to validate against an existing token
  set — it would fight `ui/uno.config.ts` rather than serve it.
- The remaining eight `quick-reference.md` categories and the other 15+
  `charts.csv` rows: no consumer here today.

### Not a token cache

Per OQ‑6 (user decision): the skill **points at `ui/uno.config.ts`** for the
token list and never restates it. What it carries instead is the part that is
_not_ derivable from the config — the attributify rules and their exceptions,
the four house recipes, and a **proposed** role→token mapping measured from
usage. That table is marked in the skill as awaiting a one-time confirmation and
carries no authority until it gets one.

### CLAUDE.md

Per OQ‑7 (user decision), this wave also fixes `CLAUDE.md`'s stale **Icons**
subsection: `material-symbols` (+ `-light`) is stated as the icon set, and the
`i-mdi-*` guidance is corrected to a warning — `@iconify-json/mdi` is installed
but **not registered** as a collection in `uno.config.ts`, so the 41 surviving
`i-mdi-*` classes emit no CSS. The edit is confined to that subsection.

**No component code is migrated by this wave.** No `i-mdi-*` renames, no
hex→token changes, no `class=` fixes. Those are recorded in the skill as
evidence for its rules; the migration is separate future work.

---

<!-- Later waves append their own `## Wave N` section here. Do not edit the
     sections above; a wave that needs to change an earlier row bumps that row
     in place and says why in its own section. -->
