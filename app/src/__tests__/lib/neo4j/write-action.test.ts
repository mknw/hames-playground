/**
 * Tests for the parameterised Cypher write action used by the graph editor.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const run = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)

vi.mock('../../../lib/neo4j/client', () => ({
  getNeo4jDriver: () => ({ session: () => ({ run, close }) }),
}))

import { executeCypherWrite } from '../../../lib/neo4j/write-action'

beforeEach(() => {
  run.mockReset().mockResolvedValue({ records: [] })
  close.mockClear()
})

describe('executeCypherWrite', () => {
  it('passes the query and its parameters to the session', async () => {
    await executeCypherWrite('MATCH (n) WHERE elementId(n) = $id SET n.name = $name', {
      id: '4:abc:1',
      name: 'Alice',
    })
    expect(run).toHaveBeenCalledWith('MATCH (n) WHERE elementId(n) = $id SET n.name = $name', {
      id: '4:abc:1',
      name: 'Alice',
    })
  })

  it('defaults to an empty parameter map', async () => {
    await executeCypherWrite('CREATE (n:Person)')
    expect(run).toHaveBeenCalledWith('CREATE (n:Person)', {})
  })

  it('propagates write failures to the caller', async () => {
    run.mockRejectedValue(new Error('constraint violation'))
    await expect(executeCypherWrite('CREATE (n:Person)')).rejects.toThrow('constraint violation')
  })

  it('closes the session whether the write succeeds or fails', async () => {
    await executeCypherWrite('CREATE (n:Person)')
    run.mockRejectedValue(new Error('nope'))
    await expect(executeCypherWrite('CREATE (n:Person)')).rejects.toThrow()
    expect(close).toHaveBeenCalledTimes(2)
  })
})
