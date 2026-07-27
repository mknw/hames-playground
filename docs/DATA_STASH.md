# Data Stash — Document Ingestion Pipeline

The Data Stash lets users upload documents that the agent can reference and
search. This doc covers the **store → chunk → embed → search** pipeline
(issues #6, #9, #8). For the tool-result side of the stash (hide/archive of
agent-produced results) see [UI_ARCHITECTURE.md](UI_ARCHITECTURE.md). Voice
recordings from the [agent trigger endpoint](AGENT_TRIGGER.md) are also stored
here (base64 audio, keyed by `run_id`) for provenance + inline playback — stored
only, not ingested.

```
upload ─▶ store (RedisJSON) ─▶ chunk ─▶ embed (local/OpenRouter) ─▶ HNSW index
                                                                         │
query ─────────────────────── embed query (same model) ────▶ KNN search ┘
```

> **See it visually:** [`data-flow.md`](data-flow.md) has Mermaid data-flow
> diagrams for this pipeline (upload → store → ingest → search) and how it
> bridges into the sandbox `/work` durable workspace (#89).

## Modules (`ui/src/lib/`)

| Module | Role |
|--------|------|
| `document-store.server.ts` (#6) | RedisJSON storage: CRUD, TTL, per-session index, hide/archive flags, `toPriorResult` adapter |
| `chunking.server.ts` (#9) | Pure text chunking — `fixed` / `sentence` / `paragraph` + MIME-aware `chunkDocument` |
| `embeddings.server.ts` (#8) | Provider-pluggable embedding with a one-model-per-corpus guard |
| `vector-store.server.ts` | Shared RediSearch wrapper: `createVectorStore` → `ensureIndex` / `upsert` / `search`; owns the index/key/payload plumbing + naming (`spaceTag`) |
| `document-ingest.server.ts` | Orchestrator: chunk → embed → vector store, `searchDocuments` (KNN), and the status-tracked `ingestStashDocument` / `ensureSessionIngested` (harness-aware ingest) |
| `doc-convert.server.ts` | Binary → markdown conversion via the `doc-convert` HTTP sidecar (`POST /extract`); gated by `STASH_CONVERT_DOCS`. See [Document conversion](#document-conversion) |
| `retriever/redis-backend.server.ts`, `retriever/supabase-backend.server.ts` | `RetrieverBackend` impls for the harness `retriever` pattern — local Data Stash (`redis`, live) + company pgvector via the Supabase MCP (`supabase`, deferred stub) |
| `stash/upload-service.server.ts`, `stash/http.server.ts` | Upload request parsing (multipart + JSON), auth/response helpers |

## API routes (`ui/src/routes/api/stash/`)

| Method · Path | Purpose |
|---|---|
| `POST /api/stash/upload` | Store a document (multipart `file`, or JSON `{sessionId, filename, content}`) |
| `GET /api/stash/upload?sessionId=` | List a session's documents (metadata) |
| `GET /api/stash/document/:id?sessionId=` | Fetch a document (content + metadata) |
| `GET /api/stash/document/:id?sessionId=&download` | Stream the raw file (base64 decoded for binary) with `Content-Disposition` (#89) |
| `DELETE /api/stash/document/:id?sessionId=` | Remove a document + its index entry |
| `PATCH /api/stash/document/:id` | Toggle `hidden` / `archived` (`{sessionId, hidden?, archived?}`) |
| `POST /api/stash/ingest` | Chunk → embed → index a stored doc (`{sessionId, docId, chunk?, embedding?}`) |
| `GET /api/stash/search?sessionId=&q=&k=` | KNN similarity search over a session's chunks |

Auth follows the existing posture (dev-bypass aware; see `lib/auth/dev-bypass.ts`). Ingest runs two ways: **explicitly** via `POST /api/stash/ingest`, or **automatically on upload** when the session's agent composes a `retriever` wired to the redis backend (see [Harness-aware ingest](#harness-aware-ingest-the-retriever-pattern) below). Either way it needs an embedding backend and binds the corpus to one model.

## Harness-aware ingest (the `retriever` pattern)

The Data Stash adapts to the agent's harness composition:

- **Sandbox present** (`withSandbox` + `syncWorkspace`) → uploads are hydrated into the VM's `/work/in` on first boot (`hydrateWorkspace`, #89). No vector ingest implied.
- **A `retriever` wired to the `redis` backend present** → uploads are **auto-ingested** into the local vector store so they're semantically searchable. An agent without such a retriever never ingests — the upload is just stored.
- Both can hold at once (independent, composable).

**The gate.** `POST /api/stash/upload`, after storing, resolves the session's agent (`loadSession` → `getOrBuildPatterns`) and checks `harnessHasRedisRetriever(patterns)` — static introspection in `harness-patterns/pattern-capabilities.ts` that walks `ConfiguredPattern.children` (the combinators — `routes`, `chain`, `withReferences`, `withSandbox` — all expose them). On a match it marks the doc `ingestStatus: 'pending'` and ingests **in the background** (the response returns immediately — embedding a large doc takes seconds). Base64 binaries are skipped (`failed`) — unless [document conversion](#document-conversion) is on and the type is convertible, in which case they're converted to markdown first. Best-effort: any failure leaves the `201` untouched.

**Safety net.** Docs uploaded *before* the agent was known (session not yet persisted) miss the gate. The redis backend runs `ensureSessionIngested` on its first search per session (idempotent via `ingestStatus`), so they still become searchable on first retrieval.

**The pattern** (`harness-patterns/patterns/retriever.server.ts`) is framework-pure: it forms ONE query, fans it out to injected `RetrieverBackend`s concurrently (per-backend error isolation), merges hits closest-first capped at `k`, sets `scope.data.matches`, and emits a `tool_result` the synthesizer consumes. It's a low-latency alternative to a tool-calling `simpleLoop` — one embed + KNN instead of a >30s LLM loop. Typical wiring (see `harness-client/examples/retriever-agent.server.ts`):

```ts
router({ retriever, neo4j, web_search }),
routes({
  retriever: retriever({ backends: [createRedisBackend(sessionId)], k: 5, generateQuery: true }),
  neo4j: simpleLoop(neo4jController, tools.neo4j),
  web_search: simpleLoop(webController, tools.web),
}),
synthesizer({ mode: 'thread' }),
```

**Query formulation.** By default the query is the user's **raw last message** — their own words embed better than a paraphrase (a generic rewrite like *"search the documents for all sections that discuss X"* dilutes the vector). `generateQuery: true` rewrites it with a cheap `RetrieveQuery` (Haiku) call **only when the turn has history** — to resolve back-references (*"more on that"*, *"those sections"*) into a self-contained query; turn-1 messages are searched verbatim. `turnWindow: N` is a no-LLM alternative that concatenates the last N user turns.

**Backends** (`ui/src/lib/retriever/`) implement `RetrieverBackend { name, type, search() }`:

- **`redis`** (`createRedisBackend`, `type: 'vector'`) — wraps `searchDocuments` (local Data Stash KNN), embedding the query locally with the corpus's recorded model. **Live.**
- **`supabase`** (`createSupabaseBackend`, `type: 'vector'`) — the company pgvector corpus via the **Supabase MCP** server; **text-in** (Supabase embeds server-side via Automatic Embeddings / Edge Functions, so no client-side embedding and no OpenAI provider here). **Deferred stub** pending IT access: when `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` land, add the Supabase MCP to `configs/custom-catalog.yaml` and implement `search()` against its match RPC. Until then `search()` throws and the retriever's per-backend guard turns it into an empty result + error event — a misconfigured backend never sinks a run.

The `type` field distinguishes vector backends from future non-vector ones (web keyword, neo4j graph, raw SQL) — only `vector` backends embed.

## Storage model (Redis)

- **Document**: RedisJSON blob at `stash:doc:{sessionId}:{docId}`, TTL default 7 days. `content` is UTF-8 text by default; binary files (xlsx, pdf, images) are stored with `encoding: 'base64'` and `size` = the original (decoded) byte count (#89). Binary content is byte-faithful and, by default, **not** semantically searchable (chunking/embedding is text-only) — unless [document conversion](#document-conversion) is enabled, which turns a convertible type (docx/pdf/pptx/odt) into markdown stored alongside as `derivedText` (the original bytes stay in `content` for `?download`). An `ingestStatus` (`pending` | `indexed` | `failed`) is stamped when the harness-aware path ingests the doc; absent means it was never ingested (no redis-retriever in the harness). Meta reads expose a computed `converted` flag when `derivedText` is present.
- **Session index**: a Redis SET `stash:docs:{sessionId}` of doc ids (self-healing — stale entries pruned on list).
- **Chunk**: a Redis HASH `stashvec:{sessionId}:{spaceTag}:{docId}:{chunkIndex}` with `vector` (float blob) + `meta` (base64 of a JSON `{content, doc_id, source, chunk_index, offsets, model, provider, dim}`). 2 writes/chunk.
- **Vector index**: a RediSearch HNSW index per `(session, embedding-space)`; `dim` matches the embedding model.
- **Embedding space**: recorded at `stash:space:{sessionId}` as `{provider, model, dimensions}`.

`MAX_CONTENT_BYTES` = 5 MiB (applies to the original bytes, base64 or not). Text files store verbatim; recognized binary types are base64-encoded by the upload service (`isTextMime` decides). Text remains the path for anything you want to search; binary is for byte-faithful round-trips (e.g. the sandbox `/work` flow, #89).

## Document conversion

Convertible binary uploads — **docx, odt, pptx, pdf** (+ legacy `.doc`/`.ppt`/`.odp`) — are turned into markdown so they flow through the same chunk → embed → search path as text. Off by default; enable with **`STASH_CONVERT_DOCS=1`**.

- **Sidecar, not MCP.** Conversion is a host pipeline step (like the direct-Redis app path), so `doc-convert.server.ts` calls a document-extraction service over plain HTTP (`POST /extract`, multipart `files` + `config={"output_format":"markdown"}`) rather than the serial MCP gateway. `DOC_CONVERT_URL` defaults to `http://localhost:8000`.
- **Engine.** The compose `doc-convert` service runs stable **kreuzberg 4.x** (`ghcr.io/kreuzberg-dev/kreuzberg-full`) — Rust core, native parsers (no LibreOffice/pandoc), heading-preserving markdown that feeds `bindHeadings`. The **xberg** successor exposes the same `/extract` contract and is a one-line image swap (RC-only today); the response parser accepts kreuzberg's bare array **and** xberg's `{results:[…]}`.
- **When.** In `ingestStashDocument`: a convertible base64 doc is converted, the markdown persisted as `derivedText`, then *that* is chunked (an in-memory text doc is handed to the unchanged `ingestDocument`). The upload gate + `ensureSessionIngested` admit convertible binaries, so they get the `pending → indexed` UX + composer-block; non-convertible binaries (zip, images) stay stored-only. `convertFn` is injectable for tests.
- **Both kept.** The original bytes remain in `content` (so `?download` + the `/work` sync serve the real file); `derivedText` holds the markdown. Chunk char-offsets and the file viewer index into `derivedText`, so chat citations line up with what's shown — `GET /api/stash/document/:id` (no `download`) serves `derivedText` for converted docs, and the panel shows the view-eye via the computed `converted` flag.
- **Graceful fallback.** Sidecar down/unreachable → the doc is marked `ingestStatus: 'failed'`; the upload itself still succeeds. Flag off → binaries behave exactly as before.

Start the sidecar: `docker compose up -d doc-convert`.

## Chunking (#9)

Default `{ maxChars: 1000, overlap: 200, strategy: 'paragraph' }`. `chunkDocument(content, mimeType)` routes by type: **CSV/TSV** → row-grouping with the header repeated; **JSON** → pretty-print then chunk; everything else → `chunkText`. Strategies: `paragraph` (blank lines), `sentence` (`.!?`), `fixed` (sliding window). Overlap is carried between chunks; an oversized single unit falls back to a fixed window. Offsets satisfy `content === text.slice(start, end)` (CSV excepted).

## Embeddings (#8) — one model per corpus

Vectors are only comparable within one model, so there is **no silent cross-provider fallback**. The provider is a deliberate choice:

- **`local`** (dev default) — `llama-server --embedding` on `:8090` (Qwen3-Embedding-0.6B, 1024-dim), OpenAI-compatible `/v1/embeddings`.
- **`openrouter`** — selectable; requires `OPENROUTER_API_KEY`.

`embed()` returns vectors tagged with `{provider, model, dimensions}`; `assertSameSpace()` enforces comparability. The space is baked into the index name and key prefix, and re-ingesting a session under a different model **throws** (override with `allowSpaceChange`). Env: `EMBEDDINGS_PROVIDER`, `EMBEDDINGS_LOCAL_URL`, `EMBEDDINGS_LOCAL_MODEL`.

Start the local embedder (separate from `pnpm dev:llama`, which serves a *chat* model on `:8080`):

```bash
llama-server --embedding -m models/Qwen3-Embedding-0.6B-Q8_0.gguf --port 8090 --ctx-size 8192
```

## Shared vector store

`vector-store.server.ts` is the single home for the embed-target Redis plumbing —
`createVectorStore({ indexName, prefix, dim })` → `ensureIndex()` / `upsert(id, vector, payload, ttl)` / `search(queryVector, k)`. It owns index creation (tolerating "already exists"), the 2-writes-per-record format (vector + base64 `meta` payload), KNN result parsing, and the `spaceTag(space)` naming that keeps one index to one model. Its consumer is the Data Stash search:

- **`document-ingest.server.ts`** — document chunks (index/prefix per `(session, space)`).

## Requirements & gotchas

- **redis-stack** (not plain `redis`): the pipeline needs **RedisJSON** (`json_*`) and **RediSearch** (`create_vector_index_hash` / `vector_search_hash`). The compose `redis` service uses `redis/redis-stack` (merged in #91).
- **Apple-Silicon / colima:** redis-stack's arm64 `redisearch.so` SIGILL-crashes on the colima VM during vector ops. Run the redis service as `platform: linux/amd64` (emulated) — see the git-ignored `docker-compose.override.yml`. Long-term: colima CPU passthrough (`--vm-type vz`). Store/RedisJSON is unaffected; only vector search needs this.
- **Gateway argument/result quirks** (see [CLAUDE.md → Redis MCP Tool Parameters](../CLAUDE.md)): the MCP gateway runs the redis server over serial stdio (so ingest is sequential and minimal-call), returns multi-value results as one text block per element (handled by `callTool` aggregation), and auto-parses JSON-looking string args into objects (so chunk `meta` is base64-encoded).
- **`doc-convert` sidecar** (only when `STASH_CONVERT_DOCS=1`): the `doc-convert` compose service must be up (`docker compose up -d doc-convert`) and reachable at `DOC_CONVERT_URL`. If it's down, convertible uploads are marked `failed` rather than crashing the upload. See [Document conversion](#document-conversion).

## Relationships

- **#89** (sandbox `/work` ⇄ DataStash artifact sync) builds on the store/retrieve path (`storeDocument` / `getDocument` / `listDocuments`) and added the base64 `encoding` field + the `?download` route for byte-faithful binaries. It does not require vector search. Mechanism: [`docs/plan/sandbox.md → Durable workspaces`](plan/sandbox.md#durable-workspaces-89).
- Distinct from **#17** (RDF/OWL → Neo4j): this is documents → Redis + vectors.
