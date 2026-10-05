/**
 * Z3 (#433 spec §8; S5): one test per archive and XML limit in spec §5.3
 * step 1, against core's bounded reader `stash/zip.server.ts`.
 *
 * The reader parses ATTACKER-SUPPLIED archives — an external sender's docx is
 * the input — so every test here is a hostile archive built in-test, field by
 * field (`zip-fixtures.ts`). The corpus the dispatch named is all here: a zip
 * bomb, a `../` traversal, an absolute path, a symlink entry, duplicate
 * entries, a central directory that lies about its local headers, an
 * oversized entry count, an encrypted entry, a nested zip, an XML
 * billion-laughs payload and an external DTD. Synthetic only: the repository
 * is public.
 *
 * Every refusal asserts its CODE, not just "it threw", because the limits
 * back each other up: lifting the declared-total check still refuses the
 * archive (the inflate budget catches it as a size mismatch), so a test that
 * only asked "did it throw" would stay green under that mutation and prove
 * nothing about the limit it is named for.
 *
 * MUTATION, one per limit (each verified, see the PR's mutation table): lift
 * the check the test is named for — delete the condition, or widen the
 * constant past the fixture — and that test goes red, either because the
 * archive is now accepted or because a different limit refuses it with a
 * different code.
 */
import { describe, expect, it, vi } from 'vitest'
import * as zlib from 'node:zlib'

vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>()
  return { ...actual, inflateRawSync: vi.fn(actual.inflateRawSync) }
})

import {
  XML_LIMITS,
  ZIP_LIMITS,
  ZipRefusedError,
  crc32,
  parseXml,
  readZip,
  scanXml,
  writeZip,
  type XmlElement,
  type ZipRefusal,
} from '../../stash/zip.server'
import { buildZip, extraField, localHeader, lowEntropy, type RawEntry } from './zip-fixtures'

const enc = new TextEncoder()
const MiB = 1024 * 1024

function refusalOf(fn: () => unknown): ZipRefusal | 'accepted' | 'other' {
  try {
    fn()
    return 'accepted'
  } catch (err) {
    return err instanceof ZipRefusedError ? err.code : 'other'
  }
}

function xmlZip(xml: string, name = 'word/document.xml'): Uint8Array {
  return buildZip([{ name, data: xml }])
}

const ok = (name = 'a.txt', data = 'hello'): RawEntry => ({ name, data })

describe('the limits are the spec §5.3 step 1 values', () => {
  it('pins every value, so a widened constant is a reviewed diff', () => {
    expect(ZIP_LIMITS).toEqual({
      maxInputBytes: 5 * MiB,
      eocdWindowBytes: 65_557,
      maxEntries: 2_000,
      maxEntryBytes: 20 * MiB,
      maxTotalBytes: 50 * MiB,
      maxRatio: 100,
      maxNameBytes: 512,
    })
    expect(XML_LIMITS).toEqual({
      maxDepth: 256,
      maxAttributes: 256,
      maxPartBytes: 20 * MiB,
      maxTreeNodes: 1_000_000,
    })
    expect(Object.isFrozen(ZIP_LIMITS)).toBe(true)
    expect(Object.isFrozen(XML_LIMITS)).toBe(true)
  })
})

describe('archive structure', () => {
  it('reads a well-formed archive (the baseline every refusal departs from)', () => {
    const entries = readZip(
      buildZip([ok('a.txt', 'alpha'), ok('dir/', ''), ok('dir/b.txt', 'beta')]),
    )
    expect(entries.map((e) => [e.name, e.directory, new TextDecoder().decode(e.data)])).toEqual([
      ['a.txt', false, 'alpha'],
      ['dir/', true, ''],
      ['dir/b.txt', false, 'beta'],
    ])
  })

  it('input over 5 MiB is refused before anything is parsed', () => {
    const big = new Uint8Array(ZIP_LIMITS.maxInputBytes + 1)
    big.set(buildZip([ok()]), big.length - buildZip([ok()]).length)
    expect(refusalOf(() => readZip(big))).toBe('input-too-large')
  })

  it('no end-of-central-directory record is refused', () => {
    const z = buildZip([ok()])
    expect(refusalOf(() => readZip(z.subarray(0, z.length - 22)))).toBe('eocd')
    expect(refusalOf(() => readZip(new Uint8Array(10)))).toBe('eocd')
    // A lone signature too close to the end to be a whole record.
    expect(
      refusalOf(() => readZip(new Uint8Array([...new Uint8Array(30), 0x50, 0x4b, 0x05, 0x06]))),
    ).toBe('eocd')
  })

  it('a second end record (hidden in the comment) is refused — exactly one', () => {
    const fake = Buffer.alloc(22)
    fake.writeUInt32LE(0x06054b50, 0)
    expect(refusalOf(() => readZip(buildZip([ok()], { comment: fake })))).toBe('eocd')
  })

  it('an end record that does not end the file is refused (trailing bytes)', () => {
    expect(refusalOf(() => readZip(buildZip([ok()], { trailing: enc.encode('x') })))).toBe('eocd')
    // Pushed past the 65,557-byte window entirely.
    expect(refusalOf(() => readZip(buildZip([ok()], { trailing: new Uint8Array(70_000) })))).toBe(
      'eocd',
    )
    // A comment length that overruns the file.
    expect(refusalOf(() => readZip(buildZip([ok()], { eocd: { commentLength: 5 } })))).toBe('eocd')
  })

  it('multi-disk archives are refused (every disk field)', () => {
    expect(refusalOf(() => readZip(buildZip([ok()], { eocd: { disk: 1 } })))).toBe('multi-disk')
    expect(refusalOf(() => readZip(buildZip([ok()], { eocd: { cdDisk: 1 } })))).toBe('multi-disk')
    expect(
      refusalOf(() => readZip(buildZip([ok(), ok('b.txt')], { eocd: { entriesOnDisk: 1 } }))),
    ).toBe('multi-disk')
    expect(refusalOf(() => readZip(buildZip([{ ...ok(), cd: { diskStart: 1 } }])))).toBe(
      'multi-disk',
    )
  })

  it('ZIP64 is refused: sentinel values, the locator, the 0x0001 extra field', () => {
    expect(refusalOf(() => readZip(buildZip([ok()], { eocd: { entries: 0xffff } })))).toBe('zip64')
    expect(refusalOf(() => readZip(buildZip([ok()], { eocd: { cdOffset: 0xffffffff } })))).toBe(
      'zip64',
    )
    expect(refusalOf(() => readZip(buildZip([ok()], { zip64Locator: true })))).toBe('zip64')
    expect(refusalOf(() => readZip(buildZip([{ ...ok(), cd: { csize: 0xffffffff } }])))).toBe(
      'zip64',
    )
    expect(refusalOf(() => readZip(buildZip([{ ...ok(), extra: extraField(0x0001) }])))).toBe(
      'zip64',
    )
    expect(
      refusalOf(() => readZip(buildZip([{ ...ok(), local: { extra: extraField(0x0001) } }]))),
    ).toBe('zip64')
  })

  it('encryption bit 0 is refused', () => {
    expect(refusalOf(() => readZip(buildZip([{ ...ok(), flags: 0x0001 }])))).toBe('encrypted')
  })

  it('encryption bit 6 (strong encryption) is refused', () => {
    expect(refusalOf(() => readZip(buildZip([{ ...ok(), flags: 0x0040 }])))).toBe('encrypted')
  })

  it('an encryption bit on the local header alone is refused too', () => {
    expect(refusalOf(() => readZip(buildZip([{ ...ok(), local: { flags: 0x0001 } }])))).toBe(
      'encrypted',
    )
  })

  it('only methods 0 (stored) and 8 (deflate) are accepted', () => {
    for (const method of [1, 9, 12, 14, 93, 99]) {
      expect(
        refusalOf(() => readZip(buildZip([{ ...ok(), method, compressed: enc.encode('x') }]))),
      ).toBe('method')
    }
    expect(refusalOf(() => readZip(buildZip([{ ...ok(), method: 0 }])))).toBe('accepted')
  })
})

describe('entries', () => {
  it('2,000 entries are accepted; 2,001 are refused', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ok(`f${i}.txt`, ''))
    expect(readZip(buildZip(many(2000)))).toHaveLength(2000)
    expect(refusalOf(() => readZip(buildZip(many(2001))))).toBe('entry-count')
  })

  it('a declared count that differs from the records parsed is refused', () => {
    expect(refusalOf(() => readZip(buildZip([ok(), ok('b.txt')], { eocd: { entries: 1 } })))).toBe(
      'count-mismatch',
    )
    expect(refusalOf(() => readZip(buildZip([ok(), ok('b.txt')], { eocd: { entries: 3 } })))).toBe(
      'count-mismatch',
    )
  })

  it('a central directory that does not end where the end record begins is refused', () => {
    const z = buildZip([ok()])
    const cdOffset = Buffer.from(z).readUInt32LE(z.length - 22 + 16)
    expect(refusalOf(() => readZip(buildZip([ok()], { eocd: { cdOffset: cdOffset - 1 } })))).toBe(
      'central-directory',
    )
    // A directory that parses cleanly but leaves unaccounted bytes before the
    // end record: only the bounds rule can see it.
    expect(refusalOf(() => readZip(buildZip([ok()], { gap: new Uint8Array(10) })))).toBe(
      'central-directory',
    )
  })

  it('overlapping entry ranges are refused (the overlap-bomb shape)', () => {
    // Entry A is STORED and its payload is a complete local header + data for
    // entry B, so B's central-directory record can point INSIDE A's range and
    // still find a header that agrees with it field for field.
    const bData = enc.encode('inner')
    const bLocal = localHeader({
      name: 'b.txt',
      method: 0,
      flags: 0,
      crc: crc32(bData),
      csize: bData.length,
      usize: bData.length,
      extra: new Uint8Array(0),
    })
    const aData = Buffer.concat([Buffer.from(bLocal), Buffer.from(bData)])
    const aHeaderLength = 30 + 'a.bin'.length
    const z = buildZip([
      { name: 'a.bin', data: aData, method: 0 },
      {
        name: 'b.txt',
        data: bData,
        method: 0,
        omitLocal: true,
        cd: { localOffset: aHeaderLength },
      },
    ])
    expect(refusalOf(() => readZip(z))).toBe('overlap')
  })

  describe('each local header must equal its central-directory record', () => {
    it('a different name (the lying-directory corpus)', () => {
      expect(
        refusalOf(() =>
          readZip(buildZip([{ ...ok('word/document.xml'), local: { name: 'word/evil.xml' } }])),
        ),
      ).toBe('local-header')
    })
    it('a different method', () => {
      expect(refusalOf(() => readZip(buildZip([{ ...ok(), local: { method: 0 } }])))).toBe(
        'local-header',
      )
    })
    it('a different compressed size', () => {
      expect(refusalOf(() => readZip(buildZip([{ ...ok(), local: { csize: 1 } }])))).toBe(
        'local-header',
      )
    })
    it('a different uncompressed size', () => {
      expect(refusalOf(() => readZip(buildZip([{ ...ok(), local: { usize: 1 } }])))).toBe(
        'local-header',
      )
    })
    it('a different CRC', () => {
      expect(refusalOf(() => readZip(buildZip([{ ...ok(), local: { crc: 1 } }])))).toBe(
        'local-header',
      )
    })
    it('a missing local header', () => {
      expect(refusalOf(() => readZip(buildZip([{ ...ok(), cd: { localOffset: 3 } }])))).toBe(
        'local-header',
      )
    })
  })

  describe('data descriptors (bit 3) — the shape third-party writers emit', () => {
    const data = 'described'
    const zeroed = { crc: 0, csize: 0, usize: 0 }
    it('accepts a deflated entry whose descriptor equals the directory (signed or not)', () => {
      for (const signature of [true, false]) {
        const z = buildZip([
          { name: 'a.txt', data, flags: 0x0008, local: zeroed, descriptor: { signature } },
        ])
        expect(new TextDecoder().decode(readZip(z)[0].data)).toBe(data)
      }
    })
    it('refuses a descriptor that disagrees with the directory', () => {
      const z = buildZip([
        { name: 'a.txt', data, flags: 0x0008, local: zeroed, descriptor: { usize: 1 } },
      ])
      expect(refusalOf(() => readZip(z))).toBe('local-header')
    })
    it('refuses a STORED entry with a descriptor (it has no unambiguous length)', () => {
      const z = buildZip([
        { name: 'a.txt', data, method: 0, flags: 0x0008, local: zeroed, descriptor: {} },
      ])
      expect(refusalOf(() => readZip(z))).toBe('local-header')
    })
    it('refuses a bit-3 flag on one header only', () => {
      const z = buildZip([
        { name: 'a.txt', data, flags: 0x0008, local: { flags: 0 }, descriptor: {} },
      ])
      expect(refusalOf(() => readZip(z))).toBe('local-header')
    })
  })

  it('a symlink entry is refused (Unix mode S_IFLNK)', () => {
    const symlink: RawEntry = {
      name: 'word/document.xml',
      data: '../../etc/passwd',
      method: 0,
      cd: { versionMadeBy: (3 << 8) | 20, externalAttr: (0o120777 << 16) >>> 0 },
    }
    expect(refusalOf(() => readZip(buildZip([symlink])))).toBe('not-regular-file')
    // A regular file and a directory with Unix modes are fine.
    expect(
      readZip(
        buildZip([
          { ...ok(), cd: { versionMadeBy: (3 << 8) | 20, externalAttr: (0o100644 << 16) >>> 0 } },
          {
            ...ok('d/', ''),
            cd: { versionMadeBy: (3 << 8) | 20, externalAttr: (0o040755 << 16) >>> 0 },
          },
        ]),
      ),
    ).toHaveLength(2)
  })

  it('a directory entry that carries data is refused', () => {
    expect(refusalOf(() => readZip(buildZip([{ name: 'd/', data: 'x', method: 0 }])))).toBe(
      'not-regular-file',
    )
  })
})

describe('decompression', () => {
  it('a zip bomb is refused by the 100:1 ratio before it is inflated', () => {
    const bomb = buildZip([{ name: 'bomb.xml', data: new Uint8Array(1 * MiB) }])
    const inflate = vi.mocked(zlib.inflateRawSync)
    inflate.mockClear()
    expect(refusalOf(() => readZip(bomb))).toBe('ratio')
    expect(inflate).not.toHaveBeenCalled()
  })

  // Large fixtures: built once each, deflated once, and refused on their
  // DECLARED sizes — before the reader inflates a byte of them.
  const sized = (size: number) => {
    const data = lowEntropy(size)
    return { data, compressed: zlib.deflateRawSync(data), crc: crc32(data), usize: size }
  }

  it('an entry over 20 MiB is refused even at a legal ratio', { timeout: 30_000 }, () => {
    const inflate = vi.mocked(zlib.inflateRawSync)
    inflate.mockClear()
    const z = buildZip([{ name: 'big.bin', ...sized(21 * MiB) }])
    expect(z.length).toBeLessThan(ZIP_LIMITS.maxInputBytes)
    expect(refusalOf(() => readZip(z))).toBe('entry-too-large')
    expect(inflate).not.toHaveBeenCalled()
  })

  it('a total over 50 MiB is refused even when each entry is legal', { timeout: 30_000 }, () => {
    const inflate = vi.mocked(zlib.inflateRawSync)
    inflate.mockClear()
    const part = sized(18 * MiB)
    const z = buildZip([
      { name: 'a.bin', ...part },
      { name: 'b.bin', ...part },
      { name: 'c.bin', ...part },
    ])
    expect(z.length).toBeLessThan(ZIP_LIMITS.maxInputBytes)
    expect(refusalOf(() => readZip(z))).toBe('total-too-large')
    expect(inflate).not.toHaveBeenCalled()
  })

  it('inflates with maxOutputLength = min(declared, 20 MiB, remaining budget)', () => {
    const data = lowEntropy(100_000)
    const inflate = vi.mocked(zlib.inflateRawSync)
    inflate.mockClear()
    readZip(buildZip([{ name: 'a.bin', data }]))
    expect(inflate).toHaveBeenCalledTimes(1)
    expect(inflate.mock.calls[0][1]).toEqual({ maxOutputLength: 100_000, info: true })
  })

  it('more output than declared is refused (the bomb that lies about its size)', () => {
    const data = lowEntropy(200_000)
    expect(refusalOf(() => readZip(buildZip([{ name: 'a.bin', data, usize: 100_000 }])))).toBe(
      'size-mismatch',
    )
  })

  it('less output than declared is refused', () => {
    const data = lowEntropy(200_000)
    expect(refusalOf(() => readZip(buildZip([{ name: 'a.bin', data, usize: 300_000 }])))).toBe(
      'size-mismatch',
    )
    // Stored: the two sizes must agree outright.
    expect(refusalOf(() => readZip(buildZip([{ ...ok(), method: 0, usize: 4 }])))).toBe(
      'size-mismatch',
    )
  })

  /**
   * #475 F4 (amendment A2): a deflate stream must end EXACTLY at the entry's
   * compressed size. `inflateRawSync` ignores what follows its final block,
   * so without the check a stream that ends early hides bytes inside the
   * entry's range — a fake descriptor and a whole local entry (D6) — that a
   * streaming reader takes as the next entry.
   * MUTATION: drop the `bytesWritten` comparison → both red.
   */
  it('D6: a bit-3 entry whose stream ends early, hiding a local entry, is refused', () => {
    const shown = 'x'
    const hiddenData = enc.encode('<w:document xmlns:w="urn:x"><w:t>hidden</w:t></w:document>')
    const hidden = Buffer.concat([
      Buffer.from(
        localHeader({
          name: 'word/document.xml',
          method: 0,
          flags: 0,
          crc: crc32(hiddenData),
          csize: hiddenData.length,
          usize: hiddenData.length,
          extra: new Uint8Array(0),
        }),
      ),
      Buffer.from(hiddenData),
    ])
    const fakeDescriptor = Buffer.alloc(16)
    fakeDescriptor.writeUInt32LE(0x08074b50, 0)
    const compressed = Buffer.concat([
      zlib.deflateRawSync(enc.encode(shown)),
      fakeDescriptor,
      hidden,
    ])
    const z = buildZip([
      {
        name: 'a.txt',
        data: shown,
        compressed,
        flags: 0x0008,
        local: { crc: 0, csize: 0, usize: 0 },
        descriptor: {},
      },
    ])
    expect(refusalOf(() => readZip(z))).toBe('inflate')
  })

  it('D7: 64 KiB of junk after the end of a deflate stream is refused', () => {
    const data = enc.encode('hello')
    const compressed = Buffer.concat([zlib.deflateRawSync(data), Buffer.alloc(64 * 1024, 0x41)])
    expect(refusalOf(() => readZip(buildZip([{ name: 'a.txt', data, compressed }])))).toBe(
      'inflate',
    )
  })

  it('a corrupt deflate stream is refused', () => {
    expect(
      refusalOf(() =>
        readZip(buildZip([{ ...ok(), compressed: new Uint8Array([0xff, 0xff, 0xff]) }])),
      ),
    ).toBe('inflate')
  })

  it('a CRC-32 mismatch is refused', () => {
    expect(refusalOf(() => readZip(buildZip([{ ...ok(), crc: 0x12345678 }])))).toBe('crc')
    expect(refusalOf(() => readZip(buildZip([{ ...ok(), method: 0, crc: 0x12345678 }])))).toBe(
      'crc',
    )
  })

  it('a nested zip is returned as opaque bytes — never recursed into', () => {
    // The inner archive is itself hostile (a traversal name and a bomb). The
    // outer read must not see either: it never opens an embedded archive.
    const inner = buildZip([
      { name: '../../evil.xml', data: 'x' },
      { name: 'bomb.bin', data: new Uint8Array(1 * MiB) },
    ])
    // Stored, then pushed out of the end-record window by a padding entry
    // (0/1 bytes only, so it carries no signature of its own); and deflated.
    const padding: RawEntry = { name: 'pad.bin', data: lowEntropy(70_000), method: 0 }
    for (const outer of [
      buildZip([{ name: 'word/embeddings/inner.zip', data: inner, method: 0 }, padding]),
      buildZip([{ name: 'word/embeddings/inner.zip', data: inner, method: 8 }]),
    ]) {
      const entries = readZip(outer)
      expect(entries.map((e) => e.name)).toContain('word/embeddings/inner.zip')
      expect(entries.map((e) => e.name)).not.toContain('../../evil.xml')
      expect(entries.map((e) => e.name)).not.toContain('bomb.bin')
      const embedded = entries.find((e) => e.name === 'word/embeddings/inner.zip')!
      expect(Buffer.from(embedded.data).equals(Buffer.from(inner))).toBe(true)
    }
  })

  it('a STORED nested zip whose end record lands in the window is refused (one signature, no exceptions)', () => {
    const inner = buildZip([{ name: 'a.txt', data: 'x' }])
    expect(
      refusalOf(() => readZip(buildZip([{ name: 'inner.zip', data: inner, method: 0 }]))),
    ).toBe('eocd')
  })
})

describe('names', () => {
  const nameRefusal = (name: string | Uint8Array, flags = 0) =>
    refusalOf(() => readZip(buildZip([{ name, data: 'x', flags }])))

  it('a ../ traversal is refused', () => {
    expect(nameRefusal('../evil.xml')).toBe('name-segment')
    expect(nameRefusal('word/../../evil.xml')).toBe('name-segment')
    expect(nameRefusal('./word/document.xml')).toBe('name-segment')
    expect(nameRefusal('word/..')).toBe('name-segment')
  })

  it('empty segments are refused (only a directory may end in /)', () => {
    expect(nameRefusal('word//document.xml')).toBe('name-segment')
    expect(nameRefusal('')).toBe('name-segment')
  })

  it('an absolute path is refused (leading / or a drive letter)', () => {
    expect(nameRefusal('/etc/passwd')).toBe('name-absolute')
    expect(nameRefusal('C:/Windows/evil.xml')).toBe('name-absolute')
    expect(nameRefusal('c:evil.xml')).toBe('name-absolute')
  })

  it('a backslash is refused', () => {
    expect(nameRefusal('word\\document.xml')).toBe('name-backslash')
    expect(nameRefusal('..\\..\\evil.xml')).toBe('name-backslash')
  })

  it('a NUL byte is refused', () => {
    expect(nameRefusal('word/document.xml\0.png')).toBe('name-nul')
  })

  it('a name over 512 bytes is refused; 512 is accepted', () => {
    expect(nameRefusal('a'.repeat(513))).toBe('name-length')
    expect(nameRefusal('a'.repeat(512))).toBe('accepted')
  })

  it('a name that is not valid UTF-8 is refused', () => {
    expect(nameRefusal(new Uint8Array([0x61, 0xff, 0x62]), 0x0800)).toBe('name-utf8')
  })

  it('a non-ASCII name without the UTF-8 flag is refused (a CP437 reader would read another name)', () => {
    expect(nameRefusal('résumé.txt')).toBe('name-utf8')
    expect(nameRefusal('résumé.txt', 0x0800)).toBe('accepted')
  })

  it('a second name source (the Info-ZIP Unicode Path extra field) is refused', () => {
    expect(refusalOf(() => readZip(buildZip([{ ...ok(), extra: extraField(0x7075) }])))).toBe(
      'name-alias',
    )
  })

  it('duplicate names are refused: exact, case-folded and NFC-equivalent', () => {
    expect(refusalOf(() => readZip(buildZip([ok('a.xml'), ok('a.xml')])))).toBe('duplicate-name')
    expect(
      refusalOf(() => readZip(buildZip([ok('word/document.xml'), ok('WORD/Document.XML')]))),
    ).toBe('duplicate-name')
    expect(
      refusalOf(() =>
        readZip(
          buildZip([
            { name: 'caf\u00e9.xml', data: 'x', flags: 0x0800 },
            { name: 'cafe\u0301.xml', data: 'y', flags: 0x0800 },
          ]),
        ),
      ),
    ).toBe('duplicate-name')
  })
})

describe('XML parts', () => {
  const BILLION_LAUGHS =
    '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">' +
    '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">' +
    '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>' +
    '<lolz>&lol3;</lolz>'

  it('an XML billion-laughs payload is refused at its DOCTYPE', () => {
    expect(refusalOf(() => readZip(xmlZip(BILLION_LAUGHS)))).toBe('xml-doctype')
  })

  it('an external DTD is refused', () => {
    const xxe =
      '<?xml version="1.0"?><!DOCTYPE w:document SYSTEM "http://attacker.invalid/evil.dtd">' +
      '<w:document xmlns:w="urn:x"/>'
    expect(refusalOf(() => readZip(xmlZip(xxe)))).toBe('xml-doctype')
    // The `.rels` parts are XML too, and checked the same way.
    expect(refusalOf(() => readZip(xmlZip(xxe, '_rels/.rels')))).toBe('xml-doctype')
  })

  it('an entity declaration, or a reference to an undeclared entity, is refused', () => {
    expect(refusalOf(() => readZip(xmlZip('<!ENTITY x "y"><r/>')))).toBe('xml-entity')
    expect(refusalOf(() => readZip(xmlZip('<r>&lol;</r>')))).toBe('xml-entity')
    expect(refusalOf(() => readZip(xmlZip('<r a="&lol;"/>')))).toBe('xml-entity')
  })

  /**
   * #475 F6: `ref in PREDEFINED` followed the prototype chain, so these four
   * decoded to `function Object() { [native code] }` and `[object Object]`.
   * MUTATION: go back to `in` → red.
   */
  it('prototype keys are not predefined entities, in text or in an attribute', () => {
    for (const key of ['constructor', 'toString', 'valueOf', '__proto__']) {
      expect(refusalOf(() => readZip(xmlZip(`<r>&${key};</r>`)))).toBe('xml-entity')
      expect(refusalOf(() => readZip(xmlZip(`<r a="&${key};"/>`)))).toBe('xml-entity')
      expect(refusalOf(() => parseXml(`<r>&${key};</r>`))).toBe('xml-entity')
    }
  })

  it('depth 256 is accepted; 257 is refused', () => {
    const nest = (d: number) => '<a>'.repeat(d) + '</a>'.repeat(d)
    expect(refusalOf(() => readZip(xmlZip(nest(256))))).toBe('accepted')
    expect(refusalOf(() => readZip(xmlZip(nest(257))))).toBe('xml-depth')
  })

  it('256 attributes on one element are accepted; 257 are refused', () => {
    const attrs = (n: number) =>
      '<r ' + Array.from({ length: n }, (_, i) => `a${i}="1"`).join(' ') + '/>'
    expect(refusalOf(() => readZip(xmlZip(attrs(256))))).toBe('accepted')
    expect(refusalOf(() => readZip(xmlZip(attrs(257))))).toBe('xml-attributes')
  })

  it('a part over 20 MiB is refused', () => {
    const big = '<r>' + 'x'.repeat(XML_LIMITS.maxPartBytes) + '</r>'
    expect(refusalOf(() => parseXml(big))).toBe('xml-size')
    expect(refusalOf(() => parseXml(enc.encode(big)))).toBe('xml-size')
  })

  it('parsing is namespace-aware: an unbound prefix is refused', () => {
    expect(refusalOf(() => readZip(xmlZip('<w:document/>')))).toBe('xml-namespace')
    expect(refusalOf(() => readZip(xmlZip('<r xmlns:p="urn:x" q:a="1"/>')))).toBe('xml-namespace')
  })

  it('a non-UTF-8 declaration or byte sequence is refused', () => {
    expect(
      refusalOf(() => readZip(xmlZip('<?xml version="1.0" encoding="ISO-8859-1"?><r/>'))),
    ).toBe('xml-encoding')
    expect(
      refusalOf(() =>
        readZip(
          buildZip([{ name: 'a.xml', data: new Uint8Array([0x3c, 0x72, 0xff, 0x2f, 0x3e]) }]),
        ),
      ),
    ).toBe('xml-encoding')
  })

  it('malformed XML is refused', () => {
    for (const bad of [
      '<a><b></a></b>',
      '<a>',
      '<a/><b/>',
      'text<a/>',
      '<a b="1" b="2"/>',
      '<a b=1/>',
    ]) {
      expect(refusalOf(() => readZip(xmlZip(bad)))).toBe('xml-malformed')
    }
  })

  it('a non-XML part is not parsed, whatever it contains', () => {
    // Real PNG magic first: a part is XML by its CONTENT now (#475 F5), so a
    // `.png` holding XML text would be — rightly — checked as XML.
    const png = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...enc.encode(BILLION_LAUGHS),
    ])
    expect(readZip(buildZip([{ name: 'word/media/image1.png', data: png }]))).toHaveLength(1)
  })

  /**
   * #475 F5 (amendment A1): an XML part is one whose CONTENT is XML, whatever
   * its name — kreuzberg opens a PPTX slide at whatever Target the rels name.
   * MUTATION: go back to the name test alone → red.
   */
  it('a slide at ppt/slides/s1.bin with a DOCTYPE is refused (XML by content)', () => {
    const slide =
      '<?xml version="1.0"?><!DOCTYPE p:sld [<!ENTITY x "y">]>' +
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'
    expect(refusalOf(() => readZip(xmlZip(slide, 'ppt/slides/s1.bin')))).toBe('xml-doctype')
    // A BOM and leading whitespace do not hide it, nor does having no extension.
    expect(refusalOf(() => readZip(xmlZip('\uFEFF \r\n\t' + slide, 'ppt/slides/s1')))).toBe(
      'xml-doctype',
    )
  })
})

describe('parseXml', () => {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

  it('resolves namespaces by URI, whatever the prefix', () => {
    const root = parseXml(
      `<?xml version="1.0" encoding="UTF-8"?><x:document xmlns:x="${W}" xmlns="urn:d">` +
        `<x:body x:val="1" plain="2"><child/></x:body></x:document>`,
    )
    expect([root.ns, root.name, root.prefix]).toEqual([W, 'document', 'x'])
    const body = root.children[0] as XmlElement
    expect(body.attributes.map((a) => [a.ns, a.name, a.value])).toEqual([
      [W, 'val', '1'],
      ['', 'plain', '2'],
    ])
    expect((body.children[0] as XmlElement).ns).toBe('urn:d')
  })

  it('decodes text, the predefined entities, character references and CDATA', () => {
    const root = parseXml(
      '<r a="&lt;&#x41;&#66;&quot;">x &amp; y<![CDATA[<raw & text>]]><!-- c --><?pi x?></r>',
    )
    expect(root.attributes[0].value).toBe('<AB"')
    expect(root.children).toEqual(['x & y', '<raw & text>'])
  })

  it('honours xmlns="" and the predefined xml prefix', () => {
    const root = parseXml('<r xmlns="urn:a"><c xmlns="" xml:lang="en"/></r>')
    const c = root.children[0] as XmlElement
    expect(c.ns).toBe('')
    expect(c.attributes.find((a) => a.name === 'lang')?.ns).toBe(
      'http://www.w3.org/XML/1998/namespace',
    )
  })

  it('strips a byte-order mark', () => {
    expect(parseXml(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('<r/>')])).name).toBe('r')
  })

  /**
   * Amendment A1 (#433 S6): the disarm builds TREES of parts up to 20 MiB, and
   * a part of tiny elements is millions of objects — about 140 bytes each,
   * measured. So tree mode counts every node it builds — elements, attributes
   * and text — and refuses past the budget, before the tree outgrows it.
   * The validation walk (`readZip`) and `scanXml` build nothing and are not
   * bounded by it. MUTATION: lift the budget → each refusal below turns red.
   */
  it('tree mode refuses a part over the node budget; the walks without a tree do not', () => {
    const n = XML_LIMITS.maxTreeNodes
    // The root is one node; n - 1 children fit, n do not.
    expect(refusalOf(() => parseXml('<r>' + '<a/>'.repeat(n - 1) + '</r>'))).toBe('accepted')
    expect(refusalOf(() => parseXml('<r>' + '<a/>'.repeat(n) + '</r>'))).toBe('xml-nodes')
    // Attributes count: half as many elements, each with one attribute.
    expect(refusalOf(() => parseXml('<r>' + '<a b=""/>'.repeat(n / 2) + '</r>'))).toBe('xml-nodes')
    // Text counts: comments split text into nodes without one element.
    expect(refusalOf(() => parseXml('<r>' + 'x<!---->'.repeat(n) + '</r>'))).toBe('xml-nodes')
    const big = '<r>' + '<a/>'.repeat(n) + '</r>'
    expect(refusalOf(() => scanXml(big, () => {}))).toBe('accepted')
  })
})

describe('scanXml (#475 F2: the type check builds no tree)', () => {
  it('reports every start tag with its depth, resolved namespace and attributes', () => {
    const tags: [number, string, string, string[]][] = []
    scanXml('<r xmlns="urn:a" xmlns:p="urn:p"><p:c p:x="1"/><d><e/></d></r>', (t) =>
      tags.push([t.depth, t.ns, t.name, t.attributes.map((a) => `${a.ns}|${a.name}=${a.value}`)]),
    )
    expect(tags).toEqual([
      [
        0,
        'urn:a',
        'r',
        ['http://www.w3.org/2000/xmlns/|xmlns=urn:a', 'http://www.w3.org/2000/xmlns/|p=urn:p'],
      ],
      [1, 'urn:p', 'c', ['urn:p|x=1']],
      [1, 'urn:a', 'd', []],
      [2, 'urn:a', 'e', []],
    ])
  })

  it('refuses exactly what parseXml refuses', () => {
    expect(refusalOf(() => scanXml('<!DOCTYPE r><r/>', () => {}))).toBe('xml-doctype')
    expect(refusalOf(() => scanXml('<r><p:c/></r>', () => {}))).toBe('xml-namespace')
    expect(refusalOf(() => scanXml('<r><c></r>', () => {}))).toBe('xml-malformed')
  })
})

describe('writeZip (the fresh-package writer S6 rebuilds on)', () => {
  it('round-trips stored and deflated entries through readZip', () => {
    const files = [
      { name: 'mimetype', data: enc.encode('application/x-test'), method: 0 as const },
      { name: 'dir/', data: new Uint8Array(0) },
      { name: 'dir/a.xml', data: enc.encode('<a/>') },
      { name: 'résumé.txt', data: lowEntropy(5000) },
    ]
    const back = readZip(writeZip(files))
    expect(back.map((e) => e.name)).toEqual(files.map((f) => f.name))
    back.forEach((e, i) =>
      expect(Buffer.from(e.data).equals(Buffer.from(files[i].data))).toBe(true),
    )
  })

  it('refuses to write a name the reader would refuse, or a duplicate', () => {
    expect(refusalOf(() => writeZip([{ name: '../x', data: new Uint8Array(0) }]))).toBe(
      'name-segment',
    )
    expect(
      refusalOf(() =>
        writeZip([
          { name: 'a', data: new Uint8Array(0) },
          { name: 'A', data: new Uint8Array(0) },
        ]),
      ),
    ).toBe('duplicate-name')
  })
})

describe('crc32 (the table, so the package keeps engines >=22)', () => {
  it('matches the standard check value and zlib.crc32 where the runtime has it', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array(0))).toBe(0)
    const sample = lowEntropy(10_000, 7)
    const native = (zlib as unknown as { crc32?: (d: Uint8Array) => number }).crc32
    if (typeof native === 'function') expect(crc32(sample)).toBe(native(sample))
  })
})
