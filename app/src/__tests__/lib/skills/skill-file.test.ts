/**
 * `parseSkillFile` — the agentskills.io frontmatter rules, held exactly (#415).
 *
 * The specification's own valid and invalid `name` examples are here verbatim,
 * then every field rule, then the YAML hardening, then the one thing an
 * accepted upload is allowed to change (line endings and a BOM).
 */
import { describe, it, expect } from 'vitest'
import { parseSkillFile, utf8Bytes } from '../../../lib/skills/skill-file'
import { SKILL_FILE_MAX_BYTES } from '@hames-ai/sandbox/skills'

const file = (frontmatter: string, body = '# Use it\n\nDo the thing.\n') =>
  `---\n${frontmatter}\n---\n${body}`
const ok = (raw: string) => {
  const r = parseSkillFile(raw)
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`)
  return r.skill
}
const err = (raw: unknown) => {
  const r = parseSkillFile(raw)
  if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.skill.name)}`)
  return r.error
}

describe('name — the specification’s rule and examples', () => {
  it.each(['pdf-processing', 'data-analysis', 'code-review', 'a', '9x', 'a'.repeat(64)])(
    'accepts %s',
    (name) => {
      expect(ok(file(`name: ${name}\ndescription: d`)).name).toBe(name)
    },
  )

  it.each([
    ['PDF-Processing', 'may contain only lowercase letters'], // uppercase not allowed
    ['-pdf', 'must not start or end with a hyphen'], // cannot start with hyphen
    ['pdf-', 'must not start or end with a hyphen'],
    ['pdf--processing', 'consecutive hyphens'], // consecutive hyphens not allowed
    ['a'.repeat(65), 'must be 1-64 characters (it is 65)'],
    ['"pdf processing"', 'may contain only lowercase letters'],
    ['ünïcode', 'may contain only lowercase letters'],
    ['../escape', 'may contain only lowercase letters'],
    ['""', 'must be 1-64 characters (it is 0)'],
  ])('refuses %s', (name, why) => {
    expect(err(file(`name: ${name}\ndescription: d`))).toContain(why)
  })

  it('must be present, and a string', () => {
    expect(err(file('description: d'))).toBe('The frontmatter needs a "name".')
    expect(err(file('name: 42\ndescription: d'))).toBe('"name" must be a string.')
    expect(err(file('name: [a]\ndescription: d'))).toBe('"name" must be a string.')
  })
})

describe('description — 1 to 1024 characters, non-empty', () => {
  it('accepts exactly 1024 characters, counted as characters rather than bytes', () => {
    const d = 'é'.repeat(1024) // 2048 bytes, 1024 characters
    expect(ok(file(`name: x\ndescription: ${d}`)).description).toBe(d)
  })

  it('refuses 1025', () => {
    expect(err(file(`name: x\ndescription: ${'a'.repeat(1025)}`))).toContain(
      'at most 1024 characters (it is 1025)',
    )
  })

  it('refuses an absent, non-string, empty or blank description', () => {
    expect(err(file('name: x'))).toBe('The frontmatter needs a "description".')
    expect(err(file('name: x\ndescription: 7'))).toBe('"description" must be a string.')
    expect(err(file('name: x\ndescription: ""'))).toBe('"description" must not be empty.')
    expect(err(file('name: x\ndescription: "   "'))).toBe('"description" must not be empty.')
  })

  it('keeps a multi-line YAML description as YAML reads it', () => {
    expect(ok(file('name: x\ndescription: >\n  Two\n  lines.')).description).toBe('Two lines.\n')
  })
})

describe('the optional fields, and only those', () => {
  it('accepts every field the specification defines', () => {
    const s = ok(
      file(
        [
          'name: pdf-processing',
          'description: Extract PDF text.',
          'license: Apache-2.0',
          'compatibility: Requires Python 3.14+ and uv',
          'metadata:',
          '  author: example-org',
          '  version: "1.0"',
          'allowed-tools: Bash(git:*) Read',
        ].join('\n'),
      ),
    )
    expect(s.name).toBe('pdf-processing')
  })

  it('refuses a field the specification does not define, naming it', () => {
    expect(err(file('name: x\ndescription: d\nuser-invocable: true\nmodel: x'))).toBe(
      'The frontmatter has fields the Agent Skills specification does not define: ' +
        'user-invocable, model. Allowed: name, description, license, compatibility, ' +
        'metadata, allowed-tools.',
    )
  })

  it('holds compatibility to 1-500 characters', () => {
    expect(err(file(`name: x\ndescription: d\ncompatibility: ${'a'.repeat(501)}`))).toContain(
      '"compatibility" must be 1-500 characters (it is 501)',
    )
    expect(err(file('name: x\ndescription: d\ncompatibility: ""'))).toContain('(it is 0)')
    expect(err(file('name: x\ndescription: d\ncompatibility: 3'))).toBe(
      '"compatibility" must be a string.',
    )
  })

  it('holds metadata to string keys and string values', () => {
    expect(err(file('name: x\ndescription: d\nmetadata:\n  version: 1.0'))).toBe(
      '"metadata" values must be strings; "version" is not (quote it, e.g. "1.0").',
    )
    expect(err(file('name: x\ndescription: d\nmetadata: [a]'))).toBe(
      '"metadata" must be a map of keys to values.',
    )
  })

  it('holds license and allowed-tools to strings', () => {
    expect(err(file('name: x\ndescription: d\nlicense: [MIT]'))).toBe('"license" must be a string.')
    expect(err(file('name: x\ndescription: d\nallowed-tools: [Read]'))).toBe(
      '"allowed-tools" must be a space-separated string.',
    )
  })
})

describe('the file around the frontmatter', () => {
  it('needs an opening and a closing ---', () => {
    expect(err('name: x\ndescription: d\n')).toContain('first line must be "---"')
    expect(err('---\nname: x\ndescription: d\n')).toContain('not closed')
  })

  it('needs a mapping between them', () => {
    expect(err('---\n---\nbody')).toBe('The frontmatter must be a set of "field: value" lines.')
    expect(err('---\n- a\n- b\n---\n')).toBe(
      'The frontmatter must be a set of "field: value" lines.',
    )
  })

  it('refuses YAML aliases — the expansion-bomb shape', () => {
    expect(err(file('name: &n x\ndescription: *n'))).toContain('Aliases are not allowed')
  })

  it('refuses duplicate keys, broken YAML and unresolvable tags', () => {
    expect(err(file('name: x\nname: y\ndescription: d'))).toContain('not valid YAML')
    expect(err(file('name: x\ndescription: [d,'))).toContain('not valid YAML')
    expect(err(file('name: x\ndescription: !custom d'))).toContain('not valid YAML')
  })

  it('refuses a NUL byte: a skill is text', () => {
    expect(err(file('name: x\ndescription: d', 'a\u0000b'))).toContain('NUL byte')
  })

  it('refuses a non-string upload', () => {
    expect(err(undefined)).toBe('A skill must be uploaded as a text file.')
    expect(err({ text: 'x' })).toBe('A skill must be uploaded as a text file.')
  })

  it(`caps the file at ${SKILL_FILE_MAX_BYTES} bytes, measured in UTF-8, before parsing`, () => {
    const head = file('name: x\ndescription: d', '')
    const atCap = head + 'a'.repeat(SKILL_FILE_MAX_BYTES - utf8Bytes(head))
    expect(utf8Bytes(atCap)).toBe(SKILL_FILE_MAX_BYTES)
    expect(ok(atCap).name).toBe('x')
    // One multi-byte character over — the cap is bytes, not characters.
    const over = atCap.slice(0, -1) + 'é'
    expect(err(over)).toBe(
      `SKILL.md is ${(SKILL_FILE_MAX_BYTES + 1).toLocaleString('en')} bytes; the limit is ` +
        `${SKILL_FILE_MAX_BYTES.toLocaleString('en')} bytes (64 KiB).`,
    )
    // Size first: an oversize file is refused for its size even if it is not YAML at all.
    expect(err('x'.repeat(SKILL_FILE_MAX_BYTES + 1))).toContain('bytes; the limit is')
  })
})

describe('what is stored', () => {
  it('is the whole file — frontmatter and body — as uploaded', () => {
    const raw = file('name: x\ndescription: d', '# Title\n\nIgnore nothing; this is text.\n')
    expect(ok(raw).content).toBe(raw)
  })

  it('normalises CRLF / CR line endings and drops a byte-order mark, and nothing else', () => {
    const raw = '\uFEFF---\r\nname: x\r\ndescription: d\r\n---\r\nline one\rline two\r\n'
    expect(ok(raw).content).toBe('---\nname: x\ndescription: d\n---\nline one\nline two\n')
  })
})
