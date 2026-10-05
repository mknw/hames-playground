/**
 * Bounded ZIP reader and writer, and the bounded XML parser — Server Only
 * (#433 S5; spec §5.2, §5.3 step 1; review F17, delta Δ3).
 *
 * The input is ATTACKER-SUPPLIED. An external sender's docx, xlsx or odt is a
 * ZIP of XML parts, and the provenance gate reads it BEFORE anyone has decided
 * whether to keep it: the type check opens `[Content_Types].xml` / `mimetype`
 * (F12), and S6's disarm rebuilds the package from an allowlist of its parts.
 * So this module is a parser of hostile bytes, and every bound below is a
 * refusal, never a truncation: a limit that silently clipped would hand the
 * caller a document that differs from what any other reader would see.
 *
 * ## Why it is in core, and why it is this small
 *
 * F12's type check reads parts from INSIDE the archive, so the reader has to
 * be where the check is — in `@hames-ai/harness-patterns`, so that a package
 * consumer with no disarm still gets the check (Δ3). Core's only dependency is
 * the MCP SDK, so it is built on Node built-ins and adds none (F17):
 * `zlib.inflateRawSync` with `maxOutputLength`, `zlib.deflateRawSync`, and a
 * CRC-32 table. It never writes to disk, so Zip Slip cannot arise here; the
 * name rules exist because the NAMES are what the next reader resolves, and
 * because two readers that disagree about a name are a parser differential.
 *
 * **CRC-32 is a 256-entry table, not `zlib.crc32`.** `zlib.crc32` arrived in
 * Node 22.2, and the spec offered either raising `engines` to `>=22.2` or the
 * table. Every runtime this repo runs is past 22.2 (CI `node-version: 22`,
 * the Docker `22-bookworm-slim` image, nix `nodejs_22`), but the floor is one
 * value shared by all six manifests and pinned by `package-manifests.test.ts`
 * ("every published package states the same one"). Raising it for one
 * function would move five other packages' install contract in an additive
 * slice; ten lines here move nothing. The test checks the table against the
 * standard check value and against `zlib.crc32` wherever the runtime has it.
 *
 * ## The limits (spec §5.3 step 1, every one a refusal with its own code)
 *
 * Archive: input ≤ 5 MiB; exactly ONE end-of-central-directory signature in
 * the last 65,557 bytes, and that record ends the file; no multi-disk, no
 * ZIP64, no encryption bit (0, 6); methods 0 and 8 only.
 * Entries: ≤ 2,000, equal to the records parsed; the central directory ends
 * where the end record begins; no two entries' byte ranges overlap; each
 * local header's name, method, flags and sizes equal its directory record.
 * Decompression: ratio ≤ 100:1, ≤ 20 MiB per entry and ≤ 50 MiB in total, all
 * on the DECLARED sizes of every entry before any entry is inflated; then
 * `maxOutputLength = min(declared, 20 MiB, remaining)`, the deflate stream
 * must end exactly at the compressed size (A2), and the actual size must
 * equal the declared one and the CRC-32 must match.
 * Names: valid UTF-8, ≤ 512 bytes, no NUL, no leading `/` or drive letter,
 * no `\`, no `.`/`..`/empty segment; unique after NFC and case folding.
 * Nesting: an embedded archive is opaque bytes — never opened.
 * XML (any part named `.xml` / `.rels`, or whose content starts with `<` after
 * an optional BOM and whitespace — A1): no `<!DOCTYPE`, no entity declaration, no
 * reference to an undeclared entity; depth ≤ 256; ≤ 256 attributes per
 * element; ≤ 20 MiB per part; UTF-8 only; namespace-aware (an unbound prefix
 * is refused).
 *
 * ## Rules beyond the letter of §5.3, each for a measured or named reason
 *
 * The small ones: the end record must END the file (bytes after it are a
 * second place to hide a directory), the central directory must end where the
 * end record begins, and an empty path segment (`a//b`) is refused with the
 * `.` / `..` ones. The three that need a reason:
 *
 * - **Data descriptors (bit 3).** §5.3 asks the local sizes to equal the
 *   directory's; a bit-3 entry writes zeros there BY DESIGN and carries the
 *   real values after the data. Measured on 379 vendor-shipped OOXML files on
 *   one machine: none written by Microsoft Office use it, the 13 bundled by
 *   one non-Microsoft application do. So a bit-3 entry is
 *   accepted only when it is DEFLATED — and a deflate stream must end
 *   EXACTLY at the entry's compressed size (amendment A2), which is what
 *   makes it self-terminating; a stored one has no unambiguous length — its
 *   local fields are zero or equal, and the descriptor after the data equals
 *   the directory record. Nothing is read from the local side that the
 *   directory does not also say.
 * - **Non-regular entries.** A Unix-mode symlink, device or FIFO entry is
 *   refused. §5.3 lists no rule for it; the dispatch's corpus does, and a
 *   symlink means a different thing to every extractor that honours modes.
 * - **Second name sources.** A non-ASCII name without the UTF-8 flag (bit 11)
 *   is refused — a reader that follows the flag decodes it as CP437 and sees
 *   a different name — and so is the Info-ZIP Unicode Path extra field
 *   (0x7075), which some readers prefer over the header's own name.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { assertServerOnImport } from '../assert.server'

assertServerOnImport()

// ============================================================================
// Limits and refusals
// ============================================================================

const MiB = 1024 * 1024

/** Spec §5.3 step 1 — archive limits. Frozen: widening one is a reviewed diff. */
export const ZIP_LIMITS = Object.freeze({
  maxInputBytes: 5 * MiB,
  /** 22-byte end record + the largest possible comment (65,535). */
  eocdWindowBytes: 65_557,
  maxEntries: 2_000,
  maxEntryBytes: 20 * MiB,
  maxTotalBytes: 50 * MiB,
  maxRatio: 100,
  maxNameBytes: 512,
})

/** Spec §5.3 step 1 — XML part limits. */
export const XML_LIMITS = Object.freeze({
  maxDepth: 256,
  maxAttributes: 256,
  maxPartBytes: 20 * MiB,
})

export type ZipRefusal =
  | 'input-too-large'
  | 'eocd'
  | 'multi-disk'
  | 'zip64'
  | 'entry-count'
  | 'count-mismatch'
  | 'central-directory'
  | 'encrypted'
  | 'method'
  | 'local-header'
  | 'overlap'
  | 'name-utf8'
  | 'name-length'
  | 'name-nul'
  | 'name-absolute'
  | 'name-backslash'
  | 'name-segment'
  | 'name-alias'
  | 'duplicate-name'
  | 'not-regular-file'
  | 'entry-too-large'
  | 'total-too-large'
  | 'ratio'
  | 'size-mismatch'
  | 'inflate'
  | 'crc'
  | 'xml-size'
  | 'xml-encoding'
  | 'xml-doctype'
  | 'xml-entity'
  | 'xml-depth'
  | 'xml-attributes'
  | 'xml-namespace'
  | 'xml-malformed'

/** Thrown for every refusal. `code` names the limit; the message is for logs. */
export class ZipRefusedError extends Error {
  readonly code: ZipRefusal
  constructor(code: ZipRefusal, detail: string) {
    super(`archive refused (${code}): ${detail}`)
    this.name = 'ZipRefusedError'
    this.code = code
  }
}

function refuse(code: ZipRefusal, detail: string): never {
  throw new ZipRefusedError(code, detail)
}

/** A name for a log line: escaped and bounded, since it is attacker-chosen. */
function quoted(name: string): string {
  return JSON.stringify(name.length > 80 ? `${name.slice(0, 80)}…` : name)
}

// ============================================================================
// CRC-32 (IEEE 802.3, the ZIP polynomial)
// ============================================================================

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ============================================================================
// Reader
// ============================================================================

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const SIG_DESCRIPTOR = 0x08074b50

const FLAG_ENCRYPTED = 0x0001
const FLAG_DESCRIPTOR = 0x0008
const FLAG_STRONG_ENCRYPTION = 0x0040
const FLAG_UTF8 = 0x0800

const EXTRA_ZIP64 = 0x0001
const EXTRA_UNICODE_PATH = 0x7075

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** One entry of a read archive, in central-directory order. */
export interface ZipEntry {
  /** The name as stored (decoded, not normalized). */
  readonly name: string
  readonly directory: boolean
  /** Inflated bytes — a copy, never a view into the input. Empty for a directory. */
  readonly data: Uint8Array
}

interface CentralRecord {
  name: string
  nameBytes: Buffer
  directory: boolean
  flags: number
  method: number
  crc: number
  csize: number
  usize: number
  localOffset: number
}

/**
 * Read a whole archive, enforcing every limit in spec §5.3 step 1, and return
 * its entries. Eager by design: every entry is inflated and its size and
 * CRC-32 verified, so an entry nobody asked for cannot hide a lie, and every
 * `.xml` / `.rels` part is checked against the XML limits.
 *
 * @throws ZipRefusedError on the first limit the archive breaks.
 */
export function readZip(input: Uint8Array): ZipEntry[] {
  if (input.length > ZIP_LIMITS.maxInputBytes) {
    refuse('input-too-large', `${input.length} bytes, limit ${ZIP_LIMITS.maxInputBytes}`)
  }
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  const eocd = readEndRecord(buf)
  const records = readCentralDirectory(buf, eocd)

  // Pass 1: every local header, every byte range and every DECLARED size —
  // all of it before a single byte is inflated, so a bomb, an oversized
  // archive or an overlap bomb is refused before any of it is expanded.
  const seen = new Set<string>()
  let declared = 0
  const located = records.map((rec) => {
    const key = foldName(rec.name)
    if (seen.has(key)) refuse('duplicate-name', quoted(rec.name))
    seen.add(key)
    const local = readLocalHeader(buf, rec, eocd.cdOffset)
    if (rec.usize > ZIP_LIMITS.maxRatio * rec.csize) {
      refuse('ratio', `${quoted(rec.name)} declares ${rec.usize} bytes from ${rec.csize}`)
    }
    if (rec.usize > ZIP_LIMITS.maxEntryBytes) {
      refuse('entry-too-large', `${quoted(rec.name)} declares ${rec.usize} bytes`)
    }
    declared += rec.usize
    if (declared > ZIP_LIMITS.maxTotalBytes) {
      refuse('total-too-large', `${declared} bytes declared in all`)
    }
    return { rec, ...local }
  })
  const ranges = located
    .map(({ rec, end }) => [rec.localOffset, end] as const)
    .sort((a, b) => a[0] - b[0])
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i][0] < ranges[i - 1][1]) refuse('overlap', 'two entries share bytes')
  }

  // Pass 2: inflate under the budget — the declared sizes are a claim, so the
  // inflater is still capped by what remains — verify, and check XML parts.
  let total = 0
  return located.map(({ rec, dataStart }) => {
    const raw = buf.subarray(dataStart, dataStart + rec.csize)
    const data =
      rec.method === 0 ? new Uint8Array(raw) : inflate(raw, rec, ZIP_LIMITS.maxTotalBytes - total)
    if (data.length !== rec.usize) {
      refuse('size-mismatch', `${quoted(rec.name)} holds ${data.length}, declares ${rec.usize}`)
    }
    if (crc32(data) !== rec.crc) refuse('crc', quoted(rec.name))
    total += data.length
    // By CONTENT, not by name [#475 F5, A1]: kreuzberg opens a PPTX slide at
    // whatever Target the rels name, so `ppt/slides/s1.bin` is an XML part.
    if (!rec.directory && (isXmlPartName(rec.name) || looksLikeXml(data))) walkXml(data, false)
    return { name: rec.name, directory: rec.directory, data }
  })
}

function inflate(raw: Uint8Array, rec: CentralRecord, remaining: number): Uint8Array {
  const maxOutputLength = Math.min(rec.usize, ZIP_LIMITS.maxEntryBytes, remaining)
  try {
    // `maxOutputLength` must be ≥ 1; an empty entry's stream is checked by
    // the size comparison after. `info: true` returns the engine, whose
    // `bytesWritten` is the INPUT consumed: `inflateRawSync` ignores anything
    // after the final block, so without this a stream that ends early hides
    // bytes a streaming reader would read as the next entry [#475 F4, A2].
    const { buffer, engine } = inflateRawSync(raw, {
      maxOutputLength: Math.max(1, maxOutputLength),
      info: true,
    } as never) as unknown as { buffer: Buffer; engine: { bytesWritten: number } }
    if (engine.bytesWritten !== raw.length) {
      refuse('inflate', `${quoted(rec.name)}: bytes after the end of the deflate stream`)
    }
    return new Uint8Array(buffer)
  } catch (err) {
    if (err instanceof ZipRefusedError) throw err
    if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      refuse('size-mismatch', `${quoted(rec.name)} inflates past its declared ${rec.usize} bytes`)
    }
    refuse('inflate', `${quoted(rec.name)}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

interface EndRecord {
  offset: number
  entries: number
  cdSize: number
  cdOffset: number
}

function readEndRecord(buf: Buffer): EndRecord {
  if (buf.length < 22) refuse('eocd', 'too short to hold an end record')
  // EXACTLY one signature in the window. A second one — in the comment, or
  // anywhere a backwards scanner would meet it first — is the classic way to
  // make two readers open two different central directories.
  const from = Math.max(0, buf.length - ZIP_LIMITS.eocdWindowBytes)
  let at = -1
  let found = 0
  for (let i = buf.length - 4; i >= from; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      found++
      at = i
    }
  }
  if (found !== 1) refuse('eocd', `${found} end-record signatures in the last 65,557 bytes`)
  if (at + 22 > buf.length || at + 22 + buf.readUInt16LE(at + 20) !== buf.length) {
    refuse('eocd', 'the end record does not end the file')
  }
  const disk = buf.readUInt16LE(at + 4)
  const cdDisk = buf.readUInt16LE(at + 6)
  const onDisk = buf.readUInt16LE(at + 8)
  const entries = buf.readUInt16LE(at + 10)
  const cdSize = buf.readUInt32LE(at + 12)
  const cdOffset = buf.readUInt32LE(at + 16)
  if (
    onDisk === 0xffff ||
    entries === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff ||
    (at >= 20 && buf.readUInt32LE(at - 20) === SIG_ZIP64_LOCATOR)
  ) {
    refuse('zip64', 'ZIP64 is not accepted')
  }
  if (disk !== 0 || cdDisk !== 0 || onDisk !== entries) refuse('multi-disk', 'more than one disk')
  if (entries > ZIP_LIMITS.maxEntries) {
    refuse('entry-count', `${entries} entries, limit ${ZIP_LIMITS.maxEntries}`)
  }
  if (cdOffset + cdSize !== at) {
    refuse('central-directory', 'the central directory does not end where the end record begins')
  }
  return { offset: at, entries, cdSize, cdOffset }
}

function readCentralDirectory(buf: Buffer, eocd: EndRecord): CentralRecord[] {
  const records: CentralRecord[] = []
  const end = eocd.cdOffset + eocd.cdSize
  let p = eocd.cdOffset
  while (p < end) {
    if (p + 46 > end || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      refuse('central-directory', `no directory record at ${p}`)
    }
    const versionMadeBy = buf.readUInt16LE(p + 4)
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nameLength = buf.readUInt16LE(p + 28)
    const extraLength = buf.readUInt16LE(p + 30)
    const commentLength = buf.readUInt16LE(p + 32)
    const diskStart = buf.readUInt16LE(p + 34)
    const externalAttr = buf.readUInt32LE(p + 38)
    const localOffset = buf.readUInt32LE(p + 42)
    const next = p + 46 + nameLength + extraLength + commentLength
    if (next > end) refuse('central-directory', 'a record overruns the directory')

    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) {
      refuse('zip64', 'a ZIP64 size or offset sentinel')
    }
    if (diskStart !== 0) refuse('multi-disk', 'an entry starts on another disk')
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) refuse('encrypted', 'encryption bit set')
    if (method !== 0 && method !== 8) refuse('method', `compression method ${method}`)
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLength)
    const name = decodeName(nameBytes, flags)
    checkExtra(buf.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength))
    const directory = name.endsWith('/')
    checkFileType(versionMadeBy, externalAttr, name)
    if (directory && usize !== 0) refuse('not-regular-file', `directory ${quoted(name)} has data`)

    records.push({
      name,
      nameBytes,
      directory,
      flags,
      method,
      crc,
      csize,
      usize,
      localOffset,
    })
    p = next
  }
  if (records.length !== eocd.entries) {
    refuse('count-mismatch', `${records.length} records parsed, ${eocd.entries} declared`)
  }
  return records
}

/** Unix modes (hosts 3 and 19): only regular files and directories. */
function checkFileType(versionMadeBy: number, externalAttr: number, name: string): void {
  const host = versionMadeBy >>> 8
  if (host !== 3 && host !== 19) return
  const type = (externalAttr >>> 16) & 0o170000
  if (type !== 0 && type !== 0o100000 && type !== 0o040000) {
    refuse('not-regular-file', `${quoted(name)} has Unix file type 0o${type.toString(8)}`)
  }
}

function checkExtra(extra: Buffer): void {
  let q = 0
  while (q < extra.length) {
    if (q + 4 > extra.length) refuse('central-directory', 'a malformed extra field')
    const id = extra.readUInt16LE(q)
    const size = extra.readUInt16LE(q + 2)
    if (q + 4 + size > extra.length) refuse('central-directory', 'a malformed extra field')
    if (id === EXTRA_ZIP64) refuse('zip64', 'a ZIP64 extra field')
    if (id === EXTRA_UNICODE_PATH) refuse('name-alias', 'a Unicode Path extra field renames it')
    q += 4 + size
  }
}

function readLocalHeader(
  buf: Buffer,
  rec: CentralRecord,
  limit: number,
): { dataStart: number; end: number } {
  const p = rec.localOffset
  if (p + 30 > limit || buf.readUInt32LE(p) !== SIG_LOCAL) {
    refuse('local-header', `no local header for ${quoted(rec.name)}`)
  }
  const flags = buf.readUInt16LE(p + 6)
  const method = buf.readUInt16LE(p + 8)
  const crc = buf.readUInt32LE(p + 14)
  const csize = buf.readUInt32LE(p + 18)
  const usize = buf.readUInt32LE(p + 22)
  const nameLength = buf.readUInt16LE(p + 26)
  const extraLength = buf.readUInt16LE(p + 28)
  const dataStart = p + 30 + nameLength + extraLength
  if (dataStart > limit) refuse('local-header', `${quoted(rec.name)} overruns the archive`)

  if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
    refuse('encrypted', 'encryption bit set on the local header')
  }
  if (!buf.subarray(p + 30, p + 30 + nameLength).equals(rec.nameBytes)) {
    refuse('local-header', `the local name differs from ${quoted(rec.name)}`)
  }
  if (method !== rec.method) refuse('local-header', `${quoted(rec.name)}: the method differs`)
  checkExtra(buf.subarray(p + 30 + nameLength, dataStart))

  const described = (rec.flags & FLAG_DESCRIPTOR) !== 0
  if (((flags & FLAG_DESCRIPTOR) !== 0) !== described) {
    refuse('local-header', `${quoted(rec.name)}: the data-descriptor flag differs`)
  }
  let end = dataStart + rec.csize
  if (!described) {
    if (crc !== rec.crc || csize !== rec.csize || usize !== rec.usize) {
      refuse('local-header', `${quoted(rec.name)}: the sizes or CRC differ`)
    }
  } else {
    if (rec.method !== 8) {
      refuse('local-header', `${quoted(rec.name)}: a stored entry with a data descriptor`)
    }
    const zeroOrEqual = (local: number, central: number) => local === 0 || local === central
    if (
      !zeroOrEqual(crc, rec.crc) ||
      !zeroOrEqual(csize, rec.csize) ||
      !zeroOrEqual(usize, rec.usize)
    ) {
      refuse('local-header', `${quoted(rec.name)}: the sizes or CRC differ`)
    }
    let q = end
    if (q + 4 <= limit && buf.readUInt32LE(q) === SIG_DESCRIPTOR) q += 4
    if (
      q + 12 > limit ||
      buf.readUInt32LE(q) !== rec.crc ||
      buf.readUInt32LE(q + 4) !== rec.csize ||
      buf.readUInt32LE(q + 8) !== rec.usize
    ) {
      refuse('local-header', `${quoted(rec.name)}: the data descriptor differs`)
    }
    end = q + 12
  }
  if (end > limit) refuse('local-header', `${quoted(rec.name)} runs into the central directory`)
  return { dataStart, end }
}

// ============================================================================
// Names
// ============================================================================

function decodeName(bytes: Uint8Array, flags: number): string {
  if (bytes.length > ZIP_LIMITS.maxNameBytes) {
    refuse('name-length', `${bytes.length} bytes, limit ${ZIP_LIMITS.maxNameBytes}`)
  }
  if (!(flags & FLAG_UTF8) && bytes.some((b) => b >= 0x80)) {
    refuse('name-utf8', 'a non-ASCII name without the UTF-8 flag')
  }
  let name: string
  try {
    name = UTF8.decode(bytes)
  } catch {
    refuse('name-utf8', 'the name is not valid UTF-8')
  }
  checkName(name)
  return name
}

function checkName(name: string): void {
  if (name.includes('\0')) refuse('name-nul', quoted(name))
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) refuse('name-absolute', quoted(name))
  if (name.includes('\\')) refuse('name-backslash', quoted(name))
  const segments = name.split('/')
  const last = segments.length - 1
  segments.forEach((s, i) => {
    if (s === '.' || s === '..' || (s === '' && !(i === last && i > 0))) {
      refuse('name-segment', quoted(name))
    }
  })
}

/** The key two names collide under: NFC, then case-folded (OPC part names
 *  are case-insensitive, so `WORD/Document.xml` IS `word/document.xml`).
 *  Upper-then-lower is the closest JS gets to full case folding (`ß` → `ss`). */
function foldName(name: string): string {
  return name.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC')
}

function isXmlPartName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.xml') || lower.endsWith('.rels')
}

/** Content that an XML reader would open: an optional UTF-8 BOM and ASCII
 *  whitespace, then `<`. Binary parts (PNG, JPEG, EMF, OLE) start otherwise. */
function looksLikeXml(data: Uint8Array): boolean {
  let i = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0
  while (
    i < data.length &&
    (data[i] === 0x20 || data[i] === 0x09 || data[i] === 0x0a || data[i] === 0x0d)
  )
    i++
  return data[i] === 0x3c
}

// ============================================================================
// Writer — a fresh package, never a patched input (spec §5.3 step 1, S6)
// ============================================================================

export interface ZipFile {
  readonly name: string
  readonly data: Uint8Array
  /** Default 8 (deflate); directories are always stored. */
  readonly method?: 0 | 8
}

/**
 * Write a fresh archive: stored or deflated entries, no extra fields, no
 * comment, a fixed timestamp (1980-01-01) so the same input gives the same
 * bytes. Names go through the reader's own rules, so the writer cannot emit
 * an archive the reader would refuse for its names.
 */
export function writeZip(files: readonly ZipFile[]): Uint8Array {
  if (files.length > ZIP_LIMITS.maxEntries) {
    refuse('entry-count', `${files.length} entries, limit ${ZIP_LIMITS.maxEntries}`)
  }
  const seen = new Set<string>()
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    checkName(file.name)
    const key = foldName(file.name)
    if (seen.has(key)) refuse('duplicate-name', quoted(file.name))
    seen.add(key)
    const name = Buffer.from(file.name, 'utf8')
    if (name.length > ZIP_LIMITS.maxNameBytes) refuse('name-length', quoted(file.name))
    const directory = file.name.endsWith('/')
    const method = directory ? 0 : (file.method ?? 8)
    const payload = method === 8 ? deflateRawSync(file.data) : Buffer.from(file.data)
    const flags = name.some((b) => b >= 0x80) ? FLAG_UTF8 : 0
    const crc = crc32(file.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(SIG_CENTRAL, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(file.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(directory ? 0x10 : 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + payload.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]))
}

// ============================================================================
// Bounded, namespace-aware XML
// ============================================================================

export interface XmlAttribute {
  /** Local name. */
  readonly name: string
  /** Resolved namespace URI; `''` for an unprefixed attribute. */
  readonly ns: string
  readonly prefix: string
  readonly value: string
}

export interface XmlElement {
  /** Local name. */
  readonly name: string
  /** Resolved namespace URI; `''` when none is in scope. Match on THIS, never on `prefix`. */
  readonly ns: string
  readonly prefix: string
  /** Every attribute, namespace declarations included, in document order. */
  readonly attributes: readonly XmlAttribute[]
  /** Elements and decoded text (CDATA included), in document order. */
  readonly children: readonly (XmlElement | string)[]
}

/**
 * Parse one XML part under the §5.3 limits and return its root element.
 * Namespace-aware: rules downstream match on `ns`, so `<x:vanish/>` with `x`
 * bound to the WordprocessingML namespace IS `w:vanish`.
 *
 * @throws ZipRefusedError (an `xml-*` code) on any limit or well-formedness error.
 */
export function parseXml(input: Uint8Array | string): XmlElement {
  return walkXml(input, true) as XmlElement
}

/** One start tag, as `scanXml` reports it. `depth` is 0 for the root. */
export interface XmlStartTag {
  readonly name: string
  readonly ns: string
  readonly prefix: string
  readonly attributes: readonly XmlAttribute[]
  readonly depth: number
}

/**
 * Walk one XML part under the same limits and well-formedness rules as
 * `parseXml`, calling `visit` for each start tag in document order, and build
 * NO tree. Memory is the part plus one element's attributes at a time, so a
 * caller that keeps only the elements it is looking for holds only those —
 * bounded by construction, whatever the part holds (#475 F2).
 *
 * @throws ZipRefusedError (an `xml-*` code), as `parseXml` does.
 */
export function scanXml(input: Uint8Array | string, visit: (tag: XmlStartTag) => void): void {
  walkXml(input, false, visit)
}

const XML_NS = 'http://www.w3.org/XML/1998/namespace'
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/'
const PREDEFINED: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
}
// One optional colon between two NCNames. The classes exclude `:`, so there
// is exactly one way to match — linear, whatever the input.
const QNAME = /^[\p{L}_][\p{L}\p{N}_.\-·]*(?::[\p{L}_][\p{L}\p{N}_.\-·]*)?$/u

interface OpenElement {
  qname: string
  prefix: string
  local: string
  attributes: { qname: string; value: string }[]
  declared: string[]
  children: (XmlElement | string)[] | null
}

/**
 * The one tokenizer behind `parseXml` (`build`), `scanXml` (`visit`) and `readZip`'s validation
 * (no tree: a 20 MiB part of tiny elements would otherwise be millions of
 * objects nobody reads). Every scan is `indexOf`-driven and linear.
 */
function walkXml(
  input: Uint8Array | string,
  build: boolean,
  visit?: (tag: XmlStartTag) => void,
): XmlElement | undefined {
  const size = typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.length
  if (size > XML_LIMITS.maxPartBytes) {
    refuse('xml-size', `${size} bytes, limit ${XML_LIMITS.maxPartBytes}`)
  }
  let text: string
  if (typeof input === 'string') {
    text = input
  } else {
    try {
      text = UTF8.decode(input)
    } catch {
      refuse('xml-encoding', 'the part is not valid UTF-8')
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  const n = text.length
  let i = 0
  if (text.startsWith('<?xml') && /[\s?]/.test(text.charAt(5))) {
    const close = text.indexOf('?>', 5)
    if (close < 0 || close > 1000) refuse('xml-malformed', 'an unterminated XML declaration')
    const encoding = /\bencoding\s{0,8}=\s{0,8}["']([^"']{0,40})["']/.exec(text.slice(0, close))
    if (encoding && !/^utf-?8$/i.test(encoding[1])) {
      refuse('xml-encoding', `declared encoding ${JSON.stringify(encoding[1])}`)
    }
    i = close + 2
  }

  const bindings = new Map<string, string[]>([
    ['xml', [XML_NS]],
    ['xmlns', [XMLNS_NS]],
  ])
  const resolve = (prefix: string): string => {
    const stack = bindings.get(prefix)
    const uri = stack?.[stack.length - 1]
    if (uri === undefined) {
      if (prefix === '') return ''
      refuse('xml-namespace', `unbound prefix ${JSON.stringify(prefix)}`)
    }
    return uri
  }
  const stack: OpenElement[] = []
  let root: XmlElement | undefined
  let rootClosed = false

  const addText = (raw: string): void => {
    if (raw.length === 0) return
    if (stack.length === 0) {
      if (/\S/.test(raw)) refuse('xml-malformed', 'text outside the root element')
      return
    }
    const decoded = decodeReferences(raw)
    const top = stack[stack.length - 1]
    if (top.children) top.children.push(decoded)
  }

  const finish = (open: OpenElement, element: XmlElement | undefined): void => {
    for (const prefix of open.declared) bindings.get(prefix)!.pop()
    const parent = stack[stack.length - 1]
    if (parent) {
      if (parent.children && element) parent.children.push(element)
    } else {
      root = element
      rootClosed = true
    }
  }

  // Resolve AFTER every declaration on this element is in scope.
  const resolveAttributes = (open: OpenElement, keep: boolean): XmlAttribute[] => {
    const seen = new Set<string>()
    const attributes: XmlAttribute[] = []
    for (const a of open.attributes) {
      const [prefix, local] = splitQName(a.qname)
      const isDecl = a.qname === 'xmlns' || prefix === 'xmlns'
      const attrNs = isDecl ? XMLNS_NS : prefix === '' ? '' : resolve(prefix)
      const key = `${attrNs}\u0000${isDecl && prefix === '' ? 'xmlns' : local}`
      if (seen.has(key)) refuse('xml-malformed', `duplicate attribute ${JSON.stringify(a.qname)}`)
      seen.add(key)
      if (keep) attributes.push({ name: local, ns: attrNs, prefix, value: a.value })
    }
    return attributes
  }

  const close = (open: OpenElement): void => {
    const ns = resolve(open.prefix)
    const attributes = resolveAttributes(open, build)
    finish(
      open,
      build
        ? { name: open.local, ns, prefix: open.prefix, attributes, children: open.children ?? [] }
        : undefined,
    )
  }

  while (i < n) {
    const lt = text.indexOf('<', i)
    if (lt < 0) {
      addText(text.slice(i))
      break
    }
    addText(text.slice(i, lt))
    i = lt

    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4)
      if (end < 0) refuse('xml-malformed', 'an unterminated comment')
      i = end + 3
      continue
    }
    if (text.startsWith('<![CDATA[', i)) {
      if (stack.length === 0) refuse('xml-malformed', 'CDATA outside the root element')
      const end = text.indexOf(']]>', i + 9)
      if (end < 0) refuse('xml-malformed', 'an unterminated CDATA section')
      const top = stack[stack.length - 1]
      if (top.children) top.children.push(text.slice(i + 9, end))
      i = end + 3
      continue
    }
    if (text.startsWith('<!', i)) {
      const keyword = text.slice(i + 2, i + 9).toUpperCase()
      if (keyword.startsWith('DOCTYPE')) refuse('xml-doctype', 'a document type declaration')
      if (keyword.startsWith('ENTITY')) refuse('xml-entity', 'an entity declaration')
      refuse('xml-doctype', 'DTD markup')
    }
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2)
      if (end < 0) refuse('xml-malformed', 'an unterminated processing instruction')
      i = end + 2
      continue
    }
    if (text.startsWith('</', i)) {
      const end = text.indexOf('>', i + 2)
      if (end < 0) refuse('xml-malformed', 'an unterminated end tag')
      const qname = text.slice(i + 2, end).trimEnd()
      const open = stack.pop()
      if (!open || open.qname !== qname) refuse('xml-malformed', 'mismatched end tag')
      close(open)
      i = end + 1
      continue
    }

    // A start tag. Scanned character by character: an attribute value may
    // hold `>`, so `indexOf('>')` would end the tag inside a value.
    if (rootClosed) refuse('xml-malformed', 'content after the root element')
    let j = i + 1
    while (j < n && !/[\s/>]/.test(text.charAt(j))) j++
    const qname = text.slice(i + 1, j)
    if (!QNAME.test(qname)) refuse('xml-malformed', `an invalid element name`)
    if (stack.length + 1 > XML_LIMITS.maxDepth) {
      refuse('xml-depth', `nesting deeper than ${XML_LIMITS.maxDepth}`)
    }
    const [prefix, local] = splitQName(qname)
    const open: OpenElement = {
      qname,
      prefix,
      local,
      attributes: [],
      declared: [],
      children: build ? [] : null,
    }
    let selfClosing = false
    for (;;) {
      const ws = j
      while (j < n && /\s/.test(text.charAt(j))) j++
      const c = text.charAt(j)
      if (c === '>') {
        j++
        break
      }
      if (c === '/' && text.charAt(j + 1) === '>') {
        selfClosing = true
        j += 2
        break
      }
      if (j >= n || j === ws) refuse('xml-malformed', 'a malformed start tag')
      const nameStart = j
      while (j < n && !/[\s=/>]/.test(text.charAt(j))) j++
      const attrName = text.slice(nameStart, j)
      if (!QNAME.test(attrName)) refuse('xml-malformed', 'an invalid attribute name')
      while (j < n && /\s/.test(text.charAt(j))) j++
      if (text.charAt(j) !== '=') refuse('xml-malformed', 'an attribute without a value')
      j++
      while (j < n && /\s/.test(text.charAt(j))) j++
      const quote = text.charAt(j)
      if (quote !== '"' && quote !== "'") refuse('xml-malformed', 'an unquoted attribute value')
      const valueEnd = text.indexOf(quote, j + 1)
      if (valueEnd < 0) refuse('xml-malformed', 'an unterminated attribute value')
      const raw = text.slice(j + 1, valueEnd)
      if (raw.includes('<')) refuse('xml-malformed', '`<` in an attribute value')
      j = valueEnd + 1
      if (open.attributes.length + 1 > XML_LIMITS.maxAttributes) {
        refuse('xml-attributes', `more than ${XML_LIMITS.maxAttributes} attributes on one element`)
      }
      // Literal whitespace normalizes to a space BEFORE references decode,
      // so `&#10;` survives as the newline it encodes (XML 1.0 §3.3.3).
      const value = decodeReferences(raw.replace(/[\t\n\r]/g, ' '))
      open.attributes.push({ qname: attrName, value })
      if (attrName === 'xmlns' || attrName.startsWith('xmlns:')) {
        const declared = attrName === 'xmlns' ? '' : attrName.slice(6)
        if (declared === 'xmlns' || (declared === 'xml' && value !== XML_NS)) {
          refuse('xml-namespace', 'a reserved prefix rebound')
        }
        if (declared !== '' && value === '') refuse('xml-namespace', 'a prefix undeclared')
        if (!bindings.has(declared)) bindings.set(declared, [])
        bindings.get(declared)!.push(value)
        open.declared.push(declared)
      }
    }
    i = j
    if (visit) {
      visit({
        name: local,
        ns: resolve(prefix),
        prefix,
        attributes: resolveAttributes(open, true),
        depth: stack.length,
      })
    }
    stack.push(open)
    if (selfClosing) close(stack.pop()!)
  }

  if (stack.length > 0) refuse('xml-malformed', 'an unclosed element')
  if (!rootClosed) refuse('xml-malformed', 'no root element')
  return root
}

function splitQName(qname: string): [prefix: string, local: string] {
  const colon = qname.indexOf(':')
  return colon < 0 ? ['', qname] : [qname.slice(0, colon), qname.slice(colon + 1)]
}

/** Decode the five predefined entities and character references; refuse any
 *  other reference — with no DTD, every other entity is undeclared. */
function decodeReferences(raw: string): string {
  if (!raw.includes('&')) return raw
  let out = ''
  let i = 0
  for (;;) {
    const amp = raw.indexOf('&', i)
    if (amp < 0) return out + raw.slice(i)
    out += raw.slice(i, amp)
    const semi = raw.indexOf(';', amp + 1)
    if (semi < 0 || semi - amp > 12) refuse('xml-entity', 'an unterminated reference')
    const ref = raw.slice(amp + 1, semi)
    // OWN keys only: `in` follows the prototype chain, so `&constructor;`
    // would decode to a function's source text [#475 F6].
    if (Object.hasOwn(PREDEFINED, ref)) {
      out += PREDEFINED[ref]
    } else if (ref.startsWith('#')) {
      const code = /^#x[0-9a-fA-F]{1,6}$/.test(ref)
        ? parseInt(ref.slice(2), 16)
        : /^#[0-9]{1,7}$/.test(ref)
          ? parseInt(ref.slice(1), 10)
          : -1
      const legal =
        code === 0x9 ||
        code === 0xa ||
        code === 0xd ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff)
      if (!legal) refuse('xml-malformed', 'an illegal character reference')
      out += String.fromCodePoint(code)
    } else {
      refuse('xml-entity', `a reference to the undeclared entity ${JSON.stringify(ref)}`)
    }
    i = semi + 1
  }
}
