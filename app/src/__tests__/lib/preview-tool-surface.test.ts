/**
 * The preview deployment's agent-reachable tool surface, pinned at the one
 * place that decides it.
 *
 * `general` hands `tools.all` — every tool the MCP gateway lists — to a single
 * controller loop, so the gateway's enabled server set IS the tool surface a
 * signed-in colleague can reach. On the preview VM that set is narrowed by
 * `docker-compose.prod.yaml`, which replaces the base file's
 * `--enable-all-servers` with an explicit `--servers=` allow-list.
 *
 * Why this is a test and not a comment: the obvious-looking alternative — trim
 * `configs/mcp-config.yaml` — does nothing at all. `--enable-all-servers` means
 * "every server in the CATALOG", so the config file supplies connection
 * parameters, not enablement. Measured against a live gateway with the same
 * config file: 9 servers / 134 tools with the flag, 5 servers / 17 tools with
 * the allow-list. Reintroducing the flag, or quietly widening the list, is
 * therefore a change that reads like nothing and reopens a cross-user read of
 * every colleague's Data Stash uploads (`redis`) and arbitrary SQL over
 * `conversations.context` (`database-server`).
 *
 * Source scan rather than a render: `docker compose config` is not available in
 * CI, and the property being pinned is a property of the tracked file.
 *
 * Widening the preview's surface is a deliberate act. If an agent genuinely
 * needs another server, add it here AND to the overlay AND to docs/PREVIEW.md
 * §3a in the same change.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const OVERLAY = resolve(process.cwd(), '../docker-compose.prod.yaml')

/** Exactly the servers docs/PREVIEW.md §3a enumerates, in the overlay's order. */
const ALLOWED = ['neo4j-cypher', 'fetch', 'web_search', 'context7', 'memory']

/** Enabled in the base compose file, and deliberately absent from the preview. */
const FORBIDDEN = ['redis', 'database-server', 'rust-mcp-filesystem', 'playwright', 'github']

function gatewayCommand(): string[] {
  const src = readFileSync(OVERLAY, 'utf-8')
  const start = src.indexOf('\n  mcp-gateway:')
  expect(start, 'docker-compose.prod.yaml no longer overrides mcp-gateway').toBeGreaterThan(-1)
  // Up to the next top-level service key (two-space indent, not a comment).
  const rest = src.slice(start + 1)
  const nextService = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:/)
  const block = nextService === -1 ? rest : rest.slice(0, nextService + 1)
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- --'))
    .map((l) => l.slice(2))
}

describe('preview tool surface (docker-compose.prod.yaml)', () => {
  it('overrides the gateway command with an explicit --servers allow-list', () => {
    const cmd = gatewayCommand()
    expect(cmd.length, 'no gateway command override in the production overlay').toBeGreaterThan(0)
    expect(cmd.some((a) => a.startsWith('--servers='))).toBe(true)
  })

  it('never re-enables the whole catalog', () => {
    const cmd = gatewayCommand()
    // Assert presence FIRST. Deleting the override entirely leaves the base
    // file's `--enable-all-servers` in force, and a bare
    // `not.toContain('--enable-all-servers')` on an empty array would pass —
    // a test that goes green precisely when the control is gone.
    expect(cmd.length, 'the override was removed; the base flags are back').toBeGreaterThan(0)
    expect(cmd).not.toContain('--enable-all-servers')
  })

  it('allows exactly the five servers the runbook enumerates', () => {
    const flag = gatewayCommand().find((a) => a.startsWith('--servers='))!
    const servers = flag.slice('--servers='.length).split(',').filter(Boolean)
    expect(servers).toEqual(ALLOWED)
  })

  it.each(FORBIDDEN)('does not expose %s to an agent controller', (server) => {
    const flag = gatewayCommand().find((a) => a.startsWith('--servers='))!
    const servers = flag.slice('--servers='.length).split(',')
    expect(servers).not.toContain(server)
  })
})
