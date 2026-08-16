---
name: resolving-merge-conflicts
description: "Use when you need to resolve an in-progress git merge/rebase conflict."
---

<!-- Vendored from mattpocock/skills (MIT © 2026 Matt Pocock), skills/engineering/resolving-merge-conflicts/SKILL.md.
     Pin + adaptations: .claude/skills/PROVENANCE.md · full license: .claude/skills/NOTICE.md -->

1. **See the current state** of the merge/rebase. Check git history, and the conflicting files.

2. **Find the primary sources** for each conflict. Understand deeply why each change was made, and what the original intent was. Read the commit messages, check the PRs, check original issues/tickets.

3. **Resolve each hunk.** Preserve both intents where possible. Where incompatible, pick the one matching the merge's stated goal and note the trade-off. Do **not** invent new behaviour. Always resolve; never `--abort`.

4. Run the project's **automated checks** — from `ui/`: `pnpm exec tsc --noEmit --project tsconfig.json`, then `pnpm test:run`, then `pnpm lint`, then prettier on the changed files. Fix anything the merge broke.

5. **Finish the merge/rebase.** Stage everything and commit. If rebasing, continue the rebase process until all commits are rebased.
