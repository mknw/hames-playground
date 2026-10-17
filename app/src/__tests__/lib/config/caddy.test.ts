// @vitest-environment node
/** Text pins complement offline `caddy validate`; neither claims live TLS/SSE evidence. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { MAX_CONTENT_BYTES } from '@hames-ai/harness-patterns/stash/document-store.server'
import { SKILL_FILE_MAX_BYTES } from '@hames-ai/sandbox/skills'

const read = (file: string) =>
  readFileSync(new URL(`../../../../../${file}`, import.meta.url), 'utf8')
const code = (text: string) => text.replace(/#.*$/gm, '').trim()
const main = code(read('configs/Caddyfile'))
const dev = code(read('configs/Caddyfile.dev'))
const shared = main.slice(main.indexOf('(preview) {'), main.indexOf('{$APP_DOMAIN} {'))
const production = parseDocument(read('docker-compose.prod.yaml')).toJS()
const clones = parseDocument(read('docker-compose.clones.yaml')).toJS()

describe('Caddy public request boundary (#432 G20 row 6)', () => {
  it('caps request bytes at 32 MiB before the shared proxy, without a plugin', () => {
    expect(shared).toMatch(/request_body\s*\{\s*max_size 32MiB\s*\}/)
    expect(main.match(/\brequest_body\b/g)).toHaveLength(1)
    expect(shared.indexOf('request_body')).toBeLessThan(shared.indexOf('reverse_proxy'))
    expect(main).not.toMatch(/\brate_limit\b/)
    expect(production.services.caddy.image).toBe('caddy:2.10-alpine')
    expect(clones.services.caddy.image).toBeUndefined()
    expect(clones.services.caddy.build).toBeUndefined()
  })

  it('leaves room for every supported maximal content representation and normal metadata', () => {
    const cap = Number(shared.match(/max_size (\d+)MiB/)?.[1]) * 1024 * 1024
    expect(MAX_CONTENT_BYTES).toBe(5 * 1024 * 1024)
    // JSON escapes can expand ONE content byte into SIX wire bytes. A 5 MiB
    // control-character document is accepted by the store's byte-size bound.
    const worstJson = JSON.stringify({
      sessionId: 'synthetic-session',
      filename: 'synthetic.txt',
      mimeType: 'text/plain',
      content: '\0'.repeat(MAX_CONTENT_BYTES),
    })
    expect(Buffer.byteLength(worstJson) + 1024 * 1024).toBeLessThan(cap)
    expect(4 * Math.ceil(MAX_CONTENT_BYTES / 3) + 1024 * 1024).toBeLessThan(cap)
    expect(MAX_CONTENT_BYTES + 1024 * 1024).toBeLessThan(cap) // multipart envelope
    expect(SKILL_FILE_MAX_BYTES * 6 + 1024 * 1024).toBeLessThan(cap)
  })

  it('keeps both SSE upstreams unbuffered with no stream/response timeout or size cap', () => {
    expect(shared).toMatch(/reverse_proxy \{args\[0\]\} \{[\s\S]*?flush_interval -1\s*\}/)
    expect(main.match(/\breverse_proxy\b/g)).toHaveLength(1)
    expect(main.match(/\bflush_interval\b/g)).toHaveLength(1)
    expect(`${main}\n${dev}`).not.toMatch(
      /\b(?:request_buffers|response_buffers|stream_timeout|read_timeout|write_timeout|response_header_timeout|timeouts)\b/,
    )
    expect(shared).toContain('encode zstd gzip')
    expect(shared).toContain('X-Content-Type-Options nosniff')
    expect(shared).toContain('Referrer-Policy strict-origin-when-cross-origin')
    expect(shared).toContain('header_up X-Forwarded-Proto {scheme}')
    expect(shared).toContain('header_up X-Forwarded-Host {host}')
  })

  it('routes release/dev hosts to their own upstream through exactly the shared guards', () => {
    expect(main.slice(main.indexOf('{$APP_DOMAIN} {')).replace(/\s+/g, ' ')).toBe(
      '{$APP_DOMAIN} { import preview app:3444 } import dev-sites/*.caddy',
    )
    expect(dev).toBe('{$DEV_APP_DOMAIN} {\n\timport preview app-dev:3444\n}')
    expect(main).toContain('email {$ACME_EMAIL}')
    expect(main).not.toContain('{$DEV_APP_DOMAIN}')
  })

  it('mounts/enables the dev site only with the clones overlay and waits for the dev app', () => {
    const proxy = clones.services.caddy
    expect(proxy.environment).toEqual([
      'DEV_APP_DOMAIN=${DEV_APP_DOMAIN:?set the separate dev hostname}',
    ])
    expect(proxy.volumes).toEqual(['./configs/Caddyfile.dev:/etc/caddy/dev-sites/dev.caddy:ro'])
    expect(proxy.depends_on['app-dev']).toEqual({ condition: 'service_healthy' })
    expect(production.services.caddy.volumes).toContain(
      './configs/Caddyfile:/etc/caddy/Caddyfile:ro',
    )
    expect(production.services.caddy.volumes.join('\n')).not.toContain('dev-sites')
    expect(production.services.caddy.environment.join('\n')).not.toContain('DEV_APP_DOMAIN')
  })
})
