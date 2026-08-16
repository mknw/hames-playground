/**
 * Sandbox backend selection (`index.server`).
 *
 * The one operational decision this barrel owns: which compute substrate the
 * harness runs on, driven by `COMPUTE_BACKEND`. Firecracker (#78) is not
 * implemented, so requesting it must warn and still hand back a working Docker
 * backend rather than crash. Also covers the process-lifetime singleton and
 * the `__setComputeBackend` test seam every other sandbox test relies on.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// DockerBackend's constructor is inert, but stub the module anyway so no MCP
// SDK / docker CLI machinery loads just to resolve a backend.
const DockerBackend = vi.hoisted(() => vi.fn(function () {}))
vi.mock('../../../lib/sandbox/docker-backend.server', () => ({
  DockerBackend,
  SandboxBootError: class SandboxBootError extends Error {},
}))

import {
  selectBackendKind,
  getComputeBackend,
  __setComputeBackend,
} from '../../../lib/sandbox/index.server'

const originalBackendEnv = process.env.COMPUTE_BACKEND

beforeEach(() => {
  DockerBackend.mockClear()
  __setComputeBackend(null)
  delete process.env.COMPUTE_BACKEND
})

afterEach(() => {
  __setComputeBackend(null)
  if (originalBackendEnv === undefined) delete process.env.COMPUTE_BACKEND
  else process.env.COMPUTE_BACKEND = originalBackendEnv
})

describe('selectBackendKind', () => {
  it('defaults to docker when COMPUTE_BACKEND is unset', () => {
    expect(selectBackendKind()).toBe('docker')
  })

  it('honours an explicit docker/firecracker selection', () => {
    process.env.COMPUTE_BACKEND = 'firecracker'
    expect(selectBackendKind()).toBe('firecracker')
    process.env.COMPUTE_BACKEND = 'docker'
    expect(selectBackendKind()).toBe('docker')
  })

  it('ignores an unrecognized value rather than failing the boot', () => {
    process.env.COMPUTE_BACKEND = 'qemu'
    expect(selectBackendKind()).toBe('docker')
  })
})

describe('getComputeBackend', () => {
  it('constructs a Docker backend once and reuses it', () => {
    const first = getComputeBackend()
    const second = getComputeBackend()

    expect(second).toBe(first)
    expect(DockerBackend).toHaveBeenCalledTimes(1)
  })

  it('falls back to docker with a warning when firecracker is requested (#78)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.COMPUTE_BACKEND = 'firecracker'

    const backend = getComputeBackend()

    expect(backend).toBeInstanceOf(DockerBackend)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not implemented'))
    warn.mockRestore()
  })

  it('returns the injected backend after __setComputeBackend, and rebuilds after a reset', () => {
    const fake = { boot: vi.fn() } as unknown as ReturnType<typeof getComputeBackend>
    __setComputeBackend(fake)
    expect(getComputeBackend()).toBe(fake)
    expect(DockerBackend).not.toHaveBeenCalled()

    __setComputeBackend(null)
    expect(getComputeBackend()).toBeInstanceOf(DockerBackend)
  })
})
