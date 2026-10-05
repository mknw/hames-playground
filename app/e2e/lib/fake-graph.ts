/**
 * A fake Microsoft Graph, at the `graphFetch` seam, that fails closed.
 *
 * ## Where it sits
 *
 * The Graph tools in `@hames-ai/connectors` never fetch anything themselves:
 * they close over the `graphFetch` their composition root hands to
 * `registerGraphConnectorTools` (`GraphConnectorDeps.graphFetch`). In the app
 * that is `auth/graph-token.server.ts`'s, which mints a delegated token for the
 * signed-in person and calls `graph.microsoft.com`. This module is a second
 * implementation of the same function type, `GraphFetchFn`, that answers from
 * the synthetic fixtures under `e2e/fixtures/graph/` instead. Everything above
 * the seam (the tools' query composition, shaping, size and denial guards) is
 * the real code, unchanged.
 *
 * The substitution happens on the TEST side, like `baml-route.ts`'s client
 * registry: the app gains no switch that could point Graph somewhere else
 * (SD-12). {@link composeGraphTools} builds a tool registry over this fake, and
 * `app.ts#installGraphTools` puts that registry behind the real `callTool`.
 * `src/__tests__/e2e-fakes-boundary.test.ts` pins that no production module
 * reaches this file.
 *
 * ## Failing closed
 *
 * A request the fixtures do not model is an ERROR, never a quiet empty answer.
 * An unknown path, an id no fixture holds, a query option the route does not
 * model, a filter it cannot evaluate, a host that is not Graph, a request
 * header or a GET body (the real `graphFetch` forwards both, and they change
 * the answer), a body asked for in the wrong encoding: each throws
 * {@link UnmatchedGraphRequest}, whose message names the method, the path and
 * the reason. A fault inside the fake itself (a malformed id that will not
 * decode, say) is recorded the same way. The throw alone is not
 * enough, because the tool registry turns every throw into
 * `{ success: false, error }` and a model may carry on around a failed tool.
 * So every refusal is also RECORDED, and {@link FakeGraph.assertAllMatched}
 * fails a scenario that made one. A new Graph call in the code under test
 * therefore shows up as a named red, never as a silently empty list.
 *
 * A Graph ERROR is different, and is modelled on purpose: a drive item with
 * `"error": { "status": 403 }` answers every route with that status, the way
 * the real `graphFetch` reports it (401 and 403 as `GraphAuthRequiredError`,
 * anything else as a plain `Error`). It counts as matched, because a fixture
 * asked for it, and only an error a fixture asked for does. Such an item is
 * left out of folder listings.
 *
 * ## What it models
 *
 * The routes the HITL scenarios read (#433): the signed-in user, OneDrive and
 * SharePoint drive items with their metadata, children and content, and inbox
 * messages with their attachments (as a list, as JSON with `contentBytes`, and
 * as raw bytes). Each route lists the query options it models. `$select`
 * PROJECTS: a field the caller did not select is not returned, so a provenance
 * check that forgot to widen its `$select` sees what live Graph would show it,
 * which is nothing.
 *
 * The fixtures assume a home tenancy of `contoso.com`: the signed-in user and
 * the "inside" identities are on it, the "outside" ones are on `fabrikam.com`.
 * Which domains count as home is deployment configuration in the app, so a
 * scenario that classifies provenance configures `contoso.com` as home.
 *
 * A list cut short by `$top` says so, the way Graph does, with an
 * `@odata.nextLink`; following that link is refused, because paging is not
 * modelled. A caller that reads a short list as complete is therefore caught.
 *
 * NOT modelled, so refused: Microsoft Search (`POST /search/query`), insights,
 * the calendar, sent items, paging, and every write. Add a route when a
 * scenario needs one; never widen a route to answer what it does not model.
 *
 * The binary content files are generated, not hand-made:
 * `fixture-binaries.ts` writes them, and scenario 10 pins that the committed
 * bytes are exactly what it writes.
 */
import { readFileSync } from 'node:fs'
import { GraphAuthRequiredError } from '@hames-ai/connectors/graph/graph-auth'
import type { AppToolRegistry } from '@hames-ai/connectors/app-tools/registry'
import type {
  GraphContentClassifier,
  GraphFetchFn,
  GraphFetchInit,
  GraphStashBridge,
} from '@hames-ai/connectors/graph/graph-tools.server'

/** The base the real `graphFetch` puts before a relative path. An absolute
 *  URL must start with it, or it is refused. */
export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

const FIXTURES = new URL('../fixtures/', import.meta.url)

type Json = Record<string, unknown>

/** A drive item fixture: the Graph `driveItem`, plus what the fake needs. */
interface DriveItemFixture {
  item: Json
  /** A file under `fixtures/files/`, served by `/content`. Absent: no content. */
  content?: string
  /** Every route on this item answers this HTTP status. */
  error?: { status: number }
}

interface AttachmentFixture {
  attachment: Json
  content: string
}

interface MessageFixture {
  folder: string
  message: Json
  attachments: AttachmentFixture[]
}

/** One request, as the fake saw it. */
export interface GraphRequestRecord {
  userId: string
  method: string
  path: string
  /** The scopes the caller asked the token for, as it passed them. */
  scopes?: readonly string[]
  /** The route that answered, or null when the request was refused. */
  route: string | null
}

/** A request no fixture models. Its message names the method, path and reason. */
export class UnmatchedGraphRequest extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly reason: string,
  ) {
    super(
      `[fake-graph] no fixture for ${method} ${path}: ${reason}. Model it under ` +
        'app/e2e/fixtures/graph/, or the code under test made a Graph call the suite does not expect.',
    )
    this.name = 'UnmatchedGraphRequest'
  }
}

export interface FakeGraph {
  /** Drop-in for the app's `graphFetch`. */
  readonly graphFetch: GraphFetchFn
  /** Every request, in order. */
  readonly requests: readonly GraphRequestRecord[]
  /** Every refused request, as `METHOD path: reason`. */
  readonly unmatched: readonly string[]
  /** Throw, naming each one, if any request was refused. */
  assertAllMatched(): void
  /** Forget the recorded requests (not the fixtures). */
  reset(): void
}

/** What a route sees of the request it answers. */
interface RouteRequest {
  userId: string
  method: string
  path: string
  /** `path` relative to {@link GRAPH_BASE}, without its query. */
  bare: string
  query: URLSearchParams
  /** Refuse the request: throws {@link UnmatchedGraphRequest}. */
  refuse: (reason: string) => never
}

interface Route {
  name: string
  pattern: RegExp
  /** The query options this route models; any other is refused. */
  options: readonly string[]
  /** The request headers this route models; any other is refused. */
  headers?: readonly string[]
  /** `bytes` routes answer base64, and must be asked for with `responseType: 'base64'`. */
  body: 'json' | 'bytes'
  answer(params: string[], req: RouteRequest): unknown
}

/** The bytes of a file under `fixtures/files/`. */
export function fixtureFile(name: string): Buffer {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`[fake-graph] bad fixture file name ${name}`)
  return readFileSync(new URL(`files/${name}`, FIXTURES))
}

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`graph/${name}`, FIXTURES), 'utf8')) as T
}

const parentOf = (item: Json): Json => (item.parentReference ?? {}) as Json

/** Give a resource with content the size of its bytes, and refuse a fixture
 *  whose declared size disagrees with them. */
function sized(resource: Json, content: string | undefined): Json {
  if (!content) return resource
  const size = fixtureFile(content).length
  if (resource.size !== undefined && resource.size !== size) {
    throw new Error(
      `[fake-graph] ${String(resource.id)} declares size ${String(resource.size)}, but ${content} is ${size} bytes`,
    )
  }
  return { ...resource, size }
}

/** `$select`: the selected fields, plus the ones Graph returns regardless. */
function project(resource: Json, select: string | null, always: readonly string[]): Json {
  if (select === null) return resource
  const out: Json = {}
  for (const key of [...always, ...select.split(',').map((f) => f.trim())]) {
    if (key && key in resource) out[key] = resource[key]
  }
  return out
}

/** A collection, cut to `$top` (a positive integer when present). A list that
 *  was cut short carries an `@odata.nextLink`, as Graph's does; following it is
 *  refused, because no route models `$skiptoken`. */
function page(list: Json[], req: RouteRequest): Json {
  const raw = req.query.get('$top')
  if (raw === null) return { value: list }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) req.refuse(`$top=${raw} is not a positive integer`)
  if (list.length <= n) return { value: list }
  return {
    value: list.slice(0, n),
    '@odata.nextLink': `${GRAPH_BASE}${req.bare}?$skiptoken=e2e-unmodelled`,
  }
}

/** The `$filter` clauses the mail tools send, joined by `and`. */
function mailFilter(req: RouteRequest): (m: Json) => boolean {
  const filter = req.query.get('$filter')
  if (filter === null) return () => true
  const tests = filter.split(' and ').map((clause): ((m: Json) => boolean) => {
    const flag = /^(hasAttachments|isRead) eq (true|false)$/.exec(clause)
    if (flag) return (m) => (m[flag[1]] === true) === (flag[2] === 'true')
    const when = /^receivedDateTime (ge|gt|le|lt) (\S+)$/.exec(clause)
    if (!when) return req.refuse(`$filter clause "${clause}" is not modelled`)
    const bound = Date.parse(when[2])
    if (Number.isNaN(bound)) req.refuse(`$filter date ${when[2]} does not parse`)
    const compare = {
      ge: (t: number) => t >= bound,
      gt: (t: number) => t > bound,
      le: (t: number) => t <= bound,
      lt: (t: number) => t < bound,
    }[when[1] as 'ge' | 'gt' | 'le' | 'lt']
    return (m) => compare(Date.parse(String(m.receivedDateTime)))
  })
  return (m) => tests.every((t) => t(m))
}

/**
 * Build a fake Graph over the committed fixtures. Each call returns its own
 * request log over the same read-only fixtures.
 */
export function createFakeGraph(): FakeGraph {
  const me = readJson<Json>('me.json')
  const drive = readJson<{ meDriveId: string; items: DriveItemFixture[] }>('drive.json')
  const mail = readJson<{ messages: MessageFixture[] }>('mail.json')

  const items: DriveItemFixture[] = drive.items.map((f) => ({
    ...f,
    item: sized(f.item, f.content),
  }))
  const messages: MessageFixture[] = mail.messages.map((m) => ({
    ...m,
    attachments: (m.attachments ?? []).map((a) => ({
      ...a,
      attachment: sized(a.attachment, a.content),
    })),
  }))
  // A shortcut's `remoteItem` repeats its target's size; a regenerated
  // content file must not leave the two disagreeing.
  for (const { item } of items) {
    const remote = item.remoteItem as Json | undefined
    if (!remote) continue
    const target = items.find(
      (t) => t.item.id === remote.id && parentOf(t.item).driveId === parentOf(remote).driveId,
    )
    if (target && remote.size !== undefined && remote.size !== target.item.size) {
      throw new Error(
        `[fake-graph] shortcut ${String(item.id)} disagrees with ${String(remote.id)} on size`,
      )
    }
  }

  const requests: GraphRequestRecord[] = []
  const unmatched: string[] = []
  /** The Graph errors a fixture asked for. Any other throw is a fault. */
  const modelled = new WeakSet<object>()

  /** Item `id` on `driveId`, or a refusal. An error modelled on the item is
   *  raised here, the way the real `graphFetch` raises it. */
  function itemOn(driveId: string | undefined, id: string, req: RouteRequest): DriveItemFixture {
    const onDrive = driveId ?? drive.meDriveId
    const hit = items.find((f) => f.item.id === id && parentOf(f.item).driveId === onDrive)
    if (!hit) return req.refuse(`no drive item ${id} on drive ${onDrive}`)
    const status = hit.error?.status
    if (status === undefined) return hit
    const e =
      status === 401 || status === 403
        ? new GraphAuthRequiredError(
            `Microsoft Graph denied the request (${status}) — the account may lack consent for this scope.`,
            req.userId,
            status,
          )
        : new Error(`[graph] ${req.method} ${req.path} failed: ${status}`)
    modelled.add(e)
    throw e
  }

  function children(req: RouteRequest, under: (parent: Json) => boolean): Json {
    const listed = items
      .filter((f) => !f.error && under(parentOf(f.item)))
      .map((f) => project(f.item, req.query.get('$select'), ['id']))
    return page(listed, req)
  }

  function messageById(id: string, req: RouteRequest): MessageFixture {
    return messages.find((m) => m.message.id === id) ?? req.refuse(`no message ${id}`)
  }

  function attachmentOf(id: string, attId: string, req: RouteRequest): AttachmentFixture {
    return (
      messageById(id, req).attachments.find((a) => a.attachment.id === attId) ??
      req.refuse(`message ${id} has no attachment ${attId}`)
    )
  }

  function attachmentJson(a: AttachmentFixture, select: string | null): Json {
    const full = { ...a.attachment, contentBytes: fixtureFile(a.content).toString('base64') }
    return project(full, select, ['@odata.type', 'id'])
  }

  /** A message, projected, with `$expand=attachments` (optionally with its own
   *  `$select`) and no other expansion. */
  function messageJson(m: MessageFixture, req: RouteRequest): Json {
    const out = project(m.message, req.query.get('$select'), ['id'])
    const expand = req.query.get('$expand')
    if (expand === null) return out
    const parsed = /^attachments(?:\(\$select=([^()]*)\))?$/.exec(expand)
    if (!parsed) return req.refuse(`$expand=${expand} is not modelled`)
    return { ...out, attachments: m.attachments.map((a) => attachmentJson(a, parsed[1] ?? null)) }
  }

  const routes: Route[] = [
    {
      name: 'me',
      pattern: /^\/me$/,
      options: ['$select'],
      body: 'json',
      answer: (_p, req) => project(me, req.query.get('$select'), ['id']),
    },
    {
      name: 'drive root children',
      pattern: /^\/me\/drive\/root\/children$/,
      options: ['$select', '$top'],
      body: 'json',
      answer: (_p, req) =>
        children(req, (p) => p.driveId === drive.meDriveId && p.path === '/drive/root:'),
    },
    {
      name: 'drive item',
      pattern: /^(?:\/me\/drive|\/drives\/([^/]+))\/items\/([^/]+)$/,
      options: ['$select'],
      body: 'json',
      answer: ([d, id], req) => project(itemOn(d, id, req).item, req.query.get('$select'), ['id']),
    },
    {
      name: 'drive item children',
      pattern: /^(?:\/me\/drive|\/drives\/([^/]+))\/items\/([^/]+)\/children$/,
      options: ['$select', '$top'],
      body: 'json',
      answer: ([d, id], req) => {
        const { item } = itemOn(d, id, req)
        if (!item.folder) req.refuse(`drive item ${id} is not a folder`)
        const driveId = parentOf(item).driveId
        return children(req, (p) => p.driveId === driveId && p.id === id)
      },
    },
    {
      name: 'drive item content',
      pattern: /^(?:\/me\/drive|\/drives\/([^/]+))\/items\/([^/]+)\/content$/,
      options: [],
      body: 'bytes',
      answer: ([d, id], req) => {
        const { content } = itemOn(d, id, req)
        if (!content) return req.refuse(`drive item ${id} has no content fixture`)
        return fixtureFile(content).toString('base64')
      },
    },
    {
      name: 'mail folder messages',
      pattern: /^\/me\/mailFolders\/([^/]+)\/messages$/,
      options: ['$select', '$filter', '$orderby', '$top', '$expand'],
      body: 'json',
      answer: ([folder], req) => {
        const inFolder = messages.filter((m) => m.folder === folder)
        if (inFolder.length === 0) req.refuse(`no messages are modelled in mail folder ${folder}`)
        // Graph's default order for a message list is newest first.
        const orderby = req.query.get('$orderby') ?? 'receivedDateTime desc'
        const order = /^receivedDateTime(?: (asc|desc))?$/.exec(orderby)
        if (!order) return req.refuse(`$orderby=${orderby} is not modelled`)
        const sign = order[1] === 'desc' ? -1 : 1
        const received = (m: MessageFixture) => Date.parse(String(m.message.receivedDateTime))
        const keep = mailFilter(req)
        const listed = inFolder
          .filter((m) => keep(m.message))
          .sort((a, b) => sign * (received(a) - received(b)))
          .map((m) => messageJson(m, req))
        return page(listed, req)
      },
    },
    {
      name: 'message',
      pattern: /^\/me\/messages\/([^/]+)$/,
      options: ['$select', '$expand'],
      body: 'json',
      answer: ([id], req) => messageJson(messageById(id, req), req),
    },
    {
      name: 'message attachments',
      pattern: /^\/me\/messages\/([^/]+)\/attachments$/,
      options: ['$select'],
      body: 'json',
      answer: ([id], req) => ({
        value: messageById(id, req).attachments.map((a) =>
          attachmentJson(a, req.query.get('$select')),
        ),
      }),
    },
    {
      name: 'message attachment',
      pattern: /^\/me\/messages\/([^/]+)\/attachments\/([^/]+)$/,
      options: ['$select'],
      body: 'json',
      answer: ([id, attId], req) =>
        attachmentJson(attachmentOf(id, attId, req), req.query.get('$select')),
    },
    {
      name: 'message attachment bytes',
      pattern: /^\/me\/messages\/([^/]+)\/attachments\/([^/]+)\/\$value$/,
      options: [],
      body: 'bytes',
      answer: ([id, attId], req) =>
        fixtureFile(attachmentOf(id, attId, req).content).toString('base64'),
    },
  ]

  function answer(
    userId: string,
    path: string,
    init: GraphFetchInit,
  ): { route: string; body: unknown } {
    const method = (init.method ?? 'GET').toUpperCase()
    const refuse = (reason: string): never => {
      throw new UnmatchedGraphRequest(method, path, reason)
    }

    let relative = path
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
      if (!path.startsWith(`${GRAPH_BASE}/`)) refuse(`only ${GRAPH_BASE} is Graph`)
      relative = path.slice(GRAPH_BASE.length)
    }
    if (!relative.startsWith('/')) refuse('a Graph path starts with /')
    if (method !== 'GET') refuse(`${method} is not modelled; the fake answers reads only`)
    if (init.body !== undefined) refuse('a GET with a body is not modelled')

    const at = relative.indexOf('?')
    const bare = at < 0 ? relative : relative.slice(0, at)
    const query = new URLSearchParams(at < 0 ? '' : relative.slice(at + 1))

    for (const route of routes) {
      const m = route.pattern.exec(bare)
      if (!m) continue
      const keys = [...query.keys()]
      for (const key of keys) {
        if (!route.options.includes(key)) {
          refuse(`query option ${key} is not modelled on the ${route.name} route`)
        }
      }
      if (new Set(keys).size !== keys.length) refuse('a query option appears twice')
      // The real `graphFetch` forwards headers, and Graph answers differently
      // under some (`Prefer: outlook.timezone`, `outlook.body-content-type`).
      // Checked per route, so a route that models one can list it.
      for (const h of Object.keys(init.headers ?? {})) {
        if (!(route.headers ?? []).includes(h)) refuse(`request header ${h} is not modelled`)
      }
      const wantsBytes = init.responseType === 'base64'
      if (wantsBytes !== (route.body === 'bytes')) {
        refuse(
          `the ${route.name} route answers ${route.body === 'bytes' ? 'bytes' : 'JSON'}, ` +
            `and the caller asked for ${wantsBytes ? 'bytes' : 'JSON'}`,
        )
      }
      const params = m.slice(1).map((p) => (p === undefined ? p : decodeURIComponent(p)))
      const req: RouteRequest = { userId, method, path, bare, query, refuse }
      return { route: route.name, body: route.answer(params as string[], req) }
    }
    return refuse('no route models this path')
  }

  return {
    async graphFetch(userId, path, init = {}) {
      const record: GraphRequestRecord = {
        userId,
        method: (init.method ?? 'GET').toUpperCase(),
        path,
        ...(init.scopes ? { scopes: [...init.scopes] } : {}),
        route: null,
      }
      requests.push(record)
      try {
        const { route, body } = answer(userId, path, init)
        record.route = route
        return structuredClone(body)
      } catch (err) {
        if (err instanceof UnmatchedGraphRequest) {
          unmatched.push(`${err.method} ${err.path}: ${err.reason}`)
        } else if (modelled.has(err as object)) {
          // A Graph error a fixture asked for: the request matched.
          record.route = 'modelled error'
        } else {
          // Anything else is the fake failing, which is never a match.
          const message = err instanceof Error ? err.message : String(err)
          unmatched.push(`${record.method} ${path}: the fake failed: ${message}`)
        }
        throw err
      }
    },
    get requests() {
      return requests
    },
    get unmatched() {
      return unmatched
    },
    assertAllMatched() {
      if (unmatched.length > 0) {
        throw new Error(
          `[fake-graph] ${unmatched.length} request(s) had no fixture:\n  ${unmatched.join('\n  ')}`,
        )
      }
    },
    reset() {
      requests.length = 0
      unmatched.length = 0
    },
  }
}

/** A Data Stash bridge that refuses. Layer 2 has no stash backend, and a tool
 *  that reaches one must say so rather than appear to have stored a file. */
export const NO_STASH: GraphStashBridge = {
  loadStore: async () => {
    throw new Error(
      '[fake-graph] these Graph tools were composed with no Data Stash: pass `stash` to compose them with one',
    )
  },
  ingest: async () => {
    throw new Error('[fake-graph] these Graph tools were composed with no Data Stash')
  },
}

/**
 * The REAL Graph tools, registered over the fake. `content` defaults to the
 * four functions the app's composition root injects in production, so a
 * file's MIME and text decisions are production's. `stash` defaults to
 * {@link NO_STASH}.
 */
export async function composeGraphTools(
  graph: FakeGraph,
  opts: {
    resolveContext: { userId: () => string | null; sessionId: () => string | null }
    content?: GraphContentClassifier
    stash?: GraphStashBridge
  },
): Promise<AppToolRegistry> {
  const [{ createAppToolRegistry }, { registerGraphConnectorTools }] = await Promise.all([
    import('@hames-ai/connectors/app-tools/registry'),
    import('@hames-ai/connectors/graph/graph-tools.server'),
  ])
  const registry = createAppToolRegistry({ resolveContext: opts.resolveContext })
  registerGraphConnectorTools({
    registerAppTool: registry.registerAppTool,
    graphFetch: graph.graphFetch,
    content: opts.content ?? (await appContentClassifier()),
    stash: opts.stash ?? NO_STASH,
  })
  return registry
}

/** The four functions `src/lib/app-tools/index.server.ts` injects as `content`. */
async function appContentClassifier(): Promise<GraphContentClassifier> {
  const [{ conversionEnabled, isConvertible }, { guessMimeType, isTextMime }] = await Promise.all([
    import('@hames-ai/harness-patterns/stash/doc-convert.server'),
    import('../../src/lib/stash/upload-service.server'),
  ])
  return { conversionEnabled, isConvertible, guessMimeType, isTextMime }
}
