#!/usr/bin/env python3
"""Hermetic stage tests and individual, restored-source red mutations."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
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
            self.assertEqual(argv[argv.index("--run-command") + 1], "sh /opt/vm-image/customize.sh")
            for index, arg in enumerate(argv):
                if arg == "--upload":
                    source, target = argv[index + 1].split(":", 1)
                    self.assertTrue(Path(source).is_relative_to(work.root))
                    self.assertTrue(target.startswith("/opt/vm-image/"))
            return b""
        if name == "guestfish":
            Path(argv[-1]).write_text(json.dumps({"images": {f: self.pin for f in vm.FLAVOURS},
                "packages": {p["name"]: p["version"] for p in self.lock["packages"]}}))
            return b""
        self.fail("unapproved builder command")

    def build(self):
        with patch.object(vm.platform, "system", return_value="Linux"), \
             patch.object(vm.platform, "machine", return_value="x86_64"), \
             patch.object(vm, "run", side_effect=self.fake):
            vm.main(["build", "--apply", "--lock", str(self.lock_path), "--work-dir", str(self.work)])

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
            self.assertEqual(archive.getnames(), ["metadata.yaml"])
            self.assertIn(b"architecture: x86_64", archive.extractfile("metadata.yaml").read())
        self.assertTrue(self.calls)
        self.assertEqual(manifest["status"], "assembled-not-boot-validated")

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
        env = {"DOCKER_HOST": "tcp://synthetic.invalid:1", "LIBGUESTFS_BACKEND": "untrusted"}
        with patch.dict(os.environ, env), patch.object(subprocess, "run") as child:
            child.return_value.returncode = 0
            child.return_value.stdout = b"ok"
            self.assertEqual(vm.run(["synthetic", "--version"], work), b"ok")
            options = child.call_args.kwargs
            self.assertEqual(options["cwd"], self.work)
            self.assertFalse(any(k.startswith("DOCKER_") for k in options["env"]))
            for name in ("TMPDIR", "XDG_CACHE_HOME", "LIBGUESTFS_CACHEDIR", "LIBGUESTFS_TMPDIR"):
                self.assertEqual(options["env"][name], str(self.work))
            self.assertEqual(options["env"]["LIBGUESTFS_BACKEND"], "direct")
            child.return_value.returncode = 1
            with self.assertRaises(RuntimeError):
                vm.run(["synthetic"], work)

    def test_save_uses_only_explicit_endpoint_inspect_and_save(self):
        calls = []
        def saved(argv, work):
            calls.append([str(a) for a in argv])
            self.assertEqual(argv[:3], ["docker", "--host", "unix:///synthetic/disposable.sock"])
            if argv[3:5] == ["image", "inspect"]:
                return self.pin.encode()
            self.assertEqual(argv[3:6], ["image", "save", "--output"])
            tar(Path(argv[6]), self.entries)
            return b""
        with patch.object(vm, "run", side_effect=saved):
            vm.main(["save", "--apply", "--docker-host", "unix:///synthetic/disposable.sock",
                     "--work-dir", str(self.work), *sum((["--" + f + "-image", self.pin] for f in vm.FLAVOURS), [])])
        self.assertEqual(len(calls), 6)
        self.assertEqual(set(json.loads((self.work / "flavours.json").read_text())), set(vm.FLAVOURS))

    def test_guest_python_checks_run_against_synthetic_data(self):
        # Execute the actual embedded Python against a tiny save archive and a
        # child-process shim. Never execute the guest shell against the host.
        scripts = re_scripts((vm.HERE / "customize.sh").read_text())
        vm.main(["verify", "--apply", "--lock", str(self.lock_path), "--work-dir", str(self.work)])
        def output(argv, **kwargs):
            if argv[0] == "dpkg-query":
                if "-f=${Version}" in argv:
                    return "1.2.3"
                return "".join(p["name"] + "\t1.2.3\n" for p in self.lock["packages"])
            return self.pin + "\n"
        old = Path.cwd()
        try:
            os.chdir(self.work)
            with patch.object(subprocess, "check_output", side_effect=output), \
                 patch.object(subprocess, "run") as child:
                for script in scripts:
                    exec(compile(script, "guest-script", "exec"), {})
                self.assertEqual(child.call_count, 6)  # three loads and three local tags
                self.assertEqual(json.loads(Path("inventory.json").read_text())["images"]["base"], self.pin)
                with patch.object(subprocess, "check_output", return_value="wrong"):
                    with self.assertRaises(SystemExit):
                        exec(compile(scripts[0], "guest-script", "exec"), {})
                with patch.object(subprocess, "check_output", side_effect=lambda argv, **kw:
                                  "wrong" if argv[0] == "docker" else output(argv, **kw)):
                    with self.assertRaises(SystemExit):
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
        ("unpinned input accepted", '    require(isinstance(record, dict)', '    record.setdefault("sha256", digest(directory / record["path"]))\n    require(isinstance(record, dict)', "test_unpinned_input_is_rejected"),
        ("input checksum not verified", 'digest(path) == record["sha256"]', 'True', "test_digest_mismatch_rejected_before_staging"),
        ("staged checksum not verified", 'digest(path) == expected', 'True', "test_staged_digest_is_rechecked"),
        ("config digest not verified", '"sha256:" + hashlib.sha256(config).hexdigest() == expected', 'True', "test_config_id_layer_and_platform_are_verified"),
        ("layer digest not verified", '"sha256:" + value.hexdigest() == expected_layer', 'True', "test_config_id_layer_and_platform_are_verified"),
        ("manifest missing disk hash", '"outputs": hashes', '"outputs": {k: v for k, v in hashes.items() if k != "disk.qcow2"}', "test_full_stage_plan_manifest_hashes_and_fingerprint"),
        ("stage writes outside work directory", 'path.resolve().is_relative_to(self.root) and not path.is_symlink()', 'True', "test_write_cannot_escape_or_follow_symlinks"),
        ("customization gets network", '"--no-network", "--format"', '"--network", "--format"', "test_full_stage_plan_manifest_hashes_and_fingerprint"),
        ("disk backing chain admitted", 'not value.get("backing-filename")', 'True', "test_backing_chain_encryption_external_file_and_size_refused"),
        ("tool version not verified", 'version == record["version"]', 'True', "test_tool_version_mismatch_refuses_manifest"),
        ("required Incus agent package omitted", 'REQUIRED <= set(names)', 'True', "test_required_packages_and_full_ids"),
        ("mutable flavour input accepted", 'require(image_id(record.get("image_id")),', 'require(True,', "test_required_packages_and_full_ids"),
        ("argument error echoes values", 'self.exit(2, "Invalid image pipeline arguments; consult --help (values suppressed).\\n")', 'self.exit(2, _message)', "test_invalid_arguments_do_not_echo_values"),
    ]
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
        ("guest package version not verified", "actual != package['version']", "False", "test_guest_python_checks_run_against_synthetic_data"),
        ("guest archive checksum not verified", "value.hexdigest() != record['sha256']", "False", "test_guest_python_checks_run_against_synthetic_data"),
        ("guest loaded config ID not verified", "actual != record['image_id']", "False", "test_guest_python_checks_run_against_synthetic_data"),
        ("provisioner daemon path absent", "  ln -s /usr/sbin/dockerd /usr/bin/dockerd", "  :", "test_provisioner_dockerd_path"),
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
