/**
 * The dev-only inference redirect, and the two gates that keep it dev-only.
 *
 * This module is the one piece of `src/` that exists for a test suite
 * (`app/e2e-browser/`), and the thing that makes that acceptable is that it is
 * structurally impossible to turn on in production. `browser-e2e-not-in-ci.test.ts`
 * pins that claim by reading the source; this pins the BEHAVIOUR, which is the
 * half a source scan cannot see: that the opt-in actually gates the install,
 * and that the install actually redirects.
 *
 * `import.meta.env.DEV` is true under vitest, so the DEV gate cannot be
 * exercised from here — a build is what flips it, and the source pin is what
 * covers it.
 *
 * The install is async because it imports `ClientRegistry` lazily; that is not
 * a detail of the test but the thing that keeps `@boundaryml/baml` out of the
 * production server entry. See the module's own header.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The unit suite runs in jsdom, where `window` exists and the server-only
// guard would refuse the import. Same mock, same reason, as its neighbours in
// this directory.
vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const FAKE_URL = 'http://127.0.0.1:9/v1'

/** A fresh module instance per test — the install is idempotent by a
 *  module-level flag, so a shared instance would make test order matter. */
async function load() {
  vi.resetModules()
  return import('~/lib/inference/dev-fake-inference.server')
}

const original = process.env.E2E_FAKE_INFERENCE_URL

beforeEach(() => {
  delete process.env.E2E_FAKE_INFERENCE_URL
})
afterEach(() => {
  if (original === undefined) delete process.env.E2E_FAKE_INFERENCE_URL
  else process.env.E2E_FAKE_INFERENCE_URL = original
})

describe('devFakeInferenceUrl', () => {
  it('is null with no opt-in — which is every ordinary `pnpm dev`', async () => {
    const { devFakeInferenceUrl } = await load()
    expect(devFakeInferenceUrl()).toBeNull()
  })

  it('is null for an empty or whitespace opt-in, rather than an empty base_url', async () => {
    process.env.E2E_FAKE_INFERENCE_URL = '   '
    const { devFakeInferenceUrl } = await load()
    expect(devFakeInferenceUrl()).toBeNull()
  })

  it('is the endpoint when the opt-in is set', async () => {
    process.env.E2E_FAKE_INFERENCE_URL = FAKE_URL
    const { devFakeInferenceUrl } = await load()
    expect(devFakeInferenceUrl()).toBe(FAKE_URL)
  })
})

describe('installDevFakeInference', () => {
  it('does nothing at all without the opt-in, and says so', async () => {
    const { installDevFakeInference } = await load()
    const client = { bamlOptions: { marker: 'untouched' } }

    expect(await installDevFakeInference(client)).toBe(false)
    // Not merely "returned false": the caller's options are the thing a silent
    // half-install would corrupt, and a redirect that partly took is worse
    // than one that did not.
    expect(client.bamlOptions).toEqual({ marker: 'untouched' })
  })

  it('installs a client registry that answers every un-overridden call', async () => {
    process.env.E2E_FAKE_INFERENCE_URL = FAKE_URL
    const { installDevFakeInference } = await load()
    const client: { bamlOptions?: unknown } = {}

    expect(await installDevFakeInference(client)).toBe(true)
    const options = client.bamlOptions as { clientRegistry?: unknown }
    expect(options.clientRegistry).toBeDefined()
  })

  it('rebuilds the registry per read, because setPrimary is a mutation', async () => {
    // A shared instance would keep whichever client the last per-call override
    // named as primary, and every later un-overridden call would be attributed
    // to the wrong tier — a green tier-switch scenario proving nothing.
    process.env.E2E_FAKE_INFERENCE_URL = FAKE_URL
    const { installDevFakeInference } = await load()
    const client: { bamlOptions?: unknown } = {}
    await installDevFakeInference(client)

    const first = (client.bamlOptions as { clientRegistry: unknown }).clientRegistry
    const second = (client.bamlOptions as { clientRegistry: unknown }).clientRegistry
    expect(first).not.toBe(second)
  })
})
