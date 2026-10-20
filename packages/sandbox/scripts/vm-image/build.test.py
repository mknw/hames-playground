#!/usr/bin/env python3
"""Hermetic stage tests and individual, restored-source red mutations."""
import contextlib
import copy
import gzip
import hashlib
import importlib.util
import io
import json
import os
import shutil
from pathlib import Path
from types import SimpleNamespace
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(os.environ.get("VM_IMAGE_SOURCE", Path(__file__).with_name("build.py")))
spec = importlib.util.spec_from_file_location("vm_image", SOURCE)
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)


def tar(path, entries):
    with tarfile.open(path, "w") as archive:
        for name, data in entries.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))


class Pipeline(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(patch.stopall)
        patch.object(vm.shutil, 'disk_usage', return_value=SimpleNamespace(free=100 * 1024**3)).start()
        self.root = Path(self.temp.name).resolve()
        self.work = self.root / "work"
        self.lock_path = self.root / "input.json"
        self.calls = []
        def asset(name, data=b"synthetic pinned input"):
            path = self.root / name
            path.write_bytes(data)
            return {"path": name, "sha256": vm.digest(path)}
        layer = b"synthetic layer"
        config = json.dumps({"os": "linux", "architecture": "amd64", "rootfs": {
            "diff_ids": ["sha256:" + hashlib.sha256(layer).hexdigest()]}}).encode()
        self.pin = "sha256:" + hashlib.sha256(config).hexdigest()
        self.entries = {"manifest.json": json.dumps([{"Config": "config.json", "Layers": ["layer.tar"]}]).encode(),
                        "config.json": config, "layer.tar": layer}
        tar(self.root / "image.tar", self.entries)
        self.lock = {"schema": 1, "architecture": "x86_64", "epoch": 1, "max_virtual_bytes": 8192,
                     "base": {**asset("cloud.qcow2"), "name": "synthetic-cloud", "version": "1"},
                     "packages": [{**asset(name + ".deb"), "name": name, "version": "1.2.3"}
                                  for name in sorted(vm.REQUIRED)],
                     "flavours": {f: {"path": "image.tar", "sha256": vm.digest(self.root / "image.tar"),
                                      "image_id": self.pin} for f in vm.FLAVOURS},
                     "tools": {name: {**asset(name), "version": "synthetic 1.0"}
                               for name in ("qemu-img", "virt-customize", "guestfish")}}
        self.write_lock()

    def write_lock(self):
        self.lock_path.write_text(json.dumps(self.lock))

    def fake(self, argv, work):
        argv = [str(a) for a in argv]
        self.calls.append(argv)
        name = Path(argv[0]).name
        if argv[1:] == ["--version"]:
            return b"synthetic 1.0\n"
        if name == "qemu-img" and argv[1] == "info":
            return json.dumps({"format": "qcow2", "virtual-size": 4096}).encode()
        if name == "qemu-img" and argv[1] == "convert":
            Path(argv[-1]).write_bytes(b"synthetic assembled disk")
            return b""
        if name == "virt-customize":
            self.assertIn("--no-network", argv)
            self.assertNotIn("--run-command", argv)  # customize.sh runs only after the appliance modprobe
            for index, arg in enumerate(argv):
                if arg == "--upload":
                    source, target = argv[index + 1].split(":", 1)
                    self.assertTrue(Path(source).is_relative_to(work.root))
                    self.assertTrue(target.startswith("/opt/vm-image/"))
            return b""
        if name == "guestfish" and "--rw" in argv:
            self.assertNotIn("--network", argv)
            commands = argv[argv.index("-i") + 1:]
            self.assertEqual(commands, ["modprobe", "overlay", ":", "sh", "sh /opt/vm-image/customize.sh"])
            self.customized = True
            return b""
        if name == "guestfish":
            self.assertIn("--ro", argv)
            self.assertTrue(getattr(self, "customized", False), "inventory read before customization")
            Path(argv[-1]).write_text(json.dumps({"images": {f: self.pin for f in vm.FLAVOURS},
                "packages": {p["name"]: p["version"] for p in self.lock["packages"]},
                "enabled_units": vm.UNIT_LAYOUTS[1], "docker_driver": "overlay2", "machine_id_state": "uninitialized", "ssh_host_keys": []}))
            return b""
        self.fail("unapproved builder command")

    def build(self):
        with patch.object(vm.platform, "system", return_value="Linux"), \
             patch.object(vm.platform, "machine", return_value="x86_64"), \
             patch.object(vm, "run", side_effect=self.fake):
            vm.main(["build", "--apply", "--lock", str(self.lock_path), "--work-dir", str(self.work)])

    def test_duplicate_tar_member_rejected(self):
        path = self.root / 'image.tar'
        with tarfile.open(path, 'a') as archive:
            info = tarfile.TarInfo('layer.tar')
            info.size = len(self.entries['layer.tar'])
            archive.addfile(info, io.BytesIO(self.entries['layer.tar']))
        with self.assertRaisesRegex(RuntimeError, 'duplicate'):
            vm.archive_id(path, self.pin, 'x86_64')

    def test_extra_layer_cannot_escape_diff_id_verification(self):
        config = json.loads(self.entries['config.json'])
        config['rootfs']['diff_ids'] = []
        self.entries['config.json'] = json.dumps(config).encode()
        pin = 'sha256:' + hashlib.sha256(self.entries['config.json']).hexdigest()
        tar(self.root / 'image.tar', self.entries)
        with self.assertRaisesRegex(RuntimeError, 'layer inventory'):
            vm.archive_id(self.root / 'image.tar', pin, 'x86_64')

    def test_verify_mismatched_config_refused_without_evidence(self):
        self.lock['flavours']['base']['image_id'] = 'sha256:' + 'f' * 64
        self.write_lock()
        with self.assertRaisesRegex(RuntimeError, 'config digest'):
            vm.main(['verify', '--apply', '--lock', str(self.lock_path), '--work-dir', str(self.work)])
        self.assertFalse((self.work / 'verified.json').exists())

    def save_args(self):
        docker = self.root / 'docker'
        docker.write_bytes(b'synthetic docker CLI')
        return ['save', '--apply', '--docker-host', 'unix:///synthetic/disposable.sock',
                '--docker', str(docker), '--work-dir', str(self.work),
                *sum((['--' + f + '-image', self.pin] for f in vm.FLAVOURS), [])]

    def save_boundary(self, argv, work):
        argv = [str(a) for a in argv]
        self.calls.append(argv)
        if argv[:3] == ['nice', '-n', '19']:
            argv = argv[6:] if argv[3:4] == ['ionice'] else argv[3:]
        if argv[1:] == ['--version']:
            return b'Docker synthetic 1.0\n'
        self.assertEqual(argv[1:3], ['--host', 'unix:///synthetic/disposable.sock'])
        if argv[3:] == ['info', '--format', '{{.Driver}}']:
            return b'overlay2\n'
        if argv[3:5] == ['image', 'inspect']:
            if argv[-2] == '{{.Size}}':
                return b'1024'
            return self.pin.encode()
        self.assertEqual(argv[3:6], ['image', 'save', '--output'])
        tar(Path(argv[6]), self.entries)
        return b''

    def test_save_inspect_mismatch_refused_before_save(self):
        def boundary(argv, work):
            if argv[3:5] == ['image', 'inspect'] and argv[-2] == '{{.Id}}':
                self.calls.append([str(a) for a in argv])
                return ('sha256:' + 'f' * 64).encode()
            return self.save_boundary(argv, work)
        with patch.object(vm, 'run', side_effect=boundary), self.assertRaisesRegex(RuntimeError, 'daemon image ID'):
            vm.main(self.save_args())
        self.assertFalse(any(a[3:5] == ['image', 'save'] for a in self.calls))
        self.assertFalse((self.work / 'flavours.json').exists())

    def test_save_free_space_refuses_before_each_export(self):
        args = self.save_args()
        free = 10 * 1024**3 + 2 * 1024
        with patch.object(vm, 'run', side_effect=self.save_boundary), \
             patch.object(vm.shutil, 'disk_usage', side_effect=[SimpleNamespace(free=free),
                          SimpleNamespace(free=free - 1), SimpleNamespace(free=free - 1)]), \
             self.assertRaisesRegex(RuntimeError, 'insufficient free space for save'):
            vm.main(args)
        saves = [a for a in self.calls if 'save' in a]
        self.assertEqual(len(saves), 1)
        self.assertEqual(saves[0][-1], self.pin)
        self.assertFalse((self.work / 'data.tar').exists())
        self.assertFalse((self.work / 'flavours.json').exists())

    def test_save_insufficient_space_refuses_before_any_export(self):
        with patch.object(vm, 'run', side_effect=self.save_boundary), \
             patch.object(vm.shutil, 'disk_usage', return_value=SimpleNamespace(free=0)), \
             self.assertRaisesRegex(RuntimeError, 'insufficient free space for save'):
            vm.main(self.save_args())
        self.assertFalse(any('save' in a for a in self.calls))

    def test_save_priorities_with_and_without_ionice(self):
        for available in (None, '/synthetic/ionice'):
            self.work = self.root / ('with-ionice' if available else 'without-ionice')
            self.calls.clear()
            with patch.object(vm, 'run', side_effect=self.save_boundary), \
                 patch.object(vm.shutil, 'which', return_value=available):
                vm.main(self.save_args())
            saves = [a for a in self.calls if 'save' in a]
            self.assertEqual(len(saves), 3)
            prefix = ['nice', '-n', '19'] + (['ionice', '-c', '3'] if available else [])
            for argv in saves:
                self.assertEqual(argv[:len(prefix)], prefix)
                self.assertEqual(argv[len(prefix):len(prefix) + 3],
                                 [str(self.work / 'docker'), '--host', 'unix:///synthetic/disposable.sock'])

    def test_save_option_shaped_manifest_refused_before_work(self):
        args = self.save_args()
        position = args.index('--base-image')
        args[position:position + 2] = ['--base-image=-o@sha256:' + 'a' * 64]
        with patch.object(vm, 'run', side_effect=self.save_boundary), self.assertRaisesRegex(RuntimeError, 'full config IDs'):
            vm.main(args)
        self.assertFalse(self.work.exists())
        self.assertEqual(self.calls, [])

    def test_save_wrong_archive_refused(self):
        self.entries['config.json'] += b' '
        with patch.object(vm, 'run', side_effect=self.save_boundary), self.assertRaisesRegex(RuntimeError, 'config digest'):
            vm.main(self.save_args())
        self.assertFalse((self.work / 'flavours.json').exists())

    def test_save_mutable_id_refused_before_work(self):
        args = self.save_args()
        args[args.index('--base-image') + 1] = 'kg-sandbox:base'
        with patch.object(vm, 'run', side_effect=self.save_boundary), self.assertRaisesRegex(RuntimeError, 'full config IDs'):
            vm.main(args)
        self.assertFalse(self.work.exists())
        self.assertEqual(self.calls, [])

    def test_save_tcp_host_refused_before_work(self):
        args = self.save_args()
        args[args.index('--docker-host') + 1] = 'tcp://synthetic.invalid:2375'
        with patch.object(vm, 'run', side_effect=self.save_boundary), self.assertRaisesRegex(RuntimeError, 'Unix endpoint'):
            vm.main(args)
        self.assertFalse(self.work.exists())
        self.assertEqual(self.calls, [])

    def test_save_requires_absolute_docker_and_records_provenance(self):
        args = self.save_args()
        args[args.index('--docker') + 1] = 'docker'
        old = Path.cwd()
        try:
            os.chdir(self.root)
            with patch.object(vm, 'run', side_effect=self.save_boundary), self.assertRaisesRegex(RuntimeError, 'absolute Docker'):
                vm.main(args)
        finally:
            os.chdir(old)
        self.assertFalse(self.work.exists())
        with patch.object(vm, 'run', side_effect=self.save_boundary):
            vm.main(self.save_args())
        evidence = json.loads((self.work / 'flavours.json').read_text())
        self.assertEqual(evidence.get('docker'), {'path': str(self.root / 'docker'),
                         'sha256': vm.digest(self.root / 'docker'), 'version': 'Docker synthetic 1.0'})
        self.assertEqual(evidence.get('docker_driver'), 'overlay2')

    def test_save_containerd_uses_archive_config(self):
        args = self.save_args()
        selectors, entries, configs = {}, {}, {}
        for flavour, letter in zip(vm.FLAVOURS, 'abc'):
            selector = 'synthetic/' + flavour + '@sha256:' + letter * 64
            selectors[flavour] = selector
            args[args.index('--' + flavour + '-image') + 1] = selector
            entries[selector] = dict(self.entries)
            config = json.loads(self.entries['config.json'])
            config['variant'] = flavour
            entries[selector]['config.json'] = json.dumps(config).encode()
            configs[flavour] = 'sha256:' + hashlib.sha256(entries[selector]['config.json']).hexdigest()
        def boundary(argv, work):
            if argv[3:] == ['info', '--format', '{{.Driver}}']:
                return b'overlayfs\n'
            if argv[3:5] == ['image', 'inspect']:
                self.assertIn(argv[-1], selectors.values())
                if argv[-2] == '{{.Size}}':
                    return b'1024'
                return argv[-1].split('@')[1].encode()
            if 'save' in argv:
                self.calls.append([str(a) for a in argv])
                tar(Path(argv[argv.index('--output') + 1]), entries[argv[-1]])
                return b''
            return self.save_boundary(argv, work)
        with patch.object(vm, 'run', side_effect=boundary):
            vm.main(args)
        evidence = json.loads((self.work / 'flavours.json').read_text())
        self.assertEqual(evidence['docker_driver'], 'overlayfs')
        self.assertEqual({f: row['image_id'] for f, row in evidence['flavours'].items()},
                         configs)
        self.assertEqual([a[-1] for a in self.calls if 'save' in a], list(selectors.values()))

    def test_save_containerd_manifest_inspect_mismatch_refused(self):
        args = self.save_args()
        args[args.index('--base-image') + 1] = 'synthetic@sha256:' + 'a' * 64
        def boundary(argv, work):
            if argv[3:] == ['info', '--format', '{{.Driver}}']:
                return b'overlayfs\n'
            if argv[3:5] == ['image', 'inspect'] and argv[-2] == '{{.Id}}':
                return ('sha256:' + 'b' * 64).encode()
            return self.save_boundary(argv, work)
        with patch.object(vm, 'run', side_effect=boundary), self.assertRaisesRegex(RuntimeError, 'daemon image ID'):
            vm.main(args)
        self.assertFalse(any('save' in a for a in self.calls))

    def test_save_containerd_manifest_wrong_platform_refused(self):
        args = self.save_args()
        args[args.index('--base-image') + 1] = 'synthetic@sha256:' + 'a' * 64
        config = json.loads(self.entries['config.json'])
        config['architecture'] = 'arm64'
        self.entries['config.json'] = json.dumps(config).encode()
        def boundary(argv, work):
            if argv[3:] == ['info', '--format', '{{.Driver}}']:
                return b'overlayfs\n'
            if argv[3:5] == ['image', 'inspect'] and argv[-2] == '{{.Id}}':
                return ('sha256:' + 'a' * 64).encode()
            return self.save_boundary(argv, work)
        with patch.object(vm, 'run', side_effect=boundary), self.assertRaisesRegex(RuntimeError, 'image platform mismatch'):
            vm.main(args)
        self.assertFalse((self.work / 'flavours.json').exists())

    def test_save_containerd_manifest_not_accepted_as_config(self):
        args = self.save_args()
        manifest = 'sha256:' + 'a' * 64
        args[args.index('--base-image') + 1] = manifest
        def boundary(argv, work):
            if argv[3:] == ['info', '--format', '{{.Driver}}']:
                return b'overlayfs\n'
            if argv[3:5] == ['image', 'inspect'] and argv[-2] == '{{.Id}}':
                return manifest.encode()
            return self.save_boundary(argv, work)
        with patch.object(vm, 'run', side_effect=boundary), self.assertRaisesRegex(RuntimeError, 'config digest'):
            vm.main(args)
        self.assertFalse((self.work / 'flavours.json').exists())

    def inventory_refused(self, change, message):
        original = self.fake
        def boundary(argv, work):
            result = original(argv, work)
            if Path(argv[0]).name == 'guestfish' and '--ro' in argv:
                path = Path(argv[-1])
                value = json.loads(path.read_text())
                change(value)
                path.write_text(json.dumps(value))
            return result
        self.fake = boundary
        with self.assertRaisesRegex(RuntimeError, message):
            self.build()
        self.assertFalse((self.work / 'manifest.json').exists())

    def test_build_wrong_guest_image_refused(self):
        self.inventory_refused(lambda v: v['images'].update(base='sha256:' + 'f' * 64), 'preload inventory')

    def test_build_mixed_enabled_units_refused(self):
        self.inventory_refused(lambda v: v.update(enabled_units=[*vm.UNIT_LAYOUTS[0], 'cloud-init-main.service']), 'enabled units')

    def test_build_missing_enabled_units_refused(self):
        self.inventory_refused(lambda v: v.pop('enabled_units'), 'enabled units')

    def test_build_wrong_guest_package_refused(self):
        self.inventory_refused(lambda v: v['packages'].update({'docker.io': 'wrong'}), 'package versions')

    def test_build_unclean_machine_id_refused(self):
        self.inventory_refused(lambda v: v.update(machine_id_state='a' * 32), 'machine identity')

    def test_build_ssh_host_keys_refused(self):
        self.inventory_refused(lambda v: v.update(ssh_host_keys=['ssh_host_ed25519_key']), 'SSH host keys')

    def test_base_backing_refused_before_convert(self):
        original = self.fake
        def boundary(argv, work):
            if argv[1] == 'info' and Path(argv[-1]).name == 'base.qcow2':
                return json.dumps({'format': 'qcow2', 'virtual-size': 4096, 'backing-filename': '/host/file'}).encode()
            return original(argv, work)
        self.fake = boundary
        with self.assertRaisesRegex(RuntimeError, 'standalone bounded'):
            self.build()
        self.assertFalse(any(a[1] == 'convert' for a in self.calls))
        self.assertFalse((self.work / 'manifest.json').exists())

    def test_output_backing_refused_without_manifest(self):
        original = self.fake
        def boundary(argv, work):
            if argv[1] == 'info' and Path(argv[-1]).name == 'disk.qcow2':
                return json.dumps({'format': 'qcow2', 'virtual-size': 4096, 'backing-filename': '/host/file'}).encode()
            return original(argv, work)
        self.fake = boundary
        with self.assertRaisesRegex(RuntimeError, 'standalone bounded'):
            self.build()
        self.assertFalse((self.work / 'manifest.json').exists())

    def test_disk_info_never_probes_format(self):
        work = vm.Work(self.work)
        with patch.object(vm, 'run', return_value=b'{"format":"qcow2","virtual-size":4096}') as child:
            vm.disk_info('qemu-img', self.root / 'cloud.qcow2', self.lock, work)
        self.assertEqual(child.call_args.args[0], ['qemu-img', 'info', '-f', 'qcow2', '--output=json', self.root / 'cloud.qcow2'])

    def test_multiple_image_archive_refused(self):
        manifest = json.loads(self.entries['manifest.json'])
        self.entries['manifest.json'] = json.dumps(manifest * 2).encode()
        tar(self.root / 'image.tar', self.entries)
        with self.assertRaisesRegex(RuntimeError, 'one image'):
            vm.archive_id(self.root / 'image.tar', self.pin, 'x86_64')

    def test_native_architecture_required(self):
        with patch.object(vm.platform, 'system', return_value='Linux'), \
             patch.object(vm.platform, 'machine', return_value='aarch64'), \
             patch.object(vm, 'run', side_effect=self.fake), self.assertRaisesRegex(RuntimeError, 'native-architecture'):
            vm.main(['build', '--apply', '--lock', str(self.lock_path), '--work-dir', str(self.work)])
        self.assertFalse(self.work.exists())

    def test_colon_input_path_refused(self):
        path = self.root / 'local:asset'
        path.write_bytes(b'input')
        with self.assertRaisesRegex(RuntimeError, 'local input path'):
            vm.checked_asset({'path': path.name, 'sha256': vm.digest(path)}, self.root)

    def test_parent_symlink_input_refused(self):
        (self.root / 'alias').symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'without symlinks'):
            vm.local_file(self.root / 'alias' / 'cloud.qcow2')

    def test_nonregular_archive_members_refused(self):
        path = self.root / 'image.tar'
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE):
            with self.subTest(kind=kind):
                tar(path, self.entries)
                with tarfile.open(path, 'a') as archive:
                    member = tarfile.TarInfo('link')
                    member.type, member.linkname = kind, 'config.json'
                    archive.addfile(member)
                with self.assertRaisesRegex(RuntimeError, 'unsafe archive member'):
                    vm.archive_id(path, self.pin, 'x86_64')

    def test_duplicate_package_refused(self):
        self.lock['packages'].append(copy.deepcopy(self.lock['packages'][0]))
        self.write_lock()
        with self.assertRaisesRegex(RuntimeError, 'duplicated'):
            vm.read_lock(self.lock_path)

    def test_epoch_bound_refused(self):
        for epoch in (-1, 2 ** 32, True, '1'):
            self.lock['epoch'] = epoch
            self.write_lock()
            with self.subTest(epoch=epoch), self.assertRaisesRegex(RuntimeError, 'fixed epoch'):
                vm.read_lock(self.lock_path)

    def test_work_and_files_private_modes(self):
        work = vm.Work(self.work)
        self.assertEqual(self.work.stat().st_mode & 0o777, 0o700)
        output = work.write('private.json', '{}')
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        copied = work.copy(self.root / 'cloud.qcow2', 'private.qcow2', self.lock['base']['sha256'])
        self.assertEqual(copied.stat().st_mode & 0o777, 0o600)

    def test_guest_dockerd_uses_runtime_store(self):
        import shlex
        source = (vm.HERE / 'customize.sh').read_text()
        command = source[source.index('dockerd --config-file'):source.index('daemon_pid=$!')]
        executable, arguments = self.root / 'dockerd', self.root / 'arguments'
        executable.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > ' + shlex.quote(str(arguments)) + '\n')
        executable.chmod(0o700)
        command = command.replace('/opt/vm-image/dockerd.log', shlex.quote(str(self.root / 'log')))
        child = subprocess.run(['sh', '-c', command + '\nwait $!'], capture_output=True,
                               env={**os.environ, 'PATH': str(self.root) + ':' + os.environ['PATH']})
        self.assertEqual(child.returncode, 0, child.stderr)
        argv = arguments.read_text().splitlines()
        self.assertEqual(argv[argv.index('--data-root') + 1], '/var/lib/docker')
        self.assertEqual([argv[i + 1] for i, v in enumerate(argv) if v == '--host'], ['unix:///run/vm-image-docker.sock'])
        self.assertIn('--iptables=false', argv)

    def guest_calls(self, driver='overlay2'):
        # Distinct config IDs and save files establish each flavour association.
        for flavour in vm.FLAVOURS:
            entries = dict(self.entries)
            config = json.loads(entries['config.json'])
            config['comment'] = flavour
            entries['config.json'] = json.dumps(config).encode()
            pin = 'sha256:' + hashlib.sha256(entries['config.json']).hexdigest()
            path = self.root / (flavour + '.tar')
            tar(path, entries)
            self.lock['flavours'][flavour] = {'path': path.name, 'sha256': vm.digest(path), 'image_id': pin}
        self.write_lock()
        vm.main(['verify', '--apply', '--lock', str(self.lock_path), '--work-dir', str(self.work)])
        enabled_units = ['incus-agent.service', 'docker.service', 'cloud-init-local.service',
                         'cloud-config.service', 'cloud-final.service',
                         'cloud-init-main.service', 'cloud-init-network.service']
        (self.work / 'enabled-units.txt').write_text('\n'.join(enabled_units) + '\n')
        def output(argv, **kw):
            if argv[0] == 'dpkg-query':
                return ''.join(p['name'] + '\t1.2.3\n' for p in self.lock['packages'])
            if argv[3:] == ['info', '--format', '{{.Driver}}']:
                return driver + '\n'
            return argv[-1] + '\n'
        script = re_scripts((vm.HERE / 'customize.sh').read_text())[1]
        old = Path.cwd()
        try:
            os.chdir(self.work)
            with patch.object(subprocess, 'check_output', side_effect=output), patch.object(subprocess, 'run') as child:
                exec(compile(script, 'guest-script', 'exec'), {})
                self.assertEqual(json.loads(Path('inventory.json').read_text()).get('docker_driver'), driver)
                self.assertEqual(json.loads(Path('inventory.json').read_text()).get('enabled_units'), enabled_units)
                return [call.args[0] for call in child.call_args_list]
        finally:
            os.chdir(old)

    def test_all_images_loaded_from_archives_without_pull(self):
        calls = self.guest_calls()
        self.assertEqual([a[3:] for a in calls[:3]], [['load', '--input', f + '.tar'] for f in vm.FLAVOURS])
        self.assertTrue(all('pull' not in a for a in calls))

    def test_runtime_tags_restored_after_all_loads(self):
        calls = self.guest_calls()
        self.assertEqual([a[3:] for a in calls[3:]],
                         [['tag', self.lock['flavours'][f]['image_id'], 'kg-sandbox:' + f] for f in vm.FLAVOURS])

    def test_guest_containerd_snapshotter_refused(self):
        with self.assertRaisesRegex(SystemExit, 'containerd snapshotter'):
            self.guest_calls('overlayfs')

    def test_guest_driver_fallback_refused(self):
        # A classic store on vfs is invisible to the overlay2 boot daemon.
        for driver in ('vfs', 'devicemapper', ''):
            try:
                with self.subTest(driver=driver), self.assertRaisesRegex(SystemExit, 'overlay2'):
                    self.guest_calls(driver)
            finally:
                shutil.rmtree(self.work, ignore_errors=True)

    def test_guest_packages_installed_offline_by_apt(self):
        import shlex
        guest = self.fake_root()
        record = self.root / 'apt-argv'
        fake = guest / 'bin/apt-get'
        fake.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > ' + shlex.quote(str(record)) + '\n')
        fake.chmod(0o700)
        for name in ('a.deb', 'b.deb'):
            (guest / 'opt/vm-image' / name).write_text('')
        child = self.shell_section('export NEEDRESTART_MODE=l', "python3 - <<'PY'", guest)
        self.assertEqual(child.returncode, 0, child.stderr)
        argv = record.read_text().splitlines()
        self.assertEqual(argv[:4], ['install', '-y', '--no-install-recommends', '--no-download'])
        self.assertEqual(argv[-2:], ['./a.deb', './b.deb'])
        self.assertIn('Dir::Etc::SourceList=/dev/null', argv)  # no repository candidates at all
        self.assertTrue(any(a.startswith('Dir::State::Lists=') and a.endswith('/opt/vm-image/no-lists') for a in argv))
        commands = [line for line in (vm.HERE / 'customize.sh').read_text().splitlines() if not line.startswith('#')]
        self.assertFalse(any(line.startswith('dpkg ') for line in commands))

    def test_guest_runs_the_host_supplied_agent(self):
        guest = self.fake_root()
        child = self.shell_section('# Run the agent the HOST serves', '# Provisioning owns daemon.json', guest)
        self.assertEqual(child.returncode, 0, child.stderr)
        unit = guest / 'etc/systemd/system/incus-agent.service.d/host-agent.conf'
        self.assertEqual(unit.read_text(), '[Service]\nExecStart=\nExecStart=/run/incus_agent/incus-agent\n')

    def test_guest_assembly_daemon_pins_classic_overlay2(self):
        guest = self.fake_root()
        child = self.shell_section('# Same classic overlay2 store', 'dockerd --config-file', guest)
        self.assertEqual(child.returncode, 0, child.stderr)
        config = json.loads((guest / 'opt/vm-image/assembly-daemon.json').read_text())
        self.assertEqual(config, {'features': {'containerd-snapshotter': False}, 'storage-driver': 'overlay2'})

    def fake_root(self):
        guest = self.root / 'guest'
        for directory in ('bin', 'usr/sbin', 'etc/docker', 'etc/ssh', 'etc/cloud/cloud.cfg.d', 'opt/vm-image', 'var/lib/docker'):
            (guest / directory).mkdir(parents=True, exist_ok=True)
        return guest

    def shell_section(self, start, end, guest, prelude=''):
        source = (vm.HERE / 'customize.sh').read_text()
        section = source[source.index(start):source.index(end, source.index(start))]
        import re
        section = re.sub(r'/(?:usr|lib|etc|opt|var)/', lambda m: str(guest) + m.group(), section)
        return subprocess.run(['sh', '-c', 'set -eu\n' + prelude + '\n' + section],
                              cwd=guest / 'opt/vm-image', capture_output=True, text=True,
                              env={**os.environ, 'PATH': str(guest / 'bin') + ':' + os.environ['PATH']})

    def test_guest_policy_rc_blocks_package_services(self):
        guest = self.fake_root()
        child = self.shell_section('test ! -e /usr/sbin/policy-rc.d', "trap 'rm -f", guest)
        self.assertEqual(child.returncode, 0, child.stderr)
        policy = guest / 'usr/sbin/policy-rc.d'
        self.assertTrue(policy.is_file())
        self.assertEqual(subprocess.run(['sh', str(policy)]).returncode, 101)
        child = self.shell_section('test ! -e /usr/sbin/policy-rc.d', "trap 'rm -f", guest)
        self.assertNotEqual(child.returncode, 0)

    def test_guest_daemon_config_adoption_refused(self):
        guest = self.fake_root()
        child = self.shell_section('# Refuse site configuration', 'dockerd --config-file', guest)
        self.assertEqual(child.returncode, 0, child.stderr)
        (guest / 'etc/docker/daemon.json').write_text('{}')
        child = self.shell_section('# Refuse site configuration', 'dockerd --config-file', guest)
        self.assertNotEqual(child.returncode, 0)

    def guest_units(self, layout, directory='usr/lib/systemd/system', missing=None, enable_status=0, masked=None):
        guest = self.fake_root()
        units = guest / directory
        units.mkdir(parents=True)
        common = ['incus-agent.service', 'docker.service', 'cloud-init-local.service',
                  'cloud-config.service', 'cloud-final.service']
        for unit in [*common, 'cloud-init.target', *layout]:
            if unit == masked:
                (units / unit).symlink_to('/dev/null')
            elif unit != missing:
                (units / unit).write_text('[Unit]\n')
        agent = guest / 'bin/incus-agent'
        agent.write_text('#!/bin/sh\nexit 0\n')
        agent.chmod(0o700)
        systemctl = guest / 'bin/systemctl'
        systemctl.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > systemctl-call\nexit '
                             + str(enable_status) + '\n')
        systemctl.chmod(0o700)
        child = self.shell_section('# The package/base', '# Provisioning owns', guest)
        return child, guest / 'opt/vm-image', [*common, *layout]

    def test_guest_legacy_cloud_init_units(self):
        child, work, expected = self.guest_units(['cloud-init.service'], 'lib/systemd/system')
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertTrue((work / 'systemctl-call').is_file())
        self.assertEqual((work / 'systemctl-call').read_text().splitlines(), ['enable', *expected])
        self.assertTrue((work / 'enabled-units.txt').is_file())
        self.assertEqual((work / 'enabled-units.txt').read_text().splitlines(), expected)

    def test_guest_new_cloud_init_units(self):
        child, work, expected = self.guest_units(['cloud-init-main.service', 'cloud-init-network.service'])
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertTrue((work / 'systemctl-call').is_file())
        self.assertEqual((work / 'systemctl-call').read_text().splitlines(), ['enable', *expected])
        self.assertTrue((work / 'enabled-units.txt').is_file())
        self.assertEqual((work / 'enabled-units.txt').read_text().splitlines(), expected)

    def test_guest_invalid_cloud_init_layouts_refused(self):
        from itertools import combinations
        variants = ['cloud-init.service', 'cloud-init-main.service', 'cloud-init-network.service']
        # All eight combinations: the two accepted layouts are tested above.
        for count in range(4):
            for layout in combinations(variants, count):
                if list(layout) in ([variants[0]], variants[1:]):
                    continue
                with self.subTest(layout=layout), tempfile.TemporaryDirectory() as directory:
                    self.root = Path(directory)
                    child, work, _ = self.guest_units(layout)
                    self.assertNotEqual(child.returncode, 0)
                    self.assertIn('cloud-init unit layout', child.stderr)
                    for unit in layout:
                        self.assertIn(unit, child.stderr)
                    self.assertFalse((work / 'systemctl-call').exists())
                    self.assertFalse((work / 'enabled-units.txt').exists())

    def test_guest_partial_common_units_refused(self):
        for missing in ('incus-agent.service', 'docker.service', 'cloud-init-local.service',
                        'cloud-config.service', 'cloud-final.service', 'cloud-init.target'):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as directory:
                self.root = Path(directory)
                child, work, _ = self.guest_units(['cloud-init.service'], missing=missing)
                self.assertNotEqual(child.returncode, 0)
                self.assertIn(missing, child.stderr)
                self.assertFalse((work / 'systemctl-call').exists())
                self.assertFalse((work / 'enabled-units.txt').exists())

    def test_guest_masked_vendor_unit_refused(self):
        for masked in ('cloud-init-main.service', 'docker.service'):
            with self.subTest(masked=masked), tempfile.TemporaryDirectory() as directory:
                self.root = Path(directory)
                child, work, _ = self.guest_units(
                    ['cloud-init-main.service', 'cloud-init-network.service'], masked=masked)
                self.assertNotEqual(child.returncode, 0)
                self.assertFalse((work / 'systemctl-call').exists())

    def test_guest_unit_enable_failure_refused(self):
        child, work, _ = self.guest_units(['cloud-init.service'], enable_status=1)
        self.assertNotEqual(child.returncode, 0)
        self.assertFalse((work / 'enabled-units.txt').exists())

    def test_guest_cleanup_and_clone_inventory(self):
        guest = self.fake_root()
        work = guest / 'opt/vm-image'
        for name in ('input.deb', 'base.tar', 'dockerd.log', 'assembly-daemon.json', 'enabled-units.txt'):
            (work / name).write_text('private input')
        (work / 'inventory.json').write_text('{}')
        (guest / 'etc/machine-id').write_text('a' * 32)
        (guest / 'etc/ssh/ssh_host_ed25519_key').write_text('private host key')
        (guest / 'var/lib/docker/engine-id').write_text('old engine')
        (guest / 'var/lib/docker/key.json').write_text('old engine key')
        # Function shims operate only on the synthetic root; embedded Python is
        # executed separately below with its literal filesystem paths remapped.
        import shlex
        cloud = guest / 'bin/cloud-init'
        cloud.write_text("#!/bin/sh\nprintf '%s\\n' \"$*\" > cloud-call\nprintf 'uninitialized\\n' > "
                         + shlex.quote(str(guest / 'etc/machine-id')) + '\n')
        cloud.chmod(0o700)
        prelude = "python3() { cat > inventory-script; }"
        child = self.shell_section('trap - EXIT', '# Agent-rendered NoCloud seeds', guest, prelude)
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertTrue((work / 'cloud-call').is_file())
        self.assertEqual((work / 'cloud-call').read_text().strip(), 'clean --logs --machine-id')
        for name in ('input.deb', 'base.tar', 'dockerd.log', 'assembly-daemon.json', 'enabled-units.txt'):
            self.assertFalse((work / name).exists(), name)
        self.assertEqual(list((guest / 'etc/ssh').glob('ssh_host_*')), [])
        self.assertFalse((guest / 'var/lib/docker/engine-id').exists())
        self.assertFalse((guest / 'var/lib/docker/key.json').exists())
        # Do not rely on the shell rewrite to check the inventory writer itself.
        script = re_scripts((vm.HERE / 'customize.sh').read_text())[2]
        import re
        script = re.sub(r'/(?:etc|var)/', lambda m: str(guest) + m.group(), script)
        old = Path.cwd()
        try:
            os.chdir(work)
            exec(compile(script, 'clone-inventory', 'exec'), {})
            inventory = json.loads(Path('inventory.json').read_text())
            self.assertEqual(inventory.get('machine_id_state'), 'uninitialized')
            self.assertEqual(inventory.get('ssh_host_keys'), [])
            (guest / 'etc/machine-id').write_text('')
            exec(compile(script, 'clone-inventory', 'exec'), {})
            self.assertEqual(json.loads(Path('inventory.json').read_text())['machine_id_state'], '')
        finally:
            os.chdir(old)

    def test_dry_run_does_not_read_probe_or_write(self):
        with patch.object(vm, "read_lock", side_effect=AssertionError("read")), \
             patch.object(vm, "run", side_effect=AssertionError("command")), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            vm.main(["build", "--lock", "/nonexistent", "--work-dir", str(self.work)])
        self.assertEqual(json.loads(output.getvalue())["mode"], "dry-run")
        self.assertFalse(self.work.exists())

    def test_invalid_arguments_do_not_echo_values(self):
        with contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit):
            vm.main(["build", "--private-synthetic-argument", "synthetic-value"])
        self.assertNotIn("synthetic", error.getvalue())

    def test_required_packages_and_full_ids(self):
        original = copy.deepcopy(self.lock)
        self.lock["packages"] = [p for p in self.lock["packages"] if p["name"] != "incus-agent"]
        self.write_lock()
        with self.assertRaisesRegex(RuntimeError, "required guest packages"):
            vm.read_lock(self.lock_path)
        self.lock = original
        self.lock["flavours"]["base"]["image_id"] = "mutable:tag"
        self.write_lock()
        with self.assertRaisesRegex(RuntimeError, "full Docker config ID"):
            vm.read_lock(self.lock_path)

    def test_unpinned_input_is_rejected(self):
        for section in ("base", "packages", "flavours", "tools"):
            lock = copy.deepcopy(self.lock)
            record = {"base": lock["base"], "packages": lock["packages"][0],
                      "flavours": lock["flavours"]["base"], "tools": lock["tools"]["qemu-img"]}[section]
            del record["sha256"]
            self.lock_path.write_text(json.dumps(lock))
            with self.assertRaises(RuntimeError):
                vm.read_lock(self.lock_path)

    def test_digest_mismatch_rejected_before_staging(self):
        (self.root / "cloud.qcow2").write_bytes(b"tampered")
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            vm.main(["verify", "--apply", "--lock", str(self.lock_path), "--work-dir", str(self.work)])
        self.assertFalse(self.work.exists())

    def test_staged_digest_is_rechecked(self):
        work = vm.Work(self.work)
        with self.assertRaisesRegex(RuntimeError, "staged checksum"):
            work.copy(self.root / "cloud.qcow2", "copy", "f" * 64)

    def test_config_id_layer_and_platform_are_verified(self):
        vm.archive_id(self.root / "image.tar", self.pin, "x86_64")
        for pin, arch in (("sha256:" + "0" * 64, "x86_64"), (self.pin, "aarch64")):
            with self.assertRaises(RuntimeError):
                vm.archive_id(self.root / "image.tar", pin, arch)
        self.entries["layer.tar"] = b"tampered layer"
        tar(self.root / "image.tar", self.entries)
        with self.assertRaisesRegex(RuntimeError, "layer digest"):
            vm.archive_id(self.root / "image.tar", self.pin, "x86_64")

    def test_archive_traversal_and_symlink_refused(self):
        self.entries["../escaped"] = b"no"
        tar(self.root / "image.tar", self.entries)
        with self.assertRaises(RuntimeError):
            vm.archive_id(self.root / "image.tar", self.pin, "x86_64")
        (self.root / "linked").symlink_to(self.root / "cloud.qcow2")
        with self.assertRaises(RuntimeError):
            vm.local_file(self.root / "linked")

    def test_containerd_gzip_layers_use_uncompressed_diff_ids(self):
        self.entries["layer.tar"] = gzip.compress(self.entries["layer.tar"], mtime=0)
        tar(self.root / "image.tar", self.entries)
        try:
            vm.archive_id(self.root / "image.tar", self.pin, "x86_64")
        except RuntimeError as error:
            self.fail(str(error))
        self.entries["layer.tar"] = gzip.compress(b"tampered", mtime=0)
        tar(self.root / "image.tar", self.entries)
        with self.assertRaisesRegex(RuntimeError, "layer digest"):
            vm.archive_id(self.root / "image.tar", self.pin, "x86_64")

    def test_expanded_layer_budget(self):
        with patch.object(vm, "LAYER_BUDGET", 3), self.assertRaisesRegex(RuntimeError, "expanded layer budget"):
            vm.archive_id(self.root / "image.tar", self.pin, "x86_64")

    def test_write_cannot_escape_or_follow_symlinks(self):
        work = vm.Work(self.work)
        with self.assertRaises(RuntimeError):
            work.write("../escaped", b"unsafe")
        self.assertFalse((self.root / "escaped").exists())
        (self.work / "linked").symlink_to(self.root / "escaped")
        with self.assertRaises(RuntimeError):
            work.write("linked", b"unsafe")
        with self.assertRaises(FileExistsError):
            vm.Work(self.work)

    def test_verify_has_real_staged_files_but_no_complete_manifest(self):
        with patch.object(vm, "run", side_effect=AssertionError("no subprocess")):
            vm.main(["verify", "--apply", "--lock", str(self.lock_path), "--work-dir", str(self.work)])
        self.assertEqual(vm.digest(self.work / "base.qcow2"), self.lock["base"]["sha256"])
        self.assertTrue((self.work / "verified.json").is_file())
        self.assertFalse((self.work / "manifest.json").exists())

    def test_full_stage_plan_manifest_hashes_and_fingerprint(self):
        self.build()
        manifest = json.loads((self.work / "manifest.json").read_text())
        expected = {"metadata.tar", "disk.qcow2", "guest-inventory.json", "lock.json", "customize.sh"}
        self.assertEqual(set(manifest["outputs"]), expected)
        for name, value in manifest["outputs"].items():
            self.assertEqual(value, vm.digest(self.work / name))
        combined = (self.work / "metadata.tar").read_bytes() + (self.work / "disk.qcow2").read_bytes()
        self.assertEqual(manifest["incus_fingerprint"], hashlib.sha256(combined).hexdigest())
        with tarfile.open(self.work / "metadata.tar", "r:") as archive:
            metadata = json.load(archive.extractfile("metadata.yaml"))
            self.assertEqual(metadata["architecture"], "x86_64")
            self.assertEqual(set(metadata["templates"]), {
                "/var/lib/cloud/seed/nocloud-net/" + name
                for name in ("meta-data", "user-data", "vendor-data", "network-config")})
            for name in ("meta-data", "user-data", "vendor-data", "network-config"):
                definition = metadata["templates"]["/var/lib/cloud/seed/nocloud-net/" + name]
                self.assertEqual(definition["when"], ["create", "copy"])
                content = archive.extractfile("templates/" + definition["template"]).read()
                self.assertIn(b"instance.name" if name == "meta-data" else ("cloud-init." + name).encode(), content)
            self.assertEqual(len(archive.getmembers()), 5)
            self.assertTrue(all(member.isfile() for member in archive.getmembers()))
        self.assertTrue(self.calls)
        self.assertEqual(manifest["status"], "assembled-not-boot-validated")
        self.assertEqual(manifest.get("runner_closure"), "operator-pinned, not recorded")
        self.assertTrue(all(Path(a[0]).parent == self.work for a in self.calls))

    def test_failed_build_never_claims_complete(self):
        original = self.fake
        def failed(argv, work):
            if Path(argv[0]).name == "virt-customize":
                raise RuntimeError("failed synthetic customizer")
            return original(argv, work)
        self.fake = failed
        with self.assertRaises(RuntimeError):
            self.build()
        self.assertFalse((self.work / "manifest.json").exists())

    def test_backing_chain_encryption_external_file_and_size_refused(self):
        work = vm.Work(self.work)
        for change in ({"backing-filename": "elsewhere"}, {"encrypted": True}, {"virtual-size": 99999},
                       {"format": "raw"}, {"format-specific": {"data": {"data-file": "elsewhere"}}}):
            info = {"format": "qcow2", "virtual-size": 4096, **change}
            with patch.object(vm, "run", return_value=json.dumps(info).encode()), self.assertRaises(RuntimeError):
                vm.disk_info("qemu-img", self.root / "cloud.qcow2", self.lock, work)

    def test_linux_runner_required_for_real_build(self):
        with patch.object(vm.platform, "system", return_value="Darwin"), self.assertRaises(RuntimeError):
            vm.main(["build", "--apply", "--lock", str(self.lock_path), "--work-dir", str(self.work)])
        self.assertFalse(self.work.exists())

    def test_tool_version_mismatch_refuses_manifest(self):
        self.lock["tools"]["qemu-img"]["version"] = "wrong"
        self.write_lock()
        with self.assertRaisesRegex(RuntimeError, "tool version mismatch"):
            self.build()
        self.assertFalse((self.work / "manifest.json").exists())

    def test_command_environment_and_failure(self):
        work = vm.Work(self.work)
        env = {"DOCKER_HOST": "tcp://synthetic.invalid:1", "LIBGUESTFS_BACKEND": "untrusted", "LD_PRELOAD": "/untrusted", "LD_LIBRARY_PATH": "/untrusted", "PATH": "/untrusted"}
        with patch.dict(os.environ, env), patch.object(subprocess, "run") as child:
            child.return_value.returncode = 0
            child.return_value.stdout = b"ok"
            self.assertEqual(vm.run(["synthetic", "--version"], work), b"ok")
            options = child.call_args.kwargs
            self.assertEqual(options["cwd"], self.work)
            self.assertFalse(any(k.startswith("DOCKER_") for k in options["env"]))
            self.assertEqual(options["env"]["PATH"], "/usr/sbin:/usr/bin:/sbin:/bin")
            self.assertEqual(set(options["env"]), {"PATH", "HOME", "TMPDIR", "XDG_CACHE_HOME", "LIBGUESTFS_CACHEDIR", "LIBGUESTFS_TMPDIR", "LIBGUESTFS_BACKEND", "LC_ALL"})
            for name in ("HOME", "TMPDIR", "XDG_CACHE_HOME", "LIBGUESTFS_CACHEDIR", "LIBGUESTFS_TMPDIR"):
                self.assertEqual(options["env"][name], str(self.work))
            self.assertEqual(options["env"]["LIBGUESTFS_BACKEND"], "direct")
            child.return_value.returncode = 1
            child.return_value.stderr = b"synthetic stage diagnosis"
            with self.assertRaises(RuntimeError):
                vm.run(["/private/tools/synthetic", "--flag"], work)

    def test_failed_stage_stderr_kept_privately(self):
        work = vm.Work(self.work)
        with patch.object(subprocess, "run") as child:
            child.return_value.returncode = 1
            child.return_value.stderr = b"overlay: unknown filesystem type"
            for _ in range(2):
                with self.assertRaisesRegex(RuntimeError, "stage command failed"):
                    vm.run([self.root / "guestfish", "--rw"], work)
        log = self.work / "failed-stage.log"
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)
        self.assertEqual(log.read_bytes(), b"guestfish\noverlay: unknown filesystem type\n" * 2)

    def test_save_uses_only_explicit_endpoint_inspect_and_save(self):
        with patch.object(vm, "run", side_effect=self.save_boundary):
            vm.main(self.save_args())
        self.assertEqual(len(self.calls), 11)  # version, driver, six inspects and three saves
        evidence = json.loads((self.work / "flavours.json").read_text())
        self.assertEqual(set(evidence["flavours"]), set(vm.FLAVOURS))
        for argv in self.calls:
            self.assertIn(str(self.work / 'docker'), argv)

    def test_guest_python_checks_run_against_synthetic_data(self):
        # Execute the actual embedded Python against a tiny save archive and a
        # child-process shim. Never execute the guest shell against the host.
        scripts = re_scripts((vm.HERE / "customize.sh").read_text())
        vm.main(["verify", "--apply", "--lock", str(self.lock_path), "--work-dir", str(self.work)])
        (self.work / 'enabled-units.txt').write_text('cloud-init.service\n')
        def output(argv, **kwargs):
            if argv[0] == "dpkg-query":
                if "-f=${Version}" in argv:
                    return "1.2.3"
                return "".join(p["name"] + "\t1.2.3\n" for p in self.lock["packages"])
            if argv[3:] == ["info", "--format", "{{.Driver}}"]:
                return "overlay2\n"
            return self.pin + "\n"
        old = Path.cwd()
        try:
            os.chdir(self.work)
            with patch.object(subprocess, "check_output", side_effect=output), \
                 patch.object(subprocess, "run") as child:
                for script in scripts[:2]:
                    exec(compile(script, "guest-script", "exec"), {})
                self.assertEqual(child.call_count, 6)  # three loads and three local tags
                self.assertEqual(json.loads(Path("inventory.json").read_text())["images"]["base"], self.pin)
                with patch.object(subprocess, "check_output", return_value="wrong"):
                    with self.assertRaises(SystemExit):
                        exec(compile(scripts[0], "guest-script", "exec"), {})
                with patch.object(subprocess, "check_output", side_effect=lambda argv, **kw:
                                  "wrong" if argv[3:5] == ["image", "inspect"] else output(argv, **kw)):
                    with self.assertRaisesRegex(SystemExit, "guest image ID mismatch"):
                        exec(compile(scripts[1], "guest-script", "exec"), {})
                Path("base.tar").write_bytes(b"tampered")
                child.reset_mock()
                with self.assertRaisesRegex(SystemExit, "guest archive checksum"):
                    exec(compile(scripts[1], "guest-script", "exec"), {})
                child.assert_not_called()
        finally:
            os.chdir(old)

    def test_provisioner_dockerd_path(self):
        source = (vm.HERE / "customize.sh").read_text()
        start = source.index("# Both provisioning consumers")
        end = source.index("# The package/base", start)
        guest = self.root / "guest"
        (guest / "usr/bin").mkdir(parents=True)
        (guest / "usr/sbin").mkdir(parents=True)
        binary = guest / "usr/sbin/dockerd"
        binary.write_text("#!/bin/sh\nexit 0\n")
        binary.chmod(0o700)
        script = "set -eu\n" + source[start:end].replace("/usr/", str(guest) + "/usr/")
        child = subprocess.run(["sh", "-c", script], capture_output=True, text=True)
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertEqual((guest / "usr/bin/dockerd").resolve(), binary)

    def test_cloud_init_driver_uses_agent_seed(self):
        source = (vm.HERE / "customize.sh").read_text()
        self.assertIn("datasource_list: [NoCloud]", source)
        self.assertIn("rm -f /etc/cloud/cloud-init.disabled", source)


def re_scripts(source):
    import re
    return re.findall(r"python3 - <<'PY'\n(.*?)\nPY", source, re.S)


def mutations():
    test = Path(__file__).resolve()
    baseline = subprocess.run([sys.executable, str(test)], capture_output=True, text=True)
    if baseline.returncode:
        raise RuntimeError("green baseline required\n" + baseline.stderr)
    source = SOURCE.read_text()
    changes = [
        ('enabled unit inventory ignored', 'inventory.get("enabled_units") in UNIT_LAYOUTS', 'True', 'test_build_mixed_enabled_units_refused'),
        ('enabled unit inventory ignored (missing key)', 'inventory.get("enabled_units") in UNIT_LAYOUTS', 'True', 'test_build_missing_enabled_units_refused'),
        ("save driver inventory omitted", '"docker_driver": driver,', '', "test_save_requires_absolute_docker_and_records_provenance"),
        ("builder tools run from source paths", 'path = work.copy(source, name, record["sha256"])', 'path = source', "test_full_stage_plan_manifest_hashes_and_fingerprint"),
        ("Docker CLI version not recorded", '"version": version}}, indent=2)', '}}, indent=2)', "test_save_requires_absolute_docker_and_records_provenance"),
        ("duplicate tar members admitted", 'len(names) == len(set(names))', 'True', "test_duplicate_tar_member_rejected"),
        ("surplus layer escapes verification", 'isinstance(layers, list) and len(layers) == len(diff_ids)', 'True', "test_extra_layer_cannot_escape_diff_id_verification"),
        ("verify skips archive config check", '        archive_id(output, record["image_id"], lock["architecture"])', '        pass', "test_verify_mismatched_config_refused_without_evidence"),
        ("save skips inspect ID equality", 'actual == pin.rsplit("@", 1)[-1]', 'True', "test_save_inspect_mismatch_refused_before_save"),
        ("save skips archive ID equality", 'expected is None or actual == expected', 'True', "test_save_wrong_archive_refused"),
        ("save admits mutable ID", 'image_id(getattr(args, f + "_image")) or re.fullmatch(', 'True or re.fullmatch(', "test_save_mutable_id_refused_before_work"),
        ("save admits TCP daemon", 're.fullmatch(r"unix:///[^\\s]+", args.docker_host)', 'True', "test_save_tcp_host_refused_before_work"),
        ("guest image inventory ignored", 'inventory["images"] == {f: lock["flavours"][f]["image_id"] for f in FLAVOURS}', 'True', "test_build_wrong_guest_image_refused"),
        ("guest package inventory ignored", 'all(inventory["packages"].get(p["name"]) == p["version"] for p in lock["packages"])', 'True', "test_build_wrong_guest_package_refused"),
        ("base disk info omitted", '    disk_info(paths["qemu-img"], work.root / "base.qcow2", lock, work)', '    pass', "test_base_backing_refused_before_convert"),
        ("output disk info omitted", '    disk_info(paths["qemu-img"], disk, lock, work)', '    pass', "test_output_backing_refused_without_manifest"),
        ("multiple image archive admitted", 'isinstance(manifest, list) and len(manifest) == 1', 'isinstance(manifest, list)', "test_multiple_image_archive_refused"),
        ("disk header format probed", '"info", "-f", "qcow2", "--output=json"', '"info", "--output=json"', "test_disk_info_never_probes_format"),
        ("parent symlink input admitted", 'not any(p.is_symlink() for p in (path, *path.parents)) and path.is_file()', 'not path.is_symlink() and path.is_file()', "test_parent_symlink_input_refused"),
        ("nonregular archive members admitted", 'and (member.isfile() or member.isdir())', 'and True', "test_nonregular_archive_members_refused"),
        ("duplicate package admitted", 'len(names) == len(set(names)) and REQUIRED', 'True and REQUIRED', "test_duplicate_package_refused"),
        ("epoch unbounded", 'type(lock.get("epoch")) is int and 0 <= lock["epoch"] < 2 ** 32', 'True', "test_epoch_bound_refused"),
        ("work directory world accessible", 'self.root.mkdir(mode=0o700)', 'self.root.mkdir(mode=0o777); os.chmod(self.root, 0o777)', "test_work_and_files_private_modes"),
        ("written file world readable", '        path.chmod(0o600)\n        return path\n\n    def copy', '        path.chmod(0o644)\n        return path\n\n    def copy', "test_work_and_files_private_modes"),
        ("staged file world readable", '        path.chmod(0o600)\n        require(digest(path)', '        path.chmod(0o644)\n        require(digest(path)', "test_work_and_files_private_modes"),
        ("machine identity inventory ignored", 'inventory["machine_id_state"] in ("", "uninitialized")', 'True', "test_build_unclean_machine_id_refused"),
        ("SSH identity inventory ignored", 'inventory["ssh_host_keys"] == []', 'True', "test_build_ssh_host_keys_refused"),
        ("save containerd uses manifest as config", '"image_id": config}', '"image_id": actual}', "test_save_containerd_uses_archive_config"),
        ("save containerd bare manifest accepted as config", 'None if manifest_pin else pin', 'None', "test_save_containerd_manifest_not_accepted_as_config"),
        ("relative Docker CLI admitted", 'args.docker is not None and args.docker.is_absolute()', 'True', "test_save_requires_absolute_docker_and_records_provenance"),
        ("Docker CLI hash not recorded", '"sha256": checksum, "version": version', '"version": version', "test_save_requires_absolute_docker_and_records_provenance"),
        ("runner closure claim absent", '"runner_closure": "operator-pinned, not recorded",', '', "test_full_stage_plan_manifest_hashes_and_fingerprint"),
        ("inherited loader environment admitted", 'env = dict(PATH=', 'env = dict(os.environ, PATH=', "test_command_environment_and_failure"),
        ("native architecture unchecked", ' and platform.machine() == lock["architecture"]', '', "test_native_architecture_required"),
        ("archive platform unchecked", 'metadata.get("os") == "linux" and metadata.get("architecture") == arch', 'True', "test_config_id_layer_and_platform_are_verified"),
        ("archive path unchecked", 'not name.is_absolute() and ".." not in name.parts', 'True', "test_archive_traversal_and_symlink_refused"),
        ("virtual disk size unbounded", ' and 0 < value["virtual-size"] <= lock["max_virtual_bytes"]', '', "test_backing_chain_encryption_external_file_and_size_refused"),
        ("colon input path admitted", 'name and ":" not in name', 'name', "test_colon_input_path_refused"),
        ("unpinned input accepted", '    require(isinstance(record, dict)', '    record.setdefault("sha256", digest(directory / record["path"]))\n    require(isinstance(record, dict)', "test_unpinned_input_is_rejected"),
        ("input checksum not verified", 'digest(path) == record["sha256"]', 'True', "test_digest_mismatch_rejected_before_staging"),
        ("staged checksum not verified", 'digest(path) == expected', 'True', "test_staged_digest_is_rechecked"),
        ("config digest not verified", 'expected is None or actual == expected', 'True', "test_config_id_layer_and_platform_are_verified"),
        ("layer digest not verified", '"sha256:" + value.hexdigest() == expected_layer', 'True', "test_config_id_layer_and_platform_are_verified"),
        ("manifest missing disk hash", '"outputs": hashes', '"outputs": {k: v for k, v in hashes.items() if k != "disk.qcow2"}', "test_full_stage_plan_manifest_hashes_and_fingerprint"),
        ("stage writes outside work directory", 'path.resolve().is_relative_to(self.root) and not path.is_symlink()', 'True', "test_write_cannot_escape_or_follow_symlinks"),
        ("customization gets network", '"--no-network", "--format"', '"--network", "--format"', "test_full_stage_plan_manifest_hashes_and_fingerprint"),
        ("appliance overlay module not loaded", '"modprobe", "overlay", ":", "sh"', '"sh"', "test_full_stage_plan_manifest_hashes_and_fingerprint"),
        ("customize script never run", '"modprobe", "overlay", ":", "sh", "sh /opt/vm-image/customize.sh"]', '"modprobe", "overlay"]', "test_full_stage_plan_manifest_hashes_and_fingerprint"),
        ("failed stage stderr discarded", 'stream.write(Path(str(argv[0])).name.encode()', 'stream.write(b"" and Path(str(argv[0])).name.encode()', "test_failed_stage_stderr_kept_privately"),
        ("failed stage log world readable", 'os.O_NOFOLLOW, 0o600)', 'os.O_NOFOLLOW, 0o644)', "test_failed_stage_stderr_kept_privately"),
        ("disk backing chain admitted", 'not value.get("backing-filename")', 'True', "test_backing_chain_encryption_external_file_and_size_refused"),
        ("tool version not verified", 'version == record["version"]', 'True', "test_tool_version_mismatch_refuses_manifest"),
        ("required Incus agent package omitted", 'REQUIRED <= set(names)', 'True', "test_required_packages_and_full_ids"),
        ("mutable flavour input accepted", 'require(image_id(record.get("image_id")),', 'require(True,', "test_required_packages_and_full_ids"),
        ("argument error echoes values", 'self.exit(2, "Invalid image pipeline arguments; consult --help (values suppressed).\\n")', 'self.exit(2, _message)', "test_invalid_arguments_do_not_echo_values"),
        ("compressed diff ID not verified", '"sha256:" + value.hexdigest() == expected_layer', 'True', "test_containerd_gzip_layers_use_uncompressed_diff_ids"),
        ("compressed layer not decoded", 'if magic == b"\\x1f\\x8b":', 'if False:', "test_containerd_gzip_layers_use_uncompressed_diff_ids"),
        ("expanded layer budget removed", 'expanded <= LAYER_BUDGET', 'True', "test_expanded_layer_budget"),
        ("cloud-init seed templates removed", 'files["metadata.yaml"] = json.dumps(metadata,', 'metadata["templates"].clear()\n    files["metadata.yaml"] = json.dumps(metadata,', "test_full_stage_plan_manifest_hashes_and_fingerprint"),
    ]
    changes.extend([
        ('review manifest pin inspect equality removed', 'actual == pin.rsplit("@", 1)[-1]', 'True', 'test_save_containerd_manifest_inspect_mismatch_refused'),
        ('review manifest pin platform equality removed', 'metadata.get("os") == "linux" and metadata.get("architecture") == arch', 'True', 'test_save_containerd_manifest_wrong_platform_refused'),
        ('save free space gate removed', 'shutil.disk_usage(work.root).free >= 2 * size + 10 * 1024**3', 'True', 'test_save_insufficient_space_refuses_before_any_export'),
        ('save free space reserve removed', '2 * size + 10 * 1024**3', '0', 'test_save_free_space_refuses_before_each_export'),
        ('save CPU priority removed', 'low_priority = ["nice", "-n", "19"]', 'low_priority = []', 'test_save_priorities_with_and_without_ionice'),
        ('save I/O priority removed', 'low_priority += ["ionice", "-c", "3"]', 'low_priority += []', 'test_save_priorities_with_and_without_ionice'),
        ('save admits option shaped manifest', '[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:', '[a-zA-Z0-9./:_-]+@sha256:', 'test_save_option_shaped_manifest_refused_before_work'),
    ])
    for label, before, after, case in changes:
        if before not in source:
            raise RuntimeError("missing mutation anchor " + label)
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            (directory / "build.py").write_text(source.replace(before, after))
            (directory / "customize.sh").write_text((vm.HERE / "customize.sh").read_text())
            result = subprocess.run([sys.executable, str(test), "Pipeline." + case], capture_output=True, text=True,
                                    env={**os.environ, "VM_IMAGE_SOURCE": str(directory / "build.py")})
            if result.returncode == 0 or "FAIL: " + case not in result.stderr:
                raise RuntimeError("mutation survived or failed without assertion: " + label + "\n" + result.stderr)
            print("RED verified: " + label)
    guest = (vm.HERE / "customize.sh").read_text()
    guest_changes = [
        ('guest masked vendor unit admitted', 'test -f "/usr/lib/systemd/system/$1" || test -f "/lib/systemd/system/$1"', 'test -e "/usr/lib/systemd/system/$1" || test -e "/lib/systemd/system/$1"', 'test_guest_masked_vendor_unit_refused'),
        ('guest enabled unit temporary file retained', './assembly-daemon.json ./enabled-units.txt', './assembly-daemon.json', 'test_guest_cleanup_and_clone_inventory'),
        ('guest legacy unit directory ignored', ' || test -f "/lib/systemd/system/$1"', '', 'test_guest_legacy_cloud_init_units'),
        ('guest modern unit directory ignored', 'test -f "/usr/lib/systemd/system/$1" || ', '', 'test_guest_new_cloud_init_units'),
        ('guest undiscovered units selected', 'if has_unit "$unit"; then', 'if true; then', 'test_guest_legacy_cloud_init_units'),
        ('guest mixed partial or absent cloud-init admitted', '"${*:-none}" >&2; exit 1', '"${*:-none}" >&2; :', 'test_guest_invalid_cloud_init_layouts_refused'),
        ('guest missing required unit admitted', 'if ! has_unit "$unit"; then', 'if false; then', 'test_guest_partial_common_units_refused'),
        ('guest unit enable omitted', 'systemctl enable "$@"', ':', 'test_guest_new_cloud_init_units'),
        ('guest legacy unit hardcoded', 'systemctl enable "$@"', 'systemctl enable cloud-init.service', 'test_guest_new_cloud_init_units'),
        ('guest unit enable failure ignored', 'systemctl enable "$@"', 'systemctl enable "$@" || true', 'test_guest_unit_enable_failure_refused'),
        ('guest selected unit list omitted', 'printf \'%s\\n\' "$@" > enabled-units.txt', ':', 'test_guest_new_cloud_init_units'),
        ('guest enabled unit inventory omitted', "'enabled_units': units.read().splitlines()", "'enabled_units': []", 'test_all_images_loaded_from_archives_without_pull'),
        ("guest machine state inventory omitted", "inventory['machine_id_state'] = Path('/etc/machine-id').read_text().strip()", "pass", "test_guest_cleanup_and_clone_inventory"),
        ("guest SSH key inventory omitted", "inventory['ssh_host_keys'] = sorted(glob.glob('/etc/ssh/ssh_host_*'))", "pass", "test_guest_cleanup_and_clone_inventory"),
        ("guest Docker data root changed", '--data-root /var/lib/docker', '--data-root /tmp/wrong-store', "test_guest_dockerd_uses_runtime_store"),
        ("guest archive load changed to pull", "'load', '--input', path", "'pull', path", "test_all_images_loaded_from_archives_without_pull"),
        ("guest runtime tag namespace changed", "'kg-sandbox:' + flavour", "'wrong-sandbox:' + flavour", "test_runtime_tags_restored_after_all_loads"),
        ("guest runtime tags omitted", "subprocess.run([*docker, 'tag', actual, 'kg-sandbox:' + flavour], check=True)", 'pass', "test_runtime_tags_restored_after_all_loads"),
        ("guest containerd snapshotter admitted", "driver != 'overlay2'", 'False', "test_guest_containerd_snapshotter_refused"),
        ("guest driver fallback admitted", "driver != 'overlay2'", "driver == 'overlayfs'", "test_guest_driver_fallback_refused"),
        ("guest apt sees repository candidates", "-o Dir::Etc::SourceList=/dev/null ", "", "test_guest_packages_installed_offline_by_apt"),
        ("guest packages may download", "install -y --no-install-recommends --no-download", "install -y --no-install-recommends", "test_guest_packages_installed_offline_by_apt"),
        ("guest packages back to bare dpkg unpack", "apt-get install -y --no-install-recommends --no-download \\\n", "dpkg --unpack ./*.deb; : \\\n", "test_guest_packages_installed_offline_by_apt"),
        ("guest agent drop-in omitted", "printf '[Service]\\nExecStart=\\nExecStart=/run/incus_agent/incus-agent\\n'", ':', "test_guest_runs_the_host_supplied_agent"),
        ("guest agent keeps packaged binary", "ExecStart=\\nExecStart=/run/incus_agent/incus-agent", "ExecStart=/usr/libexec/incus/incus-agent", "test_guest_runs_the_host_supplied_agent"),
        ("guest assembly daemon uses Docker 29 default store", '{"features":{"containerd-snapshotter":false},"storage-driver":"overlay2"}', '{}', "test_guest_assembly_daemon_pins_classic_overlay2"),
        ("guest assembly daemon may fall back from overlay2", ',"storage-driver":"overlay2"}', '}', "test_guest_assembly_daemon_pins_classic_overlay2"),
        ("guest driver inventory absent", ", 'docker_driver': driver", '', "test_all_images_loaded_from_archives_without_pull"),
        ("guest package services not suppressed", "printf '#!/bin/sh\\nexit 101\\n' > /usr/sbin/policy-rc.d", ':', "test_guest_policy_rc_blocks_package_services"),
        ("guest daemon config adopted", 'test ! -e /etc/docker/daemon.json', ':', "test_guest_daemon_config_adoption_refused"),
        ("guest input cleanup omitted", 'rm -f ./*.deb ./*.tar ./dockerd.log ./assembly-daemon.json', ':', "test_guest_cleanup_and_clone_inventory"),
        ("guest clone cleanup omitted", 'cloud-init clean --logs --machine-id', ':', "test_guest_cleanup_and_clone_inventory"),
        ("guest SSH host keys retained", 'rm -f /etc/ssh/ssh_host_*', ':', "test_guest_cleanup_and_clone_inventory"),
        ("guest Docker identity retained", 'rm -f /var/lib/docker/engine-id /var/lib/docker/key.json', ':', "test_guest_cleanup_and_clone_inventory"),
        ("guest iptables enabled", '--iptables=false', '--iptables=true', "test_guest_dockerd_uses_runtime_store"),
        ("guest TCP Docker listener added", '--host unix:///run/vm-image-docker.sock --pidfile', '--host unix:///run/vm-image-docker.sock --host tcp://0.0.0.0:2375 --pidfile', "test_guest_dockerd_uses_runtime_store"),
        ("guest package version not verified", "actual != package['version']", "False", "test_guest_python_checks_run_against_synthetic_data"),
        ("guest archive checksum not verified", "value.hexdigest() != record['sha256']", "False", "test_guest_python_checks_run_against_synthetic_data"),
        ("guest loaded config ID not verified", "actual != record['image_id']", "False", "test_guest_python_checks_run_against_synthetic_data"),
        ("provisioner daemon path absent", "  ln -s /usr/sbin/dockerd /usr/bin/dockerd", "  :", "test_provisioner_dockerd_path"),
        ("cloud-init retains source cloud driver", "datasource_list: [NoCloud]", "datasource_list: [Azure]", "test_cloud_init_driver_uses_agent_seed"),
    ]
    for label, before, after, case in guest_changes:
        if before not in guest:
            raise RuntimeError("missing guest mutation anchor")
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            (directory / "build.py").write_text(source)
            (directory / "customize.sh").write_text(guest.replace(before, after))
            result = subprocess.run([sys.executable, str(test), "Pipeline." + case], capture_output=True, text=True,
                                    env={**os.environ, "VM_IMAGE_SOURCE": str(directory / "build.py")})
            if result.returncode == 0 or "FAIL: " + case not in result.stderr:
                raise RuntimeError("guest mutation survived or failed without assertion: " + label + "\n" + result.stderr)
            print("RED verified: " + label)


if __name__ == "__main__":
    if "--mutations" in sys.argv:
        mutations()
    else:
        unittest.main()
