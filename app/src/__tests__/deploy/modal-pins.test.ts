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
 *      Caddy filters request details from its error log (Modal ships stdout to US-stored logs).
 *   3. vLLM's serve argv carries the logging posture (`--no-log-error-stack`,
 *      `--disable-uvicorn-access-log`, never `--enable-log-requests` /
 *      `--enable-log-outputs`), the LoRA flags, the app's model alias, and a
 *      loopback bind; the server is deployed with `unauthenticated=False`.
 *      Nothing in the box fetches an image URL a request names: vLLM reads no
 *      images, and the shim (whose pinned config turns its URL-fetching image
 *      path on) is started with its documented `LIGHTNING_IMAGE_URLS=off` lock.
 *      After a restore the adapter-active check runs on the readings taken
 *      AFTER it; run on the pre-sleep ones it passes whatever the restore did.
 *   4. Everything baked into the image or a snapshot is pinned public state:
 *      a digest for vLLM, a commit for each Hub repo, sha256 per model/card file, a sha512 for
 *      Caddy — and the warm-up prompts are string LITERALS in the file, not
 *      anything read at runtime.
 *   5. The operator's instance files are git-ignored by the pattern the README
 *      promises.
 *
 * The 27B (`hames_private_27b.py`, its own Modal app, `Caddyfile.27b`) gets the
 * same five, plus the one thing that makes it a drop-in for the app's
 * `VerdaQwen` client: the name it serves and the window it allows equal what that
 * client sends and assumes. What both apps share (the vLLM pin, Caddy, the
 * image env, the restore check) lives in `vllm_box.py`, and neither app file
 * imports the other, so a change to one never discards the other's snapshots.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))
const read = (relative: string) => readFileSync(path(relative), 'utf-8')

const behaviourScript = path('../../../../deploy/modal/test_behaviour.py')
const caddyfile = read('../../../../deploy/modal/Caddyfile')
const caddyfile27b = read('../../../../deploy/modal/Caddyfile.27b')
const verdaClient = read('../../../../packages/harness-baml/baml_src/verda-client.baml')
const settings = read('../../lib/settings.ts')
const app = read('../../../../deploy/modal/hames_small_models.py')
const shared = read('../../../../deploy/modal/vllm_box.py')
const bigApp = read('../../../../deploy/modal/hames_private_27b.py')
const gitignore = read('../../../../.gitignore')

/** The raw-path expression lists, flattened to one set of public paths. */
const caddyPaths = (text: string): string[] =>
  [
    ...text.matchAll(/^\s*@\w+\s+expression `\{http\.request\.uri\.path\} in \[([^\]]+)\]`$/gm),
  ].flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((path) => path[1]))

/** Every non-comment line of a Caddyfile. */
const code = (text: string) =>
  text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
const caddyCode = code(caddyfile)
const caddyCode27b = code(caddyfile27b)

const PUBLIC_PATHS = ['/v1/chat/completions', '/v1/models', '/v1/systemone', '/health']

describe('deploy/modal: the public surface is the Caddy route list', () => {
  it('forwards exactly the five public paths', () => {
    expect(caddyCode).not.toMatch(/^\s*@\w+\s+path\s/m)
    expect(caddyPaths(caddyCode).sort()).toEqual([...PUBLIC_PATHS].sort())
    // /status is a file, not a proxy: a `handle /status` block with no upstream.
    expect(caddyCode).toMatch(/handle \/status \{[^}]*file_server[^}]*\}/)
    expect(caddyCode).not.toMatch(/handle \/status \{[^}]*reverse_proxy/)
  })

  it('proxies only to the two loopback upstreams, and ends in a 404 handler', () => {
    const proxyLines = [...caddyCode.matchAll(/^\s*reverse_proxy ([^\n{]+) \{$/gm)]
    expect(proxyLines).toHaveLength(2)
    for (const line of proxyLines) expect(line[1].trim().split(/\s+/)).toHaveLength(1)
    const upstreams = proxyLines.map((m) => m[1].trim())
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
    const logBlock = `log default {
		output stderr
		format filter {
			request>uri delete
			request>headers delete
			request>remote_ip delete
			request>remote_port delete
			request>client_ip delete
		}
	}`
    expect(caddyCode).toMatch(/^\s*admin off$/m)
    expect(caddyCode.match(/^\s*log\b/gm)).toHaveLength(1)
    expect(caddyCode).toContain(logBlock)
  })
})

/** The `_vllm_argv` list body, as one string. */
const boot = app.match(/def _boot\(self\)[\s\S]*?(?= {4}def _serve)/)?.[0] ?? ''
const serve = app.match(/def _serve\(self\)[\s\S]*?hames: ready/)?.[0] ?? ''
const download = app.match(/def download_public_weights\(\)[\s\S]*?(?=\nimage =)/)?.[0] ?? ''
const installCaddy = shared.match(/def _install_caddy\(\)[\s\S]*?(?=\n\n\n)/)?.[0] ?? ''
const vllmArgv = app.match(/def _vllm_argv\(\)[^[]*\[([\s\S]*?)\n\s*\]\n/)?.[1] ?? ''

describe('deploy/modal: the server shape and the vLLM argv', () => {
  it('is deployed behind Modal proxy auth', () => {
    expect(app).toMatch(/unauthenticated=False/)
    expect(app).not.toMatch(/unauthenticated=True/)
  })

  it('starts vLLM on loopback with the logging posture, the LoRA, and the app model alias', () => {
    expect(vllmArgv).not.toBe('')
    expect(vllmArgv.match(/"--host"/g)).toHaveLength(1)
    expect(vllmArgv).not.toContain('"--log-error-stack"')
    expect(boot).toMatch(
      /self\.vllm = subprocess\.Popen\(\s*_vllm_argv\(\),\s*stdout=subprocess\.PIPE, stderr=subprocess\.STDOUT\s*\)/,
    )
    expect(boot).toMatch(
      /target=forward_stderr,\s*args=\(self\.vllm\.stdout, self\.vllm_dropped, self\.public_ready, "vllm"\)/,
    )
    expect(boot).toMatch(
      /target=forward_stderr,\s*args=\(self\.shim\.stdout, self\.shim_dropped, self\.public_ready, "shim"\)/,
    )
    expect(boot).toContain('self.public_ready = threading.Event()')
    expect(serve).toMatch(/self\.public_ready\.set\(\)\s*self\.caddy = subprocess\.Popen/)
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

  it('re-checks the adapter after a restore on the readings taken after it', () => {
    expect(shared).toMatch(/^REFERENCE_TOLERANCE = 0\.1$/m)
    expect(serve).toContain('_reference_drift(before, after[model], model)')
    expect(boot).not.toContain('["caddy", "run"')
    expect(serve).toContain('["caddy", "run"')
    expect(app.match(/\["caddy", "run"/g)).toHaveLength(1)
    expect(serve).toMatch(
      /_assert_adapter_active\(after\[SUMMARIZER_MODEL\], after\[DECIDER_MODEL\]\)/,
    )
    expect(serve).not.toMatch(/_assert_adapter_active\(self\.reference/)
  })

  it('enables dev mode (sleep needs it) — which is why the route list above exists', () => {
    for (const file of [app, bigApp]) {
      expect(file).toMatch(/\.add_local_python_source\("log_filter", "vllm_box", copy=True\)/)
      expect(file.match(/^\s*\.env\(VLLM_IMAGE_ENV\)$/gm)).toHaveLength(1)
      expect(file).not.toContain('VLLM_LOGGING_LEVEL')
      // Neither app file imports the other: a change to one keeps the other's snapshots.
      expect(file).not.toMatch(/^(from|import) hames_/m)
    }
    expect(shared).toMatch(/"VLLM_SERVER_DEV_MODE": "1"/)
    expect(shared).not.toContain('VLLM_LOGGING_LEVEL')
    for (const [key, value] of Object.entries({
      VLLM_NO_USAGE_STATS: '1',
      DO_NOT_TRACK: '1',
      VLLM_MEDIA_URL_ALLOW_REDIRECTS: '0',
      HF_HUB_OFFLINE: '1',
    })) {
      expect(shared).toContain(`"${key}": "${value}"`)
    }
  })
})

describe('deploy/modal: what the image and a snapshot can contain is pinned public state', () => {
  it('pins both Hub repos to a commit and every card file to a sha256', () => {
    expect(shared).toMatch(/^VLLM_IMAGE = "vllm\/vllm-openai:v0\.30\.0@sha256:[0-9a-f]{64}"$/m)
    expect(installCaddy).toMatch(/if digest != CADDY_SHA512:\s*raise SystemExit/)
    expect(download).toMatch(/\n {4}_install_caddy\(\)\n/)
    for (const [files, dir] of [
      ['CARD_FILES_SHA256', 'CARD_DIR'],
      ['BASE_FILES_SHA256', 'BASE_DIR'],
    ]) {
      expect(download).toContain(`allow_patterns=list(${files})`)
      expect(download).toContain(`for relative, expected in ${files}.items():`)
      expect(download).toContain(
        `digest = hashlib.sha256((${dir} / relative).read_bytes()).hexdigest()`,
      )
    }
    expect(download.match(/if digest != expected:\s*raise SystemExit/g)).toHaveLength(2)
    const base = app.match(/BASE_FILES_SHA256 = \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const baseEntries = [...base.matchAll(/"([^"]+)": "([0-9a-f]{64})"/g)]
    expect(baseEntries.map((m) => m[1]).sort()).toEqual(
      [
        'chat_template.jinja',
        'config.json',
        'merges.txt',
        'model.safetensors-00001-of-00002.safetensors',
        'model.safetensors-00002-of-00002.safetensors',
        'model.safetensors.index.json',
        'preprocessor_config.json',
        'tokenizer.json',
        'tokenizer_config.json',
        'video_preprocessor_config.json',
        'vocab.json',
      ].sort(),
    )
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
      shared
        .match(/CADDY_SHA512 = \(\s*"([0-9a-f]+)"\s*"([0-9a-f]+)"\s*\)/)
        ?.slice(1)
        .join(''),
    ).toHaveLength(128)
  })

  it('warms up with string literals, never with anything read at runtime', () => {
    const chat = app.match(/WARMUP_CHAT_MESSAGES = \(([\s\S]*?)\n\)/)?.[1] ?? ''
    const decision = app.match(/WARMUP_DECISION = \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const reference = app.match(/REFERENCE_PROMPT = (.*)/)?.[1] ?? ''
    expect(boot).toContain('list(WARMUP_CHAT_MESSAGES)')
    expect(boot).toContain('WARMUP_DECISION)')
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

/** The `Qwen27B` class, its boot and serve methods, its argv and its download. */
const big = bigApp.slice(bigApp.indexOf('@app.server('))
const bigBoot = big.match(/def _boot\(self\)[\s\S]*?(?= {4}def _serve)/)?.[0] ?? ''
const bigServe = big.match(/def _serve\(self\)[\s\S]*?hames: ready/)?.[0] ?? ''
const bigArgv =
  bigApp.match(/def _qwen27b_argv\(mtp_tokens: int\)[^[]*\[([\s\S]*?)\n\s*\]\n/)?.[1] ?? ''
const bigDownload =
  bigApp.match(/def download_qwen27b_weights\(\)[\s\S]*?(?=\nqwen27b_image =)/)?.[0] ?? ''

describe('deploy/modal: the 27B box (Qwen27B)', () => {
  it('serves the exact model name and window the VerdaQwen client sends and assumes', () => {
    expect(big).toMatch(/^@app\.server\([^@]*?\n\)\nclass Qwen27B:/)
    const clientModel = verdaClient.match(/^\s*model "([^"]+)"$/m)?.[1]
    expect(clientModel).toBeTruthy()
    expect(bigApp).toContain(`QWEN27B_MODEL = "${clientModel}"`)
    const window = settings.match(/^\s*VerdaQwen: ([\d_]+),$/m)?.[1]?.replaceAll('_', '')
    expect(bigApp).toContain(`QWEN27B_MAX_MODEL_LEN = ${window}`)
    expect(bigArgv).toContain('"--served-model-name", QWEN27B_MODEL')
    expect(bigArgv).toContain('"--max-model-len", str(QWEN27B_MAX_MODEL_LEN)')
    expect(bigBoot).toMatch(/served != \{QWEN27B_MODEL\}/)
  })

  it('forwards exactly three public paths to the one loopback upstream, the rest is a 404', () => {
    expect(caddyCode27b).not.toMatch(/^\s*@\w+\s+path\s/m)
    expect(caddyPaths(caddyCode27b).sort()).toEqual(
      ['/v1/chat/completions', '/v1/models', '/health'].sort(),
    )
    const proxies = caddyCode27b.match(/reverse_proxy[^{]*\{[^}]*\}/g) ?? []
    expect(proxies).toHaveLength(1)
    expect(proxies[0]).toMatch(/^reverse_proxy 127\.0\.0\.1:8000 \{/)
    expect(proxies[0]).toContain('header_up -Authorization')
    expect(caddyCode27b).toMatch(/handle \/status \{[^}]*file_server[^}]*\}/)
    expect(caddyCode27b).toMatch(/handle \{\s*respond 404\s*\}/)
    for (const forbidden of [
      '/sleep',
      '/wake_up',
      '/is_sleeping',
      '/collective_rpc',
      '/v1/completions',
      '/tokenize',
      '/metrics',
    ])
      expect(caddyCode27b).not.toContain(forbidden)
    // The same global block, log filter included, as the small box's.
    expect(caddyCode27b.slice(0, caddyCode27b.indexOf(':8080'))).toBe(
      caddyCode.slice(0, caddyCode.indexOf(':8080')),
    )
    expect(bigApp).toContain(
      '.add_local_file(Path(__file__).parent / "Caddyfile.27b", "/etc/hames/Caddyfile", copy=True)',
    )
  })

  it('starts vLLM on loopback, text only, with the logging posture and the reasoning parser', () => {
    expect(bigArgv).not.toBe('')
    expect(bigArgv.match(/"--host"/g)).toHaveLength(1)
    for (const flag of [
      '"--host", "127.0.0.1"',
      '"--no-log-error-stack"',
      '"--disable-uvicorn-access-log"',
      '"--enable-sleep-mode"',
      '"--language-model-only"',
      '"--reasoning-parser", "qwen3"',
    ])
      expect(bigArgv).toContain(flag)
    for (const forbidden of [
      '--enable-log-requests',
      '--enable-log-outputs',
      '"0.0.0.0"',
      '--limit-mm-per-prompt',
    ])
      expect(bigArgv).not.toContain(forbidden)
    expect(bigBoot).toMatch(
      /target=forward_stderr,\s*args=\(self\.vllm\.stdout, self\.vllm_dropped, self\.public_ready, "vllm"\)/,
    )
    expect(bigServe).toMatch(/self\.public_ready\.set\(\)\s*self\.caddy = subprocess\.Popen/)
    expect(bigApp.match(/unauthenticated=False/g)).toHaveLength(1)
    expect(bigApp).not.toMatch(/unauthenticated=True/)
    expect(big).toMatch(/^\s*image=qwen27b_image,$/m)
    expect(bigApp).toMatch(/\.run_function\(download_qwen27b_weights\)\s*\.env\(VLLM_IMAGE_ENV\)/)
  })

  it('injects the argv inputs into the container, so it runs what was deployed', () => {
    expect(big).toContain('"HAMES_MODAL_27B_MTP_TOKENS": str(QWEN27B_MTP_TOKENS)')
    expect(big).toContain('"HAMES_MODAL_27B_TARGET_CONCURRENCY": str(QWEN27B_TARGET_CONCURRENCY)')
    expect(bigBoot).toContain('_qwen27b_argv(QWEN27B_MTP_TOKENS)')
  })

  it('checks after a restore on readings taken after it, before Caddy listens', () => {
    expect(bigServe).toContain(
      'after = _reference_logprobs(QWEN27B_MODEL, QWEN27B_REFERENCE_PROMPT)',
    )
    expect(bigServe).toContain('_reference_drift(self.reference, after, QWEN27B_MODEL)')
    expect(bigServe).toMatch(/if _qwen27b_answer\(\) != QWEN27B_ANSWER:\s*raise RuntimeError/)
    expect(bigServe).toMatch(
      /now = _draft_acceptance\(\)[\s\S]*if now < before - QWEN27B_DRAFT_TOLERANCE:\s*raise/,
    )
    expect(bigServe.indexOf('_qwen27b_answer()')).toBeLessThan(bigServe.indexOf('["caddy", "run"'))
    expect(bigBoot).not.toContain('["caddy", "run"')
  })

  it('pins the 27B repo to a commit and every file to a sha256, verified at build', () => {
    expect(bigApp).toMatch(/^QWEN27B_REVISION = "[0-9a-f]{40}"$/m)
    const pins = bigApp.match(/QWEN27B_FILES_SHA256 = \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const entries = [...pins.matchAll(/"([^"]+)": "([0-9a-f]{64})"/g)]
    expect(entries).toHaveLength(pins.split('\n').filter((l) => l.trim()).length)
    const names = entries.map((m) => m[1])
    for (let i = 0; i < 64; i++) expect(names).toContain(`layers-${i}.safetensors`)
    for (const name of [
      'config.json',
      'chat_template.jinja',
      'mtp.safetensors',
      'outside.safetensors',
      'tokenizer.json',
    ])
      expect(names).toContain(name)
    expect(bigDownload).toContain('allow_patterns=list(QWEN27B_FILES_SHA256)')
    expect(bigDownload).toMatch(
      /digest = _sha256_file\(QWEN27B_DIR \/ relative\)\s*if digest != expected:\s*raise SystemExit/,
    )
    expect(bigDownload).toContain('_install_caddy()')
  })

  it('warms up and checks with string literals only', () => {
    for (const name of ['QWEN27B_WARMUP_MESSAGES', 'QWEN27B_ANSWER_MESSAGES']) {
      const block = bigApp.match(new RegExp(`${name} = \\(([\\s\\S]*?)\\n\\)`))?.[1] ?? ''
      expect(block).toMatch(/"content": '?"?[^"]+/)
      expect(block).not.toMatch(/os\.environ|open\(|read|f"|\.get\(|input\(/)
    }
    expect(bigApp.match(/QWEN27B_REFERENCE_PROMPT = (.*)/)?.[1]).toMatch(/^"[^"]+"$/)
    expect(bigBoot).toContain('list(QWEN27B_WARMUP_MESSAGES)')
  })
})

describe('deploy/modal: the instance files stay out of git', () => {
  it('ignores deploy/modal/*.local.*', () => {
    expect(gitignore).toMatch(/^deploy\/modal\/\*\.local\.\*$/m)
  })
})

// ci.yml's ubuntu-latest runner supplies python3; no Modal SDK or pytest needed.
describe('deploy/modal: Python behaviour (hermetic unit layer)', () => {
  it('withholds traceback payloads and rejects swapped or nonfinite references', () => {
    expect(() =>
      execFileSync('python3', [behaviourScript], { encoding: 'utf8', timeout: 10000 }),
    ).not.toThrow()
  })
})
