/**
 * `ooxmlDisarm` — rebuild an OOXML package from an allowlist — Server Only
 * (#433 S6; spec §5.3 step 2, review F11 and F12, amendments A1, A3, A9–A15).
 *
 * The input is an ATTACKER-SUPPLIED docx, docm, xlsx, xlsm, pptx or pptm that
 * an external sender put in front of the provenance gate. This is the
 * `DocumentDisarm` core's `flattenDocument` runs before the converter: what it
 * returns is what kreuzberg extracts, and so what the model reads. Its job is
 * to make that the text a person looking at the document would see — no more.
 * `hiddenContent: 'removed'` is only reported when it returned and counted
 * nothing (A3), so everything below either removes a carrier or counts it.
 *
 * It is built on core's bounded reader (`stash/zip.server`, Δ3) and nothing
 * else: no reader of its own, no new dependency (F17). Every archive and XML
 * limit of §5.3 step 1 is the reader's; the one this module leans on is
 * amendment A1/A14's tree budget, `XML_LIMITS.maxTreeNodes`.
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
 * A worksheet or slide is visible only through the list that names it (A12):
 * a `<sheet>` directly under the workbook's `<sheets>` with no `state` but
 * `visible`, a `<p:sldId>` directly under `<p:sldIdLst>` whose slide's `show`
 * is not false. A slide the list omits is dropped too: kreuzberg reads every
 * slide relationship (`pptx/parser.rs:470-485`).
 *
 * ## Markup compatibility first (A9)
 *
 * Before any rule, every kept part — styles included — is reduced to what
 * Word renders. Elements outside the namespaces this module understands are
 * dropped WITH their content (`mc:Ignorable` wrappers, unknown or Strict
 * namespaces, a conventional prefix rebound to another URI); VML (`v`, `o`,
 * `w10`) is not understood, so legacy `w:pict` content goes with them. Each
 * `mc:AlternateContent` keeps ONE branch — the first `mc:Choice` whose
 * `Requires` prefixes all resolve, in scope, to understood namespaces, else
 * `mc:Fallback` — exactly as Word chooses, and the other branches are
 * dropped. kreuzberg matches literal `w:` names and reads every branch
 * (`docx/parser.rs:1266-1281`), so without this an ignorable wrapper or the
 * branch Word never renders would carry text past every rule below.
 *
 * ## Rules inside the kept parts — by namespace URI, never by prefix
 *
 * Dropped:
 * - runs (`w:r`, and OMML's `m:r`) whose EFFECTIVE `vanish`, `specVanish` or
 *   `webHidden` is on — direct `rPr` first; else docDefaults, the table style
 *   (its conditional formatting included), the paragraph style and the
 *   character style, each through its `basedOn` chain and with the default
 *   style standing in for a missing one. Toggle semantics are not modelled:
 *   any style level that hides is read as hiding. A chain longer than 256, or
 *   one that loops, counts as hiding too (A13). Each style id is resolved once
 *   and each style combination once, so the cost is linear in the part;
 * - shapes with `hidden` on `wp:docPr` or on any `*:cNvPr`;
 * - `descr` and `title` on `wp:docPr` and on any `*:cNvPr` (alt text);
 * - tracked changes, accepted: `w:del`, `w:moveFrom`, a deleted row or cell
 *   (A11), any `w:delText`, the move-range markers and every property
 *   revision go; `w:ins` and `w:moveTo` are unwrapped;
 * - field codes: `w:instrText`, `w:fldChar` (with its form-field data) and
 *   everything between a field's begin and its separator, nested fields
 *   included, with O(1) field state per node and a nesting limit of 256
 *   (A13); `w:fldSimple` is unwrapped. In SpreadsheetML, cell formulas (`f`,
 *   the cached value stays) and `definedNames`;
 * - OLE and ActiveX elements (`w:object`, `p:oleObj`, `p:controls`,
 *   `oleObjects`, `controls`), and comment markers;
 * - every `r:*` reference to a relationship that was not kept; an element
 *   that was nothing but that reference goes with it;
 * - footnotes and endnotes no kept reference points at, and in a
 *   separator-type note every run but its separator mark (A11): kreuzberg
 *   prints every note, whatever its type.
 *
 * Counted, not dropped (`counted`, which makes `hiddenContent` `'not-removed'`
 * — A3, A10): hidden rows and columns; row heights under 1 and column widths
 * under 0.5; a hidden workbook window; a number format that is only `;`
 * once empty literals and `[…]` codes are gone; a `[White]` or `[Color2]`
 * format, a font or rich-text run colour equal to its cell's fill once
 * `indexed`, `theme` and tint are resolved to RGB (no fill is white); white
 * or near-white text (every channel ≥ `F0`), text with no fill or alpha 0,
 * a docx font colour equal to its `w:shd` fill, and text of 1 pt or less
 * (`w:sz` or `w:szCs`); and shapes placed off the slide.
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
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  rels: 'http://schemas.openxmlformats.org/package/2006/relationships',
  xml: 'http://www.w3.org/XML/1998/namespace',
  xmlns: 'http://www.w3.org/2000/xmlns/',
} as const

const MSO = 'http://schemas.microsoft.com/office/'

/**
 * The element namespaces each family understands (A9). An element in any
 * other namespace is dropped with its content, the way Word ignores it.
 * VML (`v`, `o`, `w10`) is deliberately absent: no rule here models its
 * visibility or its `alt`.
 */
const DRAWING = [
  NS.a,
  NS.pic,
  NS.mc,
  `${MSO}drawing/2010/main`, // a14
  `${MSO}drawing/2012/main`, // a15
  `${MSO}drawing/2014/main`, // a16
]
const UNDERSTOOD: Readonly<Record<'word' | 'sheet' | 'slides', ReadonlySet<string>>> = {
  word: new Set([
    ...DRAWING,
    NS.w,
    NS.wp,
    NS.m,
    `${MSO}word/2010/wordprocessingDrawing`, // wp14
    `${MSO}word/2010/wordprocessingShape`, // wps
    `${MSO}word/2010/wordprocessingGroup`, // wpg
    `${MSO}word/2010/wordprocessingCanvas`, // wpc
    `${MSO}word/2010/wordml`, // w14
    `${MSO}word/2012/wordml`, // w15
    `${MSO}word/2015/wordml/symex`, // w16se
    `${MSO}word/2016/wordml/cid`, // w16cid
    `${MSO}word/2018/wordml`, // w16
    `${MSO}word/2018/wordml/cex`, // w16cex
    `${MSO}word/2020/wordml/sdtdatahash`, // w16sdtdh
    `${MSO}word/2023/wordml/word16du`, // w16du
  ]),
  sheet: new Set([
    ...DRAWING,
    NS.s,
    `${MSO}spreadsheetml/2009/9/main`, // x14
    `${MSO}spreadsheetml/2009/9/ac`, // x14ac
    `${MSO}spreadsheetml/2010/11/main`, // x15
    `${MSO}spreadsheetml/2010/11/ac`, // x15ac
    `${MSO}spreadsheetml/2014/revision`, // xr
    `${MSO}spreadsheetml/2015/revision2`, // xr2
    `${MSO}spreadsheetml/2016/revision3`, // xr3
    `${MSO}excel/2006/main`, // xm
  ]),
  slides: new Set([
    ...DRAWING,
    NS.p,
    `${MSO}powerpoint/2010/main`, // p14
    `${MSO}powerpoint/2012/main`, // p15
  ]),
}

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

/** Fields nested deeper than this are refused (A13). */
const MAX_FIELD_DEPTH = 256

/** A `basedOn` chain longer than this counts as hiding, never as absent (A13). */
const MAX_STYLE_DEPTH = 256

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

/** `{ns, name}` of an element or a scanned start tag. */
type Named = { readonly ns: string; readonly name: string }

const is = (el: Named, ns: string, name: string): boolean => el.ns === ns && el.name === name

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

  // Which worksheets and slides the main part shows: only through the list
  // that names them, a depth-2 entry under its depth-1 list (A12). A
  // `<sheet>` or `<p:sldId>` anywhere else — an `extLst`, say — is a decoy.
  // Read by scanning: the tree is built once, later, when the part is rewritten.
  const shownSheets = new Set<string>()
  const hiddenSheets = new Set<string>()
  const listedSlides = new Set<string>()
  let list: Named | undefined
  scanXml(mainEntry.data, (tag) => {
    if (tag.depth === 1) list = tag
    if (tag.depth !== 2 || !list) return
    const id = attrOf(tag.attributes, 'id', NS.r)
    if (family.kind === 'sheet' && is(list, NS.s, 'sheets') && is(tag, NS.s, 'sheet')) {
      if (id === undefined) return
      const state = attrOf(tag.attributes, 'state')
      ;(state === undefined || state === 'visible' ? shownSheets : hiddenSheets).add(id)
    } else if (family.kind === 'sheet' && is(list, NS.s, 'bookViews')) {
      const visibility = attrOf(tag.attributes, 'visibility')
      if (is(tag, NS.s, 'workbookView') && visibility !== undefined && visibility !== 'visible') {
        counted.add('hiddenWindows')
      }
    } else if (family.kind === 'slides' && is(list, NS.p, 'sldIdLst') && is(tag, NS.p, 'sldId')) {
      if (id !== undefined) listedSlides.add(id)
    }
  })

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

  // Rewrite the kept parts. What the rules read comes first — the theme and
  // styles they resolve colours and hiding through, the shared strings a cell
  // points at — then the main part (its note references decide which notes
  // stay), then the rest in the order they were reached.
  const shared: Shared = { removed, counted, noteRefs: new Set() }
  const out = new Map<KeptPart, string>()
  const first: Role[] = ['theme', 'wordStyles', 'sheetStyles', 'sharedStrings']
  const sequence = [
    ...first.flatMap((role) => order.filter((p) => p.role === role)),
    order[0],
    ...order.filter((p) => p !== order[0] && !first.includes(p.role)),
  ]
  const understood = UNDERSTOOD[family.kind]
  for (const part of sequence) {
    // Markup compatibility BEFORE any rule (A9): the rules then see what Word renders.
    const root = compat(parseXml(pkg.get(part.name)!.data), understood, removed)
    const rewritten = rewritePart(root, {
      ...shared,
      role: part.role,
      keptIds: new Set(part.rels.map((r) => r.id)),
    })
    if (part.role === 'theme') shared.theme ??= readTheme(rewritten)
    if (part.role === 'wordStyles') shared.wordStyles = readWordStyles(rewritten)
    if (part.role === 'sheetStyles') shared.sheetStyles = readSheetStyles(rewritten)
    if (part.role === 'sharedStrings') shared.strings = readSharedStrings(rewritten)
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
// Markup compatibility (A9)
// ============================================================================

type Node = XmlElement | string

const elements = (el: XmlElement): XmlElement[] =>
  el.children.filter((c): c is XmlElement => typeof c !== 'string')

const decls = (el: XmlElement): XmlAttribute[] => el.attributes.filter((a) => a.ns === NS.xmlns)

/** The prefix a declaration binds: `xmlns:x` → `x`, `xmlns` → `''`. */
const declared = (a: XmlAttribute): string => (a.prefix === 'xmlns' ? a.name : '')

function withScope(
  scope: ReadonlyMap<string, string>,
  el: XmlElement,
): ReadonlyMap<string, string> {
  const own = decls(el)
  if (own.length === 0) return scope
  const next = new Map(scope)
  for (const d of own) next.set(declared(d), d.value)
  return next
}

/** Reduce a part to what Word renders. The root must itself be understood. */
function compat(root: XmlElement, understood: ReadonlySet<string>, removed: Tally): XmlElement {
  if (!understood.has(root.ns) || root.ns === NS.mc) {
    refuse('content-type', 'a part whose root element the disarm does not understand')
  }
  const scope = new Map([['xml', NS.xml]])
  return compatNode(root, understood, removed, scope)[0] as XmlElement
}

function compatNode(
  el: XmlElement,
  understood: ReadonlySet<string>,
  removed: Tally,
  outer: ReadonlyMap<string, string>,
): Node[] {
  const scope = withScope(outer, el)
  if (el.ns === NS.mc && el.name === 'AlternateContent') {
    const branches = elements(el).filter(
      (c) => c.ns === NS.mc && (c.name === 'Choice' || c.name === 'Fallback'),
    )
    const chosen =
      branches.find((c) => {
        if (c.name !== 'Choice') return false
        const inScope = withScope(scope, c)
        const requires = (attrOf(c.attributes, 'Requires') ?? '').split(/\s+/).filter(Boolean)
        return requires.every((p) => understood.has(inScope.get(p) ?? ''))
      }) ?? branches.find((c) => c.name === 'Fallback')
    removed.add('alternateContent', branches.length - (chosen ? 1 : 0))
    if (!chosen) return []
    const inner = withScope(scope, chosen)
    const kids = chosen.children.flatMap((c) =>
      typeof c === 'string' ? [c] : compatNode(c, understood, removed, inner),
    )
    const branchDecls = decls(chosen)
    const carried = [
      ...branchDecls,
      ...decls(el).filter((d) => !branchDecls.some((b) => declared(b) === declared(d))),
    ]
    return carry(carried, kids)
  }
  if (!understood.has(el.ns) || el.ns === NS.mc) {
    removed.add('unknownMarkup')
    return []
  }
  const children = el.children.flatMap((c) =>
    typeof c === 'string' ? [c] : compatNode(c, understood, removed, scope),
  )
  return [{ ...el, children }]
}

/** The prefixes an element's subtree uses — memoized, so carrying is linear (#482 F8). */
const usedMemo = new WeakMap<XmlElement, ReadonlySet<string>>()

function usedPrefixes(el: XmlElement): ReadonlySet<string> {
  const hit = usedMemo.get(el)
  if (hit) return hit
  const used = new Set<string>([el.prefix])
  for (const a of el.attributes) {
    if (a.ns === NS.xmlns) continue
    if (a.prefix !== '') used.add(a.prefix)
    // Markup-compatibility attributes name prefixes in their values.
    if (a.ns === NS.mc) {
      for (const token of a.value.split(/\s+/)) if (token) used.add(token.split(':')[0])
    }
  }
  for (const c of elements(el)) for (const p of usedPrefixes(c)) used.add(p)
  usedMemo.set(el, used)
  return used
}

/** Splice `children` in place of their parent, carrying only the declarations they use. */
function carry(carried: readonly XmlAttribute[], children: readonly Node[]): Node[] {
  if (carried.length === 0) return [...children]
  return children.map((c) => {
    if (typeof c === 'string') return c
    const own = new Set(decls(c).map(declared))
    const used = usedPrefixes(c)
    const needed = carried.filter((d) => !own.has(declared(d)) && used.has(declared(d)))
    return needed.length === 0 ? c : { ...c, attributes: [...needed, ...c.attributes] }
  })
}

// ============================================================================
// Rewriting one part
// ============================================================================

interface Shared {
  readonly removed: Tally
  readonly counted: Tally
  /** `footnote:<id>` / `endnote:<id>` for every reference the main part kept. */
  readonly noteRefs: Set<string>
  theme?: ReadonlyMap<string, string>
  wordStyles?: WordStyles
  sheetStyles?: SheetStyles
  /** Each shared string's rich-text run colours, by index. */
  strings?: readonly (readonly Color[])[]
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
  /** The enclosing paragraph's `w:shd` fill. */
  readonly pFill?: string
  /** Inside a separator-type note: only separator marks stay (A11). */
  readonly separator?: boolean
}

/** One field stack: its kinds, and how many are `code` — so `inCode` is O(1) (#482 F2a). */
interface FieldStack {
  readonly kinds: ('code' | 'result')[]
  code: number
}

/** Field-code state, per part: one stack over kept content, one over everything. */
interface Fields {
  readonly kept: FieldStack
  readonly all: FieldStack
}

const childEl = (el: XmlElement | undefined, ns: string, name: string): XmlElement | undefined =>
  el ? elements(el).find((c) => is(c, ns, name)) : undefined

/** Every match, not the first: a property given twice is ambiguous, so each one is read. */
const childEls = (el: XmlElement, ns: string, name: string): XmlElement[] =>
  elements(el).filter((c) => is(c, ns, name))

const wVal = (el: XmlElement | undefined): string | undefined =>
  el ? attrOf(el.attributes, 'val', NS.w) : undefined

/** The `w:val` of every `w:<prop>` in every `w:<props>` of `el` (`pPr`/`pStyle`, …). */
const wVals = (el: XmlElement, props: string, prop: string): string[] =>
  childEls(el, NS.w, props)
    .flatMap((p) => childEls(p, NS.w, prop))
    .map(wVal)
    .filter((v): v is string => v !== undefined)

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
  const fields: Fields = { kept: { kinds: [], code: 0 }, all: { kinds: [], code: 0 } }
  const nodes = visit(root, ctx, fields, {})
  // The root itself is never dropped by a rule that drops elements (none
  // targets a part's root), so this is the one element `visit` returned.
  const top = nodes.find((n): n is XmlElement => typeof n !== 'string')
  return top ?? { ...root, children: [] }
}

/** Advance field stacks over one `w:fldChar`; refuse nesting deeper than 256 (A13). */
function fieldChar(el: XmlElement, stacks: readonly FieldStack[]): void {
  const type = attrOf(el.attributes, 'fldCharType', NS.w)
  for (const s of stacks) {
    if (type === 'begin') {
      if (s.kinds.length >= MAX_FIELD_DEPTH) {
        refuse('content-type', `fields nested deeper than ${MAX_FIELD_DEPTH}`)
      }
      s.kinds.push('code')
      s.code++
    } else if (type === 'separate' && s.kinds.length > 0) {
      if (s.kinds[s.kinds.length - 1] === 'code') s.code--
      s.kinds[s.kinds.length - 1] = 'result'
    } else if (type === 'end' && s.kinds.length > 0) {
      if (s.kinds.pop() === 'code') s.code--
    }
  }
}

/** A dropped subtree still moves the "everything" stack. */
function fieldCharsIn(el: XmlElement, fields: Fields): void {
  if (is(el, NS.w, 'fldChar')) fieldChar(el, [fields.all])
  for (const c of elements(el)) fieldCharsIn(c, fields)
}

const inCode = (fields: Fields): boolean => fields.kept.code > 0 || fields.all.code > 0

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

const isRun = (el: XmlElement): boolean => is(el, NS.w, 'r') || is(el, NS.m, 'r')

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
  if (is(el, NS.w, 'tc') && childEl(childEl(el, NS.w, 'tcPr'), NS.w, 'cellDel'))
    return drop('deletions')
  if (isHiddenShape(el)) return drop('hiddenShapes')
  if (isRun(el) && runHidden(el, ctx, scope)) return drop('hiddenRuns')
  if (
    isRun(el) &&
    scope.separator &&
    !childEl(el, NS.w, 'separator') &&
    !childEl(el, NS.w, 'continuationSeparator')
  ) {
    return drop('separatorText')
  }
  if (
    (ctx.role === 'wordFootnotes' || ctx.role === 'wordEndnotes') &&
    (is(el, NS.w, 'footnote') || is(el, NS.w, 'endnote')) &&
    !noteKept(el, ctx)
  ) {
    return drop('unreferencedNotes')
  }

  // ── Scope, then the element itself ─────────────────────────────────────
  let inner = scope
  if (is(el, NS.w, 'p')) {
    inner = { ...scope, pStyles: wVals(el, 'pPr', 'pStyle'), pFill: shdFill(el, 'pPr') }
  } else if (is(el, NS.w, 'tbl')) {
    inner = { ...scope, tblStyles: wVals(el, 'tblPr', 'tblStyle') }
  } else if (is(el, NS.w, 'footnote') || is(el, NS.w, 'endnote')) {
    inner = { ...scope, separator: separatorNote(el) }
  }
  const out = rebuild(el, ctx, fields, inner)

  const unwrapKey = UNWRAP.get(el.ns)?.get(el.name)
  if (unwrapKey !== undefined) {
    if (unwrapKey !== null) ctx.removed.add(unwrapKey)
    const self = out[0] as XmlElement | undefined
    return self ? carry(decls(el), self.children) : []
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
    if (a.ns === NS.r && !ctx.keptIds.has(a.value)) {
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

  const runLike = isRun(el)
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
type Hiding = (typeof HIDING)[number]

function runHidden(run: XmlElement, ctx: Ctx, scope: Scope): boolean {
  const rPrs = childEls(run, NS.w, 'rPr')
  const styled = ctx.wordStyles && levels(ctx.wordStyles, wVals(run, 'rPr', 'rStyle'), scope)
  for (const prop of HIDING) {
    const direct = rPrs.flatMap((r) => childEls(r, NS.w, prop)).map((e) => onOff(e))
    if (direct.includes(true)) return true
    if (direct.length > 0) continue // set false directly: absolute, whatever a style says
    if (styled && styled.hides[prop]) return true
  }
  return false
}

function separatorNote(note: XmlElement): boolean {
  const type = attrOf(note.attributes, 'type', NS.w)
  return type === 'separator' || type === 'continuationSeparator' || type === 'continuationNotice'
}

function noteKept(note: XmlElement, ctx: Ctx): boolean {
  if (separatorNote(note)) return true
  const kind = note.name === 'footnote' ? 'footnote' : 'endnote'
  return ctx.noteRefs.has(`${kind}:${attrOf(note.attributes, 'id', NS.w)}`)
}

function collectNoteRefs(el: XmlElement, refs: Set<string>): void {
  if (is(el, NS.w, 'footnoteReference')) refs.add(`footnote:${attrOf(el.attributes, 'id', NS.w)}`)
  if (is(el, NS.w, 'endnoteReference')) refs.add(`endnote:${attrOf(el.attributes, 'id', NS.w)}`)
  for (const c of elements(el)) collectNoteRefs(c, refs)
}

// ============================================================================
// WordprocessingML styles — each id resolved once, each combination once (#482 F2b, A13)
// ============================================================================

interface RunProps {
  readonly on: ReadonlyMap<string, boolean>
  readonly color?: { readonly val?: string; readonly theme?: string }
  readonly sz?: number
  readonly szCs?: number
}

/** What a style, or a combination of styles, gives a run. */
interface Resolved {
  readonly hides: Readonly<Record<Hiding, boolean>>
  readonly color?: { readonly val?: string; readonly theme?: string }
  readonly sz?: number
  readonly szCs?: number
}

interface StyleDef {
  readonly basedOn?: string
  readonly rPr?: RunProps
  /** A table style's conditional formatting (`w:tblStylePr`). */
  readonly conditional: readonly RunProps[]
}

interface WordStyles {
  /** By lower-cased id; every definition of an id, since a duplicate is ambiguous. */
  readonly byId: ReadonlyMap<string, readonly StyleDef[]>
  readonly docDefaults?: RunProps
  /** Every style claiming `w:default` for its type: two claimants are ambiguous, so both count. */
  readonly defaults: Readonly<Record<StyleType, readonly string[]>>
  /** Per lower-cased id, over its whole `basedOn` chain. */
  readonly resolved: Map<string, Resolved & { readonly depth: number }>
  /** Per (rStyles, pStyles, tblStyles) key. */
  readonly combined: Map<string, Resolved>
}

type StyleType = 'paragraph' | 'character' | 'table'
const STYLE_TYPES: readonly string[] = ['paragraph', 'character', 'table']

function int(v: string | undefined): number | undefined {
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) ? n : undefined
}

function runProps(rPr: XmlElement | undefined): RunProps | undefined {
  if (!rPr) return undefined
  const on = new Map<string, boolean>()
  for (const prop of HIDING) {
    const v = onOff(childEl(rPr, NS.w, prop))
    if (v !== undefined) on.set(prop, v)
  }
  const color = childEl(rPr, NS.w, 'color')
  return {
    on,
    color: color && { val: wVal(color), theme: attrOf(color.attributes, 'themeColor', NS.w) },
    sz: int(wVal(childEl(rPr, NS.w, 'sz'))),
    szCs: int(wVal(childEl(rPr, NS.w, 'szCs'))),
  }
}

function readWordStyles(root: XmlElement): WordStyles {
  const byId = new Map<string, StyleDef[]>()
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
  return { byId, docDefaults, defaults, resolved: new Map(), combined: new Map() }
}

/** Nearest first: the first level that defines it wins. */
function nearest<K extends 'color' | 'sz' | 'szCs'>(
  levels: readonly (Pick<RunProps, K> | undefined)[],
  key: K,
): RunProps[K] {
  for (const l of levels) if (l?.[key] !== undefined) return l[key]
  return undefined
}

/**
 * Resolve one style id over its whole `basedOn` chain, ONCE: an iterative
 * post-order walk that memoizes every id it finishes, so each id costs its
 * own definitions and nothing more. A loop, or a chain deeper than 256,
 * counts as hiding — a bound that cuts a chain never reads as "absent" (A13).
 */
function resolveStyle(styles: WordStyles, id: string): Resolved {
  const start = id.toLowerCase()
  const memo = styles.resolved
  const done = memo.get(start)
  if (done) return done
  const open = new Set<string>([start])
  const bases = (key: string) =>
    (styles.byId.get(key) ?? [])
      .map((d) => d.basedOn?.toLowerCase())
      .filter((b): b is string => b !== undefined)
  const frames: { key: string; bases: string[]; i: number; looped: boolean }[] = [
    { key: start, bases: bases(start), i: 0, looped: false },
  ]
  while (frames.length > 0) {
    const f = frames[frames.length - 1]
    if (f.i < f.bases.length) {
      const b = f.bases[f.i++]
      if (memo.has(b)) continue
      if (open.has(b)) {
        f.looped = true
        continue
      }
      open.add(b)
      frames.push({ key: b, bases: bases(b), i: 0, looped: false })
      continue
    }
    frames.pop()
    open.delete(f.key)
    const defs = styles.byId.get(f.key) ?? []
    const own = defs.flatMap((d) => [d.rPr, ...d.conditional]).filter((p) => p !== undefined)
    const parents = f.bases.map((b) => memo.get(b)).filter((r) => r !== undefined)
    const depth = 1 + Math.max(0, ...parents.map((p) => p.depth))
    const broken = f.looped || depth > MAX_STYLE_DEPTH
    const hides = {} as Record<Hiding, boolean>
    for (const prop of HIDING) {
      hides[prop] =
        broken || own.some((p) => p.on.get(prop) === true) || parents.some((p) => p.hides[prop])
    }
    const direct = defs.map((d) => d.rPr)
    memo.set(f.key, {
      hides,
      depth,
      color: nearest([...direct, ...parents], 'color'),
      sz: nearest([...direct, ...parents], 'sz'),
      szCs: nearest([...direct, ...parents], 'szCs'),
    })
  }
  return memo.get(start)!
}

/** What the styles give a run in this scope — memoized per combination. */
function levels(styles: WordStyles, rStyles: readonly string[], scope: Scope): Resolved {
  const key = `${rStyles.join('\u0000')}|${scope.pStyles?.join('\u0000') ?? '\u0001'}|${scope.tblStyles?.join('\u0000') ?? '\u0001'}`
  const hit = styles.combined.get(key)
  if (hit) return hit
  const named = (ids: readonly string[], type: StyleType) =>
    ids.length > 0 ? ids : styles.defaults[type]
  const parts: Resolved[] = [...named(rStyles, 'character').map((id) => resolveStyle(styles, id))]
  if (scope.pStyles !== undefined) {
    parts.push(...named(scope.pStyles, 'paragraph').map((id) => resolveStyle(styles, id)))
  }
  if (scope.tblStyles !== undefined) {
    parts.push(...named(scope.tblStyles, 'table').map((id) => resolveStyle(styles, id)))
  }
  const base = styles.docDefaults
  const hides = {} as Record<Hiding, boolean>
  for (const prop of HIDING) {
    hides[prop] = parts.some((p) => p.hides[prop]) || base?.on.get(prop) === true
  }
  const all = [...parts, base]
  const combined: Resolved = {
    hides,
    color: nearest(all, 'color'),
    sz: nearest(all, 'sz'),
    szCs: nearest(all, 'szCs'),
  }
  styles.combined.set(key, combined)
  return combined
}

// ============================================================================
// Counted, not dropped (A3, A10)
// ============================================================================

function count(el: XmlElement, ctx: Ctx, scope: Scope): void {
  if (is(el, NS.w, 'r') && hasText(el, NS.w)) countWordRun(el, ctx, scope)
  else if (is(el, NS.a, 'r') && hasText(el, NS.a)) countDrawingRun(el, ctx)
  else if (ctx.role === 'worksheet') countSheet(el, ctx)
  else if (ctx.role === 'slide' && is(el, NS.p, 'spTree')) countOffSlide(el, ctx)
}

const hasText = (run: XmlElement, ns: string): boolean =>
  elements(run).some((c) => is(c, ns, 't') && textOf(c).trim() !== '')

/** A six-digit hex colour, or `undefined`. */
const hex6 = (v: string | undefined): string | undefined =>
  v !== undefined && /^[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : undefined

/** White, or near enough to read as white: every channel ≥ 0xF0 (A10). */
const nearWhite = (hex: string | undefined): boolean =>
  hex !== undefined && [0, 2, 4].every((i) => Number.parseInt(hex.slice(i, i + 2), 16) >= 0xf0)

function shdFill(el: XmlElement, props: string): string | undefined {
  const shd = childEl(childEl(el, NS.w, props), NS.w, 'shd')
  return hex6(shd ? attrOf(shd.attributes, 'fill', NS.w) : undefined)
}

function countWordRun(run: XmlElement, ctx: Ctx, scope: Scope): void {
  const direct = childEls(run, NS.w, 'rPr').map(runProps)
  const styled = ctx.wordStyles
    ? levels(ctx.wordStyles, wVals(run, 'rPr', 'rStyle'), scope)
    : undefined
  const all = [...direct, styled]
  const color = nearest(all, 'color')
  const val = hex6(color?.val)
  const theme = color?.theme
  if (theme === 'background1' || theme === 'light1' || nearWhite(val)) {
    ctx.counted.add('whiteText')
  }
  // A font colour equal to its own or its paragraph's shading (A10).
  const fill = shdFill(run, 'rPr') ?? scope.pFill
  if (val !== undefined && fill !== undefined && val === fill) ctx.counted.add('fontMatchesFill')
  const sz = nearest(all, 'sz')
  const szCs = nearest(all, 'szCs')
  if ((sz !== undefined && sz <= 2) || (szCs !== undefined && szCs <= 2)) {
    ctx.counted.add('tinyText')
  }
}

function countDrawingRun(run: XmlElement, ctx: Ctx): void {
  const rPr = childEl(run, NS.a, 'rPr')
  if (!rPr) return
  const fill = childEl(rPr, NS.a, 'solidFill')
  const clr = fill ? elements(fill)[0] : undefined
  const val = clr ? attrOf(clr.attributes, 'val') : undefined
  const alpha = clr ? int(attrOf(childEl(clr, NS.a, 'alpha')?.attributes ?? [], 'val')) : undefined
  if (
    childEl(rPr, NS.a, 'noFill') ||
    alpha === 0 ||
    (clr !== undefined && is(clr, NS.a, 'srgbClr') && nearWhite(hex6(val))) ||
    (clr !== undefined && is(clr, NS.a, 'schemeClr') && (val === 'bg1' || val === 'lt1'))
  ) {
    ctx.counted.add('whiteText')
  }
  const sz = int(attrOf(rPr.attributes, 'sz'))
  if (sz !== undefined && sz <= 100) ctx.counted.add('tinyText')
}

/** Below these, a row or column is as good as hidden (A10). */
const tiny = (v: string | undefined, under: number): boolean => {
  const n = v === undefined ? Number.NaN : Number.parseFloat(v)
  return Number.isFinite(n) && n < under
}

function countSheet(el: XmlElement, ctx: Ctx): void {
  if (is(el, NS.s, 'row')) {
    if (flag(el, 'hidden')) ctx.counted.add('hiddenRows')
    if (tiny(attrOf(el.attributes, 'ht'), 1)) ctx.counted.add('zeroRowHeights')
  } else if (is(el, NS.s, 'col')) {
    if (flag(el, 'hidden')) ctx.counted.add('hiddenColumns')
    if (tiny(attrOf(el.attributes, 'width'), 0.5)) ctx.counted.add('zeroColumnWidths')
  } else if (is(el, NS.s, 'sheetFormatPr')) {
    if (flag(el, 'zeroHeight')) ctx.counted.add('hiddenRows')
    if (tiny(attrOf(el.attributes, 'defaultRowHeight'), 1)) ctx.counted.add('zeroRowHeights')
    if (tiny(attrOf(el.attributes, 'defaultColWidth'), 0.5)) ctx.counted.add('zeroColumnWidths')
  } else if (is(el, NS.s, 'c') && ctx.sheetStyles) {
    if (!childEl(el, NS.s, 'v') && !childEl(el, NS.s, 'is')) return
    const styles = ctx.sheetStyles
    const xf = styles.xfs[int(attrOf(el.attributes, 's')) ?? 0]
    if (!xf) return
    const format = styles.numFmts.get(xf.numFmtId) ?? ''
    // `;;;` once empty literals, `[…]` codes and whitespace are gone (A10): only
    // `;` left, or nothing left but an empty literal. A bare `[h]` is not hidden.
    const bare = format
      .replace(/""/g, '')
      .replace(/\[[^\]]*\]/g, '')
      .replace(/\s/g, '')
    if (/^;*$/.test(bare) && (bare !== '' || format.includes('""'))) {
      ctx.counted.add('hiddenNumberFormats')
    }
    const fill = styles.fills[xf.fillId]
    const fillRgb = fill === undefined ? undefined : toRgb(fill, ctx)
    const invisible = (c: Color | undefined): boolean => {
      const rgb = c === undefined ? undefined : toRgb(c, ctx)
      return fillRgb === undefined ? nearWhite(rgb) : rgb === fillRgb
    }
    const v = childEl(el, NS.s, 'v')
    const runs =
      attrOf(el.attributes, 't') === 's'
        ? (ctx.strings?.[(v && int(textOf(v))) ?? -1] ?? [])
        : runColors(childEl(el, NS.s, 'is'))
    if (
      /\[(white|color ?2)\]/i.test(format) ||
      invisible(styles.fonts[xf.fontId]) ||
      runs.some(invisible)
    ) {
      ctx.counted.add('fontMatchesFill')
    }
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
    const num = (e: XmlElement | undefined, n: string) => int(attrOf(e?.attributes ?? [], n)) ?? 0
    const [x, y, cx, cy] = [num(off, 'x'), num(off, 'y'), num(ext, 'cx'), num(ext, 'cy')]
    if (x >= size.cx || y >= size.cy || x + cx <= 0 || y + cy <= 0) {
      ctx.counted.add('offSlideShapes')
    }
  }
}

function readSlideSize(root: XmlElement): { cx: number; cy: number } | undefined {
  const sz = childEl(root, NS.p, 'sldSz')
  const cx = int(attrOf(sz?.attributes ?? [], 'cx'))
  const cy = int(attrOf(sz?.attributes ?? [], 'cy'))
  return cx !== undefined && cy !== undefined ? { cx, cy } : undefined
}

// ── SpreadsheetML colours: indexed, theme and tint resolved to RGB (A10) ────

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
  /** The workbook's own palette (`<colors><indexedColors>`), when it has one. */
  readonly palette?: readonly string[]
}

/** Excel's default indexed palette, 0–63, then system foreground and background. */
const PALETTE = (
  '000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF ' +
  '000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF ' +
  '800000 008000 000080 808000 800080 008080 C0C0C0 808080 ' +
  '9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF ' +
  '000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF ' +
  '00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 ' +
  '3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 ' +
  '003366 339966 003300 333300 993300 993366 333399 333333 ' +
  '000000 FFFFFF'
).split(' ')

/** SpreadsheetML's theme index order, and the Office defaults when no theme part is kept. */
const THEME_SLOTS = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4'].concat(
  ['accent5', 'accent6', 'hlink', 'folHlink'],
)
const THEME_DEFAULTS: Readonly<Record<string, string>> = {
  dk1: '000000',
  lt1: 'FFFFFF',
  dk2: '1F497D',
  lt2: 'EEECE1',
  accent1: '4F81BD',
  accent2: 'C0504D',
  accent3: '9BBB59',
  accent4: '8064A2',
  accent5: '4BACC6',
  accent6: 'F79646',
  hlink: '0000FF',
  folHlink: '800080',
}

function readTheme(root: XmlElement): ReadonlyMap<string, string> {
  const scheme = childEl(childEl(root, NS.a, 'themeElements'), NS.a, 'clrScheme')
  const colors = new Map<string, string>()
  for (const slot of scheme ? elements(scheme) : []) {
    const c = elements(slot)[0]
    const v = c && hex6(attrOf(c.attributes, is(c, NS.a, 'sysClr') ? 'lastClr' : 'val'))
    if (slot.ns === NS.a && v) colors.set(slot.name, v)
  }
  return colors
}

function toRgb(c: Color, ctx: Shared): string | undefined {
  let rgb: string | undefined
  if (c.rgb !== undefined) rgb = hex6(c.rgb.slice(-6))
  else if (c.indexed !== undefined) {
    const i = int(c.indexed) ?? -1
    rgb = hex6(ctx.sheetStyles?.palette?.[i] ?? PALETTE[i])
  } else if (c.theme !== undefined) {
    const slot = THEME_SLOTS[int(c.theme) ?? -1]
    rgb = slot && (ctx.theme?.get(slot) ?? THEME_DEFAULTS[slot])
  }
  const tint = Number.parseFloat(c.tint ?? '0')
  return rgb && Number.isFinite(tint) && tint !== 0 ? applyTint(rgb, tint) : rgb
}

/** Excel's tint: lighten or darken the HSL lightness. */
function applyTint(hex: string, tint: number): string {
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (d !== 0) {
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r1, g1, b1] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x]
  return [r1, g1, b1]
    .map((v) =>
      Math.round((v + m) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()
}

function colorOf(el: XmlElement | undefined): Color | undefined {
  if (!el || flag(el, 'auto')) return undefined
  const a = (n: string) => attrOf(el.attributes, n)
  return { rgb: a('rgb'), theme: a('theme'), tint: a('tint'), indexed: a('indexed') }
}

/** The colours of a rich string's runs (`r/rPr/color`). */
function runColors(si: XmlElement | undefined): Color[] {
  if (!si) return []
  return childEls(si, NS.s, 'r')
    .map((r) => colorOf(childEl(childEl(r, NS.s, 'rPr'), NS.s, 'color')))
    .filter((c): c is Color => c !== undefined)
}

function readSharedStrings(root: XmlElement): Color[][] {
  return childEls(root, NS.s, 'si').map(runColors)
}

function readSheetStyles(root: XmlElement): SheetStyles {
  const num = (v: string | undefined) => int(v) ?? 0
  const numFmts = new Map<number, string>()
  for (const f of childEls(childEl(root, NS.s, 'numFmts') ?? root, NS.s, 'numFmt')) {
    numFmts.set(num(attrOf(f.attributes, 'numFmtId')), attrOf(f.attributes, 'formatCode') ?? '')
  }
  const list = (name: string, item: string) => {
    const container = childEl(root, NS.s, name)
    return container ? childEls(container, NS.s, item) : []
  }
  const indexed = childEl(childEl(root, NS.s, 'colors'), NS.s, 'indexedColors')
  return {
    numFmts,
    xfs: list('cellXfs', 'xf').map((x) => ({
      numFmtId: num(attrOf(x.attributes, 'numFmtId')),
      fontId: num(attrOf(x.attributes, 'fontId')),
      fillId: num(attrOf(x.attributes, 'fillId')),
    })),
    fonts: list('fonts', 'font').map((f) => colorOf(childEl(f, NS.s, 'color'))),
    fills: list('fills', 'fill').map((f) => {
      const pattern = childEl(f, NS.s, 'patternFill')
      if (!pattern || attrOf(pattern.attributes, 'patternType') !== 'solid') return undefined
      return colorOf(childEl(pattern, NS.s, 'fgColor'))
    }),
    palette: indexed
      ? childEls(indexed, NS.s, 'rgbColor').map((c) =>
          (attrOf(c.attributes, 'rgb') ?? '').slice(-6),
        )
      : undefined,
  }
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
