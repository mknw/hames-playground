import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFile } from 'node:fs/promises'
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
const ensure = vi.hoisted(() => vi.fn(async () => {}))
const available = vi.hoisted(() => vi.fn(() => true))
vi.mock('../../../lib/db/memories.server', () => ({
  ensureMemoriesSchema: ensure,
  isMemoryAvailable: available,
}))
const { probeMemoryAtBoot } = await import('../../../lib/memory/boot.server')
let log: ReturnType<typeof vi.spyOn>
let fetcher: ReturnType<typeof vi.fn>
beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('hames-app.memory-boot-probe')]
  vi.clearAllMocks()
  ensure.mockResolvedValue()
  available.mockReturnValue(true)
  vi.stubEnv('EMBEDDINGS_LOCAL_URL', 'http://127.0.0.1:18096/v1')
  log = vi.spyOn(console, 'info').mockImplementation(() => {})
  fetcher = vi.fn(async () => Response.json({ data: [{ embedding: Array(1024).fill(0.1) }] }))
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  log.mockRestore()
})

describe('boot memory availability', () => {
  it('logs once, local fixed content and space; starts from the boot hook', async () => {
    const first = probeMemoryAtBoot()
    expect(probeMemoryAtBoot()).toBe(first)
    await first
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        'ENABLED: schema/extension=available; embedder=answering; embeddingSpaceId=local:Qwen3-Embedding-0.6B:1024',
      ),
    )
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:18096/v1/embeddings')
    expect(JSON.parse(init.body)).toMatchObject({ input: ['wake'] })
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const source = await readFile('src/middleware.ts', 'utf8')
    expect(source).toContain('void probeMemoryAtBoot()')
  })
  it.each(['https://example.invalid/v1', 'http://127.0.0.1.example.invalid/v1'])(
    'makes no off-box call to %s',
    async (base) => {
      vi.stubEnv('EMBEDDINGS_LOCAL_URL', base)
      await probeMemoryAtBoot()
      expect(fetcher).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledWith(expect.stringContaining('DISABLED:'))
      expect(log).toHaveBeenCalledWith(expect.stringContaining('not-probed-off-box'))
    },
  )
  it('does not fail boot or quote content when schema and embedding fail', async () => {
    ensure.mockRejectedValueOnce(new Error('private content'))
    fetcher.mockRejectedValueOnce(new Error('secret content'))
    await expect(probeMemoryAtBoot()).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('DISABLED: schema/extension=unavailable; embedder=unavailable;'),
    )
    expect(JSON.stringify(log.mock.calls)).not.toContain('content')
  })
  it('disabled schema and malformed vectors cannot report enabled', async () => {
    available.mockReturnValue(false)
    fetcher.mockResolvedValueOnce(Response.json({ data: [{ embedding: [1] }] }))
    await probeMemoryAtBoot()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('DISABLED:'))
  })
})
