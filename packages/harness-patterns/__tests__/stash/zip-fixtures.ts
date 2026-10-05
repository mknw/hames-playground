/**
 * In-test ZIP builders for the bounded-reader pins (#433 S5, Z3) and the
 * document-sanitizer pins (Z1, Z4–Z10).
 *
 * Everything here is SYNTHETIC: the repository is public, so no fixture is a
 * real document. Two builders, for two jobs:
 *
 *  - `buildZip` writes raw records field by field, so a test can make the
 *    central directory and the local headers disagree, set encryption bits,
 *    lie about sizes, point two records at one byte range or append a second
 *    end record. A well-behaved writer cannot produce any of that, which is
 *    the whole point of the malicious corpus.
 *  - `ooxmlPackage` / `odfPackage` build WELL-FORMED packages on the
 *    production `writeZip`, for the type check and the flatten path.
 *
 * Not a test file (no `.test.ts`), and under `__tests__/`, so the package's
 * coverage scope excludes it.
 */
import { deflateRawSync } from 'node:zlib'
import { crc32, writeZip } from '../../stash/zip.server'

const enc = new TextEncoder()

function bytesOf(v: string | Uint8Array): Uint8Array {
  return typeof v === 'string' ? enc.encode(v) : v
}

/** Header fields a test may override on one side only. */
export interface HeaderFields {
  name: string | Uint8Array
  method: number
  flags: number
  crc: number
  csize: number
  usize: number
  extra: Uint8Array
}

export interface RawEntry {
  name: string | Uint8Array
  /** Uncompressed content. Default: empty. */
  data?: Uint8Array | string
  /** Default 8 (deflate); a name ending in `/` defaults to 0. */
  method?: number
  /** Replace the compressed payload (e.g. a deflate stream of other data). */
  compressed?: Uint8Array
  /** General-purpose flags on BOTH headers unless a side overrides them. */
  flags?: number
  crc?: number
  csize?: number
  usize?: number
  extra?: Uint8Array
  /** Local-header-only overrides (the "lying central directory" corpus). */
  local?: Partial<HeaderFields>
  /** Central-directory-only overrides. */
  cd?: Partial<
    HeaderFields & {
      versionMadeBy: number
      externalAttr: number
      diskStart: number
      localOffset: number
    }
  >
  /** Write the CD record only; its local header lives elsewhere (overlap corpus). */
  omitLocal?: boolean
  /** Append a data descriptor after the payload. */
  descriptor?: { signature?: boolean; crc?: number; csize?: number; usize?: number }
}

export interface RawZipOptions {
  comment?: Uint8Array | string
  eocd?: Partial<{
    disk: number
    cdDisk: number
    entriesOnDisk: number
    entries: number
    cdSize: number
    cdOffset: number
    commentLength: number
  }>
  /** Bytes appended after the end record. */
  trailing?: Uint8Array
  /** A ZIP64 end-of-central-directory locator just before the end record. */
  zip64Locator?: boolean
  /** Bytes between the central directory and the end record. */
  gap?: Uint8Array
}

/** One local file header (no payload). */
export function localHeader(f: HeaderFields): Uint8Array {
  const name = bytesOf(f.name)
  const b = Buffer.alloc(30 + name.length + f.extra.length)
  b.writeUInt32LE(0x04034b50, 0)
  b.writeUInt16LE(20, 4)
  b.writeUInt16LE(f.flags, 6)
  b.writeUInt16LE(f.method, 8)
  b.writeUInt16LE(0, 10)
  b.writeUInt16LE(0x21, 12)
  b.writeUInt32LE(f.crc >>> 0, 14)
  b.writeUInt32LE(f.csize >>> 0, 18)
  b.writeUInt32LE(f.usize >>> 0, 22)
  b.writeUInt16LE(name.length, 26)
  b.writeUInt16LE(f.extra.length, 28)
  Buffer.from(name).copy(b, 30)
  Buffer.from(f.extra).copy(b, 30 + name.length)
  return b
}

/** An extra-field record `{id, payload}`. */
export function extraField(id: number, payload: Uint8Array = new Uint8Array(4)): Uint8Array {
  const b = Buffer.alloc(4 + payload.length)
  b.writeUInt16LE(id, 0)
  b.writeUInt16LE(payload.length, 2)
  Buffer.from(payload).copy(b, 4)
  return b
}

/** Raw ZIP from records — every field overridable, nothing validated. */
export function buildZip(entries: RawEntry[], opts: RawZipOptions = {}): Uint8Array {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const name = bytesOf(e.name)
    const data = bytesOf(e.data ?? '')
    const dirLike = typeof e.name === 'string' && e.name.endsWith('/')
    const method = e.method ?? (dirLike ? 0 : 8)
    const payload = e.compressed ?? (method === 8 ? deflateRawSync(data) : data)
    const crc = e.crc ?? crc32(data)
    const csize = e.csize ?? payload.length
    const usize = e.usize ?? data.length
    const flags = e.flags ?? 0
    const extra = e.extra ?? new Uint8Array(0)
    const localOffset = e.cd?.localOffset ?? offset

    if (!e.omitLocal) {
      const lh = localHeader({
        name,
        method,
        flags,
        crc,
        csize,
        usize,
        extra,
        ...e.local,
      })
      parts.push(Buffer.from(lh), Buffer.from(payload))
      offset += lh.length + payload.length
      if (e.descriptor) {
        const d = Buffer.alloc(e.descriptor.signature === false ? 12 : 16)
        let q = 0
        if (e.descriptor.signature !== false) {
          d.writeUInt32LE(0x08074b50, 0)
          q = 4
        }
        d.writeUInt32LE((e.descriptor.crc ?? crc) >>> 0, q)
        d.writeUInt32LE((e.descriptor.csize ?? csize) >>> 0, q + 4)
        d.writeUInt32LE((e.descriptor.usize ?? usize) >>> 0, q + 8)
        parts.push(d)
        offset += d.length
      }
    }

    const cdName = bytesOf(e.cd?.name ?? name)
    const cdExtra = e.cd?.extra ?? extra
    const c = Buffer.alloc(46 + cdName.length + cdExtra.length)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(e.cd?.versionMadeBy ?? 20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(e.cd?.flags ?? flags, 8)
    c.writeUInt16LE(e.cd?.method ?? method, 10)
    c.writeUInt16LE(0, 12)
    c.writeUInt16LE(0x21, 14)
    c.writeUInt32LE((e.cd?.crc ?? crc) >>> 0, 16)
    c.writeUInt32LE((e.cd?.csize ?? csize) >>> 0, 20)
    c.writeUInt32LE((e.cd?.usize ?? usize) >>> 0, 24)
    c.writeUInt16LE(cdName.length, 28)
    c.writeUInt16LE(cdExtra.length, 30)
    c.writeUInt16LE(0, 32)
    c.writeUInt16LE(e.cd?.diskStart ?? 0, 34)
    c.writeUInt16LE(0, 36)
    c.writeUInt32LE((e.cd?.externalAttr ?? 0) >>> 0, 38)
    c.writeUInt32LE(localOffset >>> 0, 42)
    Buffer.from(cdName).copy(c, 46)
    Buffer.from(cdExtra).copy(c, 46 + cdName.length)
    central.push(c)
  }

  const cdOffset = offset
  const cd = Buffer.concat(central)
  const comment = bytesOf(opts.comment ?? '')
  const tail: Buffer[] = []
  if (opts.gap) tail.push(Buffer.from(opts.gap))
  if (opts.zip64Locator) {
    const l = Buffer.alloc(20)
    l.writeUInt32LE(0x07064b50, 0)
    tail.push(l)
  }
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(opts.eocd?.disk ?? 0, 4)
  eocd.writeUInt16LE(opts.eocd?.cdDisk ?? 0, 6)
  eocd.writeUInt16LE(opts.eocd?.entriesOnDisk ?? opts.eocd?.entries ?? entries.length, 8)
  eocd.writeUInt16LE(opts.eocd?.entries ?? entries.length, 10)
  eocd.writeUInt32LE((opts.eocd?.cdSize ?? cd.length) >>> 0, 12)
  eocd.writeUInt32LE((opts.eocd?.cdOffset ?? cdOffset) >>> 0, 16)
  eocd.writeUInt16LE(opts.eocd?.commentLength ?? comment.length, 20)
  return new Uint8Array(
    Buffer.concat([
      ...parts,
      cd,
      ...tail,
      eocd,
      Buffer.from(comment),
      Buffer.from(opts.trailing ?? new Uint8Array(0)),
    ]),
  )
}

/**
 * Deterministic low-entropy bytes: mostly zeros with sparse ones, which deflate
 * at roughly 25–30:1 — compressible enough to fit a large entry under the 5 MiB
 * input cap, and far enough under 100:1 that the ratio limit does not fire
 * first. A fixed-seed LCG, so every run builds the same archive.
 */
export function lowEntropy(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length)
  let s = seed >>> 0
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    out[i] = s >>> 28 === 0 ? 1 : 0
  }
  return out
}

// ── Well-formed packages (on the production writer) ─────────────────────────

const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
export const OFFICE_DOCUMENT_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
export const ODT_MIME = 'application/vnd.oasis.opendocument.text'

export const MAIN_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
} as const

export interface OoxmlOptions {
  mainPart?: string
  mainType?: string
  /** Where `_rels/.rels` points; defaults to `mainPart`. `null` omits the relationship. */
  relTarget?: string | null
  /** Override the whole `[Content_Types].xml`; `null` omits it. */
  contentTypes?: string | null
  extraParts?: Record<string, string | Uint8Array>
  /** Leave the main part itself out of the archive. */
  omitMain?: boolean
}

/** A minimal, well-formed OOXML package (synthetic). */
export function ooxmlPackage(opts: OoxmlOptions = {}): Uint8Array {
  const mainPart = opts.mainPart ?? 'word/document.xml'
  const mainType = opts.mainType ?? MAIN_TYPES.docx
  const relTarget = opts.relTarget === undefined ? mainPart : opts.relTarget
  const files: { name: string; data: Uint8Array }[] = []
  const ct =
    opts.contentTypes === undefined
      ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="${CT_NS}">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/${mainPart}" ContentType="${mainType}"/>` +
        `</Types>`
      : opts.contentTypes
  if (ct !== null) files.push({ name: '[Content_Types].xml', data: enc.encode(ct) })
  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="${REL_NS}">` +
    (relTarget === null
      ? ''
      : `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT_REL}" Target="${relTarget}"/>`) +
    `</Relationships>`
  files.push({ name: '_rels/.rels', data: enc.encode(rels) })
  if (!opts.omitMain)
    files.push({
      name: mainPart,
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
          `<w:body><w:p><w:r><w:t>Synthetic body.</w:t></w:r></w:p></w:body></w:document>`,
      ),
    })
  for (const [name, data] of Object.entries(opts.extraParts ?? {})) {
    files.push({ name, data: bytesOf(data) })
  }
  return writeZip(files)
}

/** A minimal, well-formed ODF package (synthetic). `mimetype: null` omits it. */
export function odfPackage(mimetype: string | null = ODT_MIME, withContent = true): Uint8Array {
  const files: { name: string; data: Uint8Array; method?: 0 | 8 }[] = []
  if (mimetype !== null) files.push({ name: 'mimetype', data: enc.encode(mimetype), method: 0 })
  if (withContent) {
    files.push({
      name: 'content.xml',
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0">` +
          `<office:body/></office:document-content>`,
      ),
    })
  }
  files.push({
    name: 'META-INF/manifest.xml',
    data: enc.encode(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`,
    ),
  })
  return writeZip(files)
}
