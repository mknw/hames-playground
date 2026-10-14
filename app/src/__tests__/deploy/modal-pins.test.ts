/**
 * The Modal deployment of the small models (`deploy/modal/`) — source-scan pins.
 *
 * That directory is Python and Caddy config, outside every other suite, and
 * what it protects is decided by LITERALS: which paths Caddy forwards, which
 * flags vLLM is started with, whether the proxy auth is on, and what the
 * snapshot can contain. Each of those is one edit from reading like protection
 * and matching nothing, which is the failure class the sensitive-domain brief
 * names first (SD-5's "present but unreachable"). None would error at deploy:
 * an extra Caddy route serves, a dropped `--no-log-error-stack` logs more, an
 * `unauthenticated=True` deploys fine and answers everyone.
 *
 * Five claims, each verified by mutation when written:
 *
 *   1. Caddy forwards EXACTLY the five public paths, and only to the two
 *      loopback upstreams; everything else is the 404 handler. vLLM's dev-mode
 *      routes (/sleep, /wake_up, /collective_rpc) and the shim's raw upstreams
 *      (/v1/completions, /tokenize) must not appear.
 *   2. The inbound Authorization header is stripped on every proxied route and
 *      Caddy has no `log` block (Modal ships stdout to US-stored logs).
 *   3. vLLM's serve argv carries the logging posture (`--no-log-error-stack`,
 *      `--disable-uvicorn-access-log`, never `--enable-log-requests` /
 *      `--enable-log-outputs`), the LoRA flags, the app's model alias, and a
 *      loopback bind; the server is deployed with `unauthenticated=False`.
 *      Nothing in the box fetches an image URL a request names: vLLM reads no
 *      images, and the shim (whose pinned config turns its URL-fetching image
 *      path on) is started with its documented `LIGHTNING_IMAGE_URLS=off` lock.
 *   4. Everything baked into the image or a snapshot is pinned public state:
 *      a commit hash for each Hub repo, a sha256 per card file, a sha512 for
 *      Caddy — and the warm-up prompts are string LITERALS in the file, not
 *      anything read at runtime.
 *   5. The operator's instance files are git-ignored by the pattern the README
 *      promises.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8')

const caddyfile = read('../../../../deploy/modal/Caddyfile')
const app = read('../../../../deploy/modal/hames_small_models.py')
const gitignore = read('../../../../.gitignore')

/** The `path …` matcher lines, flattened to one set of public paths. */
const caddyPaths = (text: string): string[] =>
  [...text.matchAll(/^\s*@\w+\s+path\s+(.+)$/gm)].flatMap((m) => m[1].trim().split(/\s+/))

/** Every non-comment line of the Caddyfile. */
const caddyCode = caddyfile
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n')

const PUBLIC_PATHS = ['/v1/chat/completions', '/v1/models', '/v1/systemone', '/health']

describe('deploy/modal: the public surface is the Caddy route list', () => {
  it('forwards exactly the five public paths', () => {
    expect(caddyPaths(caddyCode).sort()).toEqual([...PUBLIC_PATHS].sort())
    // /status is a file, not a proxy: a `handle /status` block with no upstream.
    expect(caddyCode).toMatch(/handle \/status \{[^}]*file_server[^}]*\}/)
    expect(caddyCode).not.toMatch(/handle \/status \{[^}]*reverse_proxy/)
  })

  it('proxies only to the two loopback upstreams, and ends in a 404 handler', () => {
    const upstreams = [...caddyCode.matchAll(/reverse_proxy\s+(\S+)/g)].map((m) => m[1])
    expect(upstreams.sort()).toEqual(['127.0.0.1:8000', '127.0.0.1:8741'])
    expect(caddyCode).toMatch(/handle \{\s*respond 404\s*\}/)
  })

  it('never names a vLLM dev-mode route or a shim-internal upstream route', () => {
    for (const forbidden of [
      '/sleep',
      '/wake_up',
      '/is_sleeping',
      '/collective_rpc',
      '/v1/completions',
      '/tokenize',
    ]) {
      expect(caddyCode).not.toContain(forbidden)
    }
  })

  it('strips the inbound Authorization header on every proxied route and writes no access log', () => {
    const proxies = caddyCode.match(/reverse_proxy[^{]*\{[^}]*\}/g) ?? []
    expect(proxies).toHaveLength(2)
    for (const block of proxies) expect(block).toContain('header_up -Authorization')
    expect(caddyCode).not.toMatch(/^\s*log\b/m)
  })
})

/** The `_vllm_argv` list body, as one string. */
const vllmArgv = app.match(/def _vllm_argv\(\)[^[]*\[([\s\S]*?)\n\s*\]\n/)?.[1] ?? ''

describe('deploy/modal: the server shape and the vLLM argv', () => {
  it('is deployed behind Modal proxy auth', () => {
    expect(app).toMatch(/unauthenticated=False/)
    expect(app).not.toMatch(/unauthenticated=True/)
  })

  it('starts vLLM on loopback with the logging posture, the LoRA, and the app model alias', () => {
    expect(vllmArgv).not.toBe('')
    for (const flag of [
      '"--no-log-error-stack"',
      '"--disable-uvicorn-access-log"',
      '"--enable-lora"',
      '"--enable-sleep-mode"',
      '"--host", "127.0.0.1"',
      '"--served-model-name", SUMMARIZER_MODEL',
      '"--lora-modules", f"{DECIDER_MODEL}=',
    ]) {
      expect(vllmArgv).toContain(flag)
    }
    for (const forbidden of ['--enable-log-requests', '--enable-log-outputs', '"0.0.0.0"']) {
      expect(vllmArgv).not.toContain(forbidden)
    }
    expect(app).toMatch(/SUMMARIZER_MODEL = "qwen3\.5-4b-instruct"/)
    expect(app).toMatch(/"--host", "127\.0\.0\.1", "--port", str\(SHIM_PORT\)/)
  })

  it('lets nothing fetch an image URL: vLLM reads no images, the shim refuses image URLs', () => {
    expect(vllmArgv).toContain('"--limit-mm-per-prompt", json.dumps({"image": 0, "video": 0})')
    expect(app).toMatch(/^SHIM_ENV = \{"LIGHTNING_IMAGE_URLS": "off"\}$/m)
    expect(app).toMatch(
      /subprocess\.Popen\(\s*_shim_argv\(\), env=\{\*\*os\.environ, \*\*SHIM_ENV\}/,
    )
  })

  it('enables dev mode (sleep needs it) — which is why the route list above exists', () => {
    expect(app).toMatch(/"VLLM_SERVER_DEV_MODE": "1"/)
  })
})

describe('deploy/modal: what the image and a snapshot can contain is pinned public state', () => {
  it('pins both Hub repos to a commit and every card file to a sha256', () => {
    expect(app).toMatch(/BASE_REVISION = "[0-9a-f]{40}"/)
    expect(app).toMatch(/CARD_REVISION = "[0-9a-f]{40}"/)
    const shas = app.match(/CARD_FILES_SHA256 = \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const entries = [...shas.matchAll(/"([^"]+)": "([0-9a-f]+)"/g)]
    expect(entries.map((m) => m[1]).sort()).toEqual(
      [
        'adapter/adapter_config.json',
        'adapter/adapter_model.safetensors',
        'h2o_lightning_shim.py',
        'serve_config.json',
      ].sort(),
    )
    for (const [, , sha] of entries) expect(sha).toHaveLength(64)
    expect(
      app
        .match(/CADDY_SHA512 = \(\s*"([0-9a-f]+)"\s*"([0-9a-f]+)"\s*\)/)
        ?.slice(1)
        .join(''),
    ).toHaveLength(128)
  })

  it('warms up with string literals, never with anything read at runtime', () => {
    const chat = app.match(/WARMUP_CHAT_MESSAGES = \(([\s\S]*?)\n\)/)?.[1] ?? ''
    const decision = app.match(/WARMUP_DECISION = \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const reference = app.match(/REFERENCE_PROMPT = (.*)/)?.[1] ?? ''
    expect(chat).not.toBe('')
    expect(decision).not.toBe('')
    expect(reference).toMatch(/^"[^"]+"$/)
    // Values are quoted strings, dicts or ints; no name reference, call or f-string.
    for (const block of [chat, decision]) {
      expect(block).toMatch(/"content": "[^"]+"|"state": "[^"]+"/)
      expect(block).not.toMatch(/os\.environ|open\(|read|f"|\.get\(|input\(/)
    }
  })
})

describe('deploy/modal: the instance files stay out of git', () => {
  it('ignores deploy/modal/*.local.*', () => {
    expect(gitignore).toMatch(/^deploy\/modal\/\*\.local\.\*$/m)
  })
})
