"""S6 component mutations: run from app/, restore source even on failure."""
from pathlib import Path
import os
import subprocess

DETAIL = 'src/components/ark-ui/observability/EventDetail.tsx'
ROWS = 'src/components/ark-ui/observability/TimelineRows.tsx'
PIN = 'src/__tests__/components/ark-ui/EventDetail.test.tsx'
CASES = [
    ('draw-at-the-mode', DETAIL, 'pct(props.data.expected! / (props.data.labels.length - 1))', 'pct(props.data.labels.findIndex(l => l.id === props.data.top) / (props.data.labels.length - 1))', 'draws the score mean'),
    ('preview-always-choice', ROWS, "(data as DecisionMadeEventData).type ?? 'choice'", "'choice'", 'preview chip names'),
    ('legacy-choice-hidden', DETAIL, "props.data.type !== 'noul'", "props.data.type === 'score'", 'preserves persisted choice'),
    ('missing-mean-at-zero', DETAIL, 'finiteMean() && props.data.labels.length > 1', 'props.data.labels.length > 1', 'does not invent a score mean'),
    ('unknown-noul-at-zero', DETAIL, 'when={finitePTrue()}', 'when={true}', 'shows unknown noul'),
    ('mean-wrong-denominator', DETAIL, 'pct(props.data.expected! / (props.data.labels.length - 1))', 'pct(props.data.expected! / props.data.labels.length)', 'draws the score mean'),
    ('score-meter-unpositioned', DETAIL, 'relative=""', '', 'draws the score mean'),
    ('restore-fixed-dark-surface', DETAIL, "? 'var(--ui-bg-secondary)'", "? 'rgba(13, 17, 23, 0.95)'", 'readout contrast'),
    ('nullable-only-mean', DETAIL, 'Number.isFinite(props.data.expected)', 'props.data.expected != null', 'does not invent a score mean'),
    ('nullable-only-ptrue', DETAIL, 'Number.isFinite(props.data.pTrue)', 'props.data.pTrue != null', 'shows unknown noul'),
    ('bypass-finite-score-probability', DETAIL, "props.data.type !== 'score' || Number.isFinite(p())", 'true', 'shows unknown nonfinite score probability'),
    ('noul-meter-unpositioned', DETAIL, 'h="3"\n              bg="ui-bg-tertiary"\n              rounded="sm"\n              relative=""', 'h="3"\n              bg="ui-bg-tertiary"\n              rounded="sm"', 'renders the noul probability in a positioned meter'),

]
if __name__ == '__main__':
    env = {**os.environ, 'CI': '1'}
    for name, filename, old, new, test in CASES:
        path = Path(filename)
        source = path.read_text()
        if old not in source:
            raise RuntimeError(f'{name}: missing anchor')
        try:
            path.write_text(source.replace(old, new, 1))
            result = subprocess.run(['pnpm', 'exec', 'vitest', 'run', PIN, '-t', test], env=env, capture_output=True, text=True)
            output = result.stdout + result.stderr
            if result.returncode == 0 or 'AssertionError' not in output:
                print(output)
                raise RuntimeError(f'{name}: no assertion RED')
            print(f'{name}: assertion RED', flush=True)
        finally:
            path.write_text(source)
