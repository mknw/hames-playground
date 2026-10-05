/**
 * `ooxmlDisarm` — rebuild an OOXML package from an allowlist — Server Only
 * (#433 S6; spec §5.3 step 2, review F11 and F12, amendments A1 and A3).
 *
 * The input is an ATTACKER-SUPPLIED docx, docm, xlsx, xlsm, pptx or pptm that
 * an external sender put in front of the provenance gate. This is the
 * `DocumentDisarm` core's `flattenDocument` runs before the converter: what it
 * returns is what kreuzberg extracts, and so what the model reads. Its job is
 * to make that the text a person looking at the document would see — no more.
 *
 * It is built on core's bounded reader (`stash/zip.server`, Δ3) and nothing
 * else: no reader of its own, no new dependency (F17). Every archive and XML
 * limit of §5.3 step 1 is the reader's; the one this module adds is
 * amendment A1's, through `parseXml`, whose trees are capped at
 * `XML_LIMITS.maxTreeNodes`.
 *
 * ## A fresh package from an allowlist — never a patched input
 *
 * A part is written only if it is reached from the main part through an
 * allowlisted relationship type AND its `[Content_Types]` type is that
 * relationship's: the document, workbook or presentation part; styles;
 * numbering; footnotes and endnotes; shared strings; VISIBLE worksheets;
 * VISIBLE slides and their notes; the theme. Everything else — macros,
 * ActiveX, OLE and embeddings, comments, customXml, customUI, the glossary,
 * connections, query tables, pivot caches, embedded fonts, external links,
 * document properties, headers and footers, settings, media — is simply never
 * written, and every external relationship is dropped (`TargetMode` anything
 * but `Internal`). Kept parts are parsed and re-serialized, so no comment,
 * processing instruction or declaration of the input survives either. The
 * content types, the package relationships and every relationships part are
 * written fresh, with canonical targets.
 *
 * A worksheet is visible when `<sheets>` lists it with no `state` but
 * `visible`; a slide when `<p:sldIdLst>` lists it and its `show` is not
 * false. A slide the list omits is dropped too: PowerPoint never shows it,
 * and kreuzberg reads every slide relationship (`pptx/parser.rs:470-485`).
 *
 * ## Rules inside the kept parts — by namespace URI, never by prefix
 *
 * Every rule matches the RESOLVED namespace (`<x:vanish/>` with `x` bound to
 * WordprocessingML is `w:vanish`; `w:` bound to anything else is not), and
 * applies inside `mc:Choice` and `mc:Fallback` alike.
 *
 * Dropped:
 * - runs (`w:r`, and OMML's `m:r`) whose EFFECTIVE `vanish`, `specVanish` or
 *   `webHidden` is on — direct `rPr` first; else docDefaults, the table style
 *   (its conditional formatting included), the paragraph style and the
 *   character style, each through its `basedOn` chain and with the default
 *   style standing in for a missing one. Toggle semantics are not modelled:
 *   any style level that hides is read as hiding, which can only drop more;
 * - shapes with `hidden` on `wp:docPr` or on any `*:cNvPr` (the shape is the
 *   element that carries it, directly or through its `nv…Pr`);
 * - `descr` and `title` on `wp:docPr` and on any `*:cNvPr` (alt text);
 * - tracked changes, accepted: `w:del`, `w:moveFrom`, a deleted row, any
 *   `w:delText`, the move-range markers and every property revision go;
 *   `w:ins` and `w:moveTo` are unwrapped;
 * - field codes: `w:instrText`, `w:fldChar` (with its form-field data) and
 *   everything between a field's begin and its separator, nested fields
 *   included; `w:fldSimple` is unwrapped. In SpreadsheetML, cell formulas
 *   (`f`, the cached value stays) and `definedNames` — DDE is a formula over
 *   an external link, and the link is a dropped part;
 * - OLE and ActiveX elements (`w:object`, `o:OLEObject`, `p:oleObj`,
 *   `oleObjects`, `controls`), and comment markers;
 * - every relationship reference (`r:*`, VML's `o:relid`) to a relationship
 *   that was not kept; an element that was nothing but that reference goes
 *   with it;
 * - footnotes and endnotes no kept reference points at (kreuzberg prints
 *   every note, referenced or not).
 *
 * Counted, not dropped (`counted`, which makes `hiddenContent` `'not-removed'`
 * — amendment A3): hidden rows and columns, zero row heights and column
 * widths, the `;;;` number format, a font colour equal to its fill (no fill
 * is white), white text and text of 1 pt or less (docx and pptx), and shapes
 * placed off the slide.
 *
 * ## Beyond the letter of §5.3, each for a named reason
 *
 * - **A hiding rule in one `mc:AlternateContent` branch drops the whole
 *   element.** The branches are alternative renderings of ONE object: Word
 *   shows the first it understands, kreuzberg reads them all. Dropping only
 *   the branch that says "hidden" would leave the other branch's copy in the
 *   extract while the person sees nothing.
 * - **Field state is tracked twice**: once over the kept content and once
 *   over everything, dropped content included, and text is code if either
 *   says so — a hidden `begin` must not turn the code after it into text.
 * - **Unreferenced notes and unlisted slides are dropped** (above): both are
 *   text a reader of the document is never shown and kreuzberg extracts.
 * - **A relationships part and the content types are at most 1 MiB**, as
 *   S5's type check holds them (A1), and two relationships sharing an Id in a
 *   kept part refuse the package: which one a consumer resolves is a guess.
 *
 * ## Failure policy
 *
 * The disarm throws rather than returning something it did not finish:
 * `DocumentRefusedError` (`unsupported-type`, `content-type`,
 * `no-main-part`) for the package, `ZipRefusedError` for a reader limit. Core
 * turns any throw into "Sanitize unavailable" (spec §5.4), and never falls
 * back to the raw file. It never reports a removal it did not make: counts
 * are taken from what was dropped, and keys with nothing to count are absent.
 */
import { deflateRawSync } from 'node:zlib'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import {
  DocumentRefusedError,
  type DocumentDisarm,
} from '@hames-ai/harness-patterns/stash/document-sanitizer.server'
import {
  parseXml,
  readZip,
  scanXml,
  writeZip,
  XML_LIMITS,
  ZipRefusedError,
  ZIP_LIMITS,
  type XmlAttribute,
  type XmlElement,
  type ZipEntry,
  type ZipFile,
} from '@hames-ai/harness-patterns/stash/zip.server'

assertServerOnImport()

// ============================================================================
// Namespaces, relationship types, roles
// ============================================================================

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  o: 'urn:schemas-microsoft-com:office:office',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  rels: 'http://schemas.openxmlformats.org/package/2006/relationships',
  xmlns: 'http://www.w3.org/2000/xmlns/',
} as const

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
const OFFICE_DOCUMENT = `${REL}officeDocument`
const OD = 'application/vnd.openxmlformats-officedocument.'

type Role =
  | 'wordMain'
  | 'wordStyles'
  | 'wordNumbering'
  | 'wordFootnotes'
  | 'wordEndnotes'
  | 'sheetMain'
  | 'sheetStyles'
  | 'sharedStrings'
  | 'worksheet'
  | 'slidesMain'
  | 'slide'
  | 'notesSlide'
  | 'theme'

/** The content type a part must carry to be kept in a role (lower case). */
const ROLE_TYPE: Readonly<Record<Exclude<Role, 'wordMain' | 'sheetMain' | 'slidesMain'>, string>> =
  {
    wordStyles: `${OD}wordprocessingml.styles+xml`,
    wordNumbering: `${OD}wordprocessingml.numbering+xml`,
    wordFootnotes: `${OD}wordprocessingml.footnotes+xml`,
    wordEndnotes: `${OD}wordprocessingml.endnotes+xml`,
    sheetStyles: `${OD}spreadsheetml.styles+xml`,
    sharedStrings: `${OD}spreadsheetml.sharedstrings+xml`,
    worksheet: `${OD}spreadsheetml.worksheet+xml`,
    slide: `${OD}presentationml.slide+xml`,
    notesSlide: `${OD}presentationml.notesslide+xml`,
    theme: `${OD}theme+xml`,
  }

/** The allowlist: from a part in one role, which relationship types reach which role. */
const EDGES: Readonly<Partial<Record<Role, Readonly<Record<string, Role>>>>> = {
  wordMain: {
    [`${REL}styles`]: 'wordStyles',
    [`${REL}numbering`]: 'wordNumbering',
    [`${REL}footnotes`]: 'wordFootnotes',
    [`${REL}endnotes`]: 'wordEndnotes',
    [`${REL}theme`]: 'theme',
  },
  sheetMain: {
    [`${REL}styles`]: 'sheetStyles',
    [`${REL}sharedStrings`]: 'sharedStrings',
    [`${REL}worksheet`]: 'worksheet',
    [`${REL}theme`]: 'theme',
  },
  slidesMain: { [`${REL}slide`]: 'slide', [`${REL}theme`]: 'theme' },
  slide: { [`${REL}notesSlide`]: 'notesSlide' },
  // Back to a slide that is ALREADY kept — never a way to reach a hidden one.
  notesSlide: { [`${REL}slide`]: 'slide' },
}

interface Family {
  readonly kind: 'word' | 'sheet' | 'slides'
  readonly mainRole: Role
  /** Where the extractor opens it, by name (S5's interpretation 2). */
  readonly mainPart: string
  readonly mainType: string
}

const word = (mainType: string): Family => ({
  kind: 'word',
  mainRole: 'wordMain',
  mainPart: 'word/document.xml',
  mainType,
})
const sheet = (mainType: string): Family => ({
  kind: 'sheet',
  mainRole: 'sheetMain',
  mainPart: 'xl/workbook.xml',
  mainType,
})
const slides = (mainType: string): Family => ({
  kind: 'slides',
  mainRole: 'slidesMain',
  mainPart: 'ppt/presentation.xml',
  mainType,
})

/** The six types §5.3 step 2 disarms, by declared MIME (lower case). */
const FAMILIES: ReadonlyMap<string, Family> = new Map([
  [`${OD}wordprocessingml.document`, word(`${OD}wordprocessingml.document.main+xml`)],
  [
    'application/vnd.ms-word.document.macroenabled.12',
    word('application/vnd.ms-word.document.macroenabled.main+xml'),
  ],
  [`${OD}spreadsheetml.sheet`, sheet(`${OD}spreadsheetml.sheet.main+xml`)],
  [
    'application/vnd.ms-excel.sheet.macroenabled.12',
    sheet('application/vnd.ms-excel.sheet.macroenabled.main+xml'),
  ],
  [`${OD}presentationml.presentation`, slides(`${OD}presentationml.presentation.main+xml`)],
  [
    'application/vnd.ms-powerpoint.presentation.macroenabled.12',
    slides('application/vnd.ms-powerpoint.presentation.macroenabled.main+xml'),
  ],
])

/** `[Content_Types].xml` and every relationships part, as S5's type check holds them (A1). */
const PACKAGE_PART_MAX_BYTES = 1024 * 1024

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

// ============================================================================
// The entry point
// ============================================================================

/**
 * Rebuild `bytes` from the allowlist and the rules above.
 *
 * @throws DocumentRefusedError for a type it does not cover or a package it
 *   cannot find its main part in; ZipRefusedError for any reader limit.
 */
export const ooxmlDisarm: DocumentDisarm = async (bytes, mime) => {
  const family = FAMILIES.get(mime.split(';')[0].trim().toLowerCase())
  if (!family) refuse('unsupported-type', 'not an OOXML type the disarm covers')
  return disarm(readZip(bytes), family)
}

function refuse(code: 'unsupported-type' | 'content-type' | 'no-main-part', detail: string): never {
  throw new DocumentRefusedError(code, detail)
}

/** Counts by key; a key is present only once something was counted. */
class Tally {
  readonly values: Record<string, number> = {}
  add(key: string, n = 1): void {
    if (n > 0) this.values[key] = (this.values[key] ?? 0) + n
  }
}

// ============================================================================
// The package: names, content types, relationships
// ============================================================================

/** The key two part names collide under — the reader's own (OPC names are case-insensitive). */
function fold(name: string): string {
  return name.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC')
}

function attrOf(attributes: readonly XmlAttribute[], name: string, ns = ''): string | undefined {
  return attributes.find((a) => a.ns === ns && a.name === name)?.value
}

/** A package part (`[Content_Types].xml`, a `.rels`) is scanned, never built into a tree. */
function scanPackagePart(
  entry: ZipEntry,
  root: { ns: string; name: string },
  child: string,
  visit: (attributes: readonly XmlAttribute[]) => void,
): void {
  if (entry.data.length > PACKAGE_PART_MAX_BYTES) {
    refuse('content-type', `${JSON.stringify(entry.name)} is larger than a package part can be`)
  }
  let rootMatches = false
  scanXml(entry.data, (tag) => {
    if (tag.depth === 0) rootMatches = tag.ns === root.ns && tag.name === root.name
    else if (tag.depth === 1 && tag.ns === root.ns && tag.name === child) visit(tag.attributes)
  })
  if (!rootMatches)
    refuse('content-type', `${JSON.stringify(entry.name)} is not a ${root.name} part`)
}

interface RawRel {
  readonly id: string
  readonly type: string
  readonly target: string
  readonly external: boolean
}

class Package {
  private readonly files = new Map<string, ZipEntry>()
  private readonly overrides = new Map<string, string>()
  private readonly defaults = new Map<string, string>()

  constructor(readonly entries: readonly ZipEntry[]) {
    for (const e of entries) if (!e.directory) this.files.set(fold(e.name), e)
    const ct = this.get('[Content_Types].xml')
    if (!ct) refuse('content-type', 'no [Content_Types].xml')
    scanPackagePart(ct, { ns: NS.ct, name: 'Types' }, 'Override', (a) => {
      const part = attrOf(a, 'PartName')
      const type = attrOf(a, 'ContentType')
      if (part === undefined || type === undefined) return
      if (this.overrides.has(fold(part))) refuse('content-type', 'a part with two declared types')
      this.overrides.set(fold(part), type)
    })
    scanPackagePart(ct, { ns: NS.ct, name: 'Types' }, 'Default', (a) => {
      const ext = attrOf(a, 'Extension')
      const type = attrOf(a, 'ContentType')
      if (ext === undefined || type === undefined) return
      if (this.defaults.has(ext.toLowerCase()))
        refuse('content-type', 'an extension declared twice')
      this.defaults.set(ext.toLowerCase(), type)
    })
  }

  get(name: string): ZipEntry | undefined {
    return this.files.get(fold(name))
  }

  /** The part's declared content type, as written (an Override, else its extension's Default). */
  typeOf(name: string): string | undefined {
    const base = name.slice(name.lastIndexOf('/') + 1)
    const dot = base.lastIndexOf('.')
    return (
      this.overrides.get(fold(`/${name}`)) ??
      (dot < 0 ? undefined : this.defaults.get(base.slice(dot + 1).toLowerCase()))
    )
  }

  /** A part's relationships; `''` is the package's own. */
  relsOf(source: string): RawRel[] {
    const entry = this.get(relsPartName(source))
    if (!entry) return []
    const rels: RawRel[] = []
    const ids = new Set<string>()
    scanPackagePart(entry, { ns: NS.rels, name: 'Relationships' }, 'Relationship', (a) => {
      const id = attrOf(a, 'Id')
      const type = attrOf(a, 'Type')
      const target = attrOf(a, 'Target')
      if (id === undefined || type === undefined || target === undefined) return
      if (ids.has(id)) refuse('content-type', 'two relationships share one Id')
      ids.add(id)
      const mode = attrOf(a, 'TargetMode')
      rels.push({ id, type, target, external: mode !== undefined && mode !== 'Internal' })
    })
    return rels
  }
}

function dirOf(name: string): string {
  return name.slice(0, name.lastIndexOf('/') + 1)
}

function relsPartName(source: string): string {
  if (source === '') return '_rels/.rels'
  return `${dirOf(source)}_rels/${source.slice(source.lastIndexOf('/') + 1)}.rels`
}

/** An internal Target, resolved against its source part. `undefined` if it climbs out. */
function resolveTarget(source: string, target: string): string | undefined {
  const path = target.split('#')[0]
  const out = path.startsWith('/') ? [] : dirOf(source).split('/').filter(Boolean)
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return undefined
      out.pop()
    } else out.push(seg)
  }
  return out.length > 0 ? out.join('/') : undefined
}

const isRelsPart = (name: string): boolean => /(^|\/)_rels\/[^/]*\.rels$/i.test(name)

/** A dropped part's report key. Names are the sender's, so this only LABELS a count. */
const CATEGORIES: readonly (readonly [string, RegExp])[] = [
  ['macros', /vbaproject|vbadata|macrosheet/],
  ['activeX', /(^|\/)activex\//],
  ['embeddings', /(^|\/)embeddings\/|oleobject/],
  ['comments', /comment/],
  ['customXml', /^customxml\//],
  ['customUI', /^customui\//],
  ['glossary', /(^|\/)glossary\//],
  ['externalLinks', /(^|\/)externallinks\//],
  ['dataConnections', /(^|\/)connections\.xml$|(^|\/)querytables\/|(^|\/)pivotcache\//],
  ['fonts', /(^|\/)fonts\//],
  ['properties', /^docprops\//],
]

function categoryOf(name: string, type: string | undefined): string {
  const [n, t] = [name.toLowerCase(), (type ?? '').toLowerCase()]
  return CATEGORIES.find(([, re]) => re.test(n) || re.test(t))?.[0] ?? 'otherParts'
}

// ============================================================================
// The allowlist walk
// ============================================================================

interface KeptRel {
  readonly id: string
  readonly type: string
  readonly target: string
}

interface KeptPart {
  readonly name: string
  readonly role: Role
  readonly type: string
  readonly rels: KeptRel[]
}

function disarm(
  entries: readonly ZipEntry[],
  family: Family,
): { bytes: Uint8Array; removed: Record<string, number>; counted: Record<string, number> } {
  const pkg = new Package(entries)
  const removed = new Tally()
  const counted = new Tally()

  // The main part: the package's ONE internal officeDocument relationship,
  // where this type keeps it, with this type's main-part type (F12).
  const office = pkg.relsOf('').filter((r) => r.type === OFFICE_DOCUMENT && !r.external)
  if (office.length === 0) refuse('no-main-part', 'no officeDocument relationship')
  if (office.length > 1) refuse('content-type', 'more than one officeDocument relationship')
  const mainName = resolveTarget('', office[0].target)
  if (mainName === undefined || fold(mainName) !== family.mainPart) {
    refuse('content-type', 'the main part is not where this type keeps it')
  }
  const mainEntry = pkg.get(family.mainPart)
  if (!mainEntry || mainEntry.name !== family.mainPart) {
    refuse('no-main-part', 'the main part is missing')
  }
  const mainType = pkg.typeOf(mainEntry.name)
  if (mainType?.toLowerCase() !== family.mainType) {
    refuse('content-type', "the main part's type is not the declared type")
  }

  const kept = new Map<string, KeptPart>()
  const order: KeptPart[] = []
  const keep = (entry: ZipEntry, role: Role, type: string): KeptPart => {
    const part: KeptPart = { name: entry.name, role, type, rels: [] }
    kept.set(fold(entry.name), part)
    order.push(part)
    return part
  }
  const reasons = new Map<string, string>()
  keep(mainEntry, family.mainRole, mainType)

  // Which worksheets and slides the main part shows. Read by scanning: the
  // tree is built once, later, when the part is rewritten.
  const shownSheets = new Set<string>()
  const hiddenSheets = new Set<string>()
  const listedSlides = new Set<string>()
  if (family.kind === 'sheet') {
    scanXml(mainEntry.data, (tag) => {
      if (tag.ns !== NS.s || tag.name !== 'sheet') return
      const id = attrOf(tag.attributes, 'id', NS.r)
      if (id === undefined) return
      const state = attrOf(tag.attributes, 'state')
      ;(state === undefined || state === 'visible' ? shownSheets : hiddenSheets).add(id)
    })
  } else if (family.kind === 'slides') {
    scanXml(mainEntry.data, (tag) => {
      if (tag.ns !== NS.p || tag.name !== 'sldId') return
      const id = attrOf(tag.attributes, 'id', NS.r)
      if (id !== undefined) listedSlides.add(id)
    })
  }

  for (let i = 0; i < order.length; i++) {
    const part = order[i]
    const edges = EDGES[part.role] ?? {}
    for (const rel of pkg.relsOf(part.name)) {
      if (rel.external) {
        removed.add('externalRelationships')
        continue
      }
      const role = edges[rel.type]
      if (role === undefined) continue
      const name = resolveTarget(part.name, rel.target)
      const entry = name === undefined ? undefined : pkg.get(name)
      if (!entry || entry.directory) continue
      const type = pkg.typeOf(entry.name)
      if (type?.toLowerCase() !== ROLE_TYPE[role as keyof typeof ROLE_TYPE]) continue
      const key = fold(entry.name)

      if (part.role === 'sheetMain' && role === 'worksheet') {
        if (!shownSheets.has(rel.id) || hiddenSheets.has(rel.id)) {
          if (hiddenSheets.has(rel.id)) reasons.set(key, 'hiddenSheets')
          continue
        }
      }
      if (part.role === 'slidesMain' && role === 'slide') {
        if (!listedSlides.has(rel.id) || !slideShown(entry)) {
          reasons.set(key, 'hiddenSlides')
          continue
        }
      }
      if (part.role === 'notesSlide' && !kept.has(key)) continue

      const existing = kept.get(key)
      if (existing && existing.role !== role) continue
      part.rels.push({ id: rel.id, type: rel.type, target: entry.name })
      if (!existing) keep(entry, role, type!)
    }
  }

  // Every part not written, by what it was.
  for (const e of entries) {
    if (e.directory || isRelsPart(e.name)) continue
    const key = fold(e.name)
    if (kept.has(key) || key === '[content_types].xml') continue
    removed.add(reasons.get(key) ?? categoryOf(e.name, pkg.typeOf(e.name)))
  }

  // Rewrite the kept parts. Styles first (the rules resolve through them),
  // then the main part (its note references decide which notes stay), then
  // the rest in the order they were reached.
  const shared: Shared = { removed, counted, noteRefs: new Set() }
  const out = new Map<KeptPart, string>()
  const styleRoles: Role[] = ['wordStyles', 'sheetStyles']
  const sequence = [
    ...order.filter((p) => styleRoles.includes(p.role)),
    order[0],
    ...order.filter((p) => p !== order[0] && !styleRoles.includes(p.role)),
  ]
  for (const part of sequence) {
    const root = parseXml(pkg.get(part.name)!.data)
    const rewritten = rewritePart(root, {
      ...shared,
      role: part.role,
      keptIds: new Set(part.rels.map((r) => r.id)),
    })
    if (part.role === 'wordStyles') shared.wordStyles = readWordStyles(rewritten)
    if (part.role === 'sheetStyles') shared.sheetStyles = readSheetStyles(rewritten)
    if (part.role === 'wordMain') collectNoteRefs(rewritten, shared.noteRefs)
    if (part.role === 'slidesMain') shared.slideSize = readSlideSize(rewritten)
    out.set(part, XML_DECL + serialize(rewritten))
  }

  const files: { name: string; data: string }[] = [
    { name: '[Content_Types].xml', data: contentTypesXml(order) },
    {
      name: '_rels/.rels',
      data: relsXml('', [{ id: 'rId1', type: OFFICE_DOCUMENT, target: mainEntry.name }]),
    },
  ]
  for (const part of order) {
    files.push({ name: part.name, data: out.get(part)! })
    if (part.rels.length > 0) {
      files.push({ name: relsPartName(part.name), data: relsXml(part.name, part.rels) })
    }
  }
  return { bytes: writeZip(files.map(zipFile)), removed: removed.values, counted: counted.values }
}

/** A slide's own `show` (ST_OnOff): hidden unless absent or true. */
function slideShown(entry: ZipEntry): boolean {
  let shown = true
  scanXml(entry.data, (tag) => {
    if (tag.depth !== 0) return
    const show = attrOf(tag.attributes, 'show')
    if (show !== undefined && show !== '1' && show !== 'true') shown = false
  })
  return shown
}

/**
 * One file of the output. A part too large or too repetitive to deflate under
 * the reader's own 100:1 ratio is stored: the output must reopen through the
 * same reader, and a refusal there would be a false "Sanitize unavailable".
 */
function zipFile(file: { name: string; data: string }): ZipFile {
  const data = new TextEncoder().encode(file.data)
  if (data.length > XML_LIMITS.maxPartBytes) {
    throw new ZipRefusedError(
      'xml-size',
      `${JSON.stringify(file.name)} would be rewritten too large`,
    )
  }
  const deflated = deflateRawSync(data).length
  return { name: file.name, data, method: data.length > ZIP_LIMITS.maxRatio * deflated ? 0 : 8 }
}

function contentTypesXml(parts: readonly KeptPart[]): string {
  return (
    `${XML_DECL}<Types xmlns="${NS.ct}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    parts
      .map(
        (p) => `<Override PartName="${escAttr(`/${p.name}`)}" ContentType="${escAttr(p.type)}"/>`,
      )
      .join('') +
    '</Types>'
  )
}

/** Fresh relationships: kept Ids, internal targets only, written canonically. */
function relsXml(source: string, rels: readonly KeptRel[]): string {
  const dir = dirOf(source)
  return (
    `${XML_DECL}<Relationships xmlns="${NS.rels}">` +
    rels
      .map((r) => {
        const target =
          dir !== '' && !r.target.startsWith(dir) ? `/${r.target}` : r.target.slice(dir.length)
        return `<Relationship Id="${escAttr(r.id)}" Type="${escAttr(r.type)}" Target="${escAttr(target)}"/>`
      })
      .join('') +
    '</Relationships>'
  )
}

// ============================================================================
// Rewriting one part
// ============================================================================

type Node = XmlElement | string

interface Shared {
  readonly removed: Tally
  readonly counted: Tally
  /** `footnote:<id>` / `endnote:<id>` for every reference the main part kept. */
  readonly noteRefs: Set<string>
  wordStyles?: WordStyles
  sheetStyles?: SheetStyles
  slideSize?: { cx: number; cy: number }
}

interface Ctx extends Shared {
  readonly role: Role
  /** The relationship Ids this part keeps; a reference to any other is dangling. */
  readonly keptIds: ReadonlySet<string>
}

interface Scope {
  /** `undefined` outside a paragraph or table; empty for "the default style". */
  readonly pStyles?: readonly string[]
  readonly tblStyles?: readonly string[]
}

/** Field-code state, per part: one stack over kept content, one over everything. */
interface Fields {
  kept: ('code' | 'result')[]
  all: ('code' | 'result')[]
  /** Hiding-rule hits, for the `mc:AlternateContent` rule. */
  hidden: number
}

const is = (el: XmlElement, ns: string, name: string): boolean => el.ns === ns && el.name === name

const elements = (el: XmlElement): XmlElement[] =>
  el.children.filter((c): c is XmlElement => typeof c !== 'string')

const childEl = (el: XmlElement | undefined, ns: string, name: string): XmlElement | undefined =>
  el ? elements(el).find((c) => is(c, ns, name)) : undefined

/** Every match, not the first: a property given twice is ambiguous, so each one is read. */
const childEls = (el: XmlElement, ns: string, name: string): XmlElement[] =>
  elements(el).filter((c) => is(c, ns, name))

/** The `w:val` of every `w:<prop>` in every `w:<props>` of `el` (`pPr`/`pStyle`, …). */
const wVals = (el: XmlElement, props: string, prop: string): string[] =>
  childEls(el, NS.w, props)
    .flatMap((p) => childEls(p, NS.w, prop))
    .map(wVal)
    .filter((v): v is string => v !== undefined)

const wVal = (el: XmlElement | undefined): string | undefined =>
  el ? attrOf(el.attributes, 'val', NS.w) : undefined

/** ST_OnOff: present and not false. Only `w:val` counts — Word ignores an unqualified one. */
function onOff(el: XmlElement | undefined, attr?: string): boolean | undefined {
  if (!el) return undefined
  const v = attr === undefined ? wVal(el) : attrOf(el.attributes, attr)
  return v === undefined || !['false', '0', 'off'].includes(v.toLowerCase())
}

/** An attribute flag such as `hidden="1"`: absent is `false`, anything but false is `true`. */
function flag(el: XmlElement, name: string): boolean {
  const v = attrOf(el.attributes, name)
  return v !== undefined && !['false', '0', 'off'].includes(v.toLowerCase())
}

const textOf = (el: XmlElement): string =>
  el.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('')

function rewritePart(root: XmlElement, ctx: Ctx): XmlElement {
  const fields: Fields = { kept: [], all: [], hidden: 0 }
  const nodes = visit(root, ctx, fields, {})
  // The root itself is never dropped by a rule that drops elements (none
  // targets a part's root), so this is the one element `visit` returned.
  const top = nodes.find((n): n is XmlElement => typeof n !== 'string')
  return top ?? { ...root, children: [] }
}

/** Advance both field stacks over one `w:fldChar`. */
function fieldChar(el: XmlElement, stacks: ('code' | 'result')[][]): void {
  const type = attrOf(el.attributes, 'fldCharType', NS.w)
  for (const s of stacks) {
    if (type === 'begin') s.push('code')
    else if (type === 'separate' && s.length > 0) s[s.length - 1] = 'result'
    else if (type === 'end') s.pop()
  }
}

/** A dropped subtree still moves the "everything" stack. */
function fieldCharsIn(el: XmlElement, fields: Fields): void {
  if (is(el, NS.w, 'fldChar')) fieldChar(el, [fields.all])
  for (const c of elements(el)) fieldCharsIn(c, fields)
}

const inCode = (fields: Fields): boolean =>
  fields.kept.includes('code') || fields.all.includes('code')

/** Elements dropped whole, by namespace and local name, and what each counts as. */
const DROP: ReadonlyMap<string, ReadonlyMap<string, string | null>> = new Map([
  [
    NS.w,
    new Map<string, string | null>([
      ['del', 'deletions'],
      ['moveFrom', 'deletions'],
      ['delText', 'deletions'],
      ['moveFromRangeStart', null],
      ['moveFromRangeEnd', null],
      ['moveToRangeStart', null],
      ['moveToRangeEnd', null],
      ['rPrChange', 'formatRevisions'],
      ['pPrChange', 'formatRevisions'],
      ['sectPrChange', 'formatRevisions'],
      ['tblPrChange', 'formatRevisions'],
      ['tblPrExChange', 'formatRevisions'],
      ['trPrChange', 'formatRevisions'],
      ['tcPrChange', 'formatRevisions'],
      ['tblGridChange', 'formatRevisions'],
      ['numberingChange', 'formatRevisions'],
      ['commentRangeStart', 'commentMarkers'],
      ['commentRangeEnd', 'commentMarkers'],
      ['commentReference', 'commentMarkers'],
      ['instrText', 'fieldCodes'],
      ['delInstrText', 'fieldCodes'],
      ['object', 'oleObjects'],
    ]),
  ],
  [NS.o, new Map([['OLEObject', 'oleObjects']])],
  [
    NS.p,
    new Map([
      ['oleObj', 'oleObjects'],
      ['controls', 'controls'],
    ]),
  ],
  [
    NS.s,
    new Map([
      ['f', 'formulas'],
      ['oleObjects', 'oleObjects'],
      ['controls', 'controls'],
    ]),
  ],
])

/** Elements replaced by their own children. */
const UNWRAP: ReadonlyMap<string, ReadonlyMap<string, string | null>> = new Map([
  [
    NS.w,
    new Map<string, string | null>([
      ['ins', null],
      ['moveTo', null],
      ['fldSimple', 'fieldCodes'],
    ]),
  ],
])

function visit(el: XmlElement, ctx: Ctx, fields: Fields, scope: Scope): Node[] {
  const drop = (key: string | null): Node[] => {
    if (key !== null) ctx.removed.add(key)
    fieldCharsIn(el, fields)
    return []
  }

  // ── Whole-element drops ────────────────────────────────────────────────
  const dropKey = DROP.get(el.ns)?.get(el.name)
  if (dropKey !== undefined) return drop(dropKey)
  if (is(el, NS.w, 'fldChar')) {
    fieldChar(el, [fields.kept, fields.all])
    return []
  }
  if (is(el, NS.s, 'definedNames')) {
    ctx.removed.add('definedNames', elements(el).length)
    return []
  }
  if (is(el, NS.w, 'tr') && childEl(childEl(el, NS.w, 'trPr'), NS.w, 'del'))
    return drop('deletions')
  if (isHiddenShape(el)) {
    fields.hidden++
    return drop('hiddenShapes')
  }
  if ((is(el, NS.w, 'r') || is(el, NS.m, 'r')) && runHidden(el, ctx, scope)) {
    fields.hidden++
    return drop('hiddenRuns')
  }
  if (
    (ctx.role === 'wordFootnotes' || ctx.role === 'wordEndnotes') &&
    (is(el, NS.w, 'footnote') || is(el, NS.w, 'endnote')) &&
    !noteKept(el, ctx)
  ) {
    return drop('unreferencedNotes')
  }

  // ── Markup compatibility: both branches, and one hidden branch hides all ─
  if (is(el, NS.mc, 'AlternateContent')) {
    const before = fields.hidden
    const rebuilt = rebuild(el, ctx, fields, scope)
    if (fields.hidden > before) {
      ctx.removed.add('alternateContent')
      return []
    }
    return rebuilt
  }

  // ── Scope, then the element itself ─────────────────────────────────────
  let inner = scope
  if (is(el, NS.w, 'p')) inner = { ...scope, pStyles: wVals(el, 'pPr', 'pStyle') }
  else if (is(el, NS.w, 'tbl')) inner = { ...scope, tblStyles: wVals(el, 'tblPr', 'tblStyle') }
  const out = rebuild(el, ctx, fields, inner)

  const unwrapKey = UNWRAP.get(el.ns)?.get(el.name)
  if (unwrapKey !== undefined) {
    if (unwrapKey !== null) ctx.removed.add(unwrapKey)
    const self = out[0] as XmlElement | undefined
    return self ? unwrap(el, self.children) : []
  }
  return out
}

/** The element with its attributes ruled and its children visited; `[]` if it was only a reference. */
function rebuild(el: XmlElement, ctx: Ctx, fields: Fields, scope: Scope): Node[] {
  let lostReference = false
  let altText = false
  const attributes: XmlAttribute[] = []
  const altBearer = is(el, NS.wp, 'docPr') || el.name === 'cNvPr'
  for (const a of el.attributes) {
    if ((a.ns === NS.r || (a.ns === NS.o && a.name === 'relid')) && !ctx.keptIds.has(a.value)) {
      ctx.removed.add('references')
      lostReference = true
      continue
    }
    if (altBearer && a.ns === '' && (a.name === 'descr' || a.name === 'title')) {
      altText = true
      continue
    }
    attributes.push(a)
  }
  if (altText) ctx.removed.add('altText')

  const runLike = is(el, NS.w, 'r') || is(el, NS.m, 'r')
  const children: Node[] = []
  for (const c of el.children) {
    if (typeof c === 'string') {
      children.push(c)
      continue
    }
    // Inside a run in a field's code, everything but its properties goes —
    // OMML's `m:r` included, which is what takes an equation in the code.
    if (runLike && inCode(fields) && !is(c, NS.w, 'rPr') && !is(c, NS.w, 'fldChar')) {
      ctx.removed.add('fieldCodes')
      fieldCharsIn(c, fields)
      continue
    }
    children.push(...visit(c, ctx, fields, scope))
  }

  if (lostReference && !children.some((c) => typeof c !== 'string')) return []
  const rebuilt: XmlElement = { ...el, attributes, children }
  count(rebuilt, ctx, scope)
  return [rebuilt]
}

/** Replace `el` by `children`, carrying its namespace declarations onto them. */
function unwrap(el: XmlElement, children: readonly Node[]): Node[] {
  const decls = el.attributes.filter((a) => a.ns === NS.xmlns)
  if (decls.length === 0) return [...children]
  const key = (a: XmlAttribute) => (a.prefix === 'xmlns' ? a.name : '')
  return children.map((c) => {
    if (typeof c === 'string') return c
    const own = new Set(c.attributes.filter((a) => a.ns === NS.xmlns).map(key))
    return { ...c, attributes: [...decls.filter((d) => !own.has(key(d))), ...c.attributes] }
  })
}

// ============================================================================
// Hidden shapes, hidden runs, notes
// ============================================================================

/** A shape whose `wp:docPr` or `*:cNvPr` — directly, or in its `nv…Pr` — says hidden. */
function isHiddenShape(el: XmlElement): boolean {
  for (const c of elements(el)) {
    if (is(c, NS.wp, 'docPr') || c.name === 'cNvPr') {
      if (flag(c, 'hidden')) return true
    } else if (/^nv.*Pr$/.test(c.name)) {
      if (elements(c).some((g) => g.name === 'cNvPr' && flag(g, 'hidden'))) return true
    }
  }
  return false
}

const HIDING = ['vanish', 'specVanish', 'webHidden'] as const

function runHidden(run: XmlElement, ctx: Ctx, scope: Scope): boolean {
  const rPrs = childEls(run, NS.w, 'rPr')
  const rStyles = wVals(run, 'rPr', 'rStyle')
  for (const prop of HIDING) {
    const direct = rPrs.flatMap((r) => childEls(r, NS.w, prop)).map((e) => onOff(e))
    if (direct.includes(true)) return true
    if (direct.length > 0) continue // set false directly: absolute, whatever a style says
    if (ctx.wordStyles && styleHides(ctx.wordStyles, prop, rStyles, scope)) return true
  }
  return false
}

function noteKept(note: XmlElement, ctx: Ctx): boolean {
  const type = attrOf(note.attributes, 'type', NS.w)
  if (type === 'separator' || type === 'continuationSeparator' || type === 'continuationNotice') {
    return true
  }
  const kind = note.name === 'footnote' ? 'footnote' : 'endnote'
  return ctx.noteRefs.has(`${kind}:${attrOf(note.attributes, 'id', NS.w)}`)
}

function collectNoteRefs(el: XmlElement, refs: Set<string>): void {
  if (is(el, NS.w, 'footnoteReference')) refs.add(`footnote:${attrOf(el.attributes, 'id', NS.w)}`)
  if (is(el, NS.w, 'endnoteReference')) refs.add(`endnote:${attrOf(el.attributes, 'id', NS.w)}`)
  for (const c of elements(el)) collectNoteRefs(c, refs)
}

// ============================================================================
// WordprocessingML styles
// ============================================================================

interface RunProps {
  readonly on: ReadonlyMap<string, boolean>
  readonly color?: { readonly val?: string; readonly theme?: string }
  readonly sz?: number
}

interface WordStyle {
  readonly basedOn?: string
  readonly rPr?: RunProps
  /** A table style's conditional formatting (`w:tblStylePr`). */
  readonly conditional: readonly RunProps[]
}

interface WordStyles {
  /** By lower-cased id; every definition of an id, since a duplicate is ambiguous. */
  readonly byId: ReadonlyMap<string, readonly WordStyle[]>
  readonly docDefaults?: RunProps
  /** Every style claiming `w:default` for its type: two claimants are ambiguous, so both count. */
  readonly defaults: Readonly<Record<StyleType, readonly string[]>>
}

type StyleType = 'paragraph' | 'character' | 'table'
const STYLE_TYPES: readonly string[] = ['paragraph', 'character', 'table']

function runProps(rPr: XmlElement | undefined): RunProps | undefined {
  if (!rPr) return undefined
  const on = new Map<string, boolean>()
  for (const prop of HIDING) {
    const v = onOff(childEl(rPr, NS.w, prop))
    if (v !== undefined) on.set(prop, v)
  }
  const color = childEl(rPr, NS.w, 'color')
  const sz = Number.parseInt(wVal(childEl(rPr, NS.w, 'sz')) ?? '', 10)
  return {
    on,
    color: color && {
      val: wVal(color),
      theme: attrOf(color.attributes, 'themeColor', NS.w),
    },
    sz: Number.isFinite(sz) ? sz : undefined,
  }
}

function readWordStyles(root: XmlElement): WordStyles {
  const byId = new Map<string, WordStyle[]>()
  const defaults: Record<StyleType, string[]> = { paragraph: [], character: [], table: [] }
  for (const s of elements(root)) {
    if (!is(s, NS.w, 'style')) continue
    const id = attrOf(s.attributes, 'styleId', NS.w)
    if (id === undefined) continue
    const key = id.toLowerCase()
    byId.set(key, [
      ...(byId.get(key) ?? []),
      {
        basedOn: wVal(childEl(s, NS.w, 'basedOn')),
        rPr: runProps(childEl(s, NS.w, 'rPr')),
        conditional: elements(s)
          .filter((c) => is(c, NS.w, 'tblStylePr'))
          .map((c) => runProps(childEl(c, NS.w, 'rPr')))
          .filter((p): p is RunProps => p !== undefined),
      },
    ])
    const type = attrOf(s.attributes, 'type', NS.w)
    const isDefault = attrOf(s.attributes, 'default', NS.w)
    if (
      type !== undefined &&
      STYLE_TYPES.includes(type) &&
      isDefault !== undefined &&
      !['false', '0', 'off'].includes(isDefault.toLowerCase())
    ) {
      defaults[type as StyleType].push(id)
    }
  }
  const docDefaults = runProps(
    childEl(childEl(childEl(root, NS.w, 'docDefaults'), NS.w, 'rPrDefault'), NS.w, 'rPr'),
  )
  return { byId, docDefaults, defaults }
}

/** Every style in these ids' `basedOn` chains, nearest first; cycles and runaway chains end. */
function chain(styles: WordStyles, ids: readonly string[]): WordStyle[] {
  const out: WordStyle[] = []
  const seen = new Set<string>()
  const queue = ids.map((id) => id.toLowerCase())
  while (queue.length > 0 && out.length < 256) {
    const key = queue.shift()!
    if (seen.has(key)) continue
    seen.add(key)
    for (const s of styles.byId.get(key) ?? []) {
      out.push(s)
      if (s.basedOn !== undefined) queue.push(s.basedOn.toLowerCase())
    }
  }
  return out
}

/** The style levels a run in this scope inherits from, nearest first. */
function levels(styles: WordStyles, rStyles: readonly string[], scope: Scope): RunProps[] {
  const props: (RunProps | undefined)[] = []
  const named = (ids: readonly string[], type: StyleType) =>
    ids.length > 0 ? ids : styles.defaults[type]
  props.push(...chain(styles, named(rStyles, 'character')).map((s) => s.rPr))
  if (scope.pStyles !== undefined) {
    props.push(...chain(styles, named(scope.pStyles, 'paragraph')).map((s) => s.rPr))
  }
  if (scope.tblStyles !== undefined) {
    for (const s of chain(styles, named(scope.tblStyles, 'table'))) {
      props.push(s.rPr, ...s.conditional)
    }
  }
  props.push(styles.docDefaults)
  return props.filter((p): p is RunProps => p !== undefined)
}

/** Any level that hides, hides: toggles cancelling out is not modelled (it only drops more). */
function styleHides(
  styles: WordStyles,
  prop: string,
  rStyles: readonly string[],
  scope: Scope,
): boolean {
  return levels(styles, rStyles, scope).some((p) => p.on.get(prop) === true)
}

// ============================================================================
// Counted, not dropped
// ============================================================================

function count(el: XmlElement, ctx: Ctx, scope: Scope): void {
  if (is(el, NS.w, 'r') && hasText(el, NS.w)) countWordRun(el, ctx, scope)
  else if (is(el, NS.a, 'r') && hasText(el, NS.a)) countDrawingRun(el, ctx)
  else if (ctx.role === 'worksheet') countSheet(el, ctx)
  else if (ctx.role === 'slide' && is(el, NS.p, 'spTree')) countOffSlide(el, ctx)
}

const hasText = (run: XmlElement, ns: string): boolean =>
  elements(run).some((c) => is(c, ns, 't') && textOf(c).trim() !== '')

function countWordRun(run: XmlElement, ctx: Ctx, scope: Scope): void {
  const direct = childEls(run, NS.w, 'rPr').map(runProps)
  const rStyles = wVals(run, 'rPr', 'rStyle')
  const stack = [...direct, ...(ctx.wordStyles ? levels(ctx.wordStyles, rStyles, scope) : [])]
  const color = stack.find((p) => p?.color !== undefined)?.color
  const sz = stack.find((p) => p?.sz !== undefined)?.sz
  // A theme colour wins over `w:val` in Word; either one saying white counts.
  const white =
    color !== undefined &&
    (color.theme === 'background1' ||
      color.theme === 'light1' ||
      color.val?.toUpperCase() === 'FFFFFF')
  if (white) ctx.counted.add('whiteText')
  if (sz !== undefined && sz <= 2) ctx.counted.add('tinyText')
}

function countDrawingRun(run: XmlElement, ctx: Ctx): void {
  const rPr = childEl(run, NS.a, 'rPr')
  if (!rPr) return
  const fill = childEl(rPr, NS.a, 'solidFill')
  const rgb = attrOf(childEl(fill, NS.a, 'srgbClr')?.attributes ?? [], 'val')
  const scheme = attrOf(childEl(fill, NS.a, 'schemeClr')?.attributes ?? [], 'val')
  if (rgb?.toUpperCase() === 'FFFFFF' || scheme === 'bg1' || scheme === 'lt1') {
    ctx.counted.add('whiteText')
  }
  const sz = Number.parseInt(attrOf(rPr.attributes, 'sz') ?? '', 10)
  if (Number.isFinite(sz) && sz <= 100) ctx.counted.add('tinyText')
}

const zero = (v: string | undefined): boolean => v !== undefined && Number.parseFloat(v) === 0

function countSheet(el: XmlElement, ctx: Ctx): void {
  if (is(el, NS.s, 'row')) {
    if (flag(el, 'hidden')) ctx.counted.add('hiddenRows')
    if (zero(attrOf(el.attributes, 'ht'))) ctx.counted.add('zeroRowHeights')
  } else if (is(el, NS.s, 'col')) {
    if (flag(el, 'hidden')) ctx.counted.add('hiddenColumns')
    if (zero(attrOf(el.attributes, 'width'))) ctx.counted.add('zeroColumnWidths')
  } else if (is(el, NS.s, 'sheetFormatPr')) {
    if (flag(el, 'zeroHeight')) ctx.counted.add('hiddenRows')
    if (zero(attrOf(el.attributes, 'defaultRowHeight'))) ctx.counted.add('zeroRowHeights')
    if (zero(attrOf(el.attributes, 'defaultColWidth'))) ctx.counted.add('zeroColumnWidths')
  } else if (is(el, NS.s, 'c') && ctx.sheetStyles) {
    if (!childEl(el, NS.s, 'v') && !childEl(el, NS.s, 'is')) return
    const xf = ctx.sheetStyles.xfs[Number.parseInt(attrOf(el.attributes, 's') ?? '0', 10)]
    if (!xf) return
    const format = ctx.sheetStyles.numFmts.get(xf.numFmtId)
    if (format !== undefined && format.replace(/\s/g, '') === ';;;') {
      ctx.counted.add('hiddenNumberFormats')
    }
    const font = ctx.sheetStyles.fonts[xf.fontId]
    const fill = ctx.sheetStyles.fills[xf.fillId]
    if (font && (fill ? sameColor(font, fill) : isWhite(font))) ctx.counted.add('fontMatchesFill')
  }
}

function countOffSlide(spTree: XmlElement, ctx: Ctx): void {
  const size = ctx.slideSize
  if (!size) return
  const shapes = ['sp', 'grpSp', 'graphicFrame', 'cxnSp', 'pic', 'contentPart']
  for (const shape of elements(spTree)) {
    if (shape.ns !== NS.p || !shapes.includes(shape.name)) continue
    const xfrm =
      childEl(childEl(shape, NS.p, 'spPr'), NS.a, 'xfrm') ??
      childEl(childEl(shape, NS.p, 'grpSpPr'), NS.a, 'xfrm') ??
      childEl(shape, NS.p, 'xfrm')
    const off = childEl(xfrm, NS.a, 'off')
    const ext = childEl(xfrm, NS.a, 'ext')
    if (!off) continue
    const num = (e: XmlElement | undefined, n: string) =>
      Number.parseInt(attrOf(e?.attributes ?? [], n) ?? '0', 10) || 0
    const [x, y, cx, cy] = [num(off, 'x'), num(off, 'y'), num(ext, 'cx'), num(ext, 'cy')]
    if (x >= size.cx || y >= size.cy || x + cx <= 0 || y + cy <= 0) {
      ctx.counted.add('offSlideShapes')
    }
  }
}

function readSlideSize(root: XmlElement): { cx: number; cy: number } | undefined {
  const sz = childEl(root, NS.p, 'sldSz')
  const cx = Number.parseInt(attrOf(sz?.attributes ?? [], 'cx') ?? '', 10)
  const cy = Number.parseInt(attrOf(sz?.attributes ?? [], 'cy') ?? '', 10)
  return Number.isFinite(cx) && Number.isFinite(cy) ? { cx, cy } : undefined
}

// ── SpreadsheetML styles ────────────────────────────────────────────────────

interface Color {
  readonly rgb?: string
  readonly theme?: string
  readonly tint?: string
  readonly indexed?: string
}

interface SheetStyles {
  readonly numFmts: ReadonlyMap<number, string>
  readonly xfs: readonly { numFmtId: number; fontId: number; fillId: number }[]
  /** A font's colour; `undefined` for the automatic one. */
  readonly fonts: readonly (Color | undefined)[]
  /** A SOLID fill's colour; `undefined` for no fill (white). */
  readonly fills: readonly (Color | undefined)[]
}

function colorOf(el: XmlElement | undefined): Color | undefined {
  if (!el) return undefined
  const a = (n: string) => attrOf(el.attributes, n)
  return { rgb: a('rgb'), theme: a('theme'), tint: a('tint'), indexed: a('indexed') }
}

function readSheetStyles(root: XmlElement): SheetStyles {
  const int = (v: string | undefined) => Number.parseInt(v ?? '0', 10) || 0
  const numFmts = new Map<number, string>()
  for (const f of elements(childEl(root, NS.s, 'numFmts') ?? root)) {
    if (!is(f, NS.s, 'numFmt')) continue
    numFmts.set(int(attrOf(f.attributes, 'numFmtId')), attrOf(f.attributes, 'formatCode') ?? '')
  }
  const list = (name: string, item: string) =>
    elements(childEl(root, NS.s, name) ?? { ...root, children: [] }).filter((e) =>
      is(e, NS.s, item),
    )
  return {
    numFmts,
    xfs: list('cellXfs', 'xf').map((x) => ({
      numFmtId: int(attrOf(x.attributes, 'numFmtId')),
      fontId: int(attrOf(x.attributes, 'fontId')),
      fillId: int(attrOf(x.attributes, 'fillId')),
    })),
    fonts: list('fonts', 'font').map((f) => colorOf(childEl(f, NS.s, 'color'))),
    fills: list('fills', 'fill').map((f) => {
      const pattern = childEl(f, NS.s, 'patternFill')
      if (!pattern || attrOf(pattern.attributes, 'patternType') !== 'solid') return undefined
      return colorOf(childEl(pattern, NS.s, 'fgColor'))
    }),
  }
}

const rgb6 = (c: Color): string | undefined => c.rgb?.slice(-6).toUpperCase()

function sameColor(a: Color, b: Color): boolean {
  if (a.rgb !== undefined && b.rgb !== undefined) return rgb6(a) === rgb6(b)
  if (a.theme !== undefined && b.theme !== undefined) {
    return a.theme === b.theme && (a.tint ?? '0') === (b.tint ?? '0')
  }
  if (a.indexed !== undefined && b.indexed !== undefined) return a.indexed === b.indexed
  return false
}

/** White on the default (white) background: rgb FFFFFF, theme 0 (Background 1), indexed 1 or 9. */
function isWhite(c: Color): boolean {
  return rgb6(c) === 'FFFFFF' || c.theme === '0' || c.indexed === '1' || c.indexed === '9'
}

// ============================================================================
// Serialization
// ============================================================================

function escText(s: string): string {
  return s.replace(/[&<\r]|]]>/g, (m) =>
    m === '&' ? '&amp;' : m === '<' ? '&lt;' : m === '\r' ? '&#13;' : ']]&gt;',
  )
}

function escAttr(s: string): string {
  return s.replace(/[&<"\t\n\r]/g, (m) =>
    m === '&'
      ? '&amp;'
      : m === '<'
        ? '&lt;'
        : m === '"'
          ? '&quot;'
          : m === '\t'
            ? '&#9;'
            : m === '\n'
              ? '&#10;'
              : '&#13;',
  )
}

function serialize(root: XmlElement): string {
  const out: string[] = []
  const write = (el: XmlElement): void => {
    const qname = el.prefix ? `${el.prefix}:${el.name}` : el.name
    out.push('<', qname)
    for (const a of el.attributes) {
      out.push(' ', a.prefix ? `${a.prefix}:${a.name}` : a.name, '="', escAttr(a.value), '"')
    }
    if (el.children.length === 0) {
      out.push('/>')
      return
    }
    out.push('>')
    for (const c of el.children) {
      if (typeof c === 'string') out.push(escText(c))
      else write(c)
    }
    out.push('</', qname, '>')
  }
  write(root)
  return out.join('')
}
