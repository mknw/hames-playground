/**
 * `predev` guard — every `workspace:*` dependency is actually linked before the
 * dev server starts.
 *
 * ## What this is for
 *
 * This repo is a pnpm workspace, and `app/` consumes the packages under
 * `packages/` through `workspace:*`. Those links are created by an install at
 * the REPO ROOT, not by anything run from `app/`. So every time a new package
 * lands on main — and five have — a `git pull` leaves the app referring to a
 * package that is declared, present on disk, and not linked.
 *
 * The failure that produces is actively misleading. Vite reports
 * `Cannot find module '@hames-ai/sandbox/settings'`, which reads like a bad import
 * path or a missing export, and sends you into the package's `exports` map. The
 * package is fine. The install simply never ran. It has now cost two debugging
 * sessions on two different packages, and the fix both times was one command
 * that finished in a second.
 *
 * So this is not a convenience wrapper around `pnpm install`. It converts a
 * confusing symptom into a named cause, and repairs it when it safely can.
 *
 * ## Why plain node and not `tsx`
 *
 * Every other script here runs through `pnpm dlx tsx`, which resolves — and may
 * fetch — a toolchain. A guard that runs before the dev server must not depend
 * on the network, and must not depend on a resolution step that is itself the
 * class of thing being checked. `node` is already guaranteed by `engines`.
 *
 * ## What it deliberately does not check
 *
 * That a given SUBPATH resolves. A workspace link points at the package source,
 * so once the link exists every subpath the package really exports resolves
 * from it. A subpath that is missing from the `exports` map is a packaging bug,
 * and the pack smoke in CI is what catches that.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(appDir, '..')

const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))
const declared = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
  .filter(([, range]) => typeof range === 'string' && range.startsWith('workspace:'))
  .map(([name]) => name)

// existsSync follows symlinks, so a dangling link counts as missing — which is
// what we want: a link left over from a renamed package is as broken as none.
const unlinked = () => declared.filter((name) => !existsSync(join(appDir, 'node_modules', name)))

let missing = unlinked()
if (missing.length === 0) process.exit(0)

console.warn(
  `\n[workspace] ${missing.length} of ${declared.length} workspace packages are not linked: ${missing.join(', ')}` +
    '\n[workspace] this is what a "Cannot find module \'@hames-ai/...\'" error at dev-server start really means.' +
    '\n[workspace] repairing with `pnpm install --frozen-lockfile` at the repo root...\n',
)

try {
  execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: repoRoot, stdio: 'inherit' })
} catch {
  // Frozen means the lockfile is the source of truth. If it refuses, the
  // lockfile genuinely disagrees with the manifests and that is a change to
  // review, not something a dev-server hook should paper over by writing one.
  console.error(
    '\n[workspace] the install failed. If it reported a lockfile mismatch, a manifest changed' +
      '\n[workspace] without the lockfile: run `pnpm install` at the repo root and COMMIT the result.\n',
  )
  process.exit(1)
}

missing = unlinked()
if (missing.length > 0) {
  console.error(
    `\n[workspace] still not linked after installing: ${missing.join(', ')}` +
      '\n[workspace] check that each package is matched by `packages/*` in pnpm-workspace.yaml' +
      '\n[workspace] and that its package.json `name` is exactly the specifier above.\n',
  )
  process.exit(1)
}

console.warn('[workspace] linked — continuing.\n')
