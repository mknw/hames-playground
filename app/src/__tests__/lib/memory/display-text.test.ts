import { describe, it, expect } from 'vitest'
import { displayText } from '../../../lib/memory/display-text'

describe('displayText', () => {
  // MUTATION (one per row): drop the matching replace → the string survives → red.
  it.each([
    ['a bidi override', 'abc‮def', 'abcdef'],
    ['a bidi isolate', 'a⁦b⁩c', 'abc'],
    ['a zero-width space', 'a​b', 'ab'],
    ['a BOM', '﻿hello', 'hello'],
    ['a control character', 'a\u0007b', 'a b'],
    ['a newline', 'line one\nline two', 'line one line two'],
    ['a line separator', 'a b', 'a b'],
    ['runs of space', 'a    b \t c', 'a b c'],
    ['an NFKC form', 'ＡＢ', 'AB'],
  ])('%s', (_n, input, out) => {
    expect(displayText(input)).toBe(out)
  })

  it.each([[null], [undefined], [7], [{}], [['a']]])('a non-string (%j) is empty', (v) => {
    expect(displayText(v)).toBe('')
  })

  it('leaves ordinary text, markup characters and non-Latin scripts alone', () => {
    expect(displayText('Prefers <b>metric</b> & "units" — 日本語')).toBe(
      'Prefers <b>metric</b> & "units" — 日本語',
    )
  })
})
