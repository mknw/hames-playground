/**
 * The `tool_args` double-encoding failure class (#145), closed at the parse
 * side for the shapes that are recoverable without guessing.
 *
 * The anchor is the real payload from `.harness-logs/sandbox-tool-recovery.json`
 * (event `ev-tey7ez`, `flavour-office-loop`), carried verbatim in
 * `fixtures/sandbox-edit-unescaped-quotes.json`. Every assertion here fails
 * against `parseUnescapedContent`'s absence, and the decline cases fail against
 * a version of it that guesses instead of declining — the two mutations this
 * file exists to catch.
 */

import { describe, it, expect } from 'vitest'
import { repairJson, repairJsonTracked } from '@hames-ai/harness-patterns/json-repair'
import incident from './fixtures/sandbox-edit-unescaped-quotes.json'

describe('repairJson — string content that was not escaped', () => {
  describe('the captured sandbox_edit incident', () => {
    it('is the shape the analysis claims: strict JSON rejects it mid-string, and it is not a truncation', () => {
      // Pins the premise the whole fix rests on. If this ever stops holding,
      // the fixture was reformatted and every assertion below is testing
      // something other than the incident.
      expect(() => JSON.parse(incident.toolArgs)).toThrow(/Expected ',' or '}'/)
      expect(incident._notTruncation.hitOutputCap).toBe(false)
      expect(incident.toolArgs.length).toBeGreaterThan(19_000)
    })

    it('recovers the actor sandbox_edit that the loop threw away', () => {
      const args = repairJson(incident.toolArgs) as {
        path: string
        edits: { oldText: string; newText: string }[]
      }

      expect(args.path).toBe('/work/build_model.py')
      expect(args.edits).toHaveLength(1)
      expect(args.edits[0].oldText).toContain(
        "wb.save('/work/out/AI_Transformation_Business_Model.xlsx')",
      )
    })

    it('restores the Excel formulas verbatim — the quotes that broke the parse are back as content', () => {
      // The defect was a Python double-quoted string holding a formula that
      // references a sheet name with a space. Recovering the payload but
      // dropping or moving one of those quotes would write broken Python into
      // the user's file, which is worse than the failure this replaces.
      const { newText } = (repairJson(incident.toolArgs) as { edits: { newText: string }[] })
        .edits[0]

      expect(newText).toContain(
        `('Total Revenue (from Revenue Model, annual)', "='Revenue Model'!N"`,
      )
      expect(newText).toContain(`"*'Cost Structure'!B" + str(var_start+1)`)
      // The five sites the model DID escape correctly must survive unchanged
      // alongside the 33 it did not.
      expect(newText).toContain(`'Key Resources': "Consultant's AI/operations expertise`)
      expect(newText.trimEnd().endsWith("print('all sheets saved')")).toBe(true)
    })

    it('reports the recovery rather than passing it off as clean model output', () => {
      const { repair } = repairJsonTracked(incident.toolArgs)

      expect(repair?.strategy).toBe('unescaped-content')
      expect(repair?.counts).toEqual({ quotes: 33, controlChars: 0 })
    })
  })

  describe('minimal repros of the same class', () => {
    it('reads a content quote that the structure does not need as a delimiter', () => {
      // Two keys on purpose. On one key the lenient chain's last-resort
      // handler happens to land on the right answer; on two it reads the
      // `"` as the end of `path` and swallows `content` into it, returning
      // ONE key and no error — so a single-key repro would pass with this
      // strategy removed and pin nothing.
      expect(repairJson('{"path": "/work/f.py", "content": "print("hello")"}')).toEqual({
        path: '/work/f.py',
        content: 'print("hello")',
      })
    })

    it('reads a raw newline inside a string — strict JSON has no other reading for it', () => {
      expect(repairJson('{"command": "import os\nprint(os.getcwd())"}')).toEqual({
        command: 'import os\nprint(os.getcwd())',
      })
      expect(repairJsonTracked('{"command": "a\nb"}').repair?.counts).toEqual({
        quotes: 0,
        controlChars: 1,
      })
    })

    it('handles content quotes nested inside arrays and objects', () => {
      expect(repairJson('{"edits": [{"newText": "x = "y""}]}')).toEqual({
        edits: [{ newText: 'x = "y"' }],
      })
    })

    it('leaves a correctly escaped quote alone in the same payload', () => {
      expect(repairJson('{"a": "ok \\"kept\\"", "b": "bad "loose""}')).toEqual({
        a: 'ok "kept"',
        b: 'bad "loose"',
      })
    })
  })

  describe('what it must NOT do', () => {
    it('does not report a repair when the model wrote valid JSON', () => {
      expect(repairJsonTracked('{"query": "movies"}').repair).toBeUndefined()
    })

    it('declines rather than half-reads a payload with a trailing brace', () => {
      // Structural damage, not an escaping mistake: reading it would mean
      // choosing which brace the model meant.
      expect(() => repairJson('{"a": "b"}}')).toThrow()
    })

    it('declines an unknown escape instead of guessing what it stood for', () => {
      // `\p` is not a JSON escape, so the model's escaping is broken in a way
      // this strategy cannot infer. It hands the payload on rather than
      // deciding what the backslash stood for — the lenient chain then keeps
      // it literal, which is its call to make, not this one's.
      expect(repairJsonTracked('{"a": "c:\\path"}')).toEqual({
        args: { a: 'c:\\path' },
        repair: { strategy: 'lenient-tokens' },
      })
    })

    // A REGRESSION GUARD, not a mutation-killed pin, and labelled so rather
    // than left looking like one: the decline below is over-determined —
    // readString's "a key must start with a quote", readObject's unexpected-
    // token throw, and the full-consumption check each catch it alone, so no
    // single mutation (nor the two in combination) reddens it. It is here
    // because the plausible future change is someone adding BACKTRACKING to
    // "improve" the recovery rate, and that would break it.
    it('declines when a content quote is followed by a real delimiter — the one ambiguous site', () => {
      // `print("hello", x)`: the quote after `hello` is followed by `,`, which
      // IS what closes a member value, so the structure cannot tell the two
      // readings apart. The greedy reading runs out of grammar one token later
      // and the WHOLE document is declined — a half-read `print("hello` must
      // never reach a write tool. What the lenient chain then makes of it is
      // its own pre-existing business; the assertion is that this strategy
      // refused rather than guessed.
      const raw = '{"c": "print("hello", x)", "path": "/work/f.py"}'
      const out = repairJsonTracked(raw)

      expect(out.repair?.strategy).not.toBe('unescaped-content')
      expect(out.args.c).not.toBe('print("hello')
    })

    it('but keeps reading when the delimiter is the wrong one for this position', () => {
      // `]` closes an ARRAY element, and this is a member value, so the `"`
      // before it is content. Only the quote followed by `,` closes. This is
      // what the position-specific follow set buys over a flat "any delimiter"
      // rule, which would have truncated at `d[`.
      expect(repairJson('{"c": "d["k"]", "path": "/p"}')).toEqual({
        c: 'd["k"]',
        path: '/p',
      })
    })

    it('declines a mis-split that would otherwise come back complete and WRONG', () => {
      // The counterexample that falsified this module's original "a wrong
      // greedy reading always runs out of grammar" claim. The model meant one
      // `cmd` holding two quoted words; encoded with one escape level it
      // splits at the `",` and the REMAINDER parses — so the result was a
      // complete, well-formed object with a fabricated second key, reported as
      // a clean `unescaped-content` recovery. Nothing downstream could tell.
      //
      // The key guard catches it: `b"",\"p` is a key that needed content
      // recovery, and a real key never does (a legitimate quote in one arrives
      // escaped). It falls through to the lenient chain instead, which is free
      // to make its own mess of it — but tags that as `lenient-tokens` rather
      // than claiming a structural read.
      const intended = { cmd: 'echo "a", "b"', p: '/x' }
      const underEscaped = JSON.stringify(intended).replace(/\\"/g, '"')

      expect(underEscaped).toBe('{"cmd":"echo "a", "b"","p":"/x"}')
      expect(repairJsonTracked(underEscaped).repair?.strategy).not.toBe('unescaped-content')
    })

    it('leaves a key alone when its quote arrived properly escaped', () => {
      // The guard keys off CONTENT recovery, not off quotes as such, so a key
      // the model encoded correctly still parses while the rest is recovered.
      expect(repairJson('{"a\\"b": "x = "y""}')).toEqual({ 'a"b': 'x = "y"' })
    })

    // DOCUMENTED LIMITATION (review F4), pinned so the docblock is verifiable
    // and so anyone who later "fixes" it sees this fail rather than discovers
    // it. Eager-close plus an ODD number of bare quotes in a value leaves every
    // key clean, so the key guard never fires and the VALUE is cut short. Left
    // open deliberately: closing it means backtracking, and refusing to
    // backtrack is what keeps this module from guessing.
    it('can still truncate a VALUE when a value holds an odd number of bare quotes', () => {
      expect(repairJsonTracked('{"a": "say "hi", "b": 1}')).toEqual({
        args: { a: 'say "hi', b: 1 },
        repair: { strategy: 'unescaped-content', counts: { quotes: 1, controlChars: 0 } },
      })
    })

    it('recovers the realistic under-escaped shapes, which come in quote PAIRS', () => {
      // Why the limitation above is tolerable: real under-escaping emits both
      // quotes of a pair, and an eager close on the first leaves the second
      // unpaired, which cascades into a decline instead of a silent cut.
      expect(repairJson('{"len": "5" wide", "unit": "in"}')).toEqual({
        len: '5" wide',
        unit: 'in',
      })
      expect(repairJson('{"a": "x "y" z", "b": 1}')).toEqual({ a: 'x "y" z', b: 1 })
      expect(repairJson('{"command": "python3 -c "import os, sys""}')).toEqual({
        command: 'python3 -c "import os, sys"',
      })
    })

    it('declines a root that is not an object — tool_args has one shape', () => {
      expect(() => repairJson('["a" "b"]')).toThrow()
    })

    it('does not let a __proto__ key from model output reach the prototype', () => {
      const args = repairJson('{"__proto__": "x = "y"", "path": "/work/f.py"}')

      expect(Object.getPrototypeOf(args)).toBe(Object.prototype)
      expect(({} as Record<string, unknown>).path).toBeUndefined()
      expect(Object.prototype.hasOwnProperty.call(args, '__proto__')).toBe(true)
    })
  })

  describe('ordering: this strategy runs before the token-rewriting chain', () => {
    it('stops the chain wrapping a raw-newline script in quotes it never wrote', () => {
      // Captured in `.harness-logs/nodes-websearch.json`: the lenient regex
      // chain "repaired" this into {"script": "\"const g = …\""}, two quote
      // characters the model never emitted, turning the whole program into a
      // string literal that code-mode would have run as a no-op. It returned a
      // value, so nothing failed and nothing was logged — exactly the silent
      // mis-coercion #217(b) is open about.
      const raw = '{"name": "code-mode", "arguments": {"script": "const g = f({});\nrun(g);"}}'

      expect(repairJson(raw)).toEqual({
        name: 'code-mode',
        arguments: { script: 'const g = f({});\nrun(g);' },
      })
    })

    it('still leaves unquoted keys and bare values to the chain that was written for them', () => {
      expect(repairJsonTracked('{query: movies}')).toEqual({
        args: { query: 'movies' },
        repair: { strategy: 'lenient-tokens' },
      })
    })
  })
})
