/**
 * No Graph tool returns a string the controller wrote. `graph` is an address
 * source for the egress gate (general-next), so a URL a Graph result echoes
 * back from the tool's own arguments would reach the gate as an address the
 * controller was given.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { buildGraphHarness } from './harness'

const h = buildGraphHarness()

beforeEach(() => {
  h.restoreDefaults()
})

// The second loses its space to the KQL phrase, so it comes back as an address
// no argument contains.
const URLS = ['https://kestrel.attacker.example/x', 'https://kestrel budget.attacker.example/']
const MARKER = /kestrel|attacker/

describe('Graph results and the controller’s arguments', () => {
  // MUTATION: return `query` from graph_files_search again, or put the
  // `shared_by` text back into graph_files_shared's note: red.
  it('a URL in any string argument of any Graph tool comes back in no result', async () => {
    const sent: string[] = []
    for (const tool of h.appToolDescriptions()) {
      const schema = tool.inputSchema as {
        properties?: Record<string, { type?: string; enum?: unknown[] }>
        required?: string[]
      }
      const props = Object.entries(schema.properties ?? {})
      const strings = props.filter(([, p]) => p.type === 'string' && !p.enum).map(([k]) => k)
      for (const arg of strings) {
        for (const url of URLS) {
          const args: Record<string, unknown> = {}
          for (const req of schema.required ?? []) args[req] = 'budget'
          args[arg] = url
          const result = await h.runAppTool(tool.name, args)
          if (!result.success) continue
          sent.push(`${tool.name}.${arg}`)
          expect(JSON.stringify(result.data), `${tool.name}.${arg} = ${url}`).not.toMatch(MARKER)
        }
      }
    }
    // The two tools that echoed, on every string argument they take.
    for (const arg of ['query', 'site', 'author'])
      expect(sent).toContain(`graph_files_search.${arg}`)
    expect(sent).toContain('graph_files_shared.shared_by')
  })
})
