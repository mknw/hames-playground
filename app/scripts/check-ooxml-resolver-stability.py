#!/usr/bin/env python3
"""Bounded #551 stability loop: three ordinary runs, three under CPU load.
Runs connector layer-1 pins only, never app global setup or a provider.
Each child has a 120s external deadline; only owned child PIDs/groups are killed.
"""
from pathlib import Path
import json
import os
import signal
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def main():
    report = Path(tempfile.mkdtemp(prefix='ooxml-551-stability-'))
    rows = []
    command = ['pnpm', 'exec', 'vitest', 'run', '--config', '../packages/connectors/vitest.config.ts', '--root', '../packages/connectors', '__tests__/document/ooxml-resolver.test.ts']
    env = dict(os.environ, TEST_DATABASE_URL='postgresql://x:x@127.0.0.1:59999/x')
    print(f'Logs: {report}', flush=True)
    for mode in ('normal', 'loaded'):
        for repeat in range(1, 4):
            load = []
            child = None
            log = report / f'{mode}-{repeat}.log'
            try:
                if mode == 'loaded':
                    for _ in range(2):
                        load.append(subprocess.Popen([sys.executable, '-c', 'import time\nend=time.monotonic()+120\nn=1\nwhile time.monotonic()<end: n=(n*1664525+1013904223)&0xffffffff'], start_new_session=True))
                with log.open('w') as output:
                    child = subprocess.Popen(command, cwd=ROOT/'app', env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
                    try:
                        code = child.wait(timeout=120)
                    except subprocess.TimeoutExpired:
                        code = 124
                rows.append({'mode': mode, 'repeat': repeat, 'exit': code, 'log': str(log)})
                print(f'{mode}-{repeat}: {code}', flush=True)
                if code:
                    print(log.read_text()[-4000:], flush=True)
                    return 1
            finally:
                for process in [child, *load]:
                    if process is None:
                        continue
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    process.wait()
                (report/'results.json').write_text(json.dumps(rows, indent=2)+'\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
