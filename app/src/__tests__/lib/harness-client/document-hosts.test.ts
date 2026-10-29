// @vitest-environment node
// GRAPH_DOCUMENT_HOSTS (#784 item 6): the tenant's own SharePoint/OneDrive hosts
// the Graph guards' `sourceLinks` exempt. The exemption matches hostnames
// exactly, so an entry that is not one would read like configuration and match
// nothing; it refuses instead.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { documentHosts } from '../../../lib/harness-client/document-hosts.server'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('documentHosts()', () => {
  it('unset or empty: no host', () => {
    vi.stubEnv('GRAPH_DOCUMENT_HOSTS', undefined)
    expect(documentHosts()).toEqual([])
    vi.stubEnv('GRAPH_DOCUMENT_HOSTS', ' , ')
    expect(documentHosts()).toEqual([])
  })

  it('reads every entry, trimmed and lower-cased', () => {
    vi.stubEnv('GRAPH_DOCUMENT_HOSTS', ' Contoso.SharePoint.com , contoso-my.sharepoint.com')
    expect(documentHosts()).toEqual(['contoso.sharepoint.com', 'contoso-my.sharepoint.com'])
  })

  // MUTATION: drop the HOSTNAME check: red on every case.
  it.each([
    '*.sharepoint.com',
    'https://contoso.sharepoint.com',
    'contoso.sharepoint.com/sites',
    'contoso.sharepoint.com:443',
    'localhost',
  ])('refuses an entry that is not a bare hostname: %s', (entry) => {
    vi.stubEnv('GRAPH_DOCUMENT_HOSTS', `contoso.sharepoint.com,${entry}`)
    expect(() => documentHosts()).toThrow(/GRAPH_DOCUMENT_HOSTS entry .* is not a bare hostname/)
  })
})
