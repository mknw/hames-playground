/**
 * Source scan: the share token comes out of the CSPRNG.
 *
 * The token is the only thing standing between an anonymous request and a
 * decrypted conversation, so where its bits come from is the security property
 * — not how long it is. The suite next door pins the SHAPE
 * (`/^[A-Za-z0-9_-]{43}$/`), and a 43-character string of `Math.random()`, a
 * hash of the conversation id and a timestamp all satisfy it. Replacing the
 * mint with any of them left `conversation-sharing.test.ts` fully green, which
 * is what this file exists to stop.
 *
 * A source scan rather than a statistical test on purpose. Sampling the mint
 * cannot distinguish a CSPRNG from a good-enough PRNG at any run length a unit
 * suite can afford, and a test that measures the output would go green on the
 * one substitution that matters. What is checkable is the call: this is a
 * property of the LINE, so the line is what gets asserted.
 *
 * It needs no database, so unlike its neighbours here it runs in CI, where the
 * DB-backed cases skip.
 */
import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// `process.cwd()` is `app/` under vitest — the anchor the other source-scan
// pins use (`encryption-coverage.test.ts`, `public-share-surface.test.ts`).
const MODULE = resolve(process.cwd(), 'src/lib/db/conversations.server.ts')

/**
 * Drop comments before scanning.
 *
 * The module's rationale header discusses the token's sizing at length, so a
 * scan that read prose could pass on a sentence and fail on a rewording. This
 * is about the code.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** `shareConversation`'s body — from its declaration to the closing brace in
 *  column 0. The mint has to be in THIS function; `randomBytes` appearing
 *  somewhere else in a 900-line module proves nothing about the token. */
function mintFunction(source: string): string {
  const match = /^export async function shareConversation[\s\S]*?^\}/m.exec(source)
  expect(match, 'shareConversation not found — this pin is scanning the wrong file').not.toBeNull()
  return match![0]
}

describe('the share token mint', () => {
  it('draws its bytes from randomBytes(SHARE_TOKEN_BYTES)', async () => {
    const mint = mintFunction(code(await readFile(MODULE, 'utf8')))
    // The constant, not a literal: 256 bits is the sizing decision recorded on
    // `SHARE_TOKEN_BYTES`, and a mint that inlined a number would let that
    // decision and the token drift apart.
    expect(mint).toContain('randomBytes(SHARE_TOKEN_BYTES)')
  })

  it('leaves no Math.random in the module that owns the token', async () => {
    const source = code(await readFile(MODULE, 'utf8'))
    // Belt to the brace above: a mint refactored into a helper elsewhere in
    // this file would still be caught, and `Math.random` has no legitimate use
    // in the module that mints an authenticator.
    expect(source).not.toContain('Math.random')
  })
})
