// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import {
  activeInferenceTier,
  assertInferenceTier,
  assertBamlCallAllowed,
  clientOverrideFor,
  configureConsumerClients,
  resolveClientForRole,
  SWITCHED_FUNCTIONS_BY_ROLE,
  SELF_DEPLOYED_CLIENT_BY_ROLE,
  type BamlRole,
} from '@hames-ai/harness-baml/clients.server'
import { privateInferenceOnly } from '../../../lib/inference/config.server'
import { assertInferenceDeploymentConfigured } from '../../../lib/inference/tier-config.server'
import { b as generated } from '@hames-ai/harness-baml/baml_client'
import { b } from '@hames-ai/harness-baml/guarded-client.server'

beforeEach(() => {
  vi.stubEnv('INFERENCE_TIERS', 'private')
  vi.stubEnv('USE_SELF_DEPLOYED_INFERENCE', '')
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  vi.stubEnv('LARGE_LLM_BASE_URL', 'https://chat.example.invalid/v1')
  vi.stubEnv('LARGE_LLM_API_KEY', 'synthetic-chat-key')
  vi.stubEnv('SMALL_LLM_BASE_URL', 'https://small.example.invalid/v1')
  vi.stubEnv('SMALL_LLM_DECISIONS_URL', 'https://small.example.invalid/v1/systemone')
  vi.stubEnv('SMALL_LLM_API_KEY', 'synthetic-small-key')
})
afterEach(() => {
  configureConsumerClients(undefined)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const roles = Object.keys(SELF_DEPLOYED_CLIENT_BY_ROLE) as BamlRole[]

describe('private-only call guards', () => {
  it.each(roles)('routes %s outside any conversation or frame', (role) => {
    expect(activeInferenceTier()).toBe('self_deployed')
    expect(clientOverrideFor(role)).toEqual({ client: SELF_DEPLOYED_CLIENT_BY_ROLE[role] })
    expect(resolveClientForRole(role)).toBe(SELF_DEPLOYED_CLIENT_BY_ROLE[role])
  })
  it('refuses an explicit public frame before a call', async () => {
    expect(() => assertInferenceTier('anthropic')).toThrow(/Private-only/)
    await withRunFrame({ inference: { tier: 'anthropic' } }, async () => {
      expect(() => clientOverrideFor('describe')).toThrow(/Private-only/)
    })
  })
  it.each(roles)('refuses public consumer and per-run overrides for %s', async (role) => {
    configureConsumerClients(() => ({ client: 'DescribeAnthropic' }))
    expect(() => clientOverrideFor(role)).toThrow(/before any request/)
    expect(() => resolveClientForRole(role)).toThrow(/before any request/)
    configureConsumerClients(undefined)
    await withRunFrame(
      {
        inference: {
          tier: 'self_deployed',
          clientOverride: () => ({ client: 'DescribeAnthropic' }),
        },
      },
      async () => {
        expect(() => clientOverrideFor(role)).toThrow(/before any request/)
      },
    )
  })
  it('refuses registry and env overrides that could redefine a private name', () => {
    for (const options of [
      { client: 'LocalQwenSmall', clientRegistry: {} },
      { client: 'LocalQwenSmall', env: {} },
    ]) {
      expect(() => assertBamlCallAllowed('GenerateConversationTitle', options)).toThrow(
        /before any request/,
      )
    }
  })
  it('guards every BAML function, including describe and screen, against missing or public options', () => {
    for (const [role, names] of Object.entries(SWITCHED_FUNCTIONS_BY_ROLE)) {
      for (const name of names) {
        expect(() => assertBamlCallAllowed(name, undefined)).toThrow(/before any request/)
        expect(() => assertBamlCallAllowed(name, { client: 'DescribeAnthropic' })).toThrow(
          /before any request/,
        )
        expect(() =>
          assertBamlCallAllowed(name, { client: SELF_DEPLOYED_CLIENT_BY_ROLE[role as BamlRole] }),
        ).not.toThrow()
      }
    }
    expect(() => assertBamlCallAllowed('NewUnmappedFunction', {})).toThrow(/unrecognised/)
  })
  it('refuses a bypass at the actual generated call boundary before invoking BAML', async () => {
    const native = vi
      .spyOn(generated, 'GenerateConversationTitle')
      .mockResolvedValue('Synthetic title')
    expect(() => b.GenerateConversationTitle('synthetic')).toThrow(/before any request/)
    expect(() => b.GenerateConversationTitle('synthetic', { client: 'DescribeAnthropic' })).toThrow(
      /before any request/,
    )
    // A bag shifted into an input position is not the positional options bag.
    expect(() => b.GenerateConversationTitle({ client: 'LocalQwenSmall' } as never)).toThrow(
      /before any request/,
    )
    expect(native).not.toHaveBeenCalled()
    await expect(
      b.GenerateConversationTitle('synthetic', { client: 'LocalQwenSmall' }),
    ).resolves.toBe('Synthetic title')
    expect(native).toHaveBeenCalledOnce()
    expect(() => b.withOptions({ client: 'DescribeAnthropic' })).toThrow(/unrecognised/)
    expect(() => b.stream).toThrow(/unguarded/)
  })
  it('preserves the unset default, override precedence and original argument bytes', async () => {
    vi.stubEnv('INFERENCE_TIERS', '')
    expect(activeInferenceTier()).toBe('anthropic')
    expect(() => assertInferenceTier('anthropic')).not.toThrow()
    for (const role of roles) expect(clientOverrideFor(role)).toBeUndefined()
    const native = vi
      .spyOn(generated, 'GenerateConversationTitle')
      .mockResolvedValue('Synthetic title')
    await b.GenerateConversationTitle('same bytes')
    expect(native).toHaveBeenCalledWith('same bytes')
    configureConsumerClients(() => ({ client: 'CustomClient' }))
    expect(clientOverrideFor('describe')).toEqual({ client: 'CustomClient' })
    await withRunFrame(
      { inference: { clientOverride: () => ({ client: 'PerRun' }) } },
      async () => {
        expect(clientOverrideFor('describe')).toEqual({ client: 'PerRun' })
      },
    )
    vi.stubEnv('USE_SELF_DEPLOYED_INFERENCE', '1')
    expect(activeInferenceTier()).toBe('self_deployed')
  })
  it('validates a restricted server at boot without changing unset boot behavior', () => {
    vi.stubEnv('SMALL_LLM_BASE_URL', '')
    expect(() => assertInferenceDeploymentConfigured()).toThrow(/SMALL_LLM_BASE_URL/)
    vi.stubEnv('INFERENCE_TIERS', '')
    vi.stubEnv('USE_SELF_DEPLOYED_INFERENCE', '1')
    expect(() => assertInferenceDeploymentConfigured()).not.toThrow()
  })
  it('refuses unknown restriction values', () => {
    vi.stubEnv('INFERENCE_TIERS', 'typo')
    expect(() => privateInferenceOnly()).toThrow(/must be unset or self_deployed/)
  })
  it.each([
    'LARGE_LLM_BASE_URL',
    'LARGE_LLM_API_KEY',
    'SMALL_LLM_BASE_URL',
    'SMALL_LLM_DECISIONS_URL',
    'SMALL_LLM_API_KEY',
  ])('refuses boot with missing %s', async (key) => {
    vi.stubEnv(key, '')
    vi.resetModules()
    await expect(import('../../../lib/inference/config.server')).rejects.toThrow()
  })
})

it('production BAML value imports use the guarded boundary; middleware only initializes the singleton', () => {
  const root = fileURLToPath(new URL('../../../../..', import.meta.url))
  const violations: string[] = []
  function scan(dir: string) {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (!['node_modules', 'baml_client', '__tests__', 'baml_src'].includes(entry.name))
          scan(relative)
      } else if (/\.tsx?$/.test(entry.name)) {
        const text = readFileSync(path.join(root, relative), 'utf8')
        if (!text.includes('baml_client')) continue
        const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true)
        function check(spec: string) {
          const raw = /(?:^|\/)baml_client(?:\/|$)/.test(spec)
          if (
            raw &&
            !spec.endsWith('/inlinedbaml') &&
            ![
              'packages/harness-baml/guarded-client.server.ts',
              'app/src/middleware.ts',
              'packages/harness-baml/baml-version-check.server.ts',
            ].includes(relative)
          )
            violations.push(relative)
        }
        function visit(node: ts.Node) {
          // The two raw imports are initialization/metadata only. Neither may
          // grow a model call or reach another callable surface on the client.
          if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
            if (relative === 'app/src/middleware.ts' && node.expression.text === 'b')
              violations.push(relative)
            if (
              relative === 'packages/harness-baml/baml-version-check.server.ts' &&
              ((node.expression.text === 'client' && node.name.text !== 'version') ||
                node.expression.text === 'b')
            )
              violations.push(relative)
          }
          if (
            ts.isImportDeclaration(node) &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            !node.importClause?.isTypeOnly
          ) {
            const bindings = node.importClause?.namedBindings
            if (!(
              bindings &&
              ts.isNamedImports(bindings) &&
              bindings.elements.every((e) => e.isTypeOnly)
            ))
              check(node.moduleSpecifier.text)
          }
          if (
            ts.isExportDeclaration(node) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            !node.isTypeOnly
          )
            check(node.moduleSpecifier.text)
          if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments[0] &&
            ts.isStringLiteral(node.arguments[0])
          )
            check(node.arguments[0].text)
          ts.forEachChild(node, visit)
        }
        visit(source)
      }
    }
  }
  scan('app/src')
  scan('app/evals')
  scan('packages')
  expect(violations).toEqual([])
})

// Execute the actual boot statement with its real validator, without importing
// middleware's unrelated services. The AST requires its imported binding and
// unconditional module-level execution; comments and dead branches do not count.
function bootGate() {
  const source = ts.createSourceFile(
    'middleware.ts',
    readFileSync(new URL('../../../middleware.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const imported = source.statements.some(
    (node) =>
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === './lib/inference/tier-config.server' &&
      !node.importClause?.isTypeOnly &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings) &&
      node.importClause.namedBindings.elements.some(
        (binding) =>
          !binding.isTypeOnly &&
          !binding.propertyName &&
          binding.name.text === 'assertInferenceDeploymentConfigured',
      ),
  )
  expect(imported).toBe(true)
  const statement = source.statements.find(
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'assertInferenceDeploymentConfigured' &&
      node.expression.arguments.length === 0,
  )
  expect(statement, 'boot must unconditionally invoke its imported validator').toBeDefined()
  return () => runInNewContext(statement!.getText(source), { assertInferenceDeploymentConfigured })
}

describe('normal boot inference gate', () => {
  it('accepts complete private configuration with an empty public key', () => {
    expect(bootGate()).not.toThrow()
  })
  it.each([
    'LARGE_LLM_BASE_URL',
    'LARGE_LLM_API_KEY',
    'SMALL_LLM_BASE_URL',
    'SMALL_LLM_DECISIONS_URL',
    'SMALL_LLM_API_KEY',
  ])('refuses missing %s through the middleware invocation', (key) => {
    vi.stubEnv(key, '')
    expect(bootGate()).toThrow(new RegExp(key))
  })
})
