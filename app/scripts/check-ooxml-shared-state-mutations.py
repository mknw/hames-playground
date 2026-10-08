#!/usr/bin/env python3
"""#536 synthetic, bounded mutation evidence. Run from app/; always restore source.

One process per mutation (90s hard timeout); a timeout is NOT accepted as red.
Uses package Vitest config, so no database/global setup or provider is reached.
Pass mutation names to select rows; no args executes the complete matrix.
"""
from pathlib import Path
import os
import fcntl
import signal
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'packages/connectors/document/ooxml-disarm.server.ts'
NEW = '__tests__/document/ooxml-shared-state.test.ts'
OLD = '__tests__/document/ooxml-disarm.test.ts'


def replace(source, before, after, count=1):
    assert source.count(before) >= count, before
    return source.replace(before, after, count)


def patch(*changes):
    def mutate(source):
        for before, after in changes:
            source = replace(source, before, after)
        return source
    return mutate


def part_syntax(source):
    return replace(source, '    const rewritten = rewritePart(root, {', '''    shared.syntax.levels.clear()
    shared.syntax.fills.clear()
    shared.syntax.colours.clear()
    shared.syntax.backgrounds.clear()
    const rewritten = rewritePart(root, {''')


def raw_level(source):
    source = replace(source, '  let hit = ctx.levelMemo.levels.get(props)', '  let hit: LevelEval | undefined')
    return replace(source, '  const hit = syntax.levels.get(props)', '  const hit: LevelSyntax | undefined = undefined')


def inherited_scan(source):
    source = replace(source, '  readonly fontScale?: number', '  readonly bodyPr?: XmlElement\n  readonly fontScale?: number')
    source = replace(source, '          fontScale: autofitScale(', "          bodyPr: childEl(childEl(el, NS.p, 'txBody'), NS.a, 'bodyPr'),\n          fontScale: autofitScale(")
    return replace(source, 'layoutMatch.entry?.fontScale', '(layoutMatch.entry ? autofitScale(layoutMatch.entry.bodyPr) : undefined)')


def tree_scan(source):
    source = replace(source, 'interface SlidesStylePart {', 'interface SlidesStylePart {\n  readonly root: XmlElement')
    source = replace(source, 'return { byTypeIdx, byIdx, byType, byStyle, bg, clrMap, clrMapOvr: clrMapOvrOf(root) }', 'return { root, byTypeIdx, byIdx, byType, byStyle, bg, clrMap, clrMapOvr: clrMapOvrOf(root) }')
    return replace(source, '  if (!part || !ph) return { ambiguous: false }', '  if (part) readSlidesStylePart(part.root)\n  if (!part || !ph) return { ambiguous: false }')


def hoist_resolved(source, kind):
    source = replace(source, 'interface DrawingSyntax {', 'interface DrawingSyntax {\n  readonly resolved: Map<XmlElement, LevelEval | DFill>')
    source = replace(source, 'syntax: { levels:', 'syntax: { resolved: new Map(), levels:') if 'syntax: { levels:' in source else replace(source, '    syntax: {', '    syntax: {\n      resolved: new Map(),')
    memo = 'levels' if kind == 'level' else 'fills'
    return source.replace(f'ctx.levelMemo.{memo}.get(', 'ctx.syntax.resolved.get(').replace(f'ctx.levelMemo.{memo}.set(', 'ctx.syntax.resolved.set(')


MUTATIONS = {
    'A-direct-level': (NEW, '#536 A/B.*resolves fill', patch(('  let hit = ctx.levelMemo.levels.get(props)', '  let hit: LevelEval | undefined'))),
    'A-raw-level': (OLD, '#524:.*paragraph.*padding children$', raw_level),
    'A-union': (OLD, '#524:.*DISTINCTLY named padding children$', patch(('  let unknown = false\n  let fill: DFill | undefined', '  let unknown = false\n  const all = new Set<string>()\n  let fill: DFill | undefined'), ('    if (level.unknown.size > 0) unknown = true', '    for (const name of level.unknown) all.add(name)\n    if (all.size > 0) unknown = true'))),
    'A-content-key': (NEW, '#536 D.*layout-level structural', patch(('ctx.levelMemo.levels.get(props)', 'ctx.levelMemo.levels.get(JSON.stringify(props) as unknown as XmlElement)'), ('ctx.levelMemo.levels.set(props, hit)', 'ctx.levelMemo.levels.set(JSON.stringify(props) as unknown as XmlElement, hit)'))),
    'B-direct-fill': (NEW, '#536 A/B.*inherited solid', patch(('  let hit = ctx.levelMemo.fills.get(el)', '  let hit: DFill | undefined'))),
    'B-content-key': (NEW, '#536 D.*layout-fill structural', patch(('ctx.levelMemo.fills.get(el)', 'ctx.levelMemo.fills.get(JSON.stringify(el) as unknown as XmlElement)'), ('ctx.levelMemo.fills.set(el, hit)', 'ctx.levelMemo.fills.set(JSON.stringify(el) as unknown as XmlElement, hit)'))),
    'C1-size': (NEW, '#536 C1.*parses long', patch(('    if (level?.size === undefined) continue\n    const pt = (level.size / 100)', "    const raw = int(attrOf(chain[evaluated.indexOf(level)]?.attributes ?? [], 'sz'))\n    if (raw === undefined) continue\n    const pt = (raw / 100)"))),
    'C1-baseline': (NEW, '#536 C1.*parses long', patch(("  const baselineScale = evaluated.find((l) => l?.baselineScale !== undefined)?.baselineScale ?? 1", "  let baselineScale = 1\n  for (const props of chain) {\n    const raw = attrOf(props?.attributes ?? [], 'baseline')\n    if (raw !== undefined) { baselineScale = int(raw) === 0 ? 1 : VERT_ALIGN_SCALE; break }\n  }"))),
    'C1-invalid-baseline': (NEW, '#536 C1.*present invalid', patch(('baseline === undefined ? undefined : int(baseline) === 0 ? 1 : VERT_ALIGN_SCALE', 'int(baseline) === undefined ? undefined : int(baseline) === 0 ? 1 : VERT_ALIGN_SCALE'))),
    'C1-invalid-size': (NEW, '#536 C1.*present invalid', patch(("size: int(attrOf(props.attributes, 'sz'))", "size: attrOf(props.attributes, 'sz') === undefined ? undefined : int(attrOf(props.attributes, 'sz')) ?? 1800"))),
    'C2-run-parse': (NEW, '#536 C2', patch(('  readonly fillRefPositive: boolean', '  readonly fillRef?: XmlElement\n  readonly fillRefPositive: boolean'), ('          fillRefPositive:', '          fillRef: ref,\n          fillRefPositive:'), ("if (f.kind === 'absent' && entry.fillRefPositive) f = { kind: 'unknown' }", "if (f.kind === 'absent' && (int(attrOf(entry.fillRef?.attributes ?? [], 'idx')) ?? 0) > 0) f = { kind: 'unknown' }"))),
    'D-per-part-compile': (NEW, '#536 D.*(structural|CPU)', part_syntax),
    'D-hoist-level': (OLD, '#524:.*the key:', lambda s: hoist_resolved(s, 'level')),
    'D-hoist-fill': (OLD, '#524:.*the key:', lambda s: hoist_resolved(s, 'fill')),
    'D-hoist-bg': (NEW, '#536 D.*bg resolves opposite', patch(('  inheritance.bgLevels ??=', '  ctx.syntax.bgLevels ??='), ('  for (const level of inheritance.bgLevels)', '  for (const level of ctx.syntax.bgLevels)'))),
    'E-materialise': (NEW, '#536 E.*(solid-siblings|pattern-holders|gsLst-padding|stop-padding)', patch(('return resolveFill(compileFill(el, syntax), s)', 'return resolveFill(compileFill(el), s)'), ("  for (const c of el?.children ?? []) if (typeof c !== 'string') return c\n  return undefined", '  return el ? elements(el)[0] : undefined'))),
    'E-no-transform-bound': (NEW, '#536 E.*(17 transforms|paired cap)', patch(('const COLOUR_TRANSFORMS_MAX = 16', 'const COLOUR_TRANSFORMS_MAX = Infinity'))),
    'E-late-stop-bound': (NEW, '#536 E.*gradient stops, before', patch(("        if (stops.length > GRAD_STOPS_MAX) return { kind: 'unknown' }", ''), ("      return { kind: 'grad', stops: stops.map((g) => compileColour(firstElement(g), syntax)) }", "      const resolved = stops.map((g) => compileColour(firstElement(g), syntax))\n      if (stops.length > GRAD_STOPS_MAX) return { kind: 'unknown' }\n      return { kind: 'grad', stops: resolved }"))),
    'E-element-only': (NEW, '#536 E.*(bgRef phClr|phClr and slide overrides)', patch(('interface DrawingSyntax {', 'interface DrawingSyntax {\n  resolvedFills?: Map<XmlElement, DFill>'), ('  return resolveFill(compileFill(el, syntax), s)', '  if (!syntax) return resolveFill(compileFill(el), s)\n  syntax.resolvedFills ??= new Map()\n  let hit = syntax.resolvedFills.get(el)\n  if (!hit) { hit = resolveFill(compileFill(el, syntax), s); syntax.resolvedFills.set(el, hit) }\n  return hit'))),
    'E-unknown-benign': (NEW, '#536 E.*(17 transforms|paired cap)', patch(('const COLOUR_UNKNOWN: ColourSyntax = { kind:', "const COLOUR_UNKNOWN: ColourSyntax = { value: '000000', kind:"), ("value: '000000', kind: 'unknown'", "value: '000000', kind: 'rgb'"))),
    'F-no-parsed-cache': (NEW, '#536 F.*scanned', patch(('    if (hit !== undefined) return hit\n    const entry = this.get(relsPartName(source))', '    const entry = this.get(relsPartName(source))'))),
    'F-cache-only': (NEW, '#536 F.*scanned', patch(('  if (cached !== undefined) return cached', ''), ('  const rel = pkg.firstInternal(source, type)', '  const rel = pkg.relsOf(source).find((r) => r.type === type && !r.external)'))),
    'G-no-true-cache': (NEW, '#536 G.*show=undefined', patch(('          shown = visibility.get(entry)', '          shown = visibility.get(entry)\n          if (shown === true) shown = undefined'))),
    'G-no-false-cache': (NEW, '#536 G.*show=0', patch(('          shown = visibility.get(entry)', '          shown = visibility.get(entry)\n          if (shown === false) shown = undefined'))),
    'H-run-lookup': (NEW, '#536 H', patch(('  if (hit !== undefined) return hit\n  const layoutMatch = layoutPh', '  const layoutMatch = layoutPh'))),
    '515-tree-reread': (OLD, '#492 F2:.*placeholder resolution', tree_scan),
    '521-B1-autofit-reread': (OLD, 'inherited fill and autofit cost one step per run', inherited_scan),
    '525-bg-memo': (NEW, '#536 background resolved memo retained', patch(('  inheritance.bgLevels ??=', '  inheritance.bgLevels ='))),
    '525-no-stop-bound': (OLD, '#522:.*gradient|#525:', patch(('const GRAD_STOPS_MAX = 10', 'const GRAD_STOPS_MAX = Infinity'))),
    '525-stop-bound-1': (OLD, '#525:|layout placeholder text gradient', patch(('const GRAD_STOPS_MAX = 10', 'const GRAD_STOPS_MAX = 1'))),
    '525-stop-bound-100': (OLD, '#525:|layout placeholder text gradient', patch(('const GRAD_STOPS_MAX = 10', 'const GRAD_STOPS_MAX = 100'))),
}


def main():
    selected = sys.argv[1:] or list(MUTATIONS)
    lock = Path(tempfile.gettempdir()) / ('ooxml-mutation-' + str(ROOT).replace('/', '_') + '.lock')
    guard = lock.open('w')
    fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
    original = SOURCE.read_text()
    report = Path(tempfile.mkdtemp(prefix='ooxml-536-mutations-'))
    print(f'Logs: {report}', flush=True)
    env = dict(os.environ, TEST_DATABASE_URL='postgresql://x:x@127.0.0.1:59999/x')
    rows = []
    try:
        for name in selected:
            test, pattern, mutate = MUTATIONS[name]
            SOURCE.write_text(mutate(original))
            command = ['pnpm', 'exec', 'vitest', 'run', '--config', '../packages/connectors/vitest.config.ts', '--root', '../packages/connectors', test, '-t', pattern]
            log = report / f'{name}.log'
            with log.open('w') as output:
                child = subprocess.Popen(command, cwd=ROOT / 'app', env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    code = child.wait(timeout=90)
                    text = log.read_text()
                    # Assertion red, never a timeout, transform failure or zero selected tests.
                    red = code != 0 and 'AssertionError:' in text and 'Tests' in text
                except subprocess.TimeoutExpired:
                    red = False
                    text = 'TIMEOUT'
                finally:
                    # Kill only this run's process group, including Vitest's fork.
                    try:
                        os.killpg(child.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    child.wait()
            SOURCE.write_text(original)
            status = 'red' if red else 'NOT VERIFIED'
            rows.append(f'| {name} | {pattern} | {status} |')
            print(f'{name}: {status}', flush=True)
            if not red:
                print(text[-3000:], flush=True)
    finally:
        SOURCE.write_text(original)
        assert SOURCE.read_text() == original
    (report / 'table.md').write_text('\n'.join(rows) + '\n')
    return 0 if all('NOT VERIFIED' not in row for row in rows) else 1


if __name__ == '__main__':
    sys.exit(main())
