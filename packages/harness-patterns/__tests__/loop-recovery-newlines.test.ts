/**
 * The JSON-decoded-newline classifier (`unterminatedStringFeedback`, #1018).
 *
 * A sandbox actor writing Python inside a JSON `tool_args` wrote `'\n'` where
 * the code needed the two characters `\n`: JSON decoding turned the escape
 * into a real line break inside a quoted string literal, and the executed
 * script died with `SyntaxError: unterminated string literal` — an error that
 * says nothing about the cause, so the retry rewrote the same script and died
 * the same way. The classifier recognises that signature on a tool error plus
 * a decoded argument, and returns the exact fix to append to the next
 * attempt's context.
 *
 * Each test names the mutation that reddens it; every one was run (#1018,
 * mutation table in the PR body).
 */

import { describe, expect, it } from 'vitest'
import { unterminatedStringFeedback } from '@hames-ai/harness-patterns/loop-recovery.server'

/** The captured failure: the escape decoded, the literal left open at it. */
const NEWLINE_BUG = { code: "text = '\n'.join(rows)" }
const REAL_ERROR = 'SyntaxError: unterminated string literal (detected at line 1)'
const OLD_ERROR = 'SyntaxError: EOL while scanning string literal'
const FIX = 'escape the backslash'

describe('the classifier matches the signature', () => {
  // Mutation: make `opensLiteralAcrossNewline` return false unconditionally →
  // every positive here goes red and the loops fall back to the bare error.
  it('the captured run: a raw break inside a single-quoted literal', () => {
    expect(unterminatedStringFeedback(NEWLINE_BUG, REAL_ERROR)).toContain(FIX)
  })

  it('the pre-3.10 spelling of the same error', () => {
    expect(unterminatedStringFeedback(NEWLINE_BUG, OLD_ERROR)).toContain(FIX)
  })

  it('a raw break inside a double-quoted literal', () => {
    expect(unterminatedStringFeedback({ code: 'msg = "hello\nworld"' }, REAL_ERROR)).toContain(FIX)
  })

  it('wherever the code hides in the args — nested objects and arrays', () => {
    expect(
      unterminatedStringFeedback(
        { files: [{ path: 'run.py', content: "text = '\n'.join(rows)" }] },
        REAL_ERROR,
      ),
    ).toContain(FIX)
  })

  it('the fix names the exact JSON spelling, not prose about escaping', () => {
    const fix = unterminatedStringFeedback(NEWLINE_BUG, REAL_ERROR)!
    // The instruction the model must copy: write \\n in JSON to get \n in code.
    expect(fix).toContain('\\\\n')
    expect(fix).toContain('triple quotes')
  })

  // Fix round 1, term 3 (coordinator): the REAL incident ran its Python
  // through a heredoc — `python3 - <<'PY'` reads the script from stdin, so the
  // body IS the code, and the mask that silenced it now keeps such a body.
  // Mutation: treat every heredoc body as masked (drop the `python` branch in
  // `maskHeredocBodies`) → this and the unquoted-delimiter positive go red.
  it('a heredoc-fed Python script with the bug matches — the incident shape', () => {
    expect(
      unterminatedStringFeedback(
        { command: "python3 - <<'PY'\nrows = ['a', 'b']\ntext = '\n'.join(rows)\nprint(text)\nPY" },
        REAL_ERROR,
      ),
    ).toContain(FIX)
  })

  it('the same through an unquoted delimiter and flags before the `-`', () => {
    expect(
      unterminatedStringFeedback(
        { command: "python3 -I - <<PY\ntext = '\n'.join(rows)\nPY" },
        REAL_ERROR,
      ),
    ).toContain(FIX)
  })

  it('a match survives an apostrophe in an earlier double-quoted string', () => {
    // `print("it's here")` closes its string on the line; the OPEN literal on a
    // later line is still the signature.
    expect(
      unterminatedStringFeedback(
        { code: "print(\"it's here\")\ntext = '\n'.join(rows)" },
        REAL_ERROR,
      ),
    ).toContain(FIX)
  })
})

describe('the classifier refuses everything else', () => {
  // Mutation: drop the `UNTERMINATED_STRING_ERROR_RE` test → these two go red
  // (the same args would fire on ANY tool error).
  it('an ordinary syntax error with the same args', () => {
    expect(unterminatedStringFeedback(NEWLINE_BUG, 'SyntaxError: invalid syntax')).toBeUndefined()
  })

  it('a different error class entirely', () => {
    expect(
      unterminatedStringFeedback(NEWLINE_BUG, 'NameError: name rows is not defined'),
    ).toBeUndefined()
  })

  // Mutation: drop the argument scan (return the guidance whenever the error
  // matches) → this and the empty-error test below go red.
  it('the matching error with args that carry no raw break in a quote', () => {
    expect(unterminatedStringFeedback({ query: 'MATCH (n) RETURN n' }, REAL_ERROR)).toBeUndefined()
  })

  it('no error text at all', () => {
    expect(unterminatedStringFeedback(NEWLINE_BUG, undefined)).toBeUndefined()
    expect(unterminatedStringFeedback(NEWLINE_BUG, '')).toBeUndefined()
  })

  // Mutation: delete the triple-quote mask in `opensLiteralAcrossNewline` →
  // the two legitimate multi-line strings below go red.
  it('a legitimate multi-line string in triple quotes', () => {
    expect(
      unterminatedStringFeedback(
        { code: "banner = '''dear reader,\nstay a while'''\nprint(banner)" },
        REAL_ERROR,
      ),
    ).toBeUndefined()
    expect(
      unterminatedStringFeedback(
        { code: 'banner = """dear reader,\nstay a while"""\nprint(banner)' },
        REAL_ERROR,
      ),
    ).toBeUndefined()
  })

  // Mutation: make `heredocFeedsPython` return true unconditionally (every
  // body scanned as code) → the legitimate-content heredocs above AND the
  // two below go red.
  it('a heredoc whose body is DATA — a script-file argument, `-c` — stays masked', () => {
    expect(
      unterminatedStringFeedback(
        { command: "python3 run.py <<EOF\ndon't stop reading\nEOF" },
        REAL_ERROR,
      ),
    ).toBeUndefined()
    expect(
      unterminatedStringFeedback(
        { command: "python3 -c 'print(1)' <<EOF\ndon't stop reading\nEOF" },
        REAL_ERROR,
      ),
    ).toBeUndefined()
  })

  it('a heredoc-fed Python script whose multi-line strings are triple-quoted', () => {
    expect(
      unterminatedStringFeedback(
        {
          command: "python3 - <<'PY'\nbanner = '''dear reader,\nstay a while'''\nprint(banner)\nPY",
        },
        REAL_ERROR,
      ),
    ).toBeUndefined()
  })

  // Mutation: delete the heredoc mask in `maskHeredocBodies` → the two
  // legitimate heredocs below go red (an apostrophe in prose is text there,
  // not an unterminated literal).
  it('legitimate heredoc content — quoted and unquoted delimiters', () => {
    expect(
      unterminatedStringFeedback(
        { command: "cat > notes.txt <<'EOF'\ndon't stop reading\nEOF" },
        REAL_ERROR,
      ),
    ).toBeUndefined()
    expect(
      unterminatedStringFeedback(
        { command: "cat > notes.txt <<EOF\ndon't stop reading\nEOF" },
        REAL_ERROR,
      ),
    ).toBeUndefined()
  })

  // Mutation: delete the `#`-comment skip → this goes red (a comment's
  // apostrophe is not a string).
  it('an apostrophe in a comment', () => {
    expect(
      unterminatedStringFeedback({ code: "# don't rush\nx = 1\nprint(x)" }, REAL_ERROR),
    ).toBeUndefined()
  })

  // The multi-line spellings of the failure are NOT the single-line signature:
  // a raw break inside triple quotes is legal, so the single-line fix would
  // misdirect there. The args still carry the single-line bug, so the ERROR
  // regex is the only thing standing between them and the guidance. Mutation:
  // widen the error regex with `|EOF in multi-line string` or a `triple-quoted`
  // alternative → this goes red.
  it('the multi-line spellings of the error do not get the single-line fix', () => {
    expect(
      unterminatedStringFeedback(
        NEWLINE_BUG,
        'SyntaxError: unterminated triple-quoted string literal (detected at line 1)',
      ),
    ).toBeUndefined()
    expect(
      unterminatedStringFeedback(NEWLINE_BUG, 'SyntaxError: EOF in multi-line string'),
    ).toBeUndefined()
  })
})
