#!/usr/bin/env python3
"""#551 assertion-red matrix. Same bounded/restoring runner as #549.
Run from app/: python3 scripts/check-ooxml-resolver-mutations.py [names...]
No database, converters, provider calls or production observers.
"""
from pathlib import Path
import importlib.util
import subprocess
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


def flatten_set(source):
    return source + '''\nfunction flattenSet(c: Conditional): string[] {
      const out: string[] = []
      const walk = (s: ColourSet | undefined, lo: number, hi: number): void => {
        if (!s) return
        if (hi - lo === 1) { out.push(c.domain!.rgbs[lo]); return }
        const mid = (lo + hi) >> 1
        walk(s.left, lo, mid)
        walk(s.right, mid, hi)
      }
      walk(c.set, 0, c.domain?.rgbs.length ?? 0)
      return out
    }\n'''


def copy_inherited_set(source):
    return replace(flatten_set(source), 'function mergeConditionals(parts: readonly Conditional[], domain: ColourDomain): Conditional {\n', '''function mergeConditionals(parts: readonly Conditional[], domain: ColourDomain): Conditional {
      parts = parts.map((p) => ({ ...p, set: flattenSet(p).reduce<ColourSet | undefined>((set, rgb) => insertSet(set, 0, domain.rgbs.length, domain.at.get(rgb)!), undefined) }))
''')


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
    # The fixed-domain helpers now precede Conditional; do not delete them.
    b = source.index('/** The styles part\'s conditional shading colours', a)
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
 'W7-assemble': ('W7 distinct conditional', lambda s: replace(flatten_set(s), '{ unknown: false, colours: [], conditional }', '{ unknown: false, colours: flattenSet(conditional) }')),
 'W7-extrema': ('exact index catches|small colour oracle', extrema),
 'W8-unknown-copy': ('W8-unknown propagation', raw_unknown),
 'W8-parent-copy': ('W8-conditional propagation|W8-added-child propagation|W8 diamond', copy_inherited_set),
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
 'F1-no-merge-memo': ('#558 F1', patch(('  const hit = domain.merged.get(a)?.get(b) ?? domain.merged.get(b)?.get(a)', '  const hit: ColourSet | undefined = undefined'))),
 'F1-upper-only': ('#558 F1', patch(('    (lower >= 0 && contrastRatio(rgb, domain.rgbs[lower]) < MIN_CONTRAST) ||', '    false ||'))),
 'F1-lower-only': ('#558 F1', patch(('    (upper >= 0 && contrastRatio(rgb, domain.rgbs[upper]) < MIN_CONTRAST)\n  )\n}\nfunction compileConditional', '    false\n  )\n}\nfunction compileConditional'))),
 'F1-extrema': ('#558 F1', patch(('  const lower = lastBelow(set, 0, domain.rgbs.length, lo)\n  const upper = firstFrom(set, 0, domain.rgbs.length, lo)', '  const lower = firstFrom(set, 0, domain.rgbs.length, 0)\n  const upper = lastBelow(set, 0, domain.rgbs.length, domain.rgbs.length)'))),
 'F2-W2-upper': ('#558 F2|W2 actual work|W2.*long ID', patch(('  const paragraph =\n    scope.pStyles === undefined', '  void scope.pStyles?.[0]?.toUpperCase()\n  void scope.tblStyles?.[0]?.toUpperCase()\n  const paragraph =\n    scope.pStyles === undefined'))),
 'F2-W2-charcode': ('#558 F2', patch(('  const paragraph =\n    scope.pStyles === undefined', "  const shared = scope.tblStyles?.[0] ?? scope.pStyles?.[0] ?? ''\n  let h = 0\n  for (let i = 0; i < shared.length; i++) h += shared.charCodeAt(i)\n  if (h < 0) return undefined as never\n  const paragraph =\n    scope.pStyles === undefined"))),
 'F2-W3-upper': ('#558 F2|W3 actual work|W3 exact long', patch(('function wordFg(c: WordColor | undefined, ctx: Shared): Fg {\n', 'function wordFg(c: WordColor | undefined, ctx: Shared): Fg {\n  void c?.themeTint?.toUpperCase()\n'))),
 'F2-X2-upper': ('#558 F2|X2 actual work', patch(('  const format = xf.format\n', "  const format = xf.format\n  void (styles.numFmts.get(xf.numFmtId) ?? '').toUpperCase()\n"))),
 'F2-X2-charcode': ('#558 F2', patch(('  const format = xf.format\n', "  const format = xf.format\n  const raw = styles.numFmts.get(xf.numFmtId) ?? ''\n  let h = 0\n  for (let i = 0; i < raw.length; i++) h += raw.charCodeAt(i)\n  if (h < 0) return\n"))),
 'F2-P1-locale': ('#558 F2|P1 actual work', patch(('if (pkg.typeRecord(entry.name)?.lower !== ROLE_TYPE[role as keyof typeof ROLE_TYPE]) continue', 'if (pkg.typeOf(entry.name)?.toLocaleLowerCase() !== ROLE_TYPE[role as keyof typeof ROLE_TYPE]) continue'))),
 'F3-K-run-join': ('#558 classification', patch(('''  let trie: StyleTrie = tables.get(table) ?? { next: new Map() }
  if (!tables.has(table)) tables.set(table, trie)
  for (const id of rStyles) {
    let next: StyleTrie | undefined = trie.next.get(id)
    if (!next) {
      next = { next: new Map() }
      trie.next.set(id, next)
    }
    trie = next
  }''', '''  const root: StyleTrie = tables.get(table) ?? { next: new Map() }
  if (!tables.has(table)) tables.set(table, root)
  const joined = rStyles.join(String.fromCharCode(0))
  let trie: StyleTrie | undefined = root.next.get(joined)
  if (!trie) {
    trie = { next: new Map() }
    root.next.set(joined, trie)
  }'''))),
 'F4-nul-key': ('#558 classification', patch(('          [ofType, ph.idx],', '          [byTypeIdx as unknown as Map<string, PhEntry>, `${ph.type}\\0${ph.idx}`],'), ('  const exact = part.byTypeIdx.get(ph.type)?.get(ph.idx)', '  const exact = (part.byTypeIdx as unknown as Map<string, PhEntry>).get(`${ph.type}\\0${ph.idx}`)'))),
 'F5-prototype': ('#558 classification', patch(('  const rgb = Object.hasOwn(HIGHLIGHT, name) ? HIGHLIGHT[name] : undefined', '  const rgb = HIGHLIGHT[name]'), ('    let rgb = Object.hasOwn(FORMAT_COLOURS, key) ? FORMAT_COLOURS[key] : undefined', '    let rgb: string | undefined = FORMAT_COLOURS[key]'))),
 'F6-first-part': ('#558 classification|#558 F1', patch(('    set = mergeSets(set, part.set, 0, domain.rgbs.length, domain)', '    set ??= part.set'))),
 'F7-index-upper-only': ('#558 classification', patch(('    (lower !== undefined && contrastRatio(rgb, lower.rgb) < MIN_CONTRAST) ||\n', '    false ||\n'))),
 'F8-highlight-case': ('#558 classification', patch(("  const name = value.toLowerCase()\n  if (name === 'none')", "  const name = value\n  if (name === 'none')"))),
 'D1-size': ('D1 merged', previous.MUTATIONS['C1-size'][2]),
 'D1-baseline': ('D1 merged', previous.MUTATIONS['C1-baseline'][2]),
}
previous.MUTATIONS = {name: (NEW, pattern, mutate) for name, (pattern, mutate) in MUTATIONS.items()}


def module_content_memo(source, field, result_type, key):
    source += f'\nconst reviewModuleMemo = new Map<string, {result_type}>()\n'
    return source.replace(f'ctx.{field}.get({key})', f'reviewModuleMemo.get(JSON.stringify({key}))').replace(f'ctx.{field}.set({key}, result)', f'reviewModuleMemo.set(JSON.stringify({key}), result)')


# The review's remaining named semantic mutations, including the #492 pins
# that the resolver-only file cannot replace. R1-R5/R13/R15/R16/R21/R22 are
# the corresponding F2/F3/F8/F7/F6 rows above, verbatim from the review patch.
previous.MUTATIONS.update({
 'R6-X4-module-content': (NEW, 'X4', lambda s: module_content_memo(s, 'sheetColours', '{rgb?: string}', 'c')),
 'R7-W3-module-content': (NEW, 'W3', lambda s: module_content_memo(s, 'wordColours', 'Fg', 'c')),
 'R8-rich-run-count': (previous.OLD, '#492', patch(('ctx.richSummaries.get(runs)', 'ctx.richSummaries.get(runs.length as never)'), ('ctx.richSummaries.set(runs, result)', 'ctx.richSummaries.set(runs.length as never, result)'))),
 'R9-group-first-ID': (NEW, 'W2|W10|classification', patch(('memo.get(selected)', 'memo.get(selected[0] as never)'), ('memo.set(selected, group)', 'memo.set(selected[0] as never, group)'))),
 'R10-Shd-fill-key': (NEW, 'W5', patch(('ctx.shadingColours.get(shd)', 'ctx.shadingColours.get(shd.fill as never)'), ('ctx.shadingColours.set(shd, result)', 'ctx.shadingColours.set(shd.fill as never, result)'))),
 'R11-W6-last-opaque': (NEW, 'W6', patch(("if (bg.kind === 'colours' && colours === undefined) colours = bg.colours", "if (bg.kind === 'colours') colours = bg.colours"))),
 'R12-P2-type-first': (NEW, 'P1/P2 metadata', patch(('Math.min(rank < 0 ? Infinity : rank, type?.categoryRank ?? Infinity)', 'type?.categoryRank ?? (rank < 0 ? Infinity : rank)'))),
 'R14-W1-size-gt-one': (previous.OLD, '#492', patch(('(p?.unknown.size ?? 0) > 0', '(p?.unknown.size ?? 0) > 1'), ('own.some((p) => p.unknown.size > 0)', 'own.some((p) => p.unknown.size > 1)'))),
 'R17-dxf-unknown-benign': (NEW, 'X3 own/empty', patch(('if (own.unknown) return true', 'if (own.unknown) return false'))),
 'R18-rich-first-size': (NEW, 'X1', patch(('minExplicitSize = Math.min(minExplicitSize ?? run.sz, run.sz)', 'minExplicitSize ??= run.sz'))),
 'R19-unresolved-rich-benign': (NEW, 'X1/X4 unresolved', patch(('if (rgb === undefined) anyUnresolvedColour = true', 'if (rgb === undefined) anyUnresolvedColour = false'))),
 'R20-format-plus-font': (previous.OLD, '#492', patch(('if (bgs.some((bg) => contrastFails(displayed, bg)))', 'if (fails(styles.fonts[xf.fontId]) || bgs.some((bg) => contrastFails(displayed, bg)))'))),
 'F1-reviewed-AVL': (NEW, '#558 F1', lambda s: subprocess.check_output(['git', 'show', '555adae6:packages/connectors/document/ooxml-disarm.server.ts'], cwd=previous.ROOT).decode()),
})
if __name__ == '__main__':
    sys.exit(previous.main())
