#!/usr/bin/env python3
"""#551 assertion-red matrix. Same bounded/restoring runner as #549.
Run from app/: python3 scripts/check-ooxml-resolver-mutations.py [names...]
No database, converters, provider calls or production observers.
"""
from pathlib import Path
import importlib.util
import sys

spec = importlib.util.spec_from_file_location('previous', Path(__file__).with_name('check-ooxml-shared-state-mutations.py'))
previous = importlib.util.module_from_spec(spec)
spec.loader.exec_module(previous)
patch, replace = previous.patch, previous.replace
NEW = '__tests__/document/ooxml-resolver.test.ts'


def raw_unknown(source):
    start, end = source.index('interface Resolved {'), source.index('interface StyleDef {')
    source = source[:start] + source[start:end].replace('readonly unknown: boolean', 'readonly unknown: ReadonlySet<string>') + source[end:]
    source += '''\nfunction unknownOf(levels) {
      const all = new Set<string>()
      for (const l of levels) for (const u of l?.unknown ?? []) all.add(u)
      return all
    }\n'''
    source = replace(source, 'unknown: own.some((p) => p.unknown.size > 0) || parents.some((p) => p.unknown),', 'unknown: unknownOf([...own, ...parents]),')
    source = replace(source, 'unknown: parts.some((p) => p.unknown) || (base?.unknown.size ?? 0) > 0,', 'unknown: unknownOf([...parts, base]),')
    return replace(source, 'direct.some((p) => (p?.unknown.size ?? 0) > 0) || styled?.unknown === true', 'unknownOf(all).size > 0')


def flatten_index(source):
    return source + '''\nfunction flattenIndex(node: ContrastNode | undefined): string[] {
      return node ? [...flattenIndex(node.left), node.rgb, ...flattenIndex(node.right)] : []
    }\n'''


def delimiter(source):
    start, end = source.index('function levels('), source.index('// ============================================================================', source.index('function levels('))
    return source[:start] + r'''function levels(styles: WordStyles, rStyles: readonly string[], scope: Scope): Resolved {
      const key = `${rStyles.join('\u0000')}|${scope.pStyles?.join('\u0000') ?? '\u0001'}|${scope.tblStyles?.join('\u0000') ?? '\u0001'}`
      const hit = styles.combined.get(key)
      if (hit) return hit
      const character = styleGroup(styles, rStyles, 'character')
      const paragraph = scope.pStyles === undefined ? undefined : styleGroup(styles, scope.pStyles, 'paragraph')
      const table = scope.tblStyles === undefined ? undefined : styleGroup(styles, scope.tblStyles, 'table')
      const result = mergeStyles([character, paragraph, table].filter(p => p !== undefined), styles, styles.docDefaults)
      styles.combined.set(key, result)
      return result
    }

''' + source[end:]


def raw_shading_level(source):
    source = replace(source, 'result = { unknown, colours }', 'result = { unknown, colours, raw: shds }')
    return replace(source, '  for (const level of scope.tblFills ?? []) {', '''  for (const cached of scope.tblFills ?? []) {
      let unknown = false
      let colours
      for (const s of cached.raw) {
        const bg = shdColours(s, ctx)
        unknown ||= bg.kind === 'unknown'
        if (colours === undefined && bg.kind === 'colours') colours = bg.colours
      }
      const level = { unknown, colours }''')


def copy_inherited(source):
    source = flatten_index(source)
    return replace(source, 'function mergeConditionals(parts: readonly Conditional[], ctx: Shared): Conditional {', '''function mergeConditionals(parts: readonly Conditional[], ctx: Shared): Conditional {
      parts = parts.map(p => ({unknown: p.unknown, index: colourIndex(flattenIndex(p.index))}))''')


def raw_highlight(source):
    source = replace(source, 'readonly highlight?: Highlight', 'readonly highlight?: string', 2)
    source = replace(source, "highlight: compileHighlight(wVal(childEl(rPr, NS.w, 'highlight'))),", "highlight: wVal(childEl(rPr, NS.w, 'highlight')),")
    source = replace(source, "highlight !== undefined && highlight.kind !== 'none'", "highlight !== undefined && highlight.toLowerCase() !== 'none'")
    return replace(source, "const lit = highlight.kind === 'rgb' ? highlight.rgb : undefined", 'const lit = HIGHLIGHT[highlight.toLowerCase()]')


def raw_format_cell(source, which):
    needle = '  const format = xf.format'
    expr = "compileFormat(styles.numFmts.get(xf.numFmtId) ?? '', styles.palette)"
    if which == 'includes':
        return replace(source, needle, needle + "\n  if ((styles.numFmts.get(xf.numFmtId) ?? '').includes('\"\"')) {}")
    if which == 'bare':
        return replace(source, needle, needle + r"""\n  const bare = (styles.numFmts.get(xf.numFmtId) ?? '').replace(/""/g, '').replace(/\[[^\]]*\]/g, '').replace(/\s/g, '')
      if (/^;*$/.test(bare)) {}""".replace('\\n', '\n', 1))
    return replace(source, needle, '  const format = ' + expr)


def cartesian(source, branch):
    if branch == 'font':
        return replace(source, 'contrastFails(baseFillIndex, rgb)', 'against(baseFills).some((bg) => fails(rgb, bg))')
    return replace(source, 'fills.some((bg) => contrastFails(baseFontIndex, bg))', 'fontRgbs.some((fg) => fills.some((bg) => fails(fg, bg)))')


def list_query(source, target):
    source = flatten_index(source)
    if target == 'W7':
        return replace(source, '{ unknown: false, colours: [], index: conditional.index }', '{ unknown: false, colours: flattenIndex(conditional.index) }')
    return replace(source, 'bgs.some((bg) => contrastFails(displayed, bg))', 'flattenIndex(displayed).some(colour => bgs.some(bg => contrastRatio(colour,bg) < MIN_CONTRAST))')


def extrema(source):
    a = source.index('function contrastFails(')
    b = source.index('interface Conditional', a)
    return source[:a] + '''function contrastFails(index: ContrastNode | undefined, rgb: string): boolean {
      if (!index) return false
      let lo = index, hi = index
      while (lo.left) lo = lo.left
      while (hi.right) hi = hi.right
      return contrastRatio(rgb,lo.rgb) < MIN_CONTRAST || contrastRatio(rgb,hi.rgb) < MIN_CONTRAST
    }
''' + source[b:]


MUTATIONS = {
 'W1-union': ('W1 actual work', raw_unknown),
 'W2-delimiter': ('W2 actual work|W2.*long ID', delimiter),
 'W2-stringify': ('W2.*long ID', patch(('  const paragraph =\n', '  JSON.stringify(scope.pStyles)\n  JSON.stringify(scope.tblStyles)\n  const paragraph =\n'))),
 'W2-normalize': ('W2.*long ID', patch(('  const paragraph =\n', '  for (const id of scope.pStyles ?? scope.tblStyles ?? []) id.toLowerCase()\n  const paragraph =\n'))),
 'W3-raw': ('W3 exact long|W3 actual', patch(('let result = ctx.wordColours.get(c)', 'let result: Fg | undefined'))),
 'W3-tint': ('W3 exact long', patch(('  let result = ctx.wordColours.get(c)', '  frac(c?.themeTint)\n  let result = ctx.wordColours.get(c)'))),
 'W4-raw': ('W4 actual work', raw_highlight),
 'W4-none-absent': ('W4 nearer', patch(("if (name === 'none') return { kind: 'none' }", "if (name === 'none') return undefined"))),
 'W4-unknown-absent': ('W4 nearer', patch(("return rgb === undefined ? { kind: 'unknown' } : { kind: 'rgb', rgb }\n}\n\n/** `w:highlight`", "return rgb === undefined ? undefined : { kind: 'rgb', rgb }\n}\n\n/** `w:highlight`"))),
 'W5-raw': ('W5 exact long|W5 actual', patch(('let result = ctx.shadingColours.get(shd)', 'let result: ShdColours | undefined'))),
 'W5-normalize': ('W5 long literal', patch(('  let result = ctx.shadingColours.get(shd)', '  shd.val?.toLowerCase()\n  let result = ctx.shadingColours.get(shd)'))),
 'W6-raw-list': ('W6 actual work', raw_shading_level),
 'W6-late-unknown': ('W6.*reads late', patch(("    if (bg.kind === 'colours' && colours === undefined) colours = bg.colours\n  }\n  result = { unknown, colours }", "    if (bg.kind === 'colours' && colours === undefined) { colours = bg.colours; break }\n  }\n  result = { unknown, colours }"))),
 'W7-assemble': ('W7 distinct conditional', lambda s: list_query(s,'W7')),
 'W7-extrema': ('exact index catches|small colour oracle', extrema),
 'W8-unknown-copy': ('W8-unknown propagation', raw_unknown),
 'W8-parent-copy': ('W8-conditional propagation|W8-added-child propagation|W8 diamond', copy_inherited),
 'W8-loop': ('W8 loop retains', patch(('        f.looped = true', '        f.looped = false'))),
 'W8-depth': ('W8 depth retains', patch(('f.looped || depth > MAX_STYLE_DEPTH', 'f.looped'))),
 'W9-spread': ('W9 append-only', patch(('    bucket.push(definition)\n    byId.set(key, bucket)', '    byId.set(key, [...bucket, definition])'))),
 'W9-concat': ('W9 append-only', patch(('    bucket.push(definition)\n    byId.set(key, bucket)', '    byId.set(key, bucket.concat(definition))'))),
 'W9-slice': ('W9 append-only', patch(('    const bucket = byId.get(key) ?? []', '    const bucket = (byId.get(key) ?? []).slice()'))),
 'W10-group-remap': ('W10.*default groups', patch(('  let group = memo.get(selected)', '  let group: Resolved | undefined'))),
 'X1-size-some': ('X1 actual work', patch(('(rich.minExplicitSize !== undefined && rich.minExplicitSize <= 1)', 'runs.some((r) => (r.sz ?? cellSz ?? 11) <= 1)'))),
 'X1-colour-some': ('X1 actual work', patch(('bgs.some((bg) => contrastFails(rich.colourIndex, bg))', 'runs.some(fails)'))),
 'X1-tuple-miss': ('X1 varying XF', patch(('  const rich = compileRich(runs, ctx)', '''  const tuples = ctx.richTuples ??= new Map()
  const tupleKey = `${xf.fontId}|${xf.fillId}`
  let rich = tuples.get(tupleKey)
  if (!rich) {ctx.richSummaries.delete(runs); rich = compileRich(runs,ctx); tuples.set(tupleKey,rich)}'''))),
 'X1-per-config': ('X1 wide SI|X1 actual work', patch(('  let result = ctx.richSummaries.get(runs)', '  let result: RichSummary | undefined'))),
 'X2-bare-cell': ('X2 actual work', lambda s: raw_format_cell(s,'bare')),
 'X2-includes-cell': ('X2 actual work', lambda s: raw_format_cell(s,'includes')),
 'X2-colour-cell': ('X2 actual work', lambda s: raw_format_cell(s,'colour')),
 'X3-font-cartesian': ('X3 font branch distinct', lambda s: cartesian(s,'font')),
 'X3-fill-cartesian': ('X3 fill branch distinct', lambda s: cartesian(s,'fill')),
 'X3-set-cartesian': ('X3 font branch distinct', patch(('contrastFails(baseFillIndex, rgb)', 'Array.from(new Set(baseFills)).some(bg => fails(rgb,bg))'))),
 'X3-extrema': ('exact index catches|small colour oracle', extrema),
 'X4-raw': ('X4 malformed|X4 exact long', patch(('  let result = ctx.sheetColours.get(c)', '  let result: {rgb?: string} | undefined'))),
 'X4-tint': ('X4 exact long', patch(('  let result = ctx.sheetColours.get(c)', "  Number.parseFloat(c.tint ?? '0')\n  let result = ctx.sheetColours.get(c)"))),
 'X4-negative': ('X4 malformed', patch(('  if (!result) {\n    result = { rgb: evaluateRgb(c, ctx) }', '  if (!result?.rgb) {\n    result = { rgb: evaluateRgb(c, ctx) }'))),
 'X5-list-query': ('X5 distinct palette', lambda s: list_query(s,'X5')),
 'X5-first-section': ('X5 late section', patch(('    if (rgb !== undefined) displayedColourIndex = insertColour(displayedColourIndex, rgb)', '    if (rgb !== undefined && !displayedColourIndex) displayedColourIndex = insertColour(displayedColourIndex, rgb)'))),
 'X5-extrema': ('exact index catches|small colour oracle', extrema),
 'X6-bare-regex': ('X2/X6 linear scanner', patch(("  const bare = chunks.join('').replace(/\\s/g, '')", "  const bare = unquoted.replace(/\\[[^\\]]*\\]/g, '').replace(/\\s/g, '')"))),
 'X6-colour-regex': ('X2/X6 linear scanner', patch(('  bracketSpans(format, (start, end) => {', "  for (const m of format.matchAll(/\\[([^\\]]+)\\]/g)) {}\n  bracketSpans(format, (start, end) => {"))),
 'X6-rescan-tail': ('X2/X6 linear scanner', patch(('    if (end < 0) break', '    if (end < 0) { cursor = start + 1; continue }'))),
 'P1-raw-lower': ('P1/P2 metadata|P1 invalid default', patch(('pkg.typeRecord(entry.name)?.lower !== ROLE_TYPE', 'type?.toLowerCase() !== ROLE_TYPE'))),
 'P2-raw-category': ('P1/P2 metadata', patch(('  const n = name.toLowerCase()', "  type?.raw.toLowerCase()\n  for (const [, re] of CATEGORIES) re.test(type?.raw.toLowerCase() ?? '')\n  const n = name.toLowerCase()"))),
 'K-delimiter': ('K delimiter', delimiter),
 'D1-size': ('D1 merged', previous.MUTATIONS['C1-size'][2]),
 'D1-baseline': ('D1 merged', previous.MUTATIONS['C1-baseline'][2]),
}
previous.MUTATIONS = {name: (NEW, pattern, mutate) for name, (pattern, mutate) in MUTATIONS.items()}
if __name__ == '__main__':
    sys.exit(previous.main())
