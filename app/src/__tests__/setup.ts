/**
 * Vitest Setup File
 *
 * Configures the test environment before tests run.
 */
import { resolveTestDatabase } from './test-database'
import { File as NodeFile } from 'node:buffer'

// At-rest encryption key for the Postgres columns holding user content and
// personal data (`lib/db/crypto.server.ts`). Set here rather than per test file
// because every DB-backed suite now needs it, and because the alternative — a
// key-less default — would have the whole suite exercise only the throwing
// path. Suites that test the *absence* of a key delete this variable for the
// duration of the assertion; the key is resolved per call, not at import, so
// that works.
process.env.DATA_ENCRYPTION_KEY ||= 'unit-test-data-encryption-key'

// Unit tests must never discover or call the hosted Exa endpoint, even when a
// developer's app/.env has a real key. The transport's own tests pass explicit
// selections and mock the MCP client.
process.env.EXA_TOOLS = 'off'
// Same for the hosted Lenny's Data endpoint: a developer's env can carry its live
// credentials and allowlist, and the transport's own tests inject a fake fetch.
process.env.LENNYS_DATA_MCP = 'off'

// Never let a test run touch the dev database. Unconditional (not `||=`): the
// point is that a developer's own DATABASE_URL cannot leak in, because
// `initSchema()`'s encryption backfill would rewrite their real rows with the
// unit-test key above. `global-setup.ts` provisions this database, and the
// same guard decides it there first: no `localhost:5432` without the opt-in.
process.env.DATABASE_URL = resolveTestDatabase('hames_test', { skipInCi: true }).url

// Vitest's jsdom environment leaves the worker's `Request` bound to Node's
// undici, but undici resolves the global `File` at TWO seams, and vitest's
// jsdom global swap breaks both on Node 24 (undici 7):
//
// 1. THE PARSE (`Request.prototype.formData()`): the multipart parser
//    constructs each file entry with `new File(...)` resolved from the GLOBAL
//    scope, while its own brand check (`webidl.is.File`) was captured against
//    Node's File when undici first loaded — before vitest swapped the global
//    to jsdom's File. The constructed jsdom File then fails the brand check:
//    `AssertionError ... webidl.is.File` inside the parse. undici 6 (Node 22)
//    captured its File at module load, before the swap, so only Node 24
//    fails.
//
// 2. THE CONSTRUCTION: undici serialises a FormData body eagerly inside the
//    Request constructor, wrapping every Blob entry in `new File([value],
//    ...)` to give it a Content-Disposition filename — and it resolves that
//    `File` from the GLOBAL scope at construction time. Vitest's compat layer
//    converts jsdom FormData entries into `node:buffer` Blobs, which jsdom's
//    File cannot read the bytes of, so with jsdom's File global the wrapped
//    entry serialises with NO content: every file body is silently dropped
//    from the wire. (Measured: the same request built under a Node File
//    global carries the bytes; built under jsdom's, the part is empty.)
//
// Restoring Node's File globally is NOT an option: component code and
// component tests build their uploads with jsdom's constructors, and jsdom's
// FormData stringifies anything that is not a jsdom Blob (three upload-panel
// tests depend on that). So the restore is scoped to the two undici seams:
// while a Request with a FormData body is being constructed, and while a
// multipart parse is in flight, the global File is temporarily Node's — the
// class undici both constructs and brand-checks — and is restored afterwards.
// Everything built outside those seams keeps the realm it had.
// Seam 1: the multipart parse. The parser constructs its file entries from
// the wire with the global File and brand-checks them against its own, so
// both sides must see Node's File for the duration of the parse.
const requestProto = globalThis.Request.prototype as unknown as {
  formData: () => Promise<FormData>
}
const originalFormData = requestProto.formData
requestProto.formData = async function (this: Request) {
  const g = globalThis as { File?: unknown }
  const realmFile = g.File
  g.File = NodeFile
  try {
    // The swap must be held across the WHOLE parse: the parser constructs its
    // file entries in an async continuation, so a synchronous set/restore would
    // release the global before the entries are built.
    return await originalFormData.call(this)
  } finally {
    g.File = realmFile
  }
}

// Seam 2: the constructor's eager FormData serialisation. Bodies that carry a
// `forEach` (both realms' FormData) get Node's File for the duration of the
// super() call, which spans vitest's compat conversion and undici's
// extractBody; every other body kind (string, Blob, Buffer, stream) is
// untouched.
const VitestRequest = globalThis.Request as unknown as new (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Request
class RequestWithFileRealm extends VitestRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const body = init?.body as { forEach?: unknown } | undefined
    if (body == null || typeof body.forEach !== 'function') {
      super(input, init)
      return
    }
    const g = globalThis as { File?: unknown }
    const realmFile = g.File
    g.File = NodeFile
    try {
      super(input, init)
    } finally {
      g.File = realmFile
    }
  }
}
globalThis.Request = RequestWithFileRealm as unknown as typeof Request
