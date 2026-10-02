// @vitest-environment node
/**
 * The gateway-side switch for the MCP gateway's management tools, pinned by
 * source (#412, #420).
 *
 * The gateway reads its `dynamic-tools` feature from the Docker CLI config the
 * base compose file mounts at `/root/.docker/config.json`. With the feature on
 * it adds `mcp-find`, `mcp-add`, `mcp-remove`, `code-mode`, `mcp-exec` and
 * `mcp-config-set` to the tool list every agent is built from.
 *
 * The value must be present and "disabled". At the pinned build (v0.37.0,
 * `cmd/docker-mcp/commands/gateway.go`, `isDynamicToolsFeatureEnabled`) a
 * missing file, a missing `features` object or a missing key all mean ON, so
 * deleting the line reads like turning it off and does the opposite. Checked
 * against the pinned image itself: "enabled" and no file both register the six
 * tools, "disabled" registers none.
 *
 * The app also drops those names from its catalog
 * (`gateway-management-tools.test.ts`); this file is the gateway half. CI never
 * starts the gateway, so the tracked files are the only place to check it.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const MOUNT = './docker-config.json:/root/.docker/config.json:ro'

interface ComposeFile {
  services: Record<string, { volumes?: string[] } | undefined>
}

function load(file: string): ComposeFile {
  // `parseDocument`, not `parse`: the overlay's `!override` tags are Compose's,
  // so yaml only warns about them and keeps the value.
  const doc = parseDocument(readFileSync(path.join(REPO, file), 'utf8'))
  expect(doc.errors, `${file} does not parse`).toEqual([])
  return doc.toJS() as ComposeFile
}

describe('the gateway management tools are off at the gateway', () => {
  it('docker-config.json sets dynamic-tools to "disabled", explicitly', () => {
    const config = JSON.parse(readFileSync(path.join(REPO, 'docker-config.json'), 'utf8')) as {
      features?: Record<string, string>
    }
    expect(config.features?.['dynamic-tools']).toBe('disabled')
  })

  it('the base gateway service mounts it where the gateway reads it', () => {
    const gateway = load('docker-compose.yaml').services['mcp-gateway']
    expect(gateway, 'no mcp-gateway service in docker-compose.yaml').toBeDefined()
    expect(gateway?.volumes ?? []).toContain(MOUNT)
  })

  it('the production overlay keeps that mount', () => {
    const gateway = load('docker-compose.prod.yaml').services['mcp-gateway']
    expect(gateway, 'the overlay no longer overrides mcp-gateway').toBeDefined()
    // No `volumes` key inherits the base list. A `volumes` key, whether it
    // merges or `!override`s, must still carry the mount.
    if (gateway?.volumes !== undefined) expect(gateway.volumes).toContain(MOUNT)
  })
})
