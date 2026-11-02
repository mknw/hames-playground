# Contributing

Issues and pull requests are welcome; for larger changes, open an issue first.
The [README](README.md#contributing) covers adding an agent; this page covers
versioning and releases of the five `@hames-ai/*` packages under
[`packages/`](packages/).

## Add a changeset

A pull request that changes what a package **ships** needs a changeset — a small
Markdown file under `.changeset/` naming the packages, the bump and one line for
the changelog. From the repo root:

```sh
pnpm changeset
```

Pick the packages, pick the bump, write the line, and commit the generated file
with your change. CI's `changeset · version intent` job fails a PR that changes
a shipped file under `packages/` without one.

"Ships" means it lands in the npm tarball: source, `package.json`, `README.md`
(it is the npm page), `LICENSE`, `baml_src`/`baml_client`. Tests, `vitest.config.ts`,
prettier config and `packages/sandbox/scripts/` do not, and need nothing. A
change that ships but deserves no release takes `pnpm changeset --empty`.

## Which bump

The five packages are one **fixed** group: they always share a version, and a
bump to any one bumps all five. While the family is at `0.x`:

| Bump    | When                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------ |
| `patch` | Fixes, docs and README changes, metadata — nothing a consumer has to change code for.                  |
| `minor` | A new export or capability, **or any breaking change** (at `0.x`, `0.1 → 0.2` is the breaking signal). |
| `major` | Reserved for `1.0.0`.                                                                                  |

## How a release happens

1. Changesets merge to `main` with their PRs.
2. The [release workflow](.github/workflows/release.yml) keeps a
   **"chore: version packages"** PR open that consumes them: bumped versions,
   updated `CHANGELOG.md`s.
3. Merging that PR makes the same workflow tag the merge commit —
   `@hames-ai/<pkg>@<version>` for each package plus a repo-level `v<version>`.
4. **Publishing is manual** and done by the maintainer with `make publish` from
   the repo root (or `scripts/publish.sh` directly). The target works on the
   latest release — the highest `v<semver>` tag — without checking anything out:

   ```sh
   make publish            # publish the latest release tag
   make publish-dry        # pack without publishing, no prompt
   ```

   It fetches tags, refuses unless every `@hames-ai/<pkg>@<version>` tag exists
   and points at the same commit as `v<version>` (naming the tag that differs),
   refuses a partial npm publish (if npm already has the version for SOME
   packages it lists them and exits non-zero — never republish over a partial
   release; if it has it for all five it prints `already published` and exits 0),
   prints the version and commit and asks for y/N, then runs
   `pnpm install --frozen-lockfile`, `npm whoami` and
   `pnpm -r publish --no-git-checks` from a throwaway worktree at that commit —
   your own checkout is never touched. Finally it verifies
   `npm view @hames-ai/<pkg> version` for all five. Overrides: `VERSION=x.y.z`
   (a specific version instead of the latest tag), `CONFIRM=1` (skip the prompt),
   `NPM_USERCONFIG=<path>` (an alternative npm config file for the whoami and
   publish steps — see npm's `userconfig` documentation).

   `--no-git-checks` is needed because the tag leaves a detached HEAD, which pnpm's
   own `publish-branch` check rejects; the per-package `prepublishOnly` tag guard
   (`scripts/check-release-tag.mjs`) replaces that check and stays the real gate.

   Always `pnpm`, never `npm publish`: the packages reference each other as
   `workspace:^`, which pnpm rewrites to a real range at pack time and npm ships
   literally. Each package's `prepublishOnly` guard refuses npm for that reason.
   No workflow publishes, and no npm token lives in CI.
