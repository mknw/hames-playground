/**
 * `classifySandboxFailure` — which fixed sentence an engine error earns.
 *
 * The sentence is a decision about what the model may be told, so each branch of
 * the engine-unreachable pattern is pinned with a message of its own (dropping a
 * branch must turn one of these red), and both sentences are pinned to survive the
 * injection guard unchanged: the office route's error channel is sanitized, and a
 * rule that mangled "do not call" / "finish now" would silently rewrite the only
 * text the actor gets.
 */
import { describe, expect, it } from 'vitest'
import { INJECTION_RULES, sanitizeText } from '@hames-ai/harness-patterns/guard'
import { classifySandboxFailure } from '../failure'

describe('classifySandboxFailure', () => {
  it.each([
    ['spawn docker ENOENT'],
    ['connect ECONNREFUSED 127.0.0.1:2375'],
    ['open /run/example: EACCES'],
    [
      'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
    ],
    ['Cannot connect to the Docker daemon at tcp://example.invalid:2375'],
    ['Is the docker daemon running?'],
    ['docker run could not start: image pull failed'],
    ['stat /run/example/engine: no such file or directory'],
    ['dial tcp 192.0.2.1:2375: connection refused'],
  ])('engine unreachable: %s', (message) => {
    expect(classifySandboxFailure(new Error(message)).reason).toBe('engine_unreachable')
  })

  it('reads the cause as well as the message', () => {
    const err = new Error('boot failed', {
      cause: new Error('connect to unix:///var/run/docker.sock'),
    })
    expect(classifySandboxFailure(err).reason).toBe('engine_unreachable')
  })

  it('classifies a non-Error throw by its string form', () => {
    expect(classifySandboxFailure('spawn docker ENOENT').reason).toBe('engine_unreachable')
  })

  it.each([
    ['docker image inspect kg-sandbox:office: Error: No such image: kg-sandbox:office'],
    ['docker run timed out after 30000ms'],
    ['rootfs layer 7 failed checksum'],
  ])('boot failed: %s', (message) => {
    expect(classifySandboxFailure(new Error(message)).reason).toBe('boot_failed')
  })

  it.each(['engine_unreachable', 'boot_failed'] as const)(
    'the %s sentence passes the injection guard unchanged',
    (reason) => {
      const message = classifySandboxFailure(
        new Error(reason === 'engine_unreachable' ? 'spawn docker ENOENT' : 'rootfs failed'),
      ).message
      const sanitized = sanitizeText(message, INJECTION_RULES)
      expect(sanitized.text).toBe(message)
      expect(sanitized.findings).toEqual([])
    },
  )
})
