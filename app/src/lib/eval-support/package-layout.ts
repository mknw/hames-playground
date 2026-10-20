/**
 * Where the eval entries find the workspace packages: relative to THIS file, never the CWD.
 * A `resolve('../packages/…')` only works from `app/`; from any other directory it dies with
 * "Cannot find module" on the first job, after the box is already awake and billing.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** `app/`, from `app/src/lib/eval-support/`. */
export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
export const REPO_ROOT = resolve(APP_DIR, '..')

export function packagePath(...segments: string[]): string {
  return join(REPO_ROOT, 'packages', ...segments)
}

/** The module `driver.ts` imports for an agent id. */
export function agentModuleFile(agent: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(agent)) throw new Error('Invalid agent id')
  return packagePath('agents', 'agents', `${agent}.server.ts`)
}

export function agentModuleUrl(agent: string): string {
  return pathToFileURL(agentModuleFile(agent)).href
}

/**
 * Throws before any wake, observer or job when a path the run will import is missing.
 * Paths in the message are repo-relative: they are enough to diagnose, and the absolute
 * root says nothing a user could not read off their own checkout.
 */
export function assertPackageLayout(
  agents: readonly string[],
  exists: (path: string) => boolean = existsSync,
): void {
  const missing = [packagePath('agents', 'agents'), ...agents.map(agentModuleFile)].filter(
    (p) => !exists(p),
  )
  if (missing.length === 0) return
  throw new Error(
    `Eval package layout is unresolvable; nothing was started or spent. Missing: ${missing
      .map((p) => p.slice(REPO_ROOT.length + 1))
      .join(
        ', ',
      )}. The eval files resolve packages/ from their own checkout, wherever the shell is, so run them from a full checkout of the repository.`,
  )
}
