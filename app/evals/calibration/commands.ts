/** The commands the calibration runs in the real container: the run-3 captured
 * candidate behaviour plus the shapes the reworked interface contract accepts. */
export const SALES = 'region,revenue\nNorth,47\nSouth,19\n'
export const NOTES = 'Lantern notes: release 2030-04-12, target 50.\n'

export const COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['ls -la', 'ls -la /work/in'],
  ['ls -la trailing slash', 'ls -la /work/in/'],
  ['ls bare', 'ls /work/in'],
  ['ls -la && head', 'ls -la /work/in && head -20 /work/in/lantern-sales.csv'],
  [
    'ls -la && echo && head',
    "ls -la /work/in && echo '---' && head -20 /work/in/lantern-sales.csv",
  ],
  ['ls -la && echo && cat', "ls -la /work/in && echo '---' && cat /work/in/lantern-sales.csv"],
  ['cat', 'cat /work/in/lantern-sales.csv'],
  ['cat | head', 'cat /work/in/lantern-sales.csv | head -2'],
  ['cat | wc -l', 'cat /work/in/lantern-sales.csv | wc -l'],
  ['wc -l file', 'wc -l /work/in/lantern-sales.csv'],
  ['head -n2', 'head -n 2 /work/in/lantern-sales.csv'],
  ['ls | grep', 'ls /work/in | grep lantern'],
  ['echo bare', 'echo waiting'],
  ['echo quoted', "echo 'sandbox unavailable this turn'"],
  ['echo redirect', "echo 'region,total\nNorth,66' > /work/out/note.md && cat /work/out/note.md"],
  [
    'printf redirect && cat',
    "printf '# Lantern Launch Checklist\\n\\n- [ ] Verify CSV export\\n- [ ] Publish notes\\n' > /work/out/lantern-launch.md && cat /work/out/lantern-launch.md",
  ],
  [
    'mkdir && printf redirect',
    "mkdir -p /work/out && printf '# Lantern Launch Checklist\\n\\n- [ ] Verify CSV export\\n- [ ] Publish notes\\n' > /work/out/lantern-launch.md && cat /work/out/lantern-launch.md",
  ],
  [
    'python3 heredoc print',
    "python3 - <<'PY'\nimport csv\nrows = list(csv.DictReader(open('/work/in/lantern-sales.csv')))\nprint('total', sum(int(r['revenue']) for r in rows))\nPY",
  ],
  [
    'python3 heredoc save',
    "python3 - <<'PY'\nimport csv\nrows = list(csv.DictReader(open('/work/in/lantern-sales.csv')))\nw = csv.writer(open('/work/out/lantern-totals.csv', 'w'))\nfor r in rows:\n    w.writerow([r['region'], r['revenue']])\nw.writerow(['Total', 66])\nprint('Saved /work/out/lantern-totals.csv')\nPY\ncat /work/out/lantern-totals.csv",
  ],
  ['write-then-run script', 'PLACEHOLDER_WRITE'],
  // Second calibration round: the verbs the reworked interface contract models.
  ['wc bare file', 'wc /work/in/lantern-sales.csv'],
  ['cat | wc bare', 'cat /work/in/lantern-sales.csv | wc'],
  ['grep file single', 'grep North /work/in/lantern-sales.csv'],
  ['grep -i file', 'grep -i north /work/in/lantern-sales.csv'],
  ['grep missing file', 'grep North /work/in/nope.csv'],
  ['ls missing dir', 'ls /work/nope'],
  ['ls -l no -a', 'ls -l /work/in'],
  ['echo -n', 'echo -n waiting'],
  ['echo double-quoted', 'echo "sandbox unavailable this turn"'],
  ['echo pipe cat', 'echo lantern-sales.csv lantern-totals.csv | cat'],
  ['cat | grep pipe', 'cat /work/in/lantern-notes.md | grep 2030'],
  ['ls pipe head', 'ls /work/in | head -1'],
]
