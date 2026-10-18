// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDocument, isSeq } from 'yaml'
const root = new URL('../../../../../', import.meta.url)
const read = (file: string) => readFileSync(fileURLToPath(new URL(file, root)), 'utf8')
describe('opt-in environment VM compose overlay', () => {
  it('replaces app mounts and gives it only the Docker client files', () => {
    const source = read('docker-compose.sandbox-vm.yaml')
    const doc = parseDocument(source)
    const volumes = doc.getIn(['services', 'app', 'volumes'], true)
    expect(isSeq(volumes)).toBe(true)
    expect((volumes as { tag?: string }).tag).toBe('!override')
    const config = doc.toJS()
    expect(Object.keys(config.services)).toEqual(['app'])
    expect(config.services.app.volumes).toHaveLength(4)
    expect(config.services.app.volumes).toContain('./configs:/configs:ro')
    expect(config.services.app.volumes.join('\n')).not.toMatch(
      /docker\.sock|stateDirectory|incus|ca-key/,
    )
    for (const name of ['CA', 'CERT', 'KEY'])
      expect(config.services.app.volumes.join('\n')).toContain(`SANDBOX_DOCKER_TLS_${name}:?`)
    expect(config.services.app.environment.SANDBOX_DOCKER_HOST).toContain(':?')
    for (const name of ['CA', 'CERT', 'KEY'])
      expect(config.services.app.environment[`SANDBOX_DOCKER_TLS_${name}`]).toMatch(
        /^\/run\/sandbox-tls\//,
      )
  })
  it('preserves the default app deployment and the gateway socket', () => {
    const base = parseDocument(read('docker-compose.yaml')).toJS()
    expect(base.services.app.volumes).toContain('/var/run/docker.sock:/var/run/docker.sock')
    expect(
      base.services['mcp-gateway'].volumes.some((v: string) => v.includes('/var/run/docker.sock')),
    ).toBe(true)
  })
})
