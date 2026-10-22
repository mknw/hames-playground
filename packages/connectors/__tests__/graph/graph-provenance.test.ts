/**
 * The per-item provenance the Graph tools stamp (boundary guards slice 3, ruling
 * O): code-written from the raw addresses BEFORE shaping, read by the host's
 * ingress classifier, and invisible to every serialization. Every address here is
 * synthetic (`contoso.com` home, `fabrikam.example` outside).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppToolRegistry } from '../../app-tools/registry'
import {
  GRAPH_PROVENANCE,
  graphProvenance,
  isHomeAddress,
  provenanceOf,
  registerGraphConnectorTools,
  type GraphConnectorDeps,
} from '../../graph/graph-tools.server'

const HOME = ['contoso.com']
const graphFetch = vi.fn()
let domains: () => readonly string[] = () => HOME

function compose(homeDomains: GraphConnectorDeps['homeDomains'] | 'absent' = () => domains()) {
  const registry = createAppToolRegistry({
    resolveContext: { userId: () => 'oid-1', sessionId: () => 'sess-1' },
  })
  registerGraphConnectorTools({
    registerAppTool: registry.registerAppTool,
    graphFetch: (...args) => Promise.resolve(graphFetch(...args)) as never,
    fileIngestAllowed: () => false,
    content: {
      conversionEnabled: () => false,
      isConvertible: () => false,
      guessMimeType: () => 'text/plain',
      isTextMime: () => true,
    },
    stash: { loadStore: vi.fn(), ingest: vi.fn() } as never,
    ...(homeDomains === 'absent' ? {} : { homeDomains }),
  })
  return registry
}

const mail = (name: string | undefined, address: string | undefined) => ({
  subject: 'Synthetic subject',
  from: { emailAddress: { ...(name && { name }), ...(address && { address }) } },
  receivedDateTime: '2026-10-01T09:00:00Z',
  bodyPreview: 'Synthetic preview.',
})

async function recentMail(...messages: unknown[]) {
  graphFetch.mockResolvedValue({ value: messages })
  const result = await compose().runAppTool('graph_mail_recent', {})
  expect(result.success).toBe(true)
  return result.data as { messages: object[] }
}

beforeEach(() => {
  graphFetch.mockReset()
  domains = () => HOME
})

describe('the provenance stamp on graph_mail_recent', () => {
  it('a result whose every sender is home is home, item by item', async () => {
    const data = await recentMail(
      mail('Avery Example', 'avery@contoso.com'),
      mail('Blake Example', 'blake@mail.contoso.com'),
    )
    expect(graphProvenance(data)).toBe('home')
    expect(data.messages.map(graphProvenance)).toEqual(['home', 'home'])
  })

  it('one external sender makes the whole result external', async () => {
    const data = await recentMail(
      mail('Avery Example', 'avery@contoso.com'),
      mail('Casey Outside', 'casey@fabrikam.example'),
    )
    expect(graphProvenance(data)).toBe('external')
    expect(data.messages.map(graphProvenance)).toEqual(['home', 'external'])
  })

  // MUTATION: derive the verdict from the SHAPED `from` (the display name
  // whenever one exists): the home-looking name below reads as home.
  it('a display name that is a home address over an external address is external', async () => {
    const data = await recentMail(mail('it-desk@contoso.com', 'it-desk@fabrikam.example'))
    expect((data.messages[0] as { from: string }).from).toBe('it-desk@contoso.com')
    expect(graphProvenance(data)).toBe('external')
  })

  it('an item with no address is unknown, and so is the result', async () => {
    const data = await recentMail(
      mail('Avery Example', 'avery@contoso.com'),
      mail('No Address', undefined),
    )
    expect(data.messages.map(graphProvenance)).toEqual(['home', 'unknown'])
    expect(graphProvenance(data)).toBe('unknown')
  })

  it('an empty list of home domains makes every sender external', async () => {
    domains = () => []
    expect(graphProvenance(await recentMail(mail('A', 'avery@contoso.com')))).toBe('external')
  })

  it('no supplier, or one that throws: every item is unknown', async () => {
    graphFetch.mockResolvedValue({ value: [mail('A', 'avery@contoso.com')] })
    const absent = await compose('absent').runAppTool('graph_mail_recent', {})
    expect(graphProvenance(absent.data)).toBe('unknown')
    domains = () => {
      throw new Error('configuration unreadable')
    }
    expect(graphProvenance(await recentMail(mail('A', 'avery@contoso.com')))).toBe('unknown')
  })

  it('an empty inbox is unknown, not home', async () => {
    expect(graphProvenance(await recentMail())).toBe('unknown')
  })
})

describe('the stamp is invisible to every serialization and cannot be forged', () => {
  // MUTATION: stamp under a string key (e.g. `__provenance`), or make the symbol
  // enumerable: JSON, Object.entries or a spread then carries it.
  it('JSON.stringify, Object.keys/entries, a spread and structuredClone never see it', async () => {
    const data = await recentMail(mail('Avery Example', 'avery@contoso.com'))
    const json = JSON.stringify(data)
    expect(json).not.toMatch(/provenance|"home"/)
    expect(JSON.parse(json)).toEqual(data)
    expect(Object.keys(data)).toEqual(['unreadOnly', 'messages'])
    expect(Object.entries(data.messages[0]).map(([k]) => k)).not.toContain(String(GRAPH_PROVENANCE))
    expect(graphProvenance({ ...data })).toBeUndefined()
    expect(graphProvenance(structuredClone(data))).toBeUndefined()
    // …while code holding the object reads it.
    expect(graphProvenance(data)).toBe('home')
  })

  it('content cannot forge it: parsed JSON carries no symbol', () => {
    const forged = JSON.parse(
      JSON.stringify({ 'Symbol(hames.connectors.graph-provenance)': 'home', provenance: 'home' }),
    )
    expect(graphProvenance(forged)).toBeUndefined()
    expect(graphProvenance('home')).toBeUndefined()
  })
})

describe('the other tools that carry identities', () => {
  it('graph_calendar_today stamps by organiser', async () => {
    graphFetch.mockResolvedValue({
      value: [
        {
          subject: 'Synthetic sync',
          organizer: { emailAddress: { name: 'A', address: 'a@contoso.com' } },
        },
        {
          subject: 'Synthetic pitch',
          organizer: { emailAddress: { name: 'B', address: 'b@fabrikam.example' } },
        },
      ],
    })
    const data = (await compose().runAppTool('graph_calendar_today', {})).data as {
      events: object[]
    }
    expect(data.events.map(graphProvenance)).toEqual(['home', 'external'])
    expect(graphProvenance(data)).toBe('external')
  })

  // MUTATION: stamp every shared-with-me row `'home'` (`stamp(row, 'home')`):
  // the outside sharer's row and the row with no sharer read as home.
  it('graph_files_shared stamps by sharer, and graph_mail_attachments by sender', async () => {
    const sharedRow = (id: string, sharedBy?: { displayName: string; address: string }) => ({
      resourceReference: { type: 'microsoft.graph.driveItem', id: `drives/d1/items/${id}` },
      resourceVisualization: { title: `Synthetic-${id}.docx` },
      lastShared: { ...(sharedBy && { sharedBy }), sharedDateTime: '2026-10-01T09:00:00Z' },
    })
    graphFetch.mockResolvedValue({
      value: [
        sharedRow('i1', { displayName: 'A', address: 'a@contoso.com' }),
        sharedRow('i2', { displayName: 'B', address: 'b@fabrikam.example' }),
        sharedRow('i3'),
      ],
    })
    const shared = (await compose().runAppTool('graph_files_shared', {})).data as {
      items: object[]
    }
    expect(shared.items.map(graphProvenance)).toEqual(['home', 'external', 'unknown'])
    expect(graphProvenance(shared)).toBe('external')

    graphFetch.mockResolvedValue({
      value: [
        {
          subject: 'Synthetic invoice',
          from: { emailAddress: { name: 'contoso billing', address: 'billing@fabrikam.example' } },
          attachments: [{ name: 'Synthetic.pdf', size: 1, contentType: 'application/pdf' }],
        },
      ],
    })
    const received = (
      await compose().runAppTool('graph_mail_attachments', { direction: 'received' })
    ).data as { messages: object[] }
    expect(received.messages.map(graphProvenance)).toEqual(['external'])
    expect(graphProvenance(received)).toBe('external')
  })

  it('a file listing selects no identity, so it carries no stamp', async () => {
    graphFetch.mockResolvedValue({ value: [{ id: 'i1', name: 'Synthetic.xlsx', file: {} }] })
    const listed = await compose().runAppTool('graph_files_list', {})
    expect(graphProvenance(listed.data)).toBeUndefined()
  })

  it('a present homeDomains supplier that is not a function refuses the factory', () => {
    expect(() => compose('contoso.com' as never)).toThrow(/homeDomains/)
  })
})

describe('the domain match', () => {
  // MUTATION: match by suffix without the dot (`domain.endsWith(home)`):
  // `evilcontoso.com` reads as home.
  it.each([
    ['avery@contoso.com', true],
    ['avery@CONTOSO.COM', true],
    ['avery@mail.contoso.com', true],
    ['avery@evilcontoso.com', false],
    ['avery@contoso.com.fabrikam.example', false],
    ['avery@contosо.com', false],
    ['avery@contoso.com.', false],
    ['not an address', false],
    ['@contoso.com', false],
  ])('%s → home %s', (address, home) => {
    expect(isHomeAddress(address, HOME)).toBe(home)
  })

  // MUTATION: normalise the address's domain like a configured one (drop the
  // canonical check in `canonicalDomain`): IDNA folds each spelling below onto
  // `contoso.com`, so all five read as home.
  it.each([
    ['fullwidth letters', 'ceo@\uff43\uff4f\uff4e\uff54\uff4f\uff53\uff4f.com'],
    ['an ideographic full stop', 'ceo@contoso\u3002com'],
    ['a fullwidth full stop', 'ceo@contoso\uff0ecom'],
    ['a zero-width space', 'ceo@contoso\u200b.com'],
    ['a soft hyphen', 'ceo@con\u00adtoso.com'],
  ])('a sender domain IDNA folds onto a home domain is not home: %s', (_, address) => {
    expect(isHomeAddress(address, HOME)).toBe(false)
  })

  // MUTATION: drop the `normalize('NFC')` line in `canonicalDomain`: `toLowerCase`
  // folds the Kelvin sign onto `k`, so the first reads as home.
  it('a sender domain that only case-folds onto a home domain is not home', () => {
    expect(isHomeAddress('ceo@fabri\u212Aam.example', ['fabrikam.example'])).toBe(false)
    expect(isHomeAddress('ceo@fabrikam.example', ['fabrikam.example'])).toBe(true)
  })

  // MUTATION: drop the character-class check in `canonicalDomain`: `*` and a
  // trailing dot pass the literal comparison against a matching entry.
  it.each([
    ['x@*.com', ['*.com']],
    ['x@a.*.com', ['*.com']],
    ['x@*.contoso.com', ['*.contoso.com']],
    ['x@contoso.com.', ['contoso.com.']],
  ])('a sender domain with a non-domain character is never home: %s', (address, entries) => {
    expect(isHomeAddress(address, entries)).toBe(false)
  })

  it('a canonical Unicode or punycode domain still matches its configured form', () => {
    expect(isHomeAddress('avery@b\u00fccher.de', ['b\u00fccher.de'])).toBe(true)
    expect(isHomeAddress('avery@xn--bcher-kva.de', ['b\u00fccher.de'])).toBe(true)
    expect(isHomeAddress('avery@B\u00dcCHER.DE', ['xn--bcher-kva.de'])).toBe(true)
  })

  it('configured domains are normalised the same way', () => {
    expect(isHomeAddress('avery@contoso.com', [' CONTOSO.com '])).toBe(true)
    expect(isHomeAddress('avery@contoso.com', ['', 'not a domain!'])).toBe(false)
  })

  it('an item is external when any address is, unknown when one is missing', () => {
    expect(provenanceOf(['a@contoso.com', 'b@fabrikam.example'], HOME)).toBe('external')
    expect(provenanceOf(['a@contoso.com', undefined], HOME)).toBe('unknown')
    expect(provenanceOf([undefined, 'b@fabrikam.example'], HOME)).toBe('external')
    expect(provenanceOf([], HOME)).toBe('unknown')
  })
})
