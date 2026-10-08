"""S6 component mutations: run from app/, restore source even on failure."""
from pathlib import Path
import os
import subprocess

DETAIL = 'src/components/ark-ui/observability/EventDetail.tsx'
ROWS = 'src/components/ark-ui/observability/TimelineRows.tsx'
PIN = 'src/__tests__/components/ark-ui/EventDetail.test.tsx'
CASES = [
    ('draw-at-the-mode', DETAIL, 'pct(props.data.expected! / (props.data.labels.length - 1))', 'pct(props.data.labels.findIndex(l => l.id === props.data.top) / (props.data.labels.length - 1))', 'draws the score mean'),
    ('drop-noul-band', DETAIL, 'data-role="decision-band"', 'data-role="removed-band"', 'noul band follows'),
    ('band-left-at-half', DETAIL, 'pct((1 - cut()!) / 2)', 'pct(0.5)', 'noul band follows'),
    ('band-width-constant', DETAIL, 'width: pct(cut()!)', 'width: pct(0.5)', 'noul band follows'),
    ('preview-always-choice', ROWS, "(data as DecisionMadeEventData).type ?? 'choice'", "'choice'", 'preview chip names'),
    ('legacy-choice-hidden', DETAIL, "props.data.type !== 'noul'", "props.data.type === 'score'", 'preserves persisted choice'),
    ('missing-mean-at-zero', DETAIL, 'props.data.expected != null && props.data.labels.length > 1', 'props.data.labels.length > 1', 'does not invent a score mean'),
    ('unknown-noul-at-zero', DETAIL, 'when={props.data.pTrue != null}', 'when={true}', 'shows unknown noul'),
    ('invent-undeclared-band', DETAIL, 'when={cut() !== undefined}', 'when={true}', 'shows a noul with no declared cut'),
]
if __name__ == '__main__':
    env = {**os.environ, 'TEST_DATABASE_URL': 'postgresql://x:x@127.0.0.1:59999/x'}
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
