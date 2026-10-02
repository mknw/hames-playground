// @vitest-environment node
/**
 * The MCP gateway image is pinned by digest, in source.
 *
 * Upstream's releases since v0.43.1 cannot run this stack (#417, decision 9).
 * They refuse the `--catalog` path both compose files pass, and they answer the
 * app's unauthenticated connection with HTTP 401. An `image:` with no digest
 * pulls `latest`, so a laptop with the January image cached keeps working while
 * the next fresh host does not. That failure shows up only on a machine nobody
 * has tested on, and CI never pulls the image, so the source is the only place
 * to check the pin.
 *
 * This pins the form, not the value. A bump is an edit to the digest itself,
 * and what it needs first is listed in the comment beside it in
 * docker-compose.yaml.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const BASE = 'docker-compose.yaml'
const PROD = 'docker-compose.prod.yaml'
const SERVICE = 'mcp-gateway'

/** `docker/mcp-gateway`, an optional tag, then a sha256 digest. The digest wins over a tag. */
const DIGEST_PINNED = /^docker\/mcp-gateway(?::[\w][\w.-]*)?@sha256:[0-9a-f]{64}$/

interface ComposeFile {
  services: Record<string, { image?: string }>
}

function load(file: string): ComposeFile {
  // `parseDocument`, not `parse`: the overlay's `!override` tags are Compose's,
  // so yaml only warns about them (TAG_RESOLVE_FAILED) and keeps the value.
  const doc = parseDocument(readFileSync(path.join(REPO, file), 'utf8'))
  expect(doc.errors, `${file} does not parse`).toEqual([])
  return doc.toJS() as ComposeFile
}

const base = load(BASE)
const prod = load(PROD)

describe('the MCP gateway image is pinned by digest', () => {
  it(`${BASE} declares the gateway image`, () => {
    expect(base.services[SERVICE]?.image, `${BASE} no longer sets the gateway image`).toBeDefined()
  })

  // The image each render resolves to. The overlay replaces the base value
  // only if it sets one, so an unpinned `image:` added there must fail too.
  it.each([
    { render: BASE, image: base.services[SERVICE]?.image },
    {
      render: `${BASE} + ${PROD}`,
      image: prod.services[SERVICE]?.image ?? base.services[SERVICE]?.image,
    },
  ])('$render resolves to a digest-pinned image', ({ image }) => {
    expect(
      image,
      'an image with no digest pulls `latest`, which cannot run this stack (#417)',
    ).toMatch(DIGEST_PINNED)
  })
})
