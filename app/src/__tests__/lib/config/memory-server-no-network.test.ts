// @vitest-environment node
/**
 * The memory MCP server runs with no network (#507 S3b review F2).
 *
 * G14 declares `memory` a LOCAL namespace: its read arguments skip the egress
 * check on the strength of "no outbound request". That is a claim about the
 * image until the container is denied a network, as the filesystem server
 * already is. CI never starts the gateway, so the catalog line is pinned here.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')

describe('memory server catalog entry', () => {
  it('sets disableNetwork: true', () => {
    const catalog = parse(readFileSync(path.join(REPO, 'configs/custom-catalog.yaml'), 'utf8')) as {
      registry: Record<string, { disableNetwork?: unknown }>
    }
    expect(catalog.registry.memory.disableNetwork).toBe(true)
  })
})
