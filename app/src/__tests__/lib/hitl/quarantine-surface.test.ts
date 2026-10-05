/**
 * The quarantine's tool surface (A7, #433 S7 / review F2).
 *
 * P2 while a request is pending: no agent can list or read the held file. That
 * is a property of WHERE the content sits, not of a check anybody runs: the
 * quarantine is an app-only, owner-scoped Postgres table, and
 *
 * - no agent has Postgres at all since #412 — the server is gone from the
 *   gateway catalog and configs, pinned gateway-side by
 *   `config/no-agent-postgres.test.ts` and package-side by
 *   `harness-patterns/agent-postgres-tools.test.ts`. What is left to pin here
 *   is that S7 did not add a SECOND way around it;
 * - nothing in the HITL modules reaches Redis, the one store agents holding
 *   `tools.all` CAN read and write — the exact home the review moved the
 *   quarantine OUT of. A Redis key is the mutation this pin is written
 *   against: writing the quarantine to Redis is what turns it red;
 * - no tool in the gateway catalog names the quarantine, so no agent's loop
 *   is even offered it.
 */

import { describe, it, expect } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const SRC = resolve(process.cwd(), 'src')
const REPO = resolve(SRC, '../..')

/** The modules S7 owns for HITL storage and its RPC. */
async function hitlModules(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await hitlModules(full, acc)
    else if (/\.ts$/.test(entry.name)) acc.push(full)
  }
  return acc
}

describe('the quarantine is out of every agent\u2019s reach (A7)', () => {
  it('uses no Redis anywhere in the HITL modules — no key an agent could scan for', async () => {
    const modules = [
      ...(await hitlModules(join(SRC, 'lib/hitl'))),
      join(SRC, 'lib/db/hitl.server.ts'),
    ]
    expect(modules.length).toBeGreaterThan(1)

    // MUTATION: write the quarantine to Redis instead — an import, a client,
    // a key prefix, any of the spellings — and this finds it.
    for (const file of modules) {
      const source = await readFile(file, 'utf8')
      expect(source, relative(SRC, file)).not.toMatch(/redis|stash-transport|createRedisBackend/i)
    }
  })

  it('is reachable by no gateway tool: the catalog names nothing HITL-shaped', async () => {
    const catalog = await readFile(join(REPO, 'packages/connectors/mcp-catalog.ts'), 'utf8')
    expect(catalog).not.toMatch(/quarantine|hitl/i)

    // And the app's tool surface never imports the quarantine's repository:
    // the only importers are the HITL modules and the turn runner, both host
    // code an agent cannot invoke.
    const offenders: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (/\.tsx?$/.test(entry.name)) {
          const source = await readFile(full, 'utf8')
          if (/db\/hitl\.server/.test(source)) offenders.push(relative(SRC, full))
        }
      }
    }
    await walk(SRC)
    expect(offenders.sort()).toEqual([
      'lib/harness-client/turn.server.ts',
      'lib/hitl/actions.server.ts',
    ])
  })
})
