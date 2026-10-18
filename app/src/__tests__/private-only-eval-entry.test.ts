// @vitest-environment node
/** Execute the actual entry point with hermetic edges, never import the live
 * eval graph into CI. Unknown imports fail closed; the native call is spied. */
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as clients from '@hames-ai/harness-baml/clients.server'
import '../lib/inference/config.server'
import { b as generated } from '@hames-ai/harness-baml/baml_client'
import { b } from '@hames-ai/harness-baml/guarded-client.server'

function execute(file: string, modules: Record<string, unknown>, processStub: unknown) {
  const source = readFileSync(new URL(`../../evals/${file}.ts`, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports: Record<string, unknown> = {}
  runInNewContext(code, {
    exports,
    require: (id: string) => {
      if (!(id in modules)) throw new Error(`Unstubbed eval import: ${id}`)
      return modules[id]
    },
    process: processStub,
    console: { log: vi.fn(), error: vi.fn() },
    Date,
  })
  return exports
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it.each([
  ['private', '', 'VerdaQwen', 'VerdaQwen', true],
  ['private', 'screen', 'VerdaQwen', 'VerdaQwen', true],
  ['', '', undefined, 'VerdaQwen', true],
  ['', 'screen', undefined, 'VerdaQwen', true],
  ['private', 'screen', 'VerdaQwen', 'WrongClient', false],
] as const)(
  'preflights the real eval entry: restriction=%s roles=%s',
  async (restriction, roles, client, served, shouldPass) => {
    for (const [key, value] of Object.entries({
      INFERENCE_TIERS: restriction,
      EVAL_CLIENT: 'tier',
      EVAL_ROLES: roles,
      EVAL_ONLY: 'screen-on-the-tier',
      ANTHROPIC_API_KEY: '',
      VERDA_INFERENCE_ENDPOINT: 'https://chat.example.invalid/v1',
      VERDA_INFERENCE_API_KEY: 'synthetic-key',
      SMALL_LLM_BASE_URL: 'https://small.example.invalid/v1',
      SMALL_LLM_DECISIONS_URL: 'https://small.example.invalid/v1/systemone',
      SMALL_LLM_API_KEY: 'synthetic-key',
    }))
      vi.stubEnv(key, value)
    const native = vi.spyOn(generated, 'Critic').mockResolvedValue({} as never)
    const exit = vi.fn()
    const writeReport = vi.fn().mockResolvedValue('synthetic-report')
    const processStub = { env: process.env, stdout: { write: vi.fn() }, exit, exitCode: 0 }
    const evalClient = execute(
      'client',
      {
        '@hames-ai/harness-baml/clients.server': clients,
        '../src/lib/inference/config.server': {},
      },
      processStub,
    )
    const scenarios = new Proxy(
      {},
      {
        get: (_, name) => ({
          id: name === 'screenScenario' ? 'screen-on-the-tier' : String(name),
          role: 'screen',
        }),
      },
    )
    const modules: Record<string, unknown> = {
      '@boundaryml/baml': {
        Collector: class {
          last = { calls: [{ selected: true, clientName: served }] }
        },
      },
      '@hames-ai/harness-baml/clients.server': clients,
      '@hames-ai/harness-baml/guarded-client.server': { b },
      './client': evalClient,
      './harness': {
        runScenario: vi.fn(async (scenario) => ({ scenario, checks: [], ms: 0 })),
        scenarioPassed: () => true,
      },
      './report': { renderReport: () => 'synthetic report', writeReport },
    }
    for (const name of [
      'router',
      'controller',
      'actor-critic',
      'synthesizer',
      'describe',
      'reference-selector',
      'screen',
      'reliability',
    ])
      modules[`./scenarios/${name}`] = scenarios
    modules['./scenarios/planner'] = {
      plannerScenario: { id: 'planner', role: 'planner' },
      isThinkingPlannerRun: () => false,
    }
    execute('run', modules, processStub)
    await vi.waitFor(() =>
      expect(writeReport.mock.calls.length + exit.mock.calls.length).toBeGreaterThan(0),
    )
    if (!shouldPass) {
      expect(exit).toHaveBeenCalledWith(1)
      expect(native).toHaveBeenCalledOnce()
      expect(writeReport).not.toHaveBeenCalled()
      return
    }
    expect(exit).not.toHaveBeenCalled()
    expect(native).toHaveBeenCalledOnce()
    expect(native.mock.calls[0][2]).toMatchObject(client ? { client } : {})
    if (!client) expect(native.mock.calls[0][2]).not.toHaveProperty('client')
    expect(writeReport).toHaveBeenCalledOnce()
  },
)
