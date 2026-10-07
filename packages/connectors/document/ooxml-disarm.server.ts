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
 * — A3, A10): the counted keys are EXACTLY FIVE reasons, the stable set of
 * #492 decision 3 —
 * - `colour-contrast`: the effective-visibility resolver could not prove the
 *   run's text visibly distinct from its background (below, the resolver);
 * - `too-small`: a size-family concealment — text of 1 pt or less after any
 *   scale, a row height under 1, a column width under 0.5;
 * - `hidden-flag`: a visibility flag the disarm counts rather than strips —
 *   hidden rows and columns, a hidden workbook window, a `;;;` number format;
 * - `layout`: a geometry-class carrier — a shape placed off the slide (the
 *   wider layout class stays filed: #485, #487, #488);
 * - `unknown-property`: a rendering property outside the resolver's explicit
 *   allowlist — the fail-closed catch-all, so an unread mechanism lands here,
 *   never in `'removed'`.
 *
 * ## The effective-visibility resolver (#492)
 *
 * ONE computation per run replaces #482's per-property concealment counters
 * (whiteText, fontMatchesFill, tinyText, …) for the colour, fill and size
 * family. Each run's effective foreground colour, background (shading,
 * highlight, cell or shape fill, gradient stops), transparency and size are
 * resolved through its format's FULL cascade —
 * - docx: docDefaults → table, paragraph and character styles → direct, the
 *   theme with tint and shade resolved to RGB, the paragraph, cell, row and
 *   table shading behind the run, and the page background;
 * - pptx: run → paragraph `a:pPr/a:defRPr` → the shape's list style at the
 *   paragraph's level → its LAYOUT's matching placeholder → the MASTER's
 *   placeholder and `txStyles` → the presentation's `defaultTextStyle`, with
 *   the shape's fill (or its `p:style/a:fillRef` through the theme's fill
 *   scheme), the slide, layout and master backgrounds, and the master's
 *   colour map read for resolution;
 * - xlsx: base style → conditional format, with `indexed`, `theme` and tint
 *   resolved to RGB and the number format's colour sections resolved against
 *   the cell's fill.
 *
 * The run counts as concealed UNLESS its text is provably visibly distinct:
 * the resolved foreground must contrast with every colour of the resolved
 * background by at least `MIN_CONTRAST` (WCAG relative luminance), the
 * resolved size must be over 1 pt after any scale, and the drawn fill must
 * exist. The predicate is FAIL-CLOSED (#492 decision 1): any rendering
 * property outside the explicit allowlist the resolver understands makes the
 * run not-provably-visible and lands in `unknown-property` — the A9 posture
 * applied to formatting, so the enumeration can no longer grow one property
 * per review round while an unread mechanism reports `'removed'`.
 *
 * **pptx master, layout and notes-master parts are READ for style
 * resolution and NEVER emitted** (#492 decision 2): the resolver opens them
 * only to work out which list styles, backgrounds and colour maps apply.
 * They stay stripped from the disarmed output — the part allowlist is
 * unchanged — and a slide whose layout relationship points at a missing or
 * mis-typed part counts `unknown-property` rather than silently dropping the
 * inheritance layer.
 *
 * The layout class (off-page anchors, text behind shapes, animations,
 * clipping: #485, #487, #488) and font-level tricks (a font whose glyphs are
 * blank) stay separate counters and files; this closes the colour, fill and
 * size family only. A `w:t` outside any run is dropped: Word never renders it.
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
/** The wps (wordprocessingShape) namespace, for text boxes (#495 F5). */
const WPS = `${MSO}word/2010/wordprocessingShape`

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

/**
 * The counted side of the report: ONLY the five concealment reasons of #492
 * decision 3 can be added — the type is the chokepoint, so no per-property
 * key can come back by mistake.
 */
export type ConcealReason =
  'colour-contrast' | 'too-small' | 'hidden-flag' | 'layout' | 'unknown-property'

class Reasons {
  readonly values: Record<string, number> = {}
  add(reason: ConcealReason, n = 1): void {
    if (n > 0) this.values[reason] = (this.values[reason] ?? 0) + n
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
): {
  bytes: Uint8Array
  removed: Record<string, number>
  counted: Record<string, number>
} {
  const pkg = new Package(entries)
  const removed = new Tally()
  const counted = new Reasons()

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
  const shared: Shared = {
    removed,
    counted,
    noteRefs: new Set(),
    slideStyle: new Map(),
    styleParts: new Map(),
  }
  const out = new Map<KeptPart, string>()
  const first: Role[] = ['theme', 'wordStyles', 'sheetStyles', 'sharedStrings']
  const sequence = [
    ...first.flatMap((role) => order.filter((p) => p.role === role)),
    order[0],
    ...order.filter((p) => p !== order[0] && !first.includes(p.role)),
  ]
  const understood = UNDERSTOOD[family.kind]
  for (const part of sequence) {
    // pptx, BEFORE the rewrite: the slide's (or notes slide's) inheritance is
    // read from its layout, the layout's master, or the notes master — read
    // for resolution only, never emitted (#492 decision 2). The resolver
    // runs inside rewritePart, so the context must be on `shared` first.
    if (part.role === 'slide' || part.role === 'notesSlide') {
      if (part.role === 'slide') {
        resolveSlideStyle(shared, pkg, part.name, understood)
      } else {
        resolveNotesStyle(shared, pkg, part.name, understood)
      }
    }
    // Markup compatibility BEFORE any rule (A9): the rules then see what Word renders.
    const root = compat(parseXml(pkg.get(part.name)!.data), understood, removed)
    const rewritten = rewritePart(root, {
      ...shared,
      role: part.role,
      keptIds: new Set(part.rels.map((r) => r.id)),
      part: part.name,
    })
    if (part.role === 'theme') {
      const theme = readTheme(rewritten)
      shared.theme ??= theme.slots
      shared.fmtFillEls ??= theme.fillEls
      shared.fmtBgFillEls ??= theme.bgFillEls
    }
    if (part.role === 'wordStyles') shared.wordStyles = readWordStyles(rewritten)
    if (part.role === 'sheetStyles') {
      shared.sheetStyles = readSheetStyles(rewritten)
      // A conditional format can turn text invisible, counted for the part
      // without evaluating the rule (#482 delta F5): the dxf's font against
      // its own fill or the base fill, and the base fonts against the dxf's
      // fill — any pair that cannot contrast counts (#492).
      const st = shared.sheetStyles
      const baseFills = st.fills.flatMap((f) => (f ? cellFillColours(f, shared).colours : []))
      const fontRgbs = st.fonts
        .flatMap((f) => (f.color && !f.color.auto ? [toRgb(f.color, shared)] : []))
        .filter((rgb): rgb is string => rgb !== undefined)
      const fails = (fg: string, bg: string): boolean => contrastRatio(fg, bg) < MIN_CONTRAST
      const against = (fills: readonly string[]): readonly string[] =>
        fills.length > 0 ? fills : ['FFFFFF']
      const dxfFont = st.dxfs.some((d) => {
        // Automatic renders black (#495 F1): a black automatic dxf font over a
        // dark fill can hide the base text.
        if (d.font === undefined) return false
        const rgb = d.font.auto ? '000000' : toRgb(d.font, shared)
        if (rgb === undefined) return true // unresolvable: not provably visible
        const own = cellFillColours(d.fill, shared)
        if (own.unknown) return true
        return (
          against(own.colours).some((bg) => fails(rgb, bg)) ||
          against(baseFills).some((bg) => fails(rgb, bg))
        )
      })
      const dxfFill = st.dxfs.some((d) => {
        const fills = cellFillColours(d.fill, shared).colours
        return fills.length > 0 && fontRgbs.some((fg) => fills.some((bg) => fails(fg, bg)))
      })
      if (dxfFont || dxfFill) counted.add('colour-contrast')
    }
    if (part.role === 'sharedStrings') shared.strings = readSharedStrings(rewritten)
    if (part.role === 'wordMain') {
      collectNoteRefs(rewritten, shared.noteRefs)
      // The page background, for runs with no shading of their own (#492).
      const bg = childEl(rewritten, NS.w, 'background')
      shared.pageBg = hex6(attrOf(bg?.attributes ?? [], 'color', NS.w))
    }
    if (part.role === 'slidesMain') {
      shared.slideSize = readSlideSize(rewritten)
      shared.slideDefaults = lstLevels(childEl(rewritten, NS.p, 'defaultTextStyle'))
    }
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
  readonly counted: Reasons
  /** `footnote:<id>` / `endnote:<id>` for every reference the main part kept. */
  readonly noteRefs: Set<string>
  theme?: ReadonlyMap<string, string>
  wordStyles?: WordStyles
  sheetStyles?: SheetStyles
  /** Each shared string's rich-text runs, by index (#492: colours and sizes). */
  strings?: readonly (readonly RichRun[])[]
  slideSize?: { cx: number; cy: number }
  /** The word document's own page background, if any (#492). */
  pageBg?: string
  /** The presentation's `defaultTextStyle`, by level 1–9 (#492). */
  slideDefaults?: ReadonlyMap<number, XmlElement>
  /** Per slide or notes-slide part name, the resolved style inheritance (#492). */
  readonly slideStyle: Map<string, SlideInheritance>
  /** Parsed read-for-resolution style parts, by part name (never emitted). */
  readonly styleParts: Map<string, SlidesStylePart>
  /** The theme's fill schemes, as written (#492: `fillRef`/`bgRef` resolution). */
  fmtFillEls?: readonly XmlElement[]
  fmtBgFillEls?: readonly XmlElement[]
}

interface Ctx extends Shared {
  readonly role: Role
  /** The relationship Ids this part keeps; a reference to any other is dangling. */
  readonly keptIds: ReadonlySet<string>
  /** This part's name, so a slide can fetch its inheritance (#492). */
  readonly part: string
}

interface Scope {
  /** `undefined` outside a paragraph or table; empty for "the default style". */
  readonly pStyles?: readonly string[]
  readonly tblStyles?: readonly string[]
  /** Inside a separator-type note: only separator marks stay (A11). */
  readonly separator?: boolean
  /** The enclosing `p:txBody`'s list-style run defaults, by level 1–9. */
  readonly lstLevels?: ReadonlyMap<number, XmlElement>
  /** The defaults for the enclosing paragraph's own level. */
  readonly defRPr?: XmlElement
  // ── #492: the effective-visibility resolver's scope ────────────────────
  /** The paragraph's own `w:pPr/w:shd` (#492). */
  readonly pShd?: Shd
  /** The enclosing text box's fill, resolved (#495 F5). */
  readonly boxBg?: { readonly unknown: boolean; readonly colours: readonly string[] }
  /** The enclosing DrawingML table cell's (else table's) fill (#495 F3). */
  readonly tblFill?: DFill
  /** The enclosing cell's, row's and table's `w:shd`, nearest first. */
  readonly tblFills?: readonly (readonly Shd[])[]
  /** The paragraph's own `a:pPr/a:defRPr` and its list level (#492). */
  readonly paraDefRPr?: XmlElement
  readonly lvl?: number
  /** The enclosing shape: its placeholder, fill and autofit scale (#492). */
  readonly shape?: {
    readonly ph?: { readonly type?: string; readonly idx?: string }
    readonly fill?: DFill
    readonly fontScale: number
  }
  /** The slide's own background, when it has one (#492). */
  readonly slideBg?: DFill
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
    inner = {
      ...scope,
      pStyles: wVals(el, 'pPr', 'pStyle'),
      pShd: shdOf(childEl(childEl(el, NS.w, 'pPr'), NS.w, 'shd')),
    }
  } else if (is(el, NS.w, 'tbl')) {
    inner = {
      ...scope,
      tblStyles: wVals(el, 'tblPr', 'tblStyle'),
      // The table's shading is the farthest background level of them all.
      tblFills: [shdLevel(el, 'tblPr'), ...(scope.tblFills ?? [])],
    }
  } else if (is(el, NS.w, 'tr')) {
    inner = { ...scope, tblFills: [shdLevel(el, 'trPr'), ...(scope.tblFills ?? [])] }
  } else if (is(el, NS.w, 'tc')) {
    inner = { ...scope, tblFills: [shdLevel(el, 'tcPr'), ...(scope.tblFills ?? [])] }
  } else if (is(el, NS.w, 'footnote') || is(el, NS.w, 'endnote')) {
    inner = { ...scope, separator: separatorNote(el) }
  } else if (is(el, NS.p, 'sld') || is(el, NS.p, 'notes')) {
    // The part's own background, when it names one (#492).
    const bg = childEl(childEl(el, NS.p, 'cSld'), NS.p, 'bg')
    const bgEl = bg ? (childEl(bg, NS.p, 'bgPr') ?? childEl(bg, NS.p, 'bgRef')) : undefined
    if (bgEl !== undefined) {
      inner = {
        ...scope,
        slideBg: bgFill(bgEl, { theme: ctx.theme, clrMap: slideInheritanceOf(ctx).clrMap }, ctx),
      }
    }
  } else if (
    is(el, NS.p, 'sp') ||
    is(el, NS.p, 'pic') ||
    is(el, NS.p, 'graphicFrame') ||
    is(el, NS.p, 'cxnSp')
  ) {
    // The shape: its placeholder, and the fill its text sits on — its own,
    // else its `p:style/a:fillRef` through the theme's fill scheme (#492).
    const s: Scheme = { theme: ctx.theme, clrMap: slideInheritanceOf(ctx).clrMap }
    let fill = drawingFill(childEl(el, NS.p, 'spPr'), s)
    if (fill.kind === 'absent') {
      const fillRef = childEl(childEl(el, NS.p, 'style'), NS.a, 'fillRef')
      const idx = int(attrOf(fillRef?.attributes ?? [], 'idx')) ?? 0
      fill = fillRef ? refFill(ctx.fmtFillEls, idx, fillRef, s) : FILL_ABSENT
    }
    inner = {
      ...scope,
      shape: {
        ph: phOf(el),
        fill: fill.kind === 'absent' ? undefined : fill,
        fontScale: 1,
      },
    }
  } else if (is(el, WPS, 'wsp')) {
    // A docx text box: its fill is a background behind the run, over the
    // paragraph shading and the table shading beneath it (#495 F5).
    const s: Scheme = { theme: ctx.theme }
    const fill = drawingFill(childEl(el, WPS, 'spPr'), s)
    if (fill.kind !== 'absent' && fill.kind !== 'none') {
      const bg = bgColours(fill)
      inner = { ...scope, boxBg: { unknown: bg.unknown, colours: bg.colours ?? [] } }
    }
  } else if (is(el, NS.a, 'tbl')) {
    // A DrawingML table: its own fill stands behind every cell (#495 F3).
    const s: Scheme = { theme: ctx.theme, clrMap: slideInheritanceOf(ctx).clrMap }
    const fill = drawingFill(childEl(el, NS.a, 'tblPr'), s)
    inner = { ...scope, tblFill: fill.kind === 'absent' ? undefined : fill }
  } else if (is(el, NS.a, 'tc')) {
    // A cell's own fill covers the table's (#495 F3).
    const s: Scheme = { theme: ctx.theme, clrMap: slideInheritanceOf(ctx).clrMap }
    const fill = drawingFill(childEl(el, NS.a, 'tcPr'), s)
    if (fill.kind !== 'absent') inner = { ...scope, tblFill: fill }
  } else if (is(el, NS.p, 'txBody')) {
    const levels = lstLevels(childEl(el, NS.a, 'lstStyle'))
    // The body's autofit scale composes with every run's size (#492).
    const auto = childEl(childEl(el, NS.a, 'bodyPr'), NS.a, 'normAutofit')
    const fontScale = pct(attrOf(auto?.attributes ?? [], 'fontScale')) ?? 1
    inner = {
      ...scope,
      lstLevels: levels,
      defRPr: undefined,
      shape: scope.shape ? { ...scope.shape, fontScale } : undefined,
    }
  } else if (is(el, NS.a, 'p')) {
    // The paragraph's declared level picks its list-style defaults (#482
    // re-check F2); its own `a:defRPr` is the next-nearest level (#492).
    const pPr = childEl(el, NS.a, 'pPr')
    const lvl = int(attrOf(pPr?.attributes ?? [], 'lvl')) ?? 0
    inner = {
      ...scope,
      defRPr: scope.lstLevels?.get(lvl + 1),
      paraDefRPr: childEl(pPr, NS.a, 'defRPr'),
      lvl,
    }
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
    // A `w:t` outside any run: Word never renders it (#482 delta F7).
    if (!runLike && is(c, NS.w, 't')) {
      ctx.removed.add('strayText')
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

/** A `w:shd` as written: `val` names the pattern, `color` and `fill` its colours. */
interface Shd {
  readonly val?: string
  readonly color?: string
  readonly fill?: string
  /** The theme-named pattern colour, with its tint and shade (#495 F6). */
  readonly themeColor?: string
  readonly themeTint?: string
  readonly themeShade?: string
  /** The theme-named fill, with its tint and shade (#495 F6). */
  readonly themeFill?: string
  readonly themeFillTint?: string
  readonly themeFillShade?: string
}

/** `w:color` as written, tint and shade included (#492). */
interface WordColor {
  readonly val?: string
  readonly theme?: string
  readonly themeTint?: string
  readonly themeShade?: string
}

interface RunProps {
  readonly on: ReadonlyMap<string, boolean>
  readonly color?: WordColor
  readonly sz?: number
  readonly szCs?: number
  /** `w:highlight/@w:val` (#482 re-check F1). */
  readonly highlight?: string
  /** `w:shd` on the run's own properties (#492). */
  readonly shd?: Shd
  /** `w:w` character scale, in percent (#492). */
  readonly scale?: number
  /** `w:position`, raised or lowered text in half-points (#492). */
  readonly position?: number
  /** `w:vertAlign`: the reduced size of super/subscript, when it applies. */
  readonly vertScale?: number
  /** Rendering properties the resolver does not model, by local name (#492). */
  readonly unknown: ReadonlySet<string>
}

/** What a style, or a combination of styles, gives a run. */
interface Resolved {
  readonly hides: Readonly<Record<Hiding, boolean>>
  readonly color?: WordColor
  readonly sz?: number
  readonly szCs?: number
  readonly highlight?: string
  readonly shd?: Shd
  readonly scale?: number
  readonly position?: number
  readonly vertScale?: number
  readonly unknown: ReadonlySet<string>
  /** The style's own `w:pPr/w:shd` — a background behind the run (#492). */
  readonly pShd?: Shd
  /** Its conditional formattings' `w:pPr/w:shd`s (#492). */
  readonly conditionalShd: readonly Shd[]
}

interface StyleDef {
  readonly basedOn?: string
  readonly rPr?: RunProps
  /** The style's own `w:pPr/w:shd`, if any. */
  readonly pShd?: Shd
  /** A table style's conditional formatting (`w:tblStylePr`). */
  readonly conditional: readonly RunProps[]
  /** The conditional formattings' `w:pPr/w:shd`s. */
  readonly conditionalShd: readonly Shd[]
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

/**
 * The run-property children the resolver READS are handled where they are
 * read. These are the ones it can PROVE unable to conceal text (#492): the
 * decorations draw the glyphs at the resolved colour and size; `vertAlign`
 * and `spacing` change only position and advance; `rFonts` names a font whose
 * glyph coverage is a separate, filed class (font-level tricks stay out).
 * `w:vanish` and its kin are hiding flags — the drop rule owns them. Anything
 * else on a run's properties is un-modelled, so it lands in `unknown-property`.
 */
const WORD_INERT: ReadonlySet<string> = new Set([
  'rStyle',
  // Typography extensions (w14/w15/…): ligatures and stylistic sets draw the
  // same glyphs at the same size and colour (#492, from the benign corpus).
  'http://schemas.microsoft.com/office/word/2010/wordml:ligatures',
  'http://schemas.microsoft.com/office/word/2010/wordml:stylisticSets',
  'rFonts',
  'b',
  'bCs',
  'i',
  'iCs',
  'caps',
  'smallCaps',
  'strike',
  'dstrike',
  'outline',
  'shadow',
  'emboss',
  'imprint',
  'noProof',
  'snapToGrid',
  'u',
  'uCs',
  'effect',
  'bdr',
  'kern',
  'vertAlign',
  'lang',
  'eastAsianLayout',
  'rtl',
  'cs',
  'em',
  'oMath',
  'fitText',
  'spacing',
  ...HIDING,
])
// w:vertAlign is READ, not inert: superscript and subscript render at a
// reduced size, which composes with the resolved size like w:w (#495 review).
const VERT_ALIGN_SCALE = 0.65

/** The `w:rPr` children the resolver reads for visibility (#492, #495). */
const WORD_READ: ReadonlySet<string> = new Set([
  'color',
  'sz',
  'szCs',
  'highlight',
  'shd',
  'w',
  'position',
  'vertAlign',
])

/**
 * A raised or lowered run within this many half-points (15 pt) still draws
 * its glyphs on the page, so it cannot conceal; beyond it the glyphs leave
 * the line, which is the layout class (#485's family) and counts `layout`.
 */
const MAX_POSITION = 300

/** One element's `w:<props>/w:shd` copies, as one background level. */
const shdLevel = (el: XmlElement, props: string): readonly Shd[] =>
  childEls(el, NS.w, props).flatMap((p) => childEls(p, NS.w, 'shd').map(shdOf).filter(isShd))

const isShd = (s: Shd | undefined): s is Shd => s !== undefined

/** A `w:shd` element, as far as its pattern is modelled. */
const shdOf = (shd: XmlElement | undefined): Shd | undefined =>
  shd && {
    val: attrOf(shd.attributes, 'val', NS.w),
    color: attrOf(shd.attributes, 'color', NS.w),
    fill: attrOf(shd.attributes, 'fill', NS.w),
    themeColor: attrOf(shd.attributes, 'themeColor', NS.w),
    themeTint: attrOf(shd.attributes, 'themeTint', NS.w),
    themeShade: attrOf(shd.attributes, 'themeShade', NS.w),
    themeFill: attrOf(shd.attributes, 'themeFill', NS.w),
    themeFillTint: attrOf(shd.attributes, 'themeFillTint', NS.w),
    themeFillShade: attrOf(shd.attributes, 'themeFillShade', NS.w),
  }

function runProps(rPr: XmlElement | undefined): RunProps | undefined {
  if (!rPr) return undefined
  const on = new Map<string, boolean>()
  for (const prop of HIDING) {
    const v = onOff(childEl(rPr, NS.w, prop))
    if (v !== undefined) on.set(prop, v)
  }
  const color = childEl(rPr, NS.w, 'color')
  const unknown = new Set<string>()
  let shd: Shd | undefined
  let scale: number | undefined
  let position: number | undefined
  let vertScale: number | undefined
  // Every child is a rendering property: one the resolver neither reads nor
  // can prove inert makes the run not-provably-visible (#492, fail-closed).
  for (const c of elements(rPr)) {
    // A property outside the wordprocessingml namespace keys by namespace and
    // local name, so the typography extensions above can be inert precisely.
    const key = c.ns === NS.w ? c.name : `${c.ns}:${c.name}`
    if (WORD_READ.has(key)) {
      if (c.name === 'shd') shd = shdOf(c)
      else if (c.name === 'w') scale = int(wVal(c))
      else if (c.name === 'position') position = int(wVal(c))
      else if (c.name === 'vertAlign') {
        // Superscript and subscript render the glyph at a reduced size.
        const v = wVal(c)?.toLowerCase()
        vertScale = v === 'superscript' || v === 'subscript' ? VERT_ALIGN_SCALE : undefined
      }
      continue
    }
    if (!WORD_INERT.has(key)) unknown.add(key)
  }
  return {
    on,
    color: color && {
      val: wVal(color),
      theme: attrOf(color.attributes, 'themeColor', NS.w),
      themeTint: attrOf(color.attributes, 'themeTint', NS.w),
      themeShade: attrOf(color.attributes, 'themeShade', NS.w),
    },
    sz: int(wVal(childEl(rPr, NS.w, 'sz'))),
    szCs: int(wVal(childEl(rPr, NS.w, 'szCs'))),
    highlight: wVal(childEl(rPr, NS.w, 'highlight')),
    shd,
    scale,
    position,
    vertScale,
    unknown,
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
        pShd: shdOf(childEl(childEl(s, NS.w, 'pPr'), NS.w, 'shd')),
        conditional: elements(s)
          .filter((c) => is(c, NS.w, 'tblStylePr'))
          .map((c) => runProps(childEl(c, NS.w, 'rPr')))
          .filter((p): p is RunProps => p !== undefined),
        conditionalShd: elements(s)
          .filter((c) => is(c, NS.w, 'tblStylePr'))
          .map((c) => shdOf(childEl(childEl(c, NS.w, 'pPr'), NS.w, 'shd')))
          .filter((s2): s2 is Shd => s2 !== undefined),
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
function nearest<
  K extends 'color' | 'sz' | 'szCs' | 'highlight' | 'shd' | 'scale' | 'position' | 'vertScale',
>(levels: readonly (Pick<RunProps, K> | undefined)[], key: K): RunProps[K] {
  for (const l of levels) if (l?.[key] !== undefined) return l[key]
  return undefined
}

/**
 * The union of every level's un-modelled properties (#492): an inherited
 * un-modelled property applies to the run just as a direct one does.
 */
const unknownOf = (
  levels: readonly (Pick<RunProps, 'unknown'> | undefined)[],
): ReadonlySet<string> => {
  const all = new Set<string>()
  for (const l of levels) for (const u of l?.unknown ?? []) all.add(u)
  return all
}

/** Nearest over a chain of paragraph shadings. */
function nearestShd(shds: readonly (Shd | undefined)[]): Shd | undefined {
  for (const s of shds) if (s !== undefined) return s
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
      highlight: nearest([...direct, ...parents], 'highlight'),
      shd: nearest([...direct, ...parents], 'shd'),
      scale: nearest([...direct, ...parents], 'scale'),
      position: nearest([...direct, ...parents], 'position'),
      vertScale: nearest([...direct, ...parents], 'vertScale'),
      unknown: unknownOf([...own, ...parents]),
      pShd: nearestShd([...defs.map((d) => d.pShd), ...parents.map((p) => p.pShd)]),
      conditionalShd: [
        ...defs.flatMap((d) => d.conditionalShd),
        ...parents.flatMap((p) => p.conditionalShd),
      ],
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
    highlight: nearest(all, 'highlight'),
    shd: nearest(all, 'shd'),
    scale: nearest(all, 'scale'),
    position: nearest(all, 'position'),
    vertScale: nearest(all, 'vertScale'),
    unknown: unknownOf(all),
    pShd: nearestShd(parts.map((p) => p.pShd)),
    conditionalShd: parts.flatMap((p) => p.conditionalShd),
  }
  styles.combined.set(key, combined)
  return combined
}

// ============================================================================
// Effective visibility (#492) — one fail-closed resolver for the colour,
// fill and size family
// ============================================================================

/**
 * A run is visibly distinct only if its foreground contrasts with every
 * colour of its effective background by at least this ratio (WCAG relative
 * luminance). 1.4 keeps grey footnotes (595959 ≈ 7.0), coloured headings
 * (4F81BD ≈ 4.9), mid-grey text (A9A9A9 ≈ 2.1), the mid-grey-on-pale-fill
 * headers real spreadsheets carry (BFBFBF/DCE6F1 ≈ 1.46) and #D9D9D9 text
 * (1.412) visibly distinct, while white (1.0), near-white FFFFFE (1.0) and
 * pale greys (E0E0E0, 1.32) do not pass — the cut sits between them, at the
 * greys around #DCDCDC. The threshold is measured against a benign corpus of
 * ordinary Office files under the owner's ~2% budget (#492 decision 1); the
 * PR reports the rate.
 */
const MIN_CONTRAST = 1.4

const channel = (hex: string, i: number): number => {
  const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance. */
const luminance = (hex: string): number =>
  0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 2) + 0.0722 * channel(hex, 4)

/** WCAG contrast ratio between two colours, at least 1. */
export const contrastRatio = (a: string, b: string): number => {
  const [l1, l2] = [luminance(a), luminance(b)]
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

/** Mix a hex colour toward white or black by a fraction (0–1). */
function mix(hex: string, toward: 'white' | 'black', amount: number): string {
  const t = toward === 'white' ? 255 : 0
  return [0, 2, 4]
    .map((i) =>
      Math.round(Number.parseInt(hex.slice(i, i + 2), 16) * (1 - amount) + t * amount)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()
}

/** A six-digit hex colour, or `undefined`. */
const hex6 = (v: string | undefined): string | undefined =>
  v !== undefined && /^[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : undefined

/** `w:color`'s value or a shading colour, with `auto` and 8-digit forms read. */
const solid = (v: string | undefined): string | undefined =>
  v === undefined || v.toLowerCase() === 'auto' ? undefined : hex6(v.length > 6 ? v.slice(-6) : v)

/** A resolved foreground: a colour, or un-modelled. Automatic is a colour. */
type Fg = { kind: 'rgb'; rgb: string } | { kind: 'unknown' }

/** `w:themeColor`'s values, mapped to the theme part's slots. */
const WORD_THEME: Readonly<Record<string, string>> = {
  text1: 'dk1',
  dark1: 'dk1',
  background1: 'lt1',
  light1: 'lt1',
  text2: 'dk2',
  dark2: 'dk2',
  background2: 'lt2',
  light2: 'lt2',
  hyperlink: 'hlink',
  followedhyperlink: 'folHlink',
  accent1: 'accent1',
  accent2: 'accent2',
  accent3: 'accent3',
  accent4: 'accent4',
  accent5: 'accent5',
  accent6: 'accent6',
}

/** A `themeTint`/`themeShade` value: a hex percentage of white or black. */
const frac = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined
  const n = Number.parseInt(v, 16)
  return Number.isFinite(n) ? n / 255 : undefined
}

/** A theme slot with its tint and shade, resolved through the theme part. */
function themeColour(
  slot: string,
  tintHex: string | undefined,
  shadeHex: string | undefined,
  ctx: Shared,
): string | undefined {
  const base = ctx.theme?.get(slot) ?? THEME_DEFAULTS[slot]
  if (base === undefined) return undefined
  let rgb = base
  const tint = frac(tintHex)
  const shade = frac(shadeHex)
  if (tint !== undefined) rgb = mix(rgb, 'white', tint)
  if (shade !== undefined) rgb = mix(rgb, 'black', shade)
  return rgb
}

/**
 * `w:color` resolved to RGB. Word's Automatic — an absent colour, or `auto` —
 * follows the theme's text colour and does NOT adapt to shading or fills
 * (#495 review finding 1): it resolves like any other foreground and takes
 * the contrast check.
 */
function wordFg(c: WordColor | undefined, ctx: Shared): Fg {
  const automatic = (): Fg => ({
    kind: 'rgb',
    rgb: themeColour('dk1', undefined, undefined, ctx) ?? '000000',
  })
  if (!c || (c.val === undefined && c.theme === undefined)) return automatic()
  if (c.theme !== undefined) {
    const slot = WORD_THEME[c.theme.toLowerCase()]
    if (slot === undefined) return { kind: 'unknown' }
    const rgb = themeColour(slot, c.themeTint, c.themeShade, ctx)
    return rgb === undefined ? { kind: 'unknown' } : { kind: 'rgb', rgb }
  }
  if (c.val === undefined) return { kind: 'unknown' }
  if (c.val.toLowerCase() === 'auto') return automatic()
  const rgb = solid(c.val)
  return rgb === undefined ? { kind: 'unknown' } : { kind: 'rgb', rgb }
}

/** The `w:shd` pattern values the resolver models; anything else is unknown. */
const WORD_SHD: ReadonlySet<string> = new Set(
  [
    'pct5',
    'pct10',
    'pct12',
    'pct15',
    'pct20',
    'pct25',
    'pct30',
    'pct35',
    'pct40',
    'pct45',
    'pct50',
    'pct55',
    'pct60',
    'pct65',
    'pct70',
    'pct75',
    'pct80',
    'pct85',
    'pct90',
    'pct95',
    'diagcross',
    'diagstripe',
    'horzcross',
    'horzstripe',
    'ltdash',
    'ltgrid',
    'lttri',
    'thickdiagcross',
    'thickhorzcross',
    'thickvertcross',
    'thindiagcross',
    'thindiagstripe',
    'thinhorzcross',
    'thinhorzstripe',
    'thinreversediagstripe',
    'thinvertstripe',
    'vertstripe',
  ].map((v) => v.toLowerCase()),
)

/** What a `w:shd` paints: nothing, one or two colours, or an un-modelled pattern. */
type ShdColours =
  { kind: 'none' } | { kind: 'colours'; readonly colours: readonly string[] } | { kind: 'unknown' }

function shdColours(shd: Shd | undefined, ctx: Shared): ShdColours {
  if (shd === undefined) return { kind: 'none' }
  const val = shd.val?.toLowerCase()
  // No `w:val` is the default, clear: the fill paints (real documents write
  // cell shading with no `w:val` at all). Only `nil` is nothing.
  if (val === 'nil') return { kind: 'none' }
  // A colour the shading names: the literal, else the theme-named one
  // (#495 F6). `auto` reads as its conventional colour in a pattern.
  const colour = (
    literal: string | undefined,
    themeName: string | undefined,
    tint: string | undefined,
    shade: string | undefined,
    autoIs: string | undefined,
  ): { rgb?: string; unknown?: boolean } => {
    const lit = solid(literal)
    if (lit !== undefined) return { rgb: lit }
    if (themeName === undefined) return autoIs === undefined ? {} : { rgb: autoIs }
    const slot = WORD_THEME[themeName.toLowerCase()]
    if (slot === undefined) return { unknown: true }
    const rgb = themeColour(slot, tint, shade, ctx)
    return rgb === undefined ? { unknown: true } : { rgb }
  }
  if (val === undefined || val === 'clear') {
    const c = colour(shd.fill, shd.themeFill, shd.themeFillTint, shd.themeFillShade, undefined)
    if (c.unknown) return { kind: 'unknown' }
    return c.rgb === undefined ? { kind: 'none' } : { kind: 'colours', colours: [c.rgb] }
  }
  if (val === 'solid') {
    // Word renders a solid shading's PATTERN colour: absent or `auto` is
    // black, never the fill (#495 F7).
    const c = colour(shd.color, shd.themeColor, shd.themeTint, shd.themeShade, '000000')
    if (c.unknown) return { kind: 'unknown' }
    return { kind: 'colours', colours: [c.rgb!] }
  }
  if (WORD_SHD.has(val)) {
    // A pattern: `auto` reads as its conventional colour — black dots on white.
    const fg = colour(shd.color, shd.themeColor, shd.themeTint, shd.themeShade, '000000')
    const bg = colour(shd.fill, shd.themeFill, shd.themeFillTint, shd.themeFillShade, 'FFFFFF')
    if (fg.unknown || bg.unknown) return { kind: 'unknown' }
    return { kind: 'colours', colours: [fg.rgb ?? '000000', bg.rgb ?? 'FFFFFF'] }
  }
  return { kind: 'unknown' }
}

/**
 * The background behind a word run: the first opaque shading level wins —
 * direct run, the styles, the paragraph, the paragraph style, then the cell,
 * row and table — with an active table style's conditional formattings
 * behind all of them, and the page background last.
 */
function wordBackgrounds(
  run: XmlElement,
  styled: Resolved | undefined,
  scope: Scope,
  ctx: Ctx,
): { readonly unknown: boolean; readonly colours: readonly string[] } {
  const levels: readonly (readonly Shd[])[] = [
    childEls(run, NS.w, 'rPr').flatMap((r) => childEls(r, NS.w, 'shd').map(shdOf).filter(isShd)),
    [styled?.shd, scope.pShd, styled?.pShd].filter(isShd),
  ]
  for (const level of levels) {
    let colours: readonly string[] | undefined
    for (const s of level) {
      const bg = shdColours(s, ctx)
      if (bg.kind === 'unknown') return { unknown: true, colours: [] }
      if (bg.kind === 'colours' && colours === undefined) colours = bg.colours
    }
    if (colours !== undefined) return { unknown: false, colours }
  }
  // The text box the run lives in, over the table shading beneath it
  // (#495 F5): an opaque box fill is the background, a transparent one falls
  // through to the table levels.
  if (scope.boxBg !== undefined) {
    if (scope.boxBg.unknown) return { unknown: true, colours: [] }
    if (scope.boxBg.colours.length > 0) return { unknown: false, colours: scope.boxBg.colours }
  }
  for (const level of (scope.tblFills ?? []) as readonly (readonly Shd[])[]) {
    let colours: readonly string[] | undefined
    for (const s of level) {
      const bg = shdColours(s, ctx)
      if (bg.kind === 'unknown') return { unknown: true, colours: [] }
      if (bg.kind === 'colours' && colours === undefined) colours = bg.colours
    }
    if (colours !== undefined) return { unknown: false, colours }
  }
  // Nothing opaque: the conditional formattings of an active table style can
  // still paint the band, so each of them is checked, else the page.
  const conditional: string[] = []
  for (const s of styled?.conditionalShd ?? []) {
    const bg = shdColours(s, ctx)
    if (bg.kind === 'unknown') return { unknown: true, colours: [] }
    if (bg.kind === 'colours') conditional.push(...bg.colours)
  }
  return {
    unknown: false,
    colours: conditional.length > 0 ? conditional : [ctx.pageBg ?? 'FFFFFF'],
  }
}

/** `w:highlight`'s fixed named palette. */
const HIGHLIGHT: Readonly<Record<string, string>> = {
  black: '000000',
  blue: '0000FF',
  cyan: '00FFFF',
  green: '00FF00',
  magenta: 'FF00FF',
  red: 'FF0000',
  yellow: 'FFFF00',
  white: 'FFFFFF',
  darkblue: '000080',
  darkcyan: '008080',
  darkgreen: '008000',
  darkmagenta: '800080',
  darkred: '800000',
  darkyellow: '808000',
  darkgray: '808080',
  lightgray: 'C0C0C0',
}

const hasText = (run: XmlElement, ns: string): boolean =>
  elements(run).some((c) => is(c, ns, 't') && textOf(c).trim() !== '')

/**
 * ONE computation per word run (#492): resolve the effective foreground,
 * background and size through the whole cascade, then count the run as
 * concealed unless its text is provably visibly distinct. Fail-closed: an
 * un-modelled rendering property anywhere in the cascade, or a colour the
 * resolver cannot resolve, counts `unknown-property` instead of reading as
 * visible.
 */
function countWordRun(run: XmlElement, ctx: Ctx, scope: Scope): void {
  const direct = childEls(run, NS.w, 'rPr').map(runProps)
  const styled = ctx.wordStyles
    ? levels(ctx.wordStyles, wVals(run, 'rPr', 'rStyle'), scope)
    : undefined
  const all = [...direct, styled]
  if (unknownOf(all).size > 0) ctx.counted.add('unknown-property')

  const fg = wordFg(nearest(all, 'color'), ctx)
  if (fg.kind === 'unknown') ctx.counted.add('unknown-property')
  // The background, resolved whatever the foreground: an un-modelled
  // background mechanism is not provably visible even for automatic text.
  const highlight = nearest(all, 'highlight')
  let unknown = false
  let colours: readonly string[]
  if (highlight !== undefined && highlight.toLowerCase() !== 'none') {
    // The highlight, when one is resolved, is drawn over every shading level.
    const lit = HIGHLIGHT[highlight.toLowerCase()]
    if (lit === undefined) {
      unknown = true
      colours = []
    } else colours = [lit]
  } else {
    const bg = wordBackgrounds(run, styled, scope, ctx)
    unknown = bg.unknown
    colours = bg.colours
  }
  if (unknown) {
    ctx.counted.add('unknown-property')
  } else if (fg.kind === 'rgb' && colours.some((bg) => contrastRatio(fg.rgb, bg) < MIN_CONTRAST)) {
    ctx.counted.add('colour-contrast')
  }

  // The size family: the smaller of sz and szCs, scaled by w:w (#486 closes
  // here), with Word's built-in 10 pt standing in when nothing defines one.
  const sz = nearest(all, 'sz')
  const szCs = nearest(all, 'szCs')
  const scale = nearest(all, 'scale')
  const halfPt =
    sz !== undefined || szCs !== undefined ? Math.min(sz ?? 200, szCs ?? 200) : undefined
  const pt = ((halfPt ?? 20) / 2) * ((scale ?? 100) / 100) * (nearest(all, 'vertScale') ?? 1)
  if (pt <= 1) ctx.counted.add('too-small')

  // A raised or lowered run beyond the bound has left the line: the layout
  // class, of which #485 is the filed remainder (#492).
  const position = nearest(all, 'position')
  if (position !== undefined && (position > MAX_POSITION || position < -MAX_POSITION)) {
    ctx.counted.add('layout')
  }
}

// ── DrawingML colours and fills ─────────────────────────────────────────────

/** A DrawingML colour, resolved as far as the resolver models it. */
interface DClr {
  readonly rgb?: string
  /** Fully transparent: an alpha of 0. */
  readonly transparent?: boolean
  readonly unknown?: boolean
}

/** A DrawingML fill; `absent` means "not set here — inherit". */
type DFill =
  | { kind: 'absent' }
  | { kind: 'none' }
  | { kind: 'solid'; readonly clr: DClr }
  | { kind: 'grad'; readonly stops: readonly DClr[] }
  | { kind: 'pattern'; readonly fg: DClr; readonly bg: DClr }
  | { kind: 'unknown' }

const FILL_ABSENT: DFill = { kind: 'absent' }

/** What a scheme name maps to when no colour map applies. */
const SCHEME_DEFAULT: Readonly<Record<string, string>> = {
  bg1: 'lt1',
  lt1: 'lt1',
  tx1: 'dk1',
  dk1: 'dk1',
  bg2: 'lt2',
  lt2: 'lt2',
  tx2: 'dk2',
  dk2: 'dk2',
  accent1: 'accent1',
  accent2: 'accent2',
  accent3: 'accent3',
  accent4: 'accent4',
  accent5: 'accent5',
  accent6: 'accent6',
  hlink: 'hlink',
  folhlink: 'folhlink',
  phclr: 'phClr',
}

/** What a run's scheme resolution needs: the theme, a colour map, `phClr`. */
interface Scheme {
  readonly theme?: ReadonlyMap<string, string>
  readonly clrMap?: ReadonlyMap<string, string>
  readonly phClr?: DClr
}

/** rgb ↔ HSL, for the `lumMod`/`lumOff`/`satMod` transforms. */
function hslOf(hex: string): [number, number, number] {
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (d !== 0) {
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return [h, s, l]
}

function hexOfHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] =
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
  return [r, g, b]
    .map((v) =>
      Math.round((v + m) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()
}

const pct = (v: string | undefined): number | undefined => {
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) ? n / 100000 : undefined
}

/** One DrawingML colour element, with its transforms, resolved to RGB. */
function drawingClr(el: XmlElement | undefined, s: Scheme): DClr {
  if (!el) return { unknown: true }
  let rgb: string | undefined
  if (is(el, NS.a, 'srgbClr')) rgb = hex6(attrOf(el.attributes, 'val'))
  else if (is(el, NS.a, 'schemeClr')) {
    const name = attrOf(el.attributes, 'val')?.toLowerCase()
    if (name === undefined) return { unknown: true }
    if (name === 'phclr') {
      const ph = s.phClr
      if (ph === undefined) return { unknown: true }
      if (ph.rgb === undefined) return { transparent: ph.transparent, unknown: ph.unknown }
      rgb = ph.rgb
    } else {
      const slot = s.clrMap?.get(name) ?? SCHEME_DEFAULT[name]
      if (slot === undefined) return { unknown: true }
      rgb = s.theme?.get(slot) ?? THEME_DEFAULTS[slot]
      if (rgb === undefined) return { unknown: true }
    }
  } else if (is(el, NS.a, 'sysClr')) {
    const val = attrOf(el.attributes, 'val')
    rgb = hex6(attrOf(el.attributes, 'lastClr')) ?? (val === 'window' ? 'FFFFFF' : undefined)
    if (rgb === undefined) return { unknown: true }
  } else return { unknown: true }
  if (rgb === undefined) return { unknown: true }

  // The transforms, in order; one the resolver does not model makes the colour
  // un-resolvable, so it cannot prove the run visible.
  let transparent = false
  for (const t of elements(el)) {
    if (t.ns !== NS.a) return { unknown: true }
    const v = pct(attrOf(t.attributes, 'val'))
    if (v === undefined) return { unknown: true }
    if (is(t, NS.a, 'alpha')) {
      if (v <= 0.05) transparent = true
    } else if (is(t, NS.a, 'tint')) rgb = mix(rgb, 'white', v)
    else if (is(t, NS.a, 'shade')) rgb = mix(rgb, 'black', v)
    else if (is(t, NS.a, 'lumMod') || is(t, NS.a, 'lumOff') || is(t, NS.a, 'satMod')) {
      const [h, sat, l] = hslOf(rgb)
      if (is(t, NS.a, 'lumMod')) rgb = hexOfHsl(h, sat, Math.min(1, Math.max(0, l * v)))
      else if (is(t, NS.a, 'lumOff')) rgb = hexOfHsl(h, sat, Math.min(1, Math.max(0, l + v)))
      else rgb = hexOfHsl(h, Math.min(1, Math.max(0, sat * v)), l)
    } else return { unknown: true }
  }
  return { rgb, transparent }
}

/** One fill ELEMENT (`a:solidFill`, `a:gradFill`, …), resolved. */
function fillEl(el: XmlElement, s: Scheme): DFill {
  if (is(el, NS.a, 'noFill')) return { kind: 'none' }
  if (is(el, NS.a, 'solidFill')) {
    const clr = drawingClr(elements(el)[0], s)
    return clr.rgb === undefined && !clr.transparent ? { kind: 'unknown' } : { kind: 'solid', clr }
  }
  if (is(el, NS.a, 'gradFill')) {
    const stops = childEls(childEl(el, NS.a, 'gsLst') ?? el, NS.a, 'gs').map((gs) =>
      drawingClr(elements(gs)[0], s),
    )
    if (stops.length === 0) return { kind: 'unknown' }
    return { kind: 'grad', stops }
  }
  if (is(el, NS.a, 'pattFill')) {
    const clr = (name: string): DClr => {
      const holder = childEl(el, NS.a, name)
      return holder ? drawingClr(elements(holder)[0], s) : { unknown: true }
    }
    return { kind: 'pattern', fg: clr('fgClr'), bg: clr('bgClr') }
  }
  if (is(el, NS.a, 'blipFill') || is(el, NS.a, 'grpFill')) return { kind: 'unknown' }
  return { kind: 'unknown' }
}

/** The fill a container's children name — `absent` when none does. */
function drawingFill(container: XmlElement | undefined, s: Scheme): DFill {
  for (const c of container ? elements(container) : []) {
    if (c.ns !== NS.a) continue
    if (
      is(c, NS.a, 'noFill') ||
      is(c, NS.a, 'solidFill') ||
      is(c, NS.a, 'gradFill') ||
      is(c, NS.a, 'pattFill') ||
      is(c, NS.a, 'blipFill') ||
      is(c, NS.a, 'grpFill')
    ) {
      return fillEl(c, s)
    }
  }
  return FILL_ABSENT
}

/** A `p:fillRef`/`p:bgRef` into one of the theme's fill schemes, with `phClr`. */
function refFill(
  list: readonly XmlElement[] | undefined,
  idx: number,
  ref: XmlElement | undefined,
  s: Scheme,
): DFill {
  // idx 0 applies no fill style: the shape is transparent, the background
  // beneath shows through. A missing or out-of-range scheme entry is the
  // un-modelled case (#495 §7).
  if (idx <= 0) return { kind: 'none' }
  if (list === undefined || list[idx - 1] === undefined) return { kind: 'unknown' }
  const phClr = ref ? drawingClr(elements(ref)[0], s) : undefined
  return fillEl(list[idx - 1], { ...s, phClr })
}

// ── Read-for-resolution style parts (#492 decision 2) ──────────────────────

/** A parsed layout, master or notes master: what runs can inherit from it. */
interface SlidesStylePart {
  /** Placeholder key `type:idx` (either side may be empty) → level → defRPr. */
  readonly byPh: ReadonlyMap<string, ReadonlyMap<number, XmlElement>>
  /** `txStyles` name → level → defRPr. */
  readonly byStyle: ReadonlyMap<string, ReadonlyMap<number, XmlElement>>
  /** The part's own background, as written (`p:bgPr` or `p:bgRef`). */
  readonly bg?: XmlElement
  /** The master's colour map, when this part is one. */
  readonly clrMap?: ReadonlyMap<string, string>
}

/** A slide's or notes slide's inheritance, resolved once per part. */
interface SlideInheritance {
  readonly layout?: SlidesStylePart
  readonly master?: SlidesStylePart
  /** The chain could not be read: every run on the part counts unknown-property. */
  readonly broken: boolean
  readonly clrMap: ReadonlyMap<string, string>
}

/** A standard colour map, for a master without one. */
const CLR_MAP_DEFAULT: Readonly<Record<string, string>> = {
  bg1: 'lt1',
  tx1: 'dk1',
  bg2: 'lt2',
  tx2: 'dk2',
  accent1: 'accent1',
  accent2: 'accent2',
  accent3: 'accent3',
  accent4: 'accent4',
  accent5: 'accent5',
  accent6: 'accent6',
  hlink: 'hlink',
  folhlink: 'folhlink',
}

/** `lvl1pPr`…`lvl9pPr` → the level's `a:defRPr`. */
function lstLevels(lst: XmlElement | undefined): ReadonlyMap<number, XmlElement> {
  const levels = new Map<number, XmlElement>()
  for (let n = 1; n <= 9; n++) {
    const def = childEl(childEl(lst, NS.a, `lvl${n}pPr`), NS.a, 'defRPr')
    if (def) levels.set(n, def)
  }
  return levels
}

/** Read one style part: placeholders, `txStyles`, background, colour map. */
/** A shape's placeholder: its `type` and `idx`, when it carries one. */
function phOf(sp: XmlElement): { readonly type?: string; readonly idx?: string } | undefined {
  for (const nv of elements(sp)) {
    if (!/^nv.*Pr$/.test(nv.name) || nv.ns !== NS.p) continue
    const ph = childEl(childEl(nv, NS.p, 'nvPr'), NS.p, 'ph')
    if (!ph) return undefined
    return { type: attrOf(ph.attributes, 'type'), idx: attrOf(ph.attributes, 'idx') }
  }
  return undefined
}

/** The inheritance of the part being rewritten; the default outside slides. */
function slideInheritanceOf(ctx: Ctx): SlideInheritance {
  return (
    ctx.slideStyle.get(ctx.part) ?? {
      broken: false,
      clrMap: new Map(Object.entries(CLR_MAP_DEFAULT)),
    }
  )
}

function readSlidesStylePart(root: XmlElement): SlidesStylePart {
  const byPh = new Map<string, ReadonlyMap<number, XmlElement>>()
  const byStyle = new Map<string, ReadonlyMap<number, XmlElement>>()
  let bg: XmlElement | undefined
  let clrMap: ReadonlyMap<string, string> | undefined
  const walk = (el: XmlElement): void => {
    if (is(el, NS.p, 'bg')) bg = childEl(el, NS.p, 'bgPr') ?? childEl(el, NS.p, 'bgRef')
    if (is(el, NS.p, 'clrMap')) {
      clrMap = new Map(
        el.attributes
          .filter((a) => a.ns === '')
          .map((a) => [a.name.toLowerCase(), a.value.toLowerCase()]),
      )
    }
    if (is(el, NS.p, 'txStyles')) {
      for (const st of elements(el)) {
        if (st.ns === NS.p) byStyle.set(st.name, lstLevels(st))
      }
    }
    if (el.ns === NS.p && ['sp', 'pic', 'graphicFrame', 'cxnSp'].includes(el.name)) {
      const ph = phOf(el)
      const lst = childEl(childEl(el, NS.p, 'txBody'), NS.a, 'lstStyle')
      if (ph && lst) byPh.set(`${ph.type ?? ''}:${ph.idx ?? ''}`, lstLevels(lst))
    }
    for (const c of elements(el)) walk(c)
  }
  walk(root)
  return { byPh, byStyle, bg, clrMap }
}

/** The content types a read-for-resolution style part must carry. */
const STYLE_TYPE: Readonly<Record<'slideLayout' | 'slideMaster' | 'notesMaster', string>> = {
  slideLayout: `${OD}presentationml.slideLayout+xml`,
  slideMaster: `${OD}presentationml.slideMaster+xml`,
  notesMaster: `${OD}presentationml.notesMaster+xml`,
}

/**
 * Read a style part reached from `source` through one relationship type —
 * for RESOLUTION only, never emitted (#492 decision 2). A relationship whose
 * target is missing or mis-typed marks the chain broken, so the slide's runs
 * count `unknown-property` instead of quietly dropping the inheritance.
 */
function readStylePart(
  shared: Shared,
  pkg: Package,
  source: string,
  type: string,
  role: 'slideLayout' | 'slideMaster' | 'notesMaster',
  understood: ReadonlySet<string>,
): { readonly name?: string; readonly part?: SlidesStylePart; readonly broken?: boolean } {
  const rel = pkg.relsOf(source).find((r) => r.type === type && !r.external)
  if (rel === undefined) return {}
  const target = resolveTarget(source, rel.target)
  const entry = target === undefined ? undefined : pkg.get(target)
  if (
    !entry ||
    entry.directory ||
    (pkg.typeOf(entry.name) ?? '').toLowerCase() !== STYLE_TYPE[role].toLowerCase()
  ) {
    return { broken: true }
  }
  const key = fold(entry.name)
  const hit = shared.styleParts.get(key)
  if (hit) return { name: entry.name, part: hit }
  // Compatibility noise inside a read-only part never reaches the report:
  // a throwaway tally, since the part is counted once, as dropped.
  const root = compat(parseXml(entry.data), understood, new Tally())
  const part = readSlidesStylePart(root)
  shared.styleParts.set(key, part)
  return { name: entry.name, part }
}

/** A slide's inheritance: its layout, the layout's master, their colour map. */
function resolveSlideStyle(
  shared: Shared,
  pkg: Package,
  name: string,
  understood: ReadonlySet<string>,
): void {
  const l = readStylePart(shared, pkg, name, `${REL}slideLayout`, 'slideLayout', understood)
  let broken = l.broken === true
  let master: SlidesStylePart | undefined
  if (l.part && l.name) {
    const m = readStylePart(shared, pkg, l.name, `${REL}slideMaster`, 'slideMaster', understood)
    broken = broken || m.broken === true
    master = m.part
  }
  shared.slideStyle.set(name, {
    layout: l.part,
    master,
    broken,
    clrMap: master?.clrMap ?? new Map(Object.entries(CLR_MAP_DEFAULT)),
  })
}

/** A notes slide's inheritance: its notes master and its colour map. */
function resolveNotesStyle(
  shared: Shared,
  pkg: Package,
  name: string,
  understood: ReadonlySet<string>,
): void {
  const m = readStylePart(shared, pkg, name, `${REL}notesMaster`, 'notesMaster', understood)
  shared.slideStyle.set(name, {
    master: m.part,
    broken: m.broken === true,
    clrMap: m.part?.clrMap ?? new Map(Object.entries(CLR_MAP_DEFAULT)),
  })
}

// ── The pptx resolver ───────────────────────────────────────────────────────

/**
 * `a:rPr`/`a:defRPr` attributes and children the resolver can PROVE unable
 * to conceal text: the decorations draw the glyphs at the resolved colour and
 * size; `spc` and `baseline` change only advance and position; the font
 * children name fonts whose glyph coverage is a separate, filed class.
 */
const DRAWING_INERT_ATTRS: ReadonlySet<string> = new Set([
  'lang',
  'altlang',
  'b',
  'i',
  'u',
  'strike',
  'kern',
  'cap',
  'spc',
  'baseline',
  'kumimoji',
  'normalizeh',
  'noproof',
  'dirty',
  'err',
  'smtclean',
  'smtid',
  'bmk',
  'rtl',
])
const DRAWING_INERT_CHILDREN: ReadonlySet<string> = new Set([
  'ln',
  'latin',
  'ea',
  'cs',
  'sym',
  'hlinkClick',
  'hlinkMouseOver',
  'uLn',
  'uLnTx',
  'uFill',
  'uFillTx',
])

/** Effect children that draw the glyphs as they are (a shadow, a glow, …). */
const EFFECTS_INERT: ReadonlySet<string> = new Set([
  'outerShdw',
  'innerShdw',
  'prstShdw',
  'reflection',
  'glow',
])

/** The rendering properties of one `a:rPr`/`a:defRPr` element the resolver cannot model. */
function drawingUnknown(props: XmlElement): ReadonlySet<string> {
  const unknown = new Set<string>()
  for (const a of props.attributes) {
    if (a.ns === NS.xml || a.ns === NS.xmlns) continue
    if (a.name === 'sz') continue
    if (!DRAWING_INERT_ATTRS.has(a.name.toLowerCase())) unknown.add(`@${a.name}`)
  }
  for (const c of elements(props)) {
    if (c.ns !== NS.a) {
      unknown.add(`${c.ns}:${c.name}`)
      continue
    }
    if (
      is(c, NS.a, 'noFill') ||
      is(c, NS.a, 'solidFill') ||
      is(c, NS.a, 'gradFill') ||
      is(c, NS.a, 'pattFill') ||
      is(c, NS.a, 'highlight')
    ) {
      continue
    }
    if (is(c, NS.a, 'effectLst') || is(c, NS.a, 'effectDag')) {
      // An empty list is a no-op, and shadows, glows and reflections draw the
      // glyphs as they are; only an effect that can blur them away — `blur`,
      // `softEdge` — is un-modelled (#492, from the benign corpus).
      const effects = elements(c).flatMap((e) => (is(e, NS.a, 'effectDag') ? elements(e) : [e]))
      if (effects.every((e) => EFFECTS_INERT.has(e.name))) continue
    }
    if (!DRAWING_INERT_CHILDREN.has(c.name)) unknown.add(c.name)
  }
  return unknown
}

/**
 * The nearest text highlight in the chain — a background drawn behind the
 * glyph and OVER every other background (#495 F2), exactly as `countWordRun`
 * treats `w:highlight`. An unresolvable one is not provably any colour.
 */
function drawingHighlight(
  chain: readonly (XmlElement | undefined)[],
  s: Scheme,
): { readonly clr?: DClr; readonly unknown: boolean } {
  for (const props of chain) {
    if (props === undefined) continue
    const hl = childEl(props, NS.a, 'highlight')
    if (hl === undefined) continue
    const clr = drawingClr(elements(hl)[0], s)
    if (clr.transparent) continue // paints nothing: the fill beneath shows
    if (clr.unknown || clr.rgb === undefined) return { unknown: true }
    return { clr, unknown: false }
  }
  return { unknown: false }
}

/**
 * The run's text fill: the nearest chain level that defines one. Unknowns are
 * collected over the WHOLE chain — a farther level's un-modelled property
 * applies to the run just as a nearer one's does.
 */
function drawingTextFill(
  chain: readonly (XmlElement | undefined)[],
  s: Scheme,
): { readonly fill?: DFill; readonly unknown: ReadonlySet<string> } {
  const unknown = new Set<string>()
  let fill: DFill | undefined
  for (const props of chain) {
    if (props) for (const u of drawingUnknown(props)) unknown.add(u)
    if (fill === undefined) {
      const f = drawingFill(props, s)
      if (f.kind !== 'absent') fill = f
    }
  }
  return { fill, unknown }
}

/** A scheme colour by name alone — the built-in default text colour. */
function schemeClrOf(name: string, s: Scheme): DClr {
  const slot = s.clrMap?.get(name) ?? SCHEME_DEFAULT[name]
  if (slot === undefined) return { unknown: true }
  const rgb = s.theme?.get(slot) ?? THEME_DEFAULTS[slot]
  return rgb === undefined ? { unknown: true } : { rgb }
}

/** The background a pptx run sits on, from the shape to the page. */
function drawingBackgrounds(
  scope: Scope,
  inheritance: SlideInheritance,
  s: Scheme,
  ctx: Ctx,
): { readonly unknown: boolean; readonly colours: readonly string[] } {
  const levels: readonly DFill[] = [
    scope.shape?.fill ?? FILL_ABSENT,
    scope.tblFill ?? FILL_ABSENT,
    scope.slideBg ?? FILL_ABSENT,
    inheritance.layout?.bg === undefined ? FILL_ABSENT : bgFill(inheritance.layout.bg, s, ctx),
    inheritance.master?.bg === undefined ? FILL_ABSENT : bgFill(inheritance.master.bg, s, ctx),
  ]
  for (const level of levels) {
    if (level.kind === 'absent' || level.kind === 'none') continue
    const bg = bgColours(level)
    if (bg.unknown) return { unknown: true, colours: [] }
    if (bg.colours !== undefined) return { unknown: false, colours: bg.colours }
  }
  return { unknown: false, colours: ['FFFFFF'] }
}

/** A `p:bgPr`/`p:bgRef` element, resolved with the theme's schemes. */
function bgFill(bg: XmlElement, s: Scheme, ctx: Ctx): DFill {
  if (is(bg, NS.p, 'bgPr')) return drawingFill(bg, s)
  const idx = int(attrOf(bg.attributes, 'idx')) ?? 0
  return refFill(ctx.fmtBgFillEls, Math.round(idx / 1000), bg, s)
}

/** A fill as a background: the colours the text must contrast with. */
function bgColours(fill: DFill): {
  readonly unknown: boolean
  readonly colours?: readonly string[]
} {
  if (fill.kind === 'solid') {
    if (fill.clr.transparent) return { unknown: false }
    if (fill.clr.rgb === undefined || fill.clr.unknown) return { unknown: true }
    return { unknown: false, colours: [fill.clr.rgb] }
  }
  if (fill.kind === 'grad') {
    const colours: string[] = []
    for (const stop of fill.stops) {
      if (stop.transparent || stop.unknown || stop.rgb === undefined) return { unknown: true }
      colours.push(stop.rgb)
    }
    return { unknown: false, colours }
  }
  if (fill.kind === 'pattern') {
    const colours: string[] = []
    for (const clr of [fill.fg, fill.bg]) {
      if (clr.transparent) return { unknown: false }
      if (clr.rgb === undefined || clr.unknown) return { unknown: true }
      colours.push(clr.rgb)
    }
    return { unknown: false, colours }
  }
  return { unknown: true }
}

/** Whether a fill as a FOREGROUND draws anything visibly distinct. */
function fgVisible(fill: DFill, bgs: readonly string[]): boolean | undefined {
  const clrVisible = (clr: DClr): boolean | undefined => {
    if (clr.transparent) return false
    if (clr.rgb === undefined || clr.unknown) return undefined
    return bgs.every((bg) => contrastRatio(clr.rgb!, bg) >= MIN_CONTRAST)
  }
  if (fill.kind === 'none') return false
  if (fill.kind === 'solid') return clrVisible(fill.clr)
  if (fill.kind === 'grad') {
    let anyUnknown = false
    for (const stop of fill.stops) {
      const v = clrVisible(stop)
      if (v === true) return true
      if (v === undefined) anyUnknown = true
    }
    return anyUnknown ? undefined : false
  }
  if (fill.kind === 'pattern') {
    let anyUnknown = false
    for (const clr of [fill.fg, fill.bg]) {
      const v = clrVisible(clr)
      if (v === true) return true
      if (v === undefined) anyUnknown = true
    }
    return anyUnknown ? undefined : false
  }
  return undefined
}

/** The layout's or master's placeholder level matching the slide shape's. */
function phLevel(
  part: SlidesStylePart | undefined,
  ph: { readonly type?: string; readonly idx?: string } | undefined,
  level: number,
): XmlElement | undefined {
  if (!part || !ph) return undefined
  const byType = (type: string): XmlElement | undefined => {
    for (const [key, levels] of part.byPh) {
      if (key.startsWith(`${type}:`) && levels.get(level)) return levels.get(level)
    }
    return undefined
  }
  const type = ph.type?.toLowerCase()
  if (type !== undefined) {
    const direct = byType(type)
    if (direct) return direct
    // `ctrTitle` and `subTitle` inherit their family's placeholder.
    if (type === 'ctrtitle') {
      const title = byType('title')
      if (title) return title
    }
    if (type === 'subtitle') {
      const body = byType('body')
      if (body) return body
    }
  }
  if (ph.idx !== undefined) {
    for (const [key, levels] of part.byPh) {
      if (key.endsWith(`:${ph.idx}`) && levels.get(level)) return levels.get(level)
    }
  }
  return undefined
}

/** A placeholder's `txStyles` name: title, body, other — or notes. */
function styleNameOf(ph: { readonly type?: string }, notes: boolean): string {
  if (notes) return 'notesStyle'
  const type = ph.type?.toLowerCase()
  if (type === 'title' || type === 'ctrtitle') return 'titleStyle'
  if (type === 'body' || type === 'obj' || type === 'subtitle') return 'bodyStyle'
  return 'otherStyle'
}

/**
 * ONE computation per DrawingML run (#492): the run's fill, size and every
 * defRPr level it inherits — its paragraph's, its shape's list style at its
 * level, its layout's matching placeholder, its master's placeholder and
 * `txStyles`, and the presentation's `defaultTextStyle` — against the
 * background of its shape, its slide, its layout, its master, or the page.
 */
function countDrawingRun(run: XmlElement, ctx: Ctx, scope: Scope): void {
  const notes = ctx.role === 'notesSlide'
  const inheritance = slideInheritanceOf(ctx)
  const level = (scope.lvl ?? 0) + 1
  const ph = scope.shape?.ph
  const s: Scheme = { theme: ctx.theme, clrMap: inheritance.clrMap }
  const chain: readonly (XmlElement | undefined)[] = [
    childEl(run, NS.a, 'rPr'),
    scope.paraDefRPr,
    scope.defRPr,
    phLevel(inheritance.layout, ph, level),
    phLevel(inheritance.master, ph, level),
    inheritance.master?.byStyle.get(styleNameOf(ph ?? {}, notes))?.get(level),
    ctx.slideDefaults?.get(level),
  ]
  const { fill, unknown } = drawingTextFill(chain, s)
  if (unknown.size > 0 || inheritance.broken) ctx.counted.add('unknown-property')

  // A text highlight, when one is resolved, is the background over every
  // other background (#495 F2).
  const highlight = drawingHighlight(chain, s)
  const bg = highlight.unknown
    ? { unknown: true, colours: [] }
    : drawingBackgrounds(scope, inheritance, s, ctx)
  if (highlight.unknown || bg.unknown) ctx.counted.add('unknown-property')
  else {
    // No fill anywhere resolves to the theme's text colour through the map.
    // No fill anywhere: PowerPoint's default text colour is the theme's tx1
    // through the master's colour map.
    const fg: DFill = fill ?? { kind: 'solid', clr: schemeClrOf('tx1', s) }
    const bgColours = highlight.clr ? [highlight.clr.rgb!] : bg.colours
    const visible = fgVisible(fg, bgColours)
    if (visible === undefined) ctx.counted.add('unknown-property')
    else if (!visible) ctx.counted.add('colour-contrast')
  }

  // Size: the nearest level's `sz`, scaled by the body's autofit fontScale
  // and by sub/superscript's reduced render (#495, as `w:vertAlign` composes).
  let baselineScale = 1
  for (const props of chain) {
    const b = props === undefined ? undefined : attrOf(props.attributes, 'baseline')
    if (b !== undefined) {
      baselineScale = int(b) === 0 ? 1 : VERT_ALIGN_SCALE
      break
    }
  }
  for (const props of chain) {
    const raw = props === undefined ? undefined : int(attrOf(props.attributes, 'sz'))
    if (raw === undefined) continue
    const pt = (raw / 100) * (scope.shape?.fontScale ?? 1) * baselineScale
    if (pt <= 1) ctx.counted.add('too-small')
    break
  }
}

/** Count concealment for one rebuilt element (A3: counted, not dropped). */
function count(el: XmlElement, ctx: Ctx, scope: Scope): void {
  if (is(el, NS.w, 'r') && hasText(el, NS.w)) countWordRun(el, ctx, scope)
  else if (is(el, NS.m, 'r') && hasText(el, NS.m)) countWordRun(el, ctx, scope)
  else if (is(el, NS.a, 'r') && hasText(el, NS.a)) countDrawingRun(el, ctx, scope)
  // A field's cached `a:t` renders with the `a:rPr` sitting on the `a:fld`
  // (#495 F4): text-bearing, like any run.
  else if (is(el, NS.a, 'fld') && hasText(el, NS.a)) countDrawingRun(el, ctx, scope)
  else if (ctx.role === 'sheetMain' && is(el, NS.s, 'bookViews')) {
    // Read from the compat-processed tree, so markup nesting cannot hide a
    // hidden window from the count (#482 delta F1, A10).
    for (const view of childEls(el, NS.s, 'workbookView')) {
      const visibility = attrOf(view.attributes, 'visibility')
      if (visibility !== undefined && visibility !== 'visible') ctx.counted.add('hidden-flag')
    }
  } else if (ctx.role === 'worksheet') countSheet(el, ctx)
  else if (ctx.role === 'slide' && is(el, NS.p, 'spTree')) countOffSlide(el, ctx)
}

/** Below these, a row or column is as good as hidden (A10). */
const tiny = (v: string | undefined, under: number): boolean => {
  const n = v === undefined ? Number.NaN : Number.parseFloat(v)
  return Number.isFinite(n) && n < under
}

function countSheet(el: XmlElement, ctx: Ctx): void {
  if (is(el, NS.s, 'row')) {
    if (flag(el, 'hidden')) ctx.counted.add('hidden-flag')
    if (tiny(attrOf(el.attributes, 'ht'), 1)) ctx.counted.add('too-small')
  } else if (is(el, NS.s, 'col')) {
    if (flag(el, 'hidden')) ctx.counted.add('hidden-flag')
    if (tiny(attrOf(el.attributes, 'width'), 0.5)) ctx.counted.add('too-small')
  } else if (is(el, NS.s, 'sheetFormatPr')) {
    if (flag(el, 'zeroHeight')) ctx.counted.add('hidden-flag')
    if (tiny(attrOf(el.attributes, 'defaultRowHeight'), 1)) ctx.counted.add('too-small')
    if (tiny(attrOf(el.attributes, 'defaultColWidth'), 0.5)) ctx.counted.add('too-small')
  } else if (is(el, NS.s, 'c') && ctx.sheetStyles) {
    countCell(el, ctx)
  }
}

/** The resolver for one cell (#492): its font, runs, fill and format, against each other. */
function countCell(el: XmlElement, ctx: Ctx): void {
  if (!childEl(el, NS.s, 'v') && !childEl(el, NS.s, 'is')) return
  const styles = ctx.sheetStyles!
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
    ctx.counted.add('hidden-flag')
  }
  const v = childEl(el, NS.s, 'v')
  const runs: readonly RichRun[] =
    attrOf(el.attributes, 't') === 's'
      ? (ctx.strings?.[(v && int(textOf(v))) ?? -1] ?? [])
      : richRuns(childEl(el, NS.s, 'is'))
  // The size family: the cell's font and each rich run's own, which inherits
  // the cell font's size when it declares none (#492).
  const cellSz = styles.fonts[xf.fontId]?.sz
  if ((cellSz ?? 11) <= 1 || runs.some((r) => (r.sz ?? cellSz ?? 11) <= 1)) {
    ctx.counted.add('too-small')
  }
  // The colour family: the cell's fill, then the font and each rich run
  // against it. An un-modelled fill mechanism is not provably visible.
  const fills = cellFillColours(styles.fills[xf.fillId], ctx)
  if (fills.unknown) {
    ctx.counted.add('unknown-property')
    return
  }
  const bgs = fills.colours.length > 0 ? fills.colours : ['FFFFFF']
  const fails = (run: RichRun | undefined): boolean => {
    const c = run?.color
    // Excel's Automatic (Black) is fill-blind (#495 F1): absent or `auto`
    // renders black, and takes the contrast check like any colour.
    const rgb = c === undefined || c.auto ? '000000' : toRgb(c, ctx)
    return rgb === undefined || bgs.some((bg) => contrastRatio(rgb, bg) < MIN_CONTRAST)
  }
  // A number format's colour sections OVERRIDE the font's colour for what the
  // cell displays (#492): when one is present, it is the displayed colour.
  const displayed = formatColours(format, styles, ctx)
  if (displayed.length > 0) {
    if (displayed.some((colour) => bgs.some((bg) => contrastRatio(colour, bg) < MIN_CONTRAST))) {
      ctx.counted.add('colour-contrast')
    }
  } else if (fails(styles.fonts[xf.fontId]) || runs.some(fails)) {
    ctx.counted.add('colour-contrast')
  }
}

/** The colour names and `[Color n]` indices a number format can carry. */
const FORMAT_COLOURS: Readonly<Record<string, string>> = {
  black: '000000',
  blue: '0000FF',
  cyan: '00FFFF',
  green: '00FF00',
  magenta: 'FF00FF',
  red: 'FF0000',
  white: 'FFFFFF',
  yellow: 'FFFF00',
}

function formatColours(format: string, styles: SheetStyles, ctx: Shared): readonly string[] {
  const out: string[] = []
  for (const m of format.matchAll(/\[([^\]]+)\]/g)) {
    const name = m[1].trim().toLowerCase()
    const fixed = FORMAT_COLOURS[name.replace(/\s+/g, '')]
    if (fixed !== undefined) {
      out.push(fixed)
      continue
    }
    const indexed = /^color\s*([1-9]\d*)$/.exec(name)
    if (indexed) {
      const rgb = hex6(styles.palette?.[Number(indexed[1]) - 1] ?? PALETTE[Number(indexed[1]) - 1])
      if (rgb !== undefined) out.push(rgb)
    }
  }
  return out
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
      ctx.counted.add('layout')
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
  /** The automatic colour, which adapts to the background. */
  readonly auto?: boolean
}

/** A rich-text run's own font properties (#492). */
interface RichRun {
  readonly color?: Color
  readonly sz?: number
}

/** A cell fill: nothing, one solid colour, a pattern's two, or un-modelled. */
interface CellFill {
  readonly kind: 'none' | 'solid' | 'pattern' | 'unknown'
  readonly colours: readonly Color[]
}

/** The `patternType` values the resolver models; anything else is unknown. */
const SHEET_PATTERNS: ReadonlySet<string> = new Set([
  'solid',
  'gray125',
  'gray0625',
  'darkhorizontal',
  'darkvertical',
  'darkdown',
  'darkup',
  'darkgrid',
  'darktrellis',
  'lighthorizontal',
  'lightvertical',
  'lightdown',
  'lightup',
  'lightbox',
  'lightgrid',
  'lighttrellis',
  'lightgray',
])

interface SheetStyles {
  readonly numFmts: ReadonlyMap<number, string>
  readonly xfs: readonly { numFmtId: number; fontId: number; fillId: number }[]
  /** Each font's own colour and size; automatic when it declares none. */
  readonly fonts: readonly RichRun[]
  /** The fills, by id: nothing, solid, a pattern, or un-modelled. */
  readonly fills: readonly (CellFill | undefined)[]
  /** The workbook's own palette (`<colors><indexedColors>`), when it has one. */
  readonly palette?: readonly string[]
  /** The conditional formats (`dxf`): each one's font and fill. */
  readonly dxfs: readonly { readonly font?: Color; readonly fill?: CellFill }[]
}

/** A cell fill's colours, resolved to RGB; unknown when a mechanism is un-modelled. */
function cellFillColours(
  fill: CellFill | undefined,
  ctx: Shared,
): { readonly colours: readonly string[]; readonly unknown: boolean } {
  if (fill === undefined || fill.kind === 'none') return { colours: [], unknown: false }
  if (fill.kind === 'unknown') return { colours: [], unknown: true }
  const colours: string[] = []
  for (const c of fill.colours) {
    if (c.auto) return { colours: [], unknown: true } // not provably any colour
    const rgb = toRgb(c, ctx)
    if (rgb === undefined) return { colours: [], unknown: true }
    colours.push(rgb)
  }
  return { colours, unknown: false }
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

function readTheme(root: XmlElement): {
  readonly slots: ReadonlyMap<string, string>
  readonly fillEls: readonly XmlElement[]
  readonly bgFillEls: readonly XmlElement[]
} {
  const elements_ = childEl(root, NS.a, 'themeElements')
  const scheme = childEl(elements_, NS.a, 'clrScheme')
  const colors = new Map<string, string>()
  for (const slot of scheme ? elements(scheme) : []) {
    const c = elements(slot)[0]
    const v = c && hex6(attrOf(c.attributes, is(c, NS.a, 'sysClr') ? 'lastClr' : 'val'))
    if (slot.ns === NS.a && v) colors.set(slot.name, v)
  }
  // The fill schemes, as written: a `p:fillRef` or `p:bgRef` resolves into
  // them with its own colour as `phClr` (#492).
  const fmt = childEl(elements_, NS.a, 'fmtScheme')
  const schemeList = (name: string): readonly XmlElement[] => {
    const lst = childEl(fmt, NS.a, name)
    return lst ? elements(lst) : []
  }
  return {
    slots: colors,
    fillEls: schemeList('fillStyleLst'),
    bgFillEls: schemeList('bgFillStyleLst'),
  }
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
  if (!el) return undefined
  if (flag(el, 'auto')) return { auto: true }
  const a = (n: string) => attrOf(el.attributes, n)
  return { rgb: a('rgb'), theme: a('theme'), tint: a('tint'), indexed: a('indexed') }
}

/** One rich-text run's own colour and size (`r/rPr`). */
function richRun(r: XmlElement): RichRun {
  const rPr = childEl(r, NS.s, 'rPr')
  const sz = Number.parseFloat(attrOf(childEl(rPr, NS.s, 'sz')?.attributes ?? [], 'val') ?? '')
  return {
    color: colorOf(childEl(rPr, NS.s, 'color')),
    sz: Number.isFinite(sz) ? sz : undefined,
  }
}

/** The rich runs of an inline or shared string (`is` / `si`). */
function richRuns(si: XmlElement | undefined): readonly RichRun[] {
  if (!si) return []
  return childEls(si, NS.s, 'r').map(richRun)
}

function readSharedStrings(root: XmlElement): readonly (readonly RichRun[])[] {
  return childEls(root, NS.s, 'si').map(richRuns)
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
    fonts: list('fonts', 'font').map((f) => {
      const sz = Number.parseFloat(attrOf(childEl(f, NS.s, 'sz')?.attributes ?? [], 'val') ?? '')
      return {
        color: colorOf(childEl(f, NS.s, 'color')),
        sz: Number.isFinite(sz) ? sz : undefined,
      }
    }),
    fills: list('fills', 'fill').map((f) => readFillEntry(f, false)),
    palette: indexed
      ? childEls(indexed, NS.s, 'rgbColor').map((c) =>
          (attrOf(c.attributes, 'rgb') ?? '').slice(-6),
        )
      : undefined,
    dxfs: list('dxfs', 'dxf').map((d) => ({
      font: colorOf(childEl(childEl(d, NS.s, 'font'), NS.s, 'color')),
      // A dxf's fill carries no patternType: Excel writes its colour as
      // bgColor, and #482 read that as solid (#482 re-check F3, #495 F8).
      fill:
        childEl(d, NS.s, 'fill') === undefined
          ? undefined
          : readFillEntry(childEl(d, NS.s, 'fill')!, true),
    })),
  }
}

/**
 * A `patternFill` as the resolver reads it: none, solid, a pattern, unknown.
 * A dxf's fill carries no `patternType` — Excel writes it that way, and #482
 * read it as solid; the rewrite dropped that reading, and it is back (#495
 * F8). A solid's colour is its `fgColor`, else its `bgColor`: either present
 * resolves, and the #482 rule — counting more is the safe direction — keeps
 * both candidates in play through `cellFillColours`.
 */
function cellFill(pattern: XmlElement | undefined, dxf: boolean): CellFill | undefined {
  if (!pattern) return undefined
  const type = attrOf(pattern.attributes, 'patternType')?.toLowerCase()
  if (type === undefined) return dxf ? solidFill(pattern) : { kind: 'none', colours: [] }
  if (type === 'none') return { kind: 'none', colours: [] }
  if (type === 'solid') return solidFill(pattern)
  if (SHEET_PATTERNS.has(type)) {
    return {
      kind: 'pattern',
      colours: [childEl(pattern, NS.s, 'fgColor'), childEl(pattern, NS.s, 'bgColor')]
        .map(colorOf)
        .filter(isColor),
    }
  }
  return { kind: 'unknown', colours: [] }
}

/** A solid fill's colour: its `fgColor`, else its `bgColor` (#495 F8). */
function solidFill(pattern: XmlElement): CellFill {
  // A solid pattern renders ONE colour — the foreground. Excel writes a dxf's
  // colour as `bgColor`, so that resolves when `fgColor` is absent; treating
  // both as backgrounds would flag every fill whose legacy `bgColor` is black.
  const fg = colorOf(childEl(pattern, NS.s, 'fgColor'))
  const bg = colorOf(childEl(pattern, NS.s, 'bgColor'))
  const c = fg !== undefined ? fg : bg
  return c === undefined ? { kind: 'unknown', colours: [] } : { kind: 'solid', colours: [c] }
}

const isColor = (c: Color | undefined): c is Color => c !== undefined

/**
 * One fill entry (#495 F9): its patternFill, unless the entry carries more
 * than that — an `extLst` with an `x14:fill` gradient — in which case it is
 * not provably any colour, whatever the patternFill says.
 */
function readFillEntry(f: XmlElement, dxf: boolean): CellFill | undefined {
  const pattern = childEl(f, NS.s, 'patternFill')
  const more = elements(f).filter((c) => !is(c, NS.s, 'patternFill'))
  if (more.length > 0) return { kind: 'unknown', colours: [] }
  return cellFill(pattern, dxf)
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
