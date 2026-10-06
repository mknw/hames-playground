/**
 * Synthetic OOXML packages for the `ooxmlDisarm` suite (#433 S6, pin Z2).
 *
 * Every package here is BUILT in the test, part by part, on core's own writer
 * (`writeZip`). None is a real document, none was produced by an Office
 * application, and nothing is read from disk: the repository is public, so a
 * fixture is a few lines of XML a reader can audit, never a file.
 *
 * The builders write the smallest package each rule needs: a content-types
 * part, the package relationships, the main part, and whatever parts and
 * relationships the case adds. Sentinels are unique uppercase words, so a test
 * can say "this string is in no part of the output" without matching markup.
 */
import { readZip, writeZip } from '@hames-ai/harness-patterns/stash/zip.server'

const enc = new TextEncoder()
const dec = new TextDecoder()

// ── Namespaces, relationship types, content types ───────────────────────────

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  v: 'urn:schemas-microsoft-com:vml',
  o: 'urn:schemas-microsoft-com:office:office',
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  rels: 'http://schemas.openxmlformats.org/package/2006/relationships',
} as const

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
const MS = 'http://schemas.microsoft.com/office/2006/relationships/'

export const RT = {
  officeDocument: `${R}officeDocument`,
  styles: `${R}styles`,
  numbering: `${R}numbering`,
  footnotes: `${R}footnotes`,
  endnotes: `${R}endnotes`,
  theme: `${R}theme`,
  settings: `${R}settings`,
  fontTable: `${R}fontTable`,
  font: `${R}font`,
  header: `${R}header`,
  footer: `${R}footer`,
  comments: `${R}comments`,
  hyperlink: `${R}hyperlink`,
  image: `${R}image`,
  oleObject: `${R}oleObject`,
  package: `${R}package`,
  control: `${R}control`,
  customXml: `${R}customXml`,
  glossaryDocument: `${R}glossaryDocument`,
  attachedTemplate: `${R}attachedTemplate`,
  aFChunk: `${R}aFChunk`,
  sharedStrings: `${R}sharedStrings`,
  worksheet: `${R}worksheet`,
  chartsheet: `${R}chartsheet`,
  externalLink: `${R}externalLink`,
  connections: `${R}connections`,
  pivotCacheDefinition: `${R}pivotCacheDefinition`,
  queryTable: `${R}queryTable`,
  table: `${R}table`,
  drawing: `${R}drawing`,
  vmlDrawing: `${R}vmlDrawing`,
  slide: `${R}slide`,
  notesSlide: `${R}notesSlide`,
  slideLayout: `${R}slideLayout`,
  slideMaster: `${R}slideMaster`,
  extendedProperties: `${R}extended-properties`,
  customProperties: `${R}custom-properties`,
  coreProperties:
    'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  vbaProject: `${MS}vbaProject`,
  wordVbaData: `${MS}wordVbaData`,
  xlMacrosheet: `${MS}xlMacrosheet`,
  activeXBinary: `${MS}activeXControlBinary`,
  ui: 'http://schemas.microsoft.com/office/2007/relationships/ui/extensibility',
  stylesWithEffects: 'http://schemas.microsoft.com/office/2007/relationships/stylesWithEffects',
} as const

const OD = 'application/vnd.openxmlformats-officedocument.'

export const CT = {
  docxMain: `${OD}wordprocessingml.document.main+xml`,
  docmMain: 'application/vnd.ms-word.document.macroEnabled.main+xml',
  xlsxMain: `${OD}spreadsheetml.sheet.main+xml`,
  xlsmMain: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
  pptxMain: `${OD}presentationml.presentation.main+xml`,
  pptmMain: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
  wStyles: `${OD}wordprocessingml.styles+xml`,
  wNumbering: `${OD}wordprocessingml.numbering+xml`,
  wFootnotes: `${OD}wordprocessingml.footnotes+xml`,
  wEndnotes: `${OD}wordprocessingml.endnotes+xml`,
  wComments: `${OD}wordprocessingml.comments+xml`,
  wSettings: `${OD}wordprocessingml.settings+xml`,
  wFontTable: `${OD}wordprocessingml.fontTable+xml`,
  wHeader: `${OD}wordprocessingml.header+xml`,
  wFooter: `${OD}wordprocessingml.footer+xml`,
  wGlossary: `${OD}wordprocessingml.document.glossary+xml`,
  theme: `${OD}theme+xml`,
  sStyles: `${OD}spreadsheetml.styles+xml`,
  sharedStrings: `${OD}spreadsheetml.sharedStrings+xml`,
  worksheet: `${OD}spreadsheetml.worksheet+xml`,
  sComments: `${OD}spreadsheetml.comments+xml`,
  externalLink: `${OD}spreadsheetml.externalLink+xml`,
  connections: `${OD}spreadsheetml.connections+xml`,
  pivotCacheDefinition: `${OD}spreadsheetml.pivotCacheDefinition+xml`,
  queryTable: `${OD}spreadsheetml.queryTable+xml`,
  table: `${OD}spreadsheetml.table+xml`,
  macrosheet: 'application/vnd.ms-excel.macrosheet+xml',
  slide: `${OD}presentationml.slide+xml`,
  notesSlide: `${OD}presentationml.notesSlide+xml`,
  slideLayout: `${OD}presentationml.slideLayout+xml`,
  slideMaster: `${OD}presentationml.slideMaster+xml`,
  pComments: `${OD}presentationml.comments+xml`,
  vba: 'application/vnd.ms-office.vbaProject',
  vbaData: 'application/vnd.ms-word.vbaData+xml',
  ole: `${OD}oleObject`,
  activeX: 'application/vnd.ms-office.activeX+xml',
  activeXBin: 'application/vnd.ms-office.activeX',
  font: 'application/vnd.openxmlformats-officedocument.obfuscatedFont',
  customUI: 'application/xml',
  customXml: 'application/xml',
  customXmlProps: `${OD}customXmlProperties+xml`,
  coreProps: 'application/vnd.openxmlformats-package.core-properties+xml',
  appProps: `${OD}extended-properties+xml`,
  customProps: `${OD}custom-properties+xml`,
  png: 'image/png',
} as const

export const MIME = {
  docx: `${OD}wordprocessingml.document`,
  docm: 'application/vnd.ms-word.document.macroEnabled.12',
  xlsx: `${OD}spreadsheetml.sheet`,
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  pptx: `${OD}presentationml.presentation`,
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
} as const

// ── The generic builder ─────────────────────────────────────────────────────

export interface Rel {
  readonly id: string
  readonly type: string
  readonly target: string
  readonly external?: boolean
  /** A raw `TargetMode` value, for the cases that are not `External`. */
  readonly targetMode?: string
}

export interface Part {
  readonly name: string
  /** An Override in `[Content_Types].xml`; omit to fall back to the Default. */
  readonly type?: string
  readonly body: string | Uint8Array
  /** Store it rather than deflate it: a repetitive part would break the reader's 100:1 ratio. */
  readonly stored?: boolean
}

export interface PackageSpec {
  readonly main: Part
  readonly parts?: readonly Part[]
  /** Relationships by SOURCE part name (`''` is the package itself). */
  readonly rels?: Readonly<Record<string, readonly Rel[]>>
  /** Where the package's officeDocument relationship points; `null` omits it. */
  readonly officeDocument?: string | null
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

function relsPartName(source: string): string {
  if (source === '') return '_rels/.rels'
  const slash = source.lastIndexOf('/')
  return `${source.slice(0, slash + 1)}_rels/${source.slice(slash + 1)}.rels`
}

export function relsXml(rels: readonly Rel[]): string {
  return (
    `${XML_DECL}<Relationships xmlns="${NS.rels}">` +
    rels
      .map(
        (r) =>
          `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"` +
          (r.external ? ' TargetMode="External"' : '') +
          (r.targetMode ? ` TargetMode="${r.targetMode}"` : '') +
          '/>',
      )
      .join('') +
    '</Relationships>'
  )
}

/** A whole package: content types, package rels (officeDocument first), parts, rels parts. */
export function buildPackage(spec: PackageSpec): Uint8Array {
  const parts = [spec.main, ...(spec.parts ?? [])]
  const ct =
    `${XML_DECL}<Types xmlns="${NS.ct}">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    parts
      .filter((p) => p.type)
      .map((p) => `<Override PartName="/${p.name}" ContentType="${p.type}"/>`)
      .join('') +
    '</Types>'
  const target = spec.officeDocument === undefined ? spec.main.name : spec.officeDocument
  const rels: Record<string, Rel[]> = {
    '': target === null ? [] : [{ id: 'rIdMain', type: RT.officeDocument, target }],
  }
  for (const [source, list] of Object.entries(spec.rels ?? {})) {
    rels[source] = [...(rels[source] ?? []), ...list]
  }
  const files: { name: string; data: Uint8Array; method?: 0 | 8 }[] = [
    { name: '[Content_Types].xml', data: enc.encode(ct) },
  ]
  for (const [source, list] of Object.entries(rels)) {
    files.push({ name: relsPartName(source), data: enc.encode(relsXml(list)) })
  }
  for (const p of parts) {
    files.push({
      name: p.name,
      data: typeof p.body === 'string' ? enc.encode(p.body) : p.body,
      method: p.stored ? 0 : 8,
    })
  }
  return writeZip(files)
}

/** `n` pseudo-random hex digits (an LCG): padding no deflater can shrink past 4:1. */
export function noise(n: number, seed = 1): string {
  let x = seed >>> 0
  let out = ''
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    out += ((x >>> 16) & 15).toString(16)
  }
  return out
}

/** A synthetic binary blob (an OLE header, then filler) — never a real file. */
export function blob(sentinel: string): Uint8Array {
  return enc.encode(`\xd0\xcf\x11\xe0 ${sentinel} synthetic binary`)
}

// ── WordprocessingML ────────────────────────────────────────────────────────

/** Every namespace a body fragment below may use, bound on the root. */
const W_ROOT_NS =
  `xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" ` +
  `xmlns:pic="${NS.pic}" xmlns:mc="${NS.mc}" xmlns:m="${NS.m}" xmlns:v="${NS.v}" ` +
  `xmlns:o="${NS.o}" xmlns:w14="${NS.w14}" xmlns:wps="${NS.wps}" mc:Ignorable="w14"`

export function wDocument(body: string): string {
  return `${XML_DECL}<w:document ${W_ROOT_NS}><w:body>${body}</w:body></w:document>`
}

export function wStyles(inner: string): string {
  return `${XML_DECL}<w:styles xmlns:w="${NS.w}">${inner}</w:styles>`
}

export function wNotes(kind: 'footnotes' | 'endnotes', inner: string): string {
  const el = kind === 'footnotes' ? 'footnote' : 'endnote'
  return (
    `${XML_DECL}<w:${kind} ${W_ROOT_NS}>` +
    `<w:${el} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${el}>` +
    `<w:${el} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${el}>` +
    `${inner}</w:${kind}>`
  )
}

/** A paragraph with one plain run. */
export const para = (text: string, pPr = ''): string =>
  `<w:p>${pPr}<w:r><w:t>${text}</w:t></w:r></w:p>`

/** A run with run properties. */
export const run = (text: string, rPr = ''): string =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t>${text}</w:t></w:r>`

export interface DocxSpec {
  readonly body: string
  readonly macroEnabled?: boolean
  /** Store `word/document.xml` rather than deflate it. */
  readonly stored?: boolean
  readonly styles?: string
  readonly numbering?: string
  readonly footnotes?: string
  readonly endnotes?: string
  /** More relationships from `word/document.xml`. */
  readonly docRels?: readonly Rel[]
  /** More relationships from the package itself. */
  readonly rootRels?: readonly Rel[]
  readonly parts?: readonly Part[]
  readonly extraRels?: Readonly<Record<string, readonly Rel[]>>
}

export function docx(spec: DocxSpec): Uint8Array {
  const parts: Part[] = []
  const docRels: Rel[] = []
  const add = (id: string, type: string, name: string, ctype: string, body?: string) => {
    if (body === undefined) return
    parts.push({ name: `word/${name}`, type: ctype, body })
    docRels.push({ id, type, target: name })
  }
  add('rIdStyles', RT.styles, 'styles.xml', CT.wStyles, spec.styles)
  add('rIdNumbering', RT.numbering, 'numbering.xml', CT.wNumbering, spec.numbering)
  add('rIdFootnotes', RT.footnotes, 'footnotes.xml', CT.wFootnotes, spec.footnotes)
  add('rIdEndnotes', RT.endnotes, 'endnotes.xml', CT.wEndnotes, spec.endnotes)
  return buildPackage({
    main: {
      name: 'word/document.xml',
      type: spec.macroEnabled ? CT.docmMain : CT.docxMain,
      body: wDocument(spec.body),
      stored: spec.stored,
    },
    parts: [...parts, ...(spec.parts ?? [])],
    rels: {
      'word/document.xml': [...docRels, ...(spec.docRels ?? [])],
      ...(spec.rootRels ? { '': spec.rootRels } : {}),
      ...spec.extraRels,
    },
  })
}

// ── SpreadsheetML ───────────────────────────────────────────────────────────

export interface SheetSpec {
  readonly name: string
  /** `hidden`, `veryHidden`, … — omitted means visible. */
  readonly state?: string
  /** The worksheet's inner XML (`<sheetData>` and friends). */
  readonly xml: string
  /** Leave the sheet out of `<sheets>` (its relationship stays). */
  readonly unlisted?: boolean
  /** An Excel 4.0 macro sheet rather than a worksheet. */
  readonly macro?: boolean
  readonly rels?: readonly Rel[]
}

export interface XlsxSpec {
  readonly sheets: readonly SheetSpec[]
  readonly macroEnabled?: boolean
  readonly styles?: string
  readonly sharedStrings?: string
  /** Inner XML appended to `<workbook>` after `<sheets>`. */
  readonly workbookExtra?: string
  readonly workbookRels?: readonly Rel[]
  readonly rootRels?: readonly Rel[]
  readonly parts?: readonly Part[]
  readonly extraRels?: Readonly<Record<string, readonly Rel[]>>
}

const S_ROOT_NS = `xmlns="${NS.s}" xmlns:r="${NS.r}" xmlns:mc="${NS.mc}"`
const XM = 'http://schemas.microsoft.com/office/excel/2006/main'

export function worksheet(inner: string): string {
  return `${XML_DECL}<worksheet ${S_ROOT_NS}>${inner}</worksheet>`
}

/** A row of inline-string cells. */
export const row = (r: number, cells: readonly string[], attrs = ''): string =>
  `<row r="${r}"${attrs}>` +
  cells
    .map(
      (t, i) => `<c r="${String.fromCharCode(65 + i)}${r}" t="inlineStr"><is><t>${t}</t></is></c>`,
    )
    .join('') +
  '</row>'

export function xlsx(spec: XlsxSpec): Uint8Array {
  const parts: Part[] = []
  const wbRels: Rel[] = []
  const listed: string[] = []
  spec.sheets.forEach((s, i) => {
    const n = i + 1
    const dir = s.macro ? 'macrosheets' : 'worksheets'
    parts.push({
      name: `xl/${dir}/sheet${n}.xml`,
      type: s.macro ? CT.macrosheet : CT.worksheet,
      body: s.macro
        ? `${XML_DECL}<xm:macrosheet xmlns:xm="${XM}" ${S_ROOT_NS}>${s.xml}</xm:macrosheet>`
        : worksheet(s.xml),
    })
    wbRels.push({
      id: `rIdSheet${n}`,
      type: s.macro ? RT.xlMacrosheet : RT.worksheet,
      target: `${dir}/sheet${n}.xml`,
    })
    if (!s.unlisted) {
      listed.push(
        `<sheet name="${s.name}" sheetId="${n}"${s.state ? ` state="${s.state}"` : ''} r:id="rIdSheet${n}"/>`,
      )
    }
  })
  if (spec.styles !== undefined) {
    parts.push({ name: 'xl/styles.xml', type: CT.sStyles, body: spec.styles })
    wbRels.push({ id: 'rIdStyles', type: RT.styles, target: 'styles.xml' })
  }
  if (spec.sharedStrings !== undefined) {
    parts.push({ name: 'xl/sharedStrings.xml', type: CT.sharedStrings, body: spec.sharedStrings })
    wbRels.push({ id: 'rIdStrings', type: RT.sharedStrings, target: 'sharedStrings.xml' })
  }
  const extraSheetRels: Record<string, Rel[]> = {}
  spec.sheets.forEach((s, i) => {
    const dir = s.macro ? 'macrosheets' : 'worksheets'
    if (s.rels) extraSheetRels[`xl/${dir}/sheet${i + 1}.xml`] = [...s.rels]
  })
  return buildPackage({
    main: {
      name: 'xl/workbook.xml',
      type: spec.macroEnabled ? CT.xlsmMain : CT.xlsxMain,
      body:
        `${XML_DECL}<workbook ${S_ROOT_NS}><sheets>${listed.join('')}</sheets>` +
        `${spec.workbookExtra ?? ''}</workbook>`,
    },
    parts: [...parts, ...(spec.parts ?? [])],
    rels: {
      'xl/workbook.xml': [...wbRels, ...(spec.workbookRels ?? [])],
      ...(spec.rootRels ? { '': spec.rootRels } : {}),
      ...extraSheetRels,
      ...spec.extraRels,
    },
  })
}

/** A spreadsheet styles part: `numFmts`, `fonts`, `fills` and `cellXfs` as given. */
export function sStyles(opts: {
  numFmts?: string
  fonts?: readonly string[]
  fills?: readonly string[]
  xfs: readonly string[]
}): string {
  const fonts = opts.fonts ?? ['<font><sz val="11"/></font>']
  const fills = opts.fills ?? [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
  ]
  return (
    `${XML_DECL}<styleSheet xmlns="${NS.s}">` +
    (opts.numFmts ? `<numFmts>${opts.numFmts}</numFmts>` : '') +
    `<fonts>${fonts.join('')}</fonts><fills>${fills.join('')}</fills>` +
    `<cellXfs>${opts.xfs.join('')}</cellXfs></styleSheet>`
  )
}

// ── PresentationML ──────────────────────────────────────────────────────────

export interface SlideSpec {
  /** The slide's `<p:spTree>` inner XML (after the group properties). */
  readonly shapes: string
  /** The raw `show` attribute; omitted means shown. */
  readonly show?: string
  /** Notes text for this slide; omitted means no notes part. */
  readonly notes?: string
  /** Leave the slide out of `<p:sldIdLst>` (its relationship stays). */
  readonly unlisted?: boolean
  readonly rels?: readonly Rel[]
}

export interface PptxSpec {
  readonly slides: readonly SlideSpec[]
  readonly macroEnabled?: boolean
  /** `<p:sldSz>`; default 9,144,000 × 6,858,000 EMU. */
  readonly size?: { readonly cx: number; readonly cy: number }
  /** Inner XML appended to `<p:presentation>` after `<p:notesSz>`. */
  readonly presentationExtra?: string
  readonly presentationRels?: readonly Rel[]
  readonly rootRels?: readonly Rel[]
  readonly parts?: readonly Part[]
  readonly extraRels?: Readonly<Record<string, readonly Rel[]>>
}

const P_ROOT_NS = `xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:mc="${NS.mc}"`

const SP_TREE_HEAD =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'

export function pSlide(shapes: string, show?: string): string {
  return (
    `${XML_DECL}<p:sld ${P_ROOT_NS}${show === undefined ? '' : ` show="${show}"`}>` +
    `<p:cSld><p:spTree>${SP_TREE_HEAD}${shapes}</p:spTree></p:cSld></p:sld>`
  )
}

/** A text shape. `cNvPr` attributes and an `a:rPr` are optional. */
export function shape(
  text: string,
  opts: { id?: number; cNvPr?: string; rPr?: string; xfrm?: string } = {},
): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${opts.id ?? 2}" name="Shape"${opts.cNvPr ? ` ${opts.cNvPr}` : ''}/>` +
    `<p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${opts.xfrm ?? ''}</p:spPr>` +
    `<p:txBody><a:bodyPr/><a:p><a:r>${opts.rPr ?? '<a:rPr lang="en-US"/>'}<a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
  )
}

export function pptx(spec: PptxSpec): Uint8Array {
  const parts: Part[] = []
  const presRels: Rel[] = []
  const ids: string[] = []
  const extra: Record<string, Rel[]> = {}
  spec.slides.forEach((s, i) => {
    const n = i + 1
    const name = `ppt/slides/slide${n}.xml`
    parts.push({ name, type: CT.slide, body: pSlide(s.shapes, s.show) })
    presRels.push({ id: `rIdSlide${n}`, type: RT.slide, target: `slides/slide${n}.xml` })
    if (!s.unlisted) ids.push(`<p:sldId id="${255 + n}" r:id="rIdSlide${n}"/>`)
    const slideRels: Rel[] = [...(s.rels ?? [])]
    if (s.notes !== undefined) {
      const notesName = `ppt/notesSlides/notesSlide${n}.xml`
      parts.push({
        name: notesName,
        type: CT.notesSlide,
        body:
          `${XML_DECL}<p:notes ${P_ROOT_NS}><p:cSld><p:spTree>${SP_TREE_HEAD}` +
          `${shape(s.notes, { id: 3 })}</p:spTree></p:cSld></p:notes>`,
      })
      slideRels.push({
        id: 'rIdNotes',
        type: RT.notesSlide,
        target: `../notesSlides/notesSlide${n}.xml`,
      })
      extra[notesName] = [{ id: 'rIdSlide', type: RT.slide, target: `../slides/slide${n}.xml` }]
    }
    if (slideRels.length > 0) extra[name] = slideRels
  })
  const size = spec.size ?? { cx: 9144000, cy: 6858000 }
  return buildPackage({
    main: {
      name: 'ppt/presentation.xml',
      type: spec.macroEnabled ? CT.pptmMain : CT.pptxMain,
      body:
        `${XML_DECL}<p:presentation ${P_ROOT_NS}><p:sldIdLst>${ids.join('')}</p:sldIdLst>` +
        `<p:sldSz cx="${size.cx}" cy="${size.cy}"/><p:notesSz cx="6858000" cy="9144000"/>` +
        `${spec.presentationExtra ?? ''}</p:presentation>`,
    },
    parts: [...parts, ...(spec.parts ?? [])],
    rels: {
      'ppt/presentation.xml': [...presRels, ...(spec.presentationRels ?? [])],
      ...(spec.rootRels ? { '': spec.rootRels } : {}),
      ...extra,
      ...spec.extraRels,
    },
  })
}

// ── Reading the output ──────────────────────────────────────────────────────

/** Every file of a package, decoded as UTF-8 (lossy for binaries — they only need to be absent). */
export function unpack(bytes: Uint8Array): Map<string, string> {
  return new Map(readZip(bytes).map((e) => [e.name, dec.decode(e.data)]))
}

/** All of a package's text, every part concatenated: "is this sentinel anywhere". */
export function everything(bytes: Uint8Array): string {
  return [...unpack(bytes).entries()].map(([n, t]) => `${n}\n${t}`).join('\n')
}

/**
 * Wrap content in markup compatibility, the rule-bearing half in `branch` —
 * which is always the branch Word renders (A9): a Choice that requires `w14`
 * (understood), or a Fallback behind a Choice that requires a namespace no
 * consumer understands. `other` goes in the branch Word does not render.
 */
export function inAlternateContent(
  ruled: string,
  branch: 'choice' | 'fallback',
  other = '',
  mcPrefix = 'mc',
): string {
  const choice = branch === 'choice' ? ruled : other
  const fallback = branch === 'fallback' ? ruled : other
  const decl = mcPrefix === 'mc' ? '' : ` xmlns:${mcPrefix}="${NS.mc}"`
  const requires =
    branch === 'choice'
      ? `xmlns:w14="${NS.w14}" Requires="w14"`
      : 'xmlns:zz="urn:not-understood" Requires="zz"'
  return (
    `<${mcPrefix}:AlternateContent${decl}>` +
    `<${mcPrefix}:Choice ${requires}>${choice}</${mcPrefix}:Choice>` +
    `<${mcPrefix}:Fallback>${fallback}</${mcPrefix}:Fallback>` +
    `</${mcPrefix}:AlternateContent>`
  )
}
