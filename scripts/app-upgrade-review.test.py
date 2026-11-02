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
    def test_missing_yaml_prerequisite_refuses_before_configuration(self):
        # Disable site packages, independently of whether this machine has PyYAML.
        result = subprocess.run(['python3', '-S', str(GATE), 'predict', SHA, '/unused'],
                                cwd=ROOT, text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('python3-yaml host prerequisite', result.stderr)
        self.assertNotIn('Traceback', result.stderr)

    def test_invalid_sha_never_reaches_configuration(self):
        for value in ('', 'a'*39, 'a'*41, 'g'*40, 'A'*40, 'main'):
            with self.subTest(value=value), patch.object(gate, 'configuration', side_effect=AssertionError('Invalid SHA reached configuration')):
                with self.assertRaisesRegex(SystemExit, 'full commit SHA'):
                    gate.target_prediction(value)

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


class ComposeSubsetReview(unittest.TestCase):
    def refuses(self, body, line, what, name='parts/target.compose'):
        # An unselected, arbitrarily named file still belongs to the target tree.
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w') as archive:
            for filename, text in {'docker-compose.yaml': 'services: {app: {env_file: ./runtime.env}}',
                                   name: body}.items():
                raw = text.encode()
                member = tarfile.TarInfo(filename); member.size = len(raw)
                archive.addfile(member, io.BytesIO(raw))
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / 'prediction.json'
            def command(*args):
                self.assertEqual(args, ('git', 'archive', SHA))
                return output.getvalue()
            with patch.object(gate, 'command', side_effect=command), \
                 patch.object(gate, 'configuration', side_effect=AssertionError('Hashing began')) as config, \
                 patch.object(gate, 'preserve_env_files', side_effect=AssertionError('Target rewrite began')) as preserve, \
                 patch.object(gate.subprocess, 'run', side_effect=AssertionError('External effect began')), \
                 patch.object(gate.sys, 'argv', ['gate', 'predict', SHA, str(artifact)]):
                expected = f'unsupported Compose YAML construct at {name}:{line}: {what}; this gate refuses it'
                with self.assertRaisesRegex(SystemExit, re.escape(expected)):
                    gate.main()
                config.assert_not_called()
                preserve.assert_not_called()
                self.assertFalse(artifact.exists())

    def test_root_merge_key_refuses(self):
        self.refuses('name: fixture\n<<: {}\n', 2, 'merge key <<')

    def test_nested_merge_key_refuses(self):
        for key in ('<<', '"<<"', "'<<'"):
            with self.subTest(key=key):
                self.refuses('x-extra:\n  - nested:\n      ' + key + ': {}\n', 3, 'merge key <<')

    def test_aliased_merge_key_refuses(self):
        self.refuses('x-key: &key <<\nx-extra:\n  *key: {}\n', 3, 'merge key <<')

    def test_mapping_anchor_refuses(self):
        self.refuses('x-extra:\n  nested: &map {value: fixture}\n', 2, 'mapping/sequence anchor or alias')

    def test_sequence_anchor_refuses(self):
        self.refuses('x-extra:\n  nested: &seq [fixture]\n', 2, 'mapping/sequence anchor or alias')

    def test_mapping_alias_refuses(self):
        self.refuses('x-extra: &map {value: fixture}\nx-copy: *map\n', 1, 'mapping/sequence anchor or alias')

    def test_sequence_alias_refuses(self):
        self.refuses('x-extra: &seq [fixture]\nx-copy: *seq\n', 1, 'mapping/sequence anchor or alias')

    def test_custom_tag_refuses(self):
        for value in ('!unknown fixture', '!unknown {}', '!unknown []',
                      '!<tag:example.invalid,2026:value> fixture'):
            with self.subTest(value=value):
                tag = 'tag:example.invalid,2026:value' if value.startswith('!<') else '!unknown'
                self.refuses('x-extra:\n  nested: ' + value + '\n', 2, 'custom tag ' + tag)

    def test_reserved_extension_anywhere_refuses(self):
        self.refuses('x-extra:\n  - x-upgrade-gate-env-file: []\n', 2, 'reserved upgrade gate extension')
        self.refuses('x-key: &key x-upgrade-gate-env-file\nx-extra:\n  *key: []\n', 3, 'reserved upgrade gate extension')

    def test_later_yaml_error_does_not_hide_unsupported_construct(self):
        # PyYAML rejects duplicate anchors; retain the earlier refusal even if
        # another parser accepts this document or a later syntax error occurs.
        self.refuses('x-first: &map {}\nx-second: &map {}\n', 1, 'mapping/sequence anchor or alias')
        self.refuses('x-first: !unknown fixture\nx-second: [\n', 1, 'custom tag !unknown')

    def test_root_merge_regression_forms_refuse(self):
        # Reviewer root shapes now refuse under the explicit supported-subset ruling.
        for merge in ('*project', '[*project]'):
            for collision in ('', '      x-upgrade-gate-env-file: []\n'):
                with self.subTest(merge=merge, collision=bool(collision)):
                    self.refuses('x-project: &project\n  services:\n    app:\n'
                                 '      env_file: ./runtime.env\n' + collision + '<<: ' + merge + '\n',
                                 1, 'mapping/sequence anchor or alias')


    def test_real_compose_inventory_is_supported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for path in ROOT.glob('docker-compose*.yaml'):
                (root / path.name).write_bytes(path.read_bytes())
            gate.validate_target_tree(root)

    def test_supported_scalars_and_tags_are_not_mistaken_for_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'fixture.compose').write_text(
                'x-value: &scalar <<\nx-alias: *scalar\nx-marker-value: x-upgrade-gate-env-file\n'
                'x-string: !!str fixture\nx-reset-scalar: !reset null\nx-reset-sequence: !reset []\n'
                'x-override: !override {value: fixture}\n')
            gate.validate_target_tree(root)


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


    def prediction_equals_checkout(self, root, target, command, run):
        with patch.object(gate, 'command', side_effect=command), patch.object(gate.subprocess, 'run', side_effect=run):
            try:
                predicted = gate.target_prediction(SHA)
            except SystemExit as error:
                self.fail(f'Valid unchanged shape refused: {error}')
        for name, body in target.items():
            (root/name).parent.mkdir(parents=True, exist_ok=True)
            (root/name).write_text(body)
        self.assertEqual(predicted['target_hashes'], gate.configuration()[2])

    def test_production_root_env_file_matches_checkout(self):
        root, target, command, run = self.fixture(False, False)
        # Exact production service env_file form, with the protected root .env.
        target['docker-compose.prod.yaml'] = 'services:\n  app:\n    env_file: !override\n      - path: ./.env\n        required: true\n'
        (root/'docker-compose.prod.yaml').write_text(target['docker-compose.prod.yaml'])
        self.prediction_equals_checkout(root, target, command, run)

    def test_host_relative_runtime_env_file_matches_checkout(self):
        root, target, command, run = self.fixture(False, False)
        (root/'runtime.env').write_text('SYNTHETIC_VALUE=fixture-only\n')
        target['docker-compose.prod.yaml'] = 'services:\n  app:\n    env_file:\n      - path: ./runtime.env\n        required: true\n'
        (root/'docker-compose.prod.yaml').write_text(target['docker-compose.prod.yaml'])
        self.prediction_equals_checkout(root, target, command, run)

    def test_unchanged_clone_absolute_runtime_env_matches_checkout(self):
        root, target, command, run = self.fixture(True, False)
        runtime = root/'runtime.env'
        runtime.write_text('SYNTHETIC_VALUE=fixture-only\n')
        target['docker-compose.prod.yaml'] = f'services:\n  app:\n    env_file: {runtime}\n  app-dev:\n    env_file: {runtime}\n'
        (root/'docker-compose.prod.yaml').write_text(target['docker-compose.prod.yaml'])
        self.prediction_equals_checkout(root, target, command, run)

    def test_empty_runtime_env_control_matches_checkout(self):
        root, target, command, run = self.fixture(True, False)
        runtime = root/'runtime.env'
        runtime.write_text('')
        target['docker-compose.prod.yaml'] = f'services:\n  app:\n    env_file: {runtime}\n  app-dev:\n    env_file: {runtime}\n'
        (root/'docker-compose.prod.yaml').write_text(target['docker-compose.prod.yaml'])
        self.prediction_equals_checkout(root, target, command, run)

    def test_literal_dollar_interpolation_matches_checkout(self):
        root, target, command, run = self.fixture(False, False)
        with (root/'.env').open('a') as f:
            f.write("DOLLAR_VALUE='prefix$RV918_UNSET_VARIABLE'\n")
        target['docker-compose.yaml'] = target['docker-compose.yaml'].replace('REV: old', 'REV: ${DOLLAR_VALUE:?}')
        (root/'docker-compose.yaml').write_text(target['docker-compose.yaml'])
        self.prediction_equals_checkout(root, target, command, run)

    def test_two_hop_extends_uses_target_tree(self):
        root, target, command, run = self.fixture(True, False)
        old = 'services:\n  shared:\n    environment:\n      TRANSITIVE: old\n'
        target['compose-leaf.yaml'] = old.replace('TRANSITIVE: old', 'TRANSITIVE: new')
        (root/'compose-leaf.yaml').write_text(old)
        middle = 'services:\n  shared:\n    extends:\n      file: compose-leaf.yaml\n      service: shared\n'
        target['compose-middle.yaml'] = middle
        (root/'compose-middle.yaml').write_text(middle)
        target['docker-compose.yaml'] = target['docker-compose.yaml'].replace('  app:\n', '  app:\n    extends:\n      file: compose-middle.yaml\n      service: shared\n')
        (root/'docker-compose.yaml').write_text(target['docker-compose.yaml'])
        with patch.object(gate, 'command', side_effect=command), patch.object(gate.subprocess, 'run', side_effect=run):
            with self.assertRaisesRegex(SystemExit, 'forbidden target Compose hash change: app-dev'):
                gate.target_prediction(SHA)

    def test_inherited_env_files_merge_and_override_like_checkout(self):
        for override in ('', '!override '):
            with self.subTest(override=override):
                root, target, command, run = self.fixture(True, False)
                for name in ('base.env', 'extra.env'):
                    (root / name).write_text('VALUE=fixture-only\n')
                target['docker-compose.yaml'] = target['docker-compose.yaml'].replace(
                    '  app:\n', '  app:\n    env_file: [./base.env]\n')
                target['docker-compose.clones.yaml'] += f'    env_file: {override}[./extra.env]\n'
                for name, body in target.items():
                    (root / name).write_text(body)
                self.prediction_equals_checkout(root, target, command, run)

    def test_environment_key_named_env_file_is_not_rewritten(self):
        root, target, command, run = self.fixture(True, False)
        target['docker-compose.yaml'] = target['docker-compose.yaml'].replace(
            '      REV: old', '      REV: old\n      env_file: literal-value')
        (root / 'docker-compose.yaml').write_text(target['docker-compose.yaml'])
        self.prediction_equals_checkout(root, target, command, run)

    def test_nested_inherited_env_file_matches_checkout(self):
        root, target, command, run = self.fixture(True, False)
        (root / 'parts').mkdir()
        (root / 'parts/runtime.env').write_text('VALUE=fixture-only\n')
        target['parts/shared.compose'] = 'services:\n  shared:\n    env_file: ./runtime.env\n'
        target['docker-compose.yaml'] = target['docker-compose.yaml'].replace(
            '  app:\n', '  app:\n    extends:\n      file: parts/shared.compose\n      service: shared\n')
        for name, body in target.items():
            (root / name).write_text(body)
        self.prediction_equals_checkout(root, target, command, run)

    def test_included_target_service_and_env_file(self):
        root, target, command, run = self.fixture(False, False)
        (root / 'parts').mkdir()
        (root / 'parts/runtime.env').write_text('VALUE=fixture-only\n')
        target['parts/infra.compose'] = '''services:
  included:
    image: alpine:latest
    env_file: ./runtime.env
    environment:
      REV: old
    volumes:
      - ./config:/config:ro
'''
        target['docker-compose.yaml'] += 'include:\n  - parts/infra.compose\n'
        for name, body in target.items():
            (root / name).write_text(body)
        self.prediction_equals_checkout(root, target, command, run)
        target['parts/infra.compose'] = target['parts/infra.compose'].replace('REV: old', 'REV: new')
        with patch.object(gate, 'command', side_effect=command), patch.object(gate.subprocess, 'run', side_effect=run):
            with self.assertRaisesRegex(SystemExit, 'forbidden target Compose hash change: included'):
                gate.target_prediction(SHA)


    def test_services_mapping_merge_refuses(self):
        root, target, command, run = self.fixture(True, False)
        (root / 'runtime.env').write_text('VALUE=fixture-only\n')
        flat = target['docker-compose.yaml'].replace('  app:\n', '  app:\n    env_file: ./runtime.env\n')
        (root / 'docker-compose.yaml').write_text(flat)
        expected = gate.configuration()[2]
        service = flat.split('  app:\n')[1].split('  caddy:\n')[0]
        target['docker-compose.yaml'] = ('x-services: &services\n  app:\n' + service
            + flat.split('services:\n')[0] + 'services:\n  <<: *services\n  caddy:\n'
            + flat.split('  caddy:\n')[1])
        (root / 'docker-compose.yaml').write_text(target['docker-compose.yaml'])
        self.assertEqual(expected, gate.configuration()[2], 'Merge syntax must be hash-equivalent')
        self.prediction_refuses_subset(command, run)

    def test_scalar_reset_env_file_preserves_tag(self):
        root, target, command, run = self.fixture(True, False)
        (root / 'runtime.env').write_text('VALUE=fixture-only\n')
        target['docker-compose.yaml'] = target['docker-compose.yaml'].replace(
            '  app:\n', '  app:\n    env_file: ./runtime.env\n')
        target['docker-compose.clones.yaml'] += '    env_file: !reset null\n'
        for name, body in target.items():
            (root / name).write_text(body)
        expected = gate.configuration()[2]  # Compose accepts this declaration.
        (root / 'docker-compose.clones.yaml').write_text(
            target['docker-compose.clones.yaml'].replace('!reset null', '!reset []'))
        self.assertEqual(expected, gate.configuration()[2], 'Both reset forms must be hash-equivalent')
        (root / 'docker-compose.clones.yaml').write_text(target['docker-compose.clones.yaml'])
        self.prediction_equals_checkout(root, target, command, run)
        target['docker-compose.clones.yaml'] = target['docker-compose.clones.yaml'].replace('!reset null', '!reset []')
        self.prediction_equals_checkout(root, target, command, run)

    def test_merged_service_target_only_env_change_refuses_subset(self):
        root, target, command, run = self.fixture(True, False)
        for name, value in (('old.env', 'old'), ('new.env', 'new')):
            (root / name).write_text(f'VALUE={value}\n')
        base = target['docker-compose.yaml'].replace('  app:\n', '  app:\n    env_file: ./old.env\n')
        merged = base.replace('services:\n', 'x-services: &services\n', 1) + '\nservices:\n  <<: [*services]\n'
        (root / 'docker-compose.yaml').write_text(merged)
        current = gate.configuration()[2]
        target['docker-compose.yaml'] = merged.replace('./old.env', './new.env')
        (root / 'docker-compose.yaml').write_text(target['docker-compose.yaml'])
        self.assertNotEqual(current['app-dev'], gate.configuration()[2]['app-dev'])
        (root / 'docker-compose.yaml').write_text(merged)
        self.prediction_refuses_subset(command, run)

    def test_reserved_extension_direct_and_service_merge_refuse(self):
        for alias in (False, True):
            with self.subTest(alias=alias):
                root, target, command, run = self.fixture(True, False)
                marker = 'x-upgrade-gate-env-file: [{path: ./runtime.env, x-upgrade-origin: .}]'
                (root / 'runtime.env').write_text('VALUE=fixture-only\n')
                if alias:
                    target['docker-compose.yaml'] = ('x-common: &common\n  ' + marker + '\n'
                        + target['docker-compose.yaml'].replace('  app:\n', '  app:\n    <<: *common\n'))
                else:
                    target['docker-compose.yaml'] = target['docker-compose.yaml'].replace('  app:\n', '  app:\n    ' + marker + '\n')
                with patch.object(gate, 'command', side_effect=command), patch.object(gate.subprocess, 'run', side_effect=run):
                    with self.assertRaisesRegex(SystemExit, 'mapping/sequence anchor or alias' if alias else 'reserved upgrade gate extension'):
                        gate.target_prediction(SHA)

    def test_services_mapping_reserved_extension_refuses(self):
        root, target, command, run = self.fixture(True, False)
        for name in ('old.env', 'new.env'):
            (root / name).write_text('')
        base = target['docker-compose.yaml'].replace('  app:\n', '  app:\n    env_file: ./old.env\n')
        (root / 'docker-compose.yaml').write_text(base)
        gate.configuration()  # Baseline is accepted by the real parser.
        changed = base.replace('env_file: ./old.env',
            'env_file: ./new.env\n    x-upgrade-gate-env-file: [{path: ./old.env, x-upgrade-origin: .}]')
        service = changed.split('  app:\n')[1].split('  caddy:\n')[0]
        target['docker-compose.yaml'] = ('x-services: &services\n  app:\n' + service
            + changed.split('services:\n')[0] + 'services:\n  <<: *services\n  caddy:\n'
            + changed.split('  caddy:\n')[1])
        (root / 'docker-compose.yaml').write_text(target['docker-compose.yaml'])
        gate.configuration()  # The target also is valid Compose input.
        (root / 'docker-compose.yaml').write_text(base)
        self.prediction_refuses_subset(command, run)

    def prediction_refuses_subset(self, command, run):
        with patch.object(gate, 'command', side_effect=command), patch.object(gate.subprocess, 'run', side_effect=run), \
             patch.object(gate, 'configuration', side_effect=AssertionError('Hashing began')):
            with self.assertRaisesRegex(SystemExit, 'unsupported Compose YAML construct at .*: mapping/sequence anchor or alias; this gate refuses it'):
                gate.target_prediction(SHA)

    def test_scalar_alias_env_file_matches_checkout(self):
        root, target, command, run = self.fixture(True, False)
        (root / 'runtime.env').write_text('VALUE=fixture-only\n')
        target['docker-compose.yaml'] = ('x-runtime: &runtime ./runtime.env\n'
            + target['docker-compose.yaml'].replace('  app:\n', '  app:\n    env_file: *runtime\n'))
        for name, body in target.items():
            (root / name).write_text(body)
        self.prediction_equals_checkout(root, target, command, run)


@unittest.skipUnless(os.environ.get('RV918_COMPOSE_CONFIG') == '1', 'opt-in real Compose parser; no daemon mutations')
class ProductionComposeReview(unittest.TestCase):
    def check_shape(self, clones, merged=False):
        realrun = subprocess.run
        realcommand = gate.command
        files = gate.CLONE_FILES if clones else gate.SINGLE_FILES
        # Exercise the committed production inputs and a real target archive,
        # with synthetic host configuration only. No runtime env file is copied.
        target_sha = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD']).decode().strip()
        archive = subprocess.check_output(['git', '-C', str(ROOT), 'archive', target_sha])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            oldcwd = Path.cwd()
            self.addCleanup(os.chdir, oldcwd)
            os.chdir(root)
            for name in files.split(':'):
                (root / name).write_bytes((ROOT / name).read_bytes())
            runtime = root / 'runtime.env'
            runtime.write_text('SYNTHETIC_VALUE=fixture-only\n')
            (root / '.env').write_text(f'''COMPOSE_FILE={files}
COMPOSE_PROFILES=app
POSTGRES_PASSWORD=fixture-postgres
NEO4J_PASSWORD=fixture-neo4j
APP_DOMAIN=release.example.invalid
DEV_APP_DOMAIN=dev.example.invalid
ACME_EMAIL=ops@example.invalid
RELEASE_DATABASE_URL=postgresql://release:fixture@postgres:5432/release
DEV_DATABASE_URL=postgresql://dev:fixture@postgres:5432/dev
RELEASE_RUNTIME_ENV_FILE={runtime}
DEV_RUNTIME_ENV_FILE={runtime}
DEV_CLONE_PATH={root}/dev
''')
            if merged:
                baseline = gate.configuration()[2]
                path = root / 'docker-compose.clones.yaml'
                path.write_text(path.read_text().replace('services:\n', 'x-services: &services\n', 1)
                                + '\nservices:\n  <<: *services\n')
                self.assertEqual(baseline, gate.configuration()[2], 'Merge syntax must be hash-equivalent')
                output = io.BytesIO()
                with tarfile.open(fileobj=io.BytesIO(archive)) as original, tarfile.open(fileobj=output, mode='w') as updated:
                    for member in original:
                        content = original.extractfile(member) if member.isfile() else None
                        if member.name == path.name:
                            raw = path.read_bytes()
                            member.size = len(raw)
                            content = io.BytesIO(raw)
                        updated.addfile(member, content)
                archive = output.getvalue()

            def command(*args):
                if args[:2] == ('git', 'archive'):
                    return archive
                if args[:2] == ('git', 'show'):
                    return (ROOT / args[2].split(':', 1)[1]).read_bytes()
                return realcommand(*args)

            def run(args, **kwargs):
                if '--dry-run' in args:
                    return subprocess.CompletedProcess(args, 0, b'',
                        b'{"dry-run":true,"id":"Container hames-app","status":"Starting"}\n')
                self.assertIn('config', args)
                return realrun(args, **kwargs)

            with patch.object(gate, 'command', side_effect=command), patch.object(gate.subprocess, 'run', side_effect=run):
                if merged:
                    with self.assertRaisesRegex(SystemExit, 'unsupported Compose YAML construct at docker-compose.clones.yaml:.*mapping/sequence anchor or alias; this gate refuses it'):
                        gate.target_prediction(target_sha)
                    return
                try:
                    predicted = gate.target_prediction(target_sha)
                except SystemExit as error:
                    self.fail(f'Unchanged production shape refused: {error}')
                self.assertEqual(predicted['target_hashes'], gate.configuration()[2])
            os.chdir(oldcwd)

    def test_production_single_matches_checkout(self):
        self.check_shape(False)

    def test_production_clone_matches_checkout(self):
        self.check_shape(True)

    def test_production_merge_alias_clone_refuses(self):
        self.check_shape(True, merged=True)


if __name__ == '__main__':
    unittest.main()
