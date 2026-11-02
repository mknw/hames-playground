"""Upgrade regressions: offline unless RV918_COMPOSE_CONFIG=1.

Run: python3 scripts/app-upgrade-review.test.py -v
Compose config tests use the real parser only; every dry-run call is mocked.
Source mutations are run against copies through the existing path overrides.
"""
import io
import tarfile
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
GATE = Path(os.environ.get('APP_UPGRADE_GATE_PATH', ROOT / 'scripts/app-upgrade-gate.py'))
BACKUP = Path(os.environ.get('BACKUP_PREVIEW_PATH', ROOT / 'scripts/backup-preview.sh'))
RUNBOOK = Path(os.environ.get('APP_UPGRADE_RUNBOOK_PATH', ROOT / 'docs/deployment/app-upgrade.md'))
SPEC = importlib.util.spec_from_file_location('review_gate', GATE)
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)
SHA = 'a' * 40


def shell(text, env=None):
    return subprocess.run(['bash', '-c', text], cwd=ROOT, text=True,
                          capture_output=True, env={**os.environ, **(env or {})})


class OfflineReview(unittest.TestCase):
    def backup_fixture(self, edits=()):
        script = (ROOT / 'scripts/backup-preview.test.sh').read_text()
        script = script.split('\nrun_case success\n')[0]
        for old, new in edits:
            self.assertIn(old, script)
            script = script.replace(old, new)
        return script

    def check_shell(self, script):
        result = shell(script, {'BACKUP_PREVIEW_PATH': str(BACKUP)})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_backup_capture_probe_refuse_before_stop(self):
        self.check_shell(self.backup_fixture() + '''
for params in '1 0 0' '0 0 1'; do
  # Deliberate word splitting supplies failure switches to run_case.
  if run_case refuse $params; then exit 1; fi
  ! grep -q '^compose stop neo4j$' "$TMP/trace"
  grep -q '^image rm hames-neo4j:backup-' "$TMP/trace"
done
''')

    def test_backup_cleanup_after_downstream_failure_and_term(self):
        for command in ("'compose exec -T redis redis-cli SAVE') ;;",
                        "'compose stop neo4j') ;;", "'compose start neo4j') ;;"):
            with self.subTest(command=command):
                fixture = self.backup_fixture([(command, command.replace(';;', 'exit 1 ;;'))])
                self.check_shell(fixture + '''
if run_case failure; then exit 1; fi
grep -q '^image rm hames-neo4j:backup-' "$TMP/trace"
grep -q '^compose start neo4j$' "$TMP/trace"
''')
        fixture = self.backup_fixture([("'compose stop neo4j') ;;",
                                       "'compose stop neo4j') kill -TERM \"$PPID\" ;;")])
        self.check_shell(fixture + '''
if run_case terminated; then exit 1; fi
grep -q '^image rm hames-neo4j:backup-' "$TMP/trace"
grep -q '^compose start neo4j$' "$TMP/trace"
''')

    def test_backup_cleanup_failure_is_not_success(self):
        fixture = self.backup_fixture([("'image rm '*) ;;", "'image rm '*) exit 1 ;;")])
        self.check_shell(fixture + '''
if run_case cleanup-failure; then exit 1; fi
grep -q 'temporary Neo4j image cleanup failed' "$TMP/out"
''')

    def test_backup_image_and_volume_drift_refuse_before_stop(self):
        for old,new in (("printf 'sha256:exact\\n'", "printf 'sha256:different\\n'"),
                        ("printf 'hames_neo4j_data\\n'", "printf 'other-volume\\n'")):
            with self.subTest(new=new):
                self.check_shell(self.backup_fixture([(old,new)]) + '''
if run_case drift; then exit 1; fi
! grep -q '^compose stop neo4j$' "$TMP/trace"
! grep -q '^commit ' "$TMP/trace"
''')

    def prediction_fixture(self):
        script = (ROOT / 'scripts/app-upgrade-prestop.test.sh').read_text()
        script = script[:script.index('\n: >"$TRACE"\nif stop_block')]
        script = re.sub(r'^ROOT=.*$', 'ROOT=' + str(ROOT), script, count=1, flags=re.M)
        return script

    def test_prediction_invalid_shapes_wrong_target_and_private_mode(self):
        script = self.prediction_fixture() + '''
for invalid in 'null' '[]' '{' '{"target_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'; do
  printf '%s' "$invalid" > "$TMP/prediction.json"
  : > "$TRACE"
  if stop_block > "$TMP/out" 2>&1; then exit 1; fi
  ! grep -q '^compose stop app$' "$TRACE"
done
rm "$TMP/prediction.json"
python3 "$GATE" predict "$TARGET_SHA" "$TMP/prediction.json"
python3 - "$TMP/prediction.json" <<'CHECK'
import os,sys,stat
assert stat.S_IMODE(os.stat(sys.argv[1]).st_mode) == 0o600
CHECK
if python3 "$GATE" predict "$TARGET_SHA" "$TMP/prediction.json"; then exit 1; fi
: > "$TRACE"
stop_block
grep -q '^compose stop app$' "$TRACE"
'''
        result = shell(script, {'APP_UPGRADE_GATE_PATH': str(GATE)})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_runbook_preserves_preset_target_and_reaches_guarded_stop(self):
        text = RUNBOOK.read_text()
        first = next(b for b in re.findall(r'```bash\n(.*?)\n```', text, re.S)
                     if 'dev_enabled_ids="$dump_root/' in b)
        stop = next(b for b in re.findall(r'```sh\n(.*?)\n```', text, re.S)
                    if 'docker compose stop app' in b)
        # Keep the real prediction gate and first stop; fake all external effects.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); bindir = root / 'bin'; bindir.mkdir()
            (root / '.env').write_text('COMPOSE_FILE=' + gate.SINGLE_FILES + '\nCOMPOSE_PROFILES=app\n')
            docker = (ROOT / 'scripts/app-upgrade-prestop.test.sh').read_text().split(
                'cat >"$TMP/bin/docker" <<\'SH\'\n', 1)[1].split('\nSH\n', 1)[0]
            stubs = {'docker': docker, 'id': '#!/bin/sh\necho 1000\n',
                     'git': '''#!/bin/sh
case "$*" in
  *':scripts/app-upgrade-gate.py') cat "$REVIEW_GATE" ;;
  'archive '*) tar -cf - --files-from /dev/null ;;
  'show '*) printf 'services: {}\\n' ;;
  'fetch '*|'cat-file '*) exit 0 ;;
  *) exit 99 ;;
esac
'''}
            for name, body in stubs.items():
                path = bindir / name; path.write_text(body); path.chmod(0o755)
            env = {**os.environ, 'PATH': str(bindir) + ':' + os.environ['PATH'],
                   'TARGET_SHA': SHA, 'TRACE': str(root / 'trace'),
                   'DEV_CLONE_PATH': '', 'REVIEW_GATE': str(GATE)}
            result = subprocess.run(['bash', '-c', first + '\n' + '\n'.join(stop.splitlines()[:2])],
                                    cwd=root, env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, 'Valid preset SHA must reach prediction and stop: ' + result.stderr)
            self.assertIn('compose stop app', (root / 'trace').read_text())


@unittest.skipUnless(os.environ.get('RV918_COMPOSE_CONFIG') == '1', 'opt-in real Compose parser; no daemon mutations')
class ComposeReview(unittest.TestCase):
    def fixture(self, clones, change):
        realrun = subprocess.run
        realcommand = gate.command
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        root = Path(temporary.name); oldcwd = Path.cwd(); os.chdir(root)
        self.addCleanup(os.chdir, oldcwd)
        base = '''name: rv918-config
services:
  app:
    image: alpine:latest
    environment:
      REV: old
      ENV_MARKER: ${ENV_MARKER:?}
    volumes:
      - ./fixture-config:/config:ro
  caddy:
    image: alpine:latest
  mcp-gateway:
    image: alpine:latest
  mcp-config:
    image: alpine:latest
  embedder:
    image: alpine:latest
    mem_limit: 3g
'''
        files = {'docker-compose.yaml': base, 'docker-compose.prod.yaml': 'services: {}\n'}
        if clones:
            files['docker-compose.clones.yaml'] = '''services:
  app-dev:
    extends:
      file: docker-compose.yaml
      service: app
'''
        for name, body in files.items(): (root / name).write_text(body)
        (root / '.env').write_text('COMPOSE_FILE=' + ':'.join(files) + '\nCOMPOSE_PROFILES=app\nENV_MARKER=fixture-value\n')
        target = {**files, 'docker-compose.yaml': base.replace('REV: old', 'REV: new') if change else base}
        def command(*args):
            if args[:2] == ('git', 'archive'):
                output = io.BytesIO()
                with tarfile.open(fileobj=output, mode='w') as archive:
                    for name, body in target.items():
                        data = body.encode()
                        entry = tarfile.TarInfo(name); entry.size = len(data)
                        archive.addfile(entry, io.BytesIO(data))
                return output.getvalue()
            if args[0] == 'git': return target[args[2].split(':', 1)[1]].encode()
            return realcommand(*args)
        def run(args, **kwargs):
            if '--dry-run' in args:
                return subprocess.CompletedProcess(args, 0, b'',
                    b'{"dry-run":true,"id":"Container rv918-config-app-1","status":"Starting"}\n')
            self.assertIn('config', args)  # fail closed: real Docker can only render
            return realrun(args, **kwargs)
        return root, target, command, run

    def test_single_target_paths_and_env_match_checkout(self):
        root,target,command,run = self.fixture(False, True)
        with patch.object(gate, 'command', side_effect=command), patch.object(gate.subprocess, 'run', side_effect=run):
            predicted = gate.target_prediction(SHA)
        for name,body in target.items(): (root / name).write_text(body)
        self.assertEqual(predicted['target_hashes'], gate.configuration()[2])

    def test_unchanged_clone_paths_and_env_match_checkout(self):
        root,target,command,run = self.fixture(True, False)
        with patch.object(gate, 'command', side_effect=command), patch.object(gate.subprocess, 'run', side_effect=run):
            predicted = gate.target_prediction(SHA)
        for name,body in target.items(): (root / name).write_text(body)
        self.assertEqual(predicted['target_hashes'], gate.configuration()[2])

    def test_clone_target_extends_is_not_read_from_old_checkout(self):
        root,target,command,run = self.fixture(True, True)
        with patch.object(gate, 'command', side_effect=command), patch.object(gate.subprocess, 'run', side_effect=run):
            try:
                predicted = gate.target_prediction(SHA)
            except SystemExit as error:
                self.assertIn('forbidden target Compose hash change: app-dev', str(error))
                return
        for name,body in target.items(): (root / name).write_text(body)
        self.assertEqual(predicted['target_hashes'], gate.configuration()[2],
                         'Prediction accepted old inherited service instead of refusing target protected-service drift')


if __name__ == '__main__':
    unittest.main()
