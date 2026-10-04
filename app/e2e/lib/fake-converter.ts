/**
 * A fake document converter at `DOC_CONVERT_URL`, that fails closed.
 *
 * ## Where it sits
 *
 * `@hames-ai/harness-patterns/stash/doc-convert.server.ts` turns a binary
 * document into Markdown by posting it to a kreuzberg sidecar: `POST /extract`,
 * a multipart body with one `files` part and a JSON `config` part. It reads the
 * sidecar's base URL from `DOC_CONVERT_URL` on every call, so pointing that
 * variable here is the shipped seam, unmodified, the same way `VerdaQwen` reaches
 * the fake inference endpoint. `app.ts#bootApp` does it in BOTH modes: the live
 * mode measures the inference route, and a real converter in layer 2 would make
 * a red result depend on whatever build a developer happens to run (the real
 * one is layer 4's: spec §8). `src/__tests__/e2e-fakes-boundary.test.ts` pins
 * that no production module reaches this file.
 *
 * ## What it answers
 *
 * Only the synthetic inputs listed in `e2e/fixtures/converter/manifest.json`,
 * each with its fixed Markdown, in the stable kreuzberg 4.x reply shape (a bare
 * array, which `extractMarkdown` reads). An input is identified by the SHA-256
 * of its bytes AND the part's declared type, because kreuzberg picks its parser
 * from that type (spec §5.1, F12): the right bytes under the wrong type are a
 * different request. A pipeline that rewrites the bytes before conversion
 * (spec §5.3's disarm) sends different bytes, and needs its own manifest entry.
 *
 * ## Failing closed
 *
 * Anything else is refused with an error status and a body that names what was
 * refused: a route other than `POST /extract`, a request without exactly one
 * file, a `config` it cannot honour (kreuzberg's `ExtractionConfig` is
 * `deny_unknown_fields`, so an unknown field is refused here too, by name), and
 * bytes or a type no manifest entry holds. Never a default document. The
 * production client reports only the status, so every refusal is also
 * RECORDED, and {@link FakeConverter.assertAllMatched} fails a scenario that
 * caused one, naming the digest, the filename and the type.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fixtureFile } from './fake-graph'

/** One request, as the fake saw it. */
export interface ConverterRequestRecord {
  method: string
  path: string
  status: number
  /** Set once the body parsed as a single file. */
  file?: { sha256: string; filename: string; mimeType: string }
}

export interface FakeConverter {
  /** The value for `DOC_CONVERT_URL`: a base URL with no trailing slash. */
  readonly url: string
  readonly requests: readonly ConverterRequestRecord[]
  /** Every refused request, with the reason. */
  readonly unmatched: readonly string[]
  /** Throw, naming each one, if any request was refused. */
  assertAllMatched(): void
  /** Forget the recorded requests (not the fixtures). */
  reset(): void
  /** Stop listening. Never call it on `bootApp`'s instance, which every
   *  scenario file in the process shares. */
  close(): Promise<void>
}

interface ManifestEntry {
  file: string
  mimeType: string
  markdown: string
}

/** The `ExtractionConfig` fields the fake understands. A real kreuzberg field
 *  missing here is refused: extend this list together with what it means. */
const KNOWN_CONFIG = ['output_format', 'max_archive_depth', 'use_cache'] as const

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function loadManifest(): Map<string, ManifestEntry> {
  const { entries } = JSON.parse(
    readFileSync(new URL('../fixtures/converter/manifest.json', import.meta.url), 'utf8'),
  ) as { entries: ManifestEntry[] }
  const byDigest = new Map<string, ManifestEntry>()
  for (const entry of entries) {
    const digest = sha256(fixtureFile(entry.file))
    if (byDigest.has(digest)) {
      throw new Error(`[fake-converter] ${entry.file} has the same bytes as another entry`)
    }
    byDigest.set(digest, entry)
  }
  return byDigest
}

/** Start a fake converter on an ephemeral loopback port. */
export async function startFakeConverter(): Promise<FakeConverter> {
  const manifest = loadManifest()
  const requests: ConverterRequestRecord[] = []
  const unmatched: string[] = []

  /** Answer one request: the manifest's reply, or a recorded refusal. */
  async function handle(
    req: http.IncomingMessage,
    record: ConverterRequestRecord,
  ): Promise<{ status: number; body: unknown }> {
    const refuse = (status: number, reason: string) => {
      unmatched.push(`${record.method} ${record.path}: ${reason}`)
      return {
        status,
        body: { error_type: 'FakeConverterRefusal', message: `[fake-converter] ${reason}` },
      }
    }

    if (record.path !== '/extract') {
      return refuse(
        404,
        `no route ${record.method} ${record.path}; the fake serves POST /extract only`,
      )
    }
    if (record.method !== 'POST') return refuse(405, `${record.method} /extract is not modelled`)

    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    let form: FormData
    try {
      form = await new Response(Buffer.concat(chunks), {
        headers: { 'content-type': req.headers['content-type'] ?? '' },
      }).formData()
    } catch {
      return refuse(400, 'the body is not multipart/form-data')
    }

    const files = form.getAll('files')
    const [file] = files
    if (files.length !== 1 || !(file instanceof File)) {
      return refuse(400, `expected exactly one file in the "files" part, got ${files.length}`)
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    record.file = { sha256: sha256(bytes), filename: file.name, mimeType: file.type }

    const rawConfig = form.get('config')
    if (typeof rawConfig !== 'string') {
      return refuse(400, 'no config part: the fake answers output_format "markdown" only')
    }
    let config: unknown
    try {
      config = JSON.parse(rawConfig)
    } catch {
      return refuse(400, 'the config part is not JSON')
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return refuse(400, 'the config part is not a JSON object')
    }
    const unknownField = Object.keys(config).find(
      (k) => !(KNOWN_CONFIG as readonly string[]).includes(k),
    )
    if (unknownField) return refuse(400, `unknown config field \`${unknownField}\``)
    const format = (config as { output_format?: unknown }).output_format
    if (format !== 'markdown') {
      return refuse(
        400,
        `config output_format is ${JSON.stringify(format)}; the fake answers "markdown" only`,
      )
    }

    const entry = manifest.get(record.file.sha256)
    const named = `sha256 ${record.file.sha256} (${file.name}, ${file.type || 'no type'})`
    if (!entry) return refuse(422, `no manifest entry for ${named}`)
    if (entry.mimeType !== file.type) {
      return refuse(
        422,
        `${named} is ${entry.file}, which the manifest declares as ${entry.mimeType}`,
      )
    }
    return {
      status: 200,
      body: [{ content: entry.markdown, mime_type: entry.mimeType, metadata: {} }],
    }
  }

  const server = http.createServer((req, res) => {
    const record: ConverterRequestRecord = {
      method: req.method ?? 'GET',
      path: (req.url ?? '/').split('?')[0],
      status: 0,
    }
    requests.push(record)
    handle(req, record)
      .catch((err: unknown) => {
        const reason = `the fake failed: ${err instanceof Error ? err.message : String(err)}`
        unmatched.push(`${record.method} ${record.path}: ${reason}`)
        return { status: 500, body: { error_type: 'FakeConverterFailure', message: reason } }
      })
      .then(({ status, body }) => {
        record.status = status
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    get requests() {
      return requests
    },
    get unmatched() {
      return unmatched
    },
    assertAllMatched() {
      if (unmatched.length > 0) {
        throw new Error(
          `[fake-converter] ${unmatched.length} request(s) were refused:\n  ${unmatched.join('\n  ')}`,
        )
      }
    },
    reset() {
      requests.length = 0
      unmatched.length = 0
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
