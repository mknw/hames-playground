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
 * Every tracked compose file is held to it, not only the two that are loaded: a
 * stale copy that still floats the image (a `docker-compose.yaml.bak2` did
 * until #421) is a trap for whoever copies from it.
 *
 * This pins the form, not the value. A bump is an edit to the digest itself,
 * and what it needs first is listed in the comment beside it in
 * docker-compose.yaml.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const BASE = 'docker-compose.yaml'
const PROD = 'docker-compose.prod.yaml'
const SERVICE = 'mcp-gateway'

/** Any reference to the gateway's repository, whatever follows it. */
const GATEWAY_REPO = /^(?:docker\.io\/)?docker\/mcp-gateway(?=[:@]|$)/

/** The gateway repository, an optional tag, then a sha256 digest. The digest wins over a tag. */
const DIGEST_PINNED = /^(?:docker\.io\/)?docker\/mcp-gateway(?::[\w][\w.-]*)?@sha256:[0-9a-f]{64}$/

interface ComposeFile {
  services?: Record<string, { image?: string } | null>
}

function load(file: string): ComposeFile {
  // `parseDocument`, not `parse`: the overlay's `!override` tags are Compose's,
  // so yaml only warns about them (TAG_RESOLVE_FAILED) and keeps the value.
  const doc = parseDocument(readFileSync(path.join(REPO, file), 'utf8'))
  expect(doc.errors, `${file} does not parse`).toEqual([])
  return doc.toJS() as ComposeFile
}

/**
 * Every tracked compose file at any depth, including a copy with a suffix after
 * the extension (`.bak2`, `.orig`). Tracked only: a scratch file on a
 * developer's disk is not a claim about the repo.
 */
function trackedComposeFiles(): string[] {
  return execFileSync('git', ['ls-files', '--', ':(glob)**/docker-compose*.y*ml*'], { cwd: REPO })
    .toString()
    .split('\n')
    .filter(Boolean)
}

const base = load(BASE)
const prod = load(PROD)

describe('the MCP gateway image is pinned by digest', () => {
  it(`${BASE} declares the gateway image`, () => {
    expect(
      base.services?.[SERVICE]?.image,
      `${BASE} no longer sets the gateway image`,
    ).toBeDefined()
  })

  // The image each render resolves to. The overlay replaces the base value
  // only if it sets one, so an unpinned `image:` added there must fail too.
  it.each([
    { render: BASE, image: base.services?.[SERVICE]?.image },
    {
      render: `${BASE} + ${PROD}`,
      image: prod.services?.[SERVICE]?.image ?? base.services?.[SERVICE]?.image,
    },
  ])('$render resolves to a digest-pinned image', ({ image }) => {
    expect(
      image,
      'an image with no digest pulls `latest`, which cannot run this stack (#417)',
    ).toMatch(DIGEST_PINNED)
  })

  it('no tracked compose file names the gateway image without a digest', () => {
    const files = trackedComposeFiles()
    // Non-vacuity: a pathspec typo would otherwise scan nothing and pass.
    expect(files, 'the scan no longer finds the two loaded compose files').toEqual(
      expect.arrayContaining([BASE, PROD]),
    )
    // By image, not by service name: the stale copy called its service `gateway`.
    const references = files.flatMap((file) =>
      Object.entries(load(file).services ?? {})
        .map(([service, def]) => ({ where: `${file}: ${service}`, image: def?.image }))
        .filter((ref): ref is { where: string; image: string } =>
          GATEWAY_REPO.test(ref.image ?? ''),
        ),
    )
    expect(references.length, 'the scan found no gateway image at all').toBeGreaterThan(0)
    for (const { where, image } of references) {
      expect(image, `${where} floats the gateway image (#417)`).toMatch(DIGEST_PINNED)
    }
  })
})
