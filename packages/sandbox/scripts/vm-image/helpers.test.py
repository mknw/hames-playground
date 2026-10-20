#!/usr/bin/env python3
"""Hermetic checks for grow_base.py and closure.py decision logic. No libguestfs, apt or network.

`--mutations` applies each named source edit and requires its test to fail.
"""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


def load(name):
    path = Path(os.environ.get("VM_HELPER_" + name.upper(), HERE / (name + ".py")))
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


grow = load("grow_base")
closure = load("closure")


def part(num, start, end, guid=None):
    return {"num": num, "start": start, "end": end, "type": "T" + str(num), "guid": guid or "G" + str(num)}


def inventory(parts, root_bytes=100, files="f", count=3):
    return {"parts": parts, "root_bytes": root_bytes, "files": files, "count": count}


class Helpers(unittest.TestCase):
    def test_aligned_end_leaves_the_backup_gpt_and_aligns(self):
        total = 10 * 1024 ** 3 // 512
        end = grow.aligned_end(total)
        self.assertEqual((end + 1) % grow.ALIGN, 0)
        self.assertLessEqual(end, total - grow.GPT_BACKUP - 1)
        self.assertGreater(end, total - grow.GPT_BACKUP - grow.ALIGN - 1)
        with self.assertRaises(RuntimeError):
            grow.aligned_end(grow.GPT_BACKUP + 10)

    def test_root_must_be_partition_one_and_last(self):
        layout = [part(1, 1000, 5000), part(14, 10, 20), part(15, 30, 900)]
        self.assertEqual(grow.root_partition(layout)["num"], 1)
        for broken in ([part(1, 10, 20), part(16, 1000, 5000)], [part(2, 1000, 5000)]):
            with self.assertRaises(RuntimeError):
                grow.root_partition(broken)

    def test_compare_admits_only_root_growth(self):
        before = inventory([part(1, 1000, 5000), part(15, 30, 900)])
        grown = inventory([part(1, 1000, 9000), part(15, 30, 900)], root_bytes=200)
        grow.compare(before, grown)
        refusals = {
            "root did not grow": inventory([part(1, 1000, 9000), part(15, 30, 900)], root_bytes=100),
            "other partition resized": inventory([part(1, 1000, 9000), part(15, 30, 950)], root_bytes=200),
            "partition moved": inventory([part(1, 1100, 9000), part(15, 30, 900)], root_bytes=200),
            "GUID changed": inventory([part(1, 1000, 9000, "X"), part(15, 30, 900)], root_bytes=200),
            "partition added": inventory([part(1, 1000, 9000), part(15, 30, 900), part(16, 9001, 9100)], root_bytes=200),
            "file list changed": inventory([part(1, 1000, 9000), part(15, 30, 900)], root_bytes=200, files="g"),
            "file count changed": inventory([part(1, 1000, 9000), part(15, 30, 900)], root_bytes=200, count=4),
            "root shrank": inventory([part(1, 1000, 4000), part(15, 30, 900)], root_bytes=200),
        }
        for label, after in refusals.items():
            with self.subTest(label), self.assertRaises(RuntimeError):
                grow.compare(before, after)

    def test_size_is_whole_gib(self):
        self.assertEqual(grow.size_bytes("10G"), 10 * 1024 ** 3)
        for value in ("10", "0G", "1.5G", "10GiB", "-1G", "10G extra"):
            with self.subTest(value), self.assertRaises(RuntimeError):
                grow.size_bytes(value)

    def test_synthetic_status_marks_every_manifest_package_installed(self):
        status = closure.synthetic_status("adduser\t3.153ubuntu1\nlibc6:amd64\t2.42-2ubuntu1\n\n")
        stanzas = status.split("\n\n")
        self.assertEqual(len(stanzas), 2)
        self.assertIn("Package: adduser\nStatus: install ok installed\nArchitecture: all\nVersion: 3.153ubuntu1", stanzas[0])
        self.assertIn("Package: libc6\nStatus: install ok installed\nArchitecture: amd64\nVersion: 2.42-2ubuntu1", stanzas[1])
        for broken in ("", "adduser 3.153\n", "adduser\t3.1\textra\n", "Bad_Name\t1.0\n", "adduser\t1.0;rm\n"):
            with self.subTest(broken=broken), self.assertRaises(RuntimeError):
                closure.synthetic_status(broken)

    def test_snapshot_source_is_dated_signed_and_codename_bound(self):
        source = closure.sources("resolute", "20261018T120000Z")
        self.assertIn("URIs: https://snapshot.ubuntu.com/ubuntu/20261018T120000Z\n", source)
        self.assertIn("Suites: resolute resolute-updates resolute-security\n", source)
        self.assertIn("Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n", source)
        for codename, snapshot in (("resolute", "latest"), ("resolute", "2026-10-18"), ("../x", "20261018T120000Z"), ("", "20261018T120000Z")):
            with self.subTest(codename=codename, snapshot=snapshot), self.assertRaises(RuntimeError):
                closure.sources(codename, snapshot)

    def test_closure_requires_the_lock_packages(self):
        self.assertEqual(set(closure.REQUIRED), set(load("build").REQUIRED))


def mutations():
    baseline = subprocess.run([sys.executable, __file__], capture_output=True, text=True)
    if baseline.returncode:
        raise RuntimeError("green baseline required\n" + baseline.stderr)
    changes = [
        ("grow_base", "backup GPT ignored", "(total_sectors - GPT_BACKUP) // ALIGN", "total_sectors // ALIGN", "test_aligned_end_leaves_the_backup_gpt_and_aligns"),
        ("grow_base", "end not aligned", "// ALIGN * ALIGN - 1", "- 1", "test_aligned_end_leaves_the_backup_gpt_and_aligns"),
        ("grow_base", "any partition taken as root", 'root = [p for p in parts if p["num"] == 1]', "root = parts[:1]", "test_root_must_be_partition_one_and_last"),
        ("grow_base", "root need not be last", 'and max(p["start"] for p in parts) == root[0]["start"]', "", "test_root_must_be_partition_one_and_last"),
        ("grow_base", "partition identity unchecked", 'require([(p["num"], p["start"], p["type"], p["guid"]) for p in before["parts"]]', 'require(True or [(p["num"], p["start"], p["type"], p["guid"]) for p in before["parts"]]', "test_compare_admits_only_root_growth"),
        ("grow_base", "other partition resize admitted", 'new["end"] == old["end"] or (old["num"] == 1', 'True or (old["num"] == 1', "test_compare_admits_only_root_growth"),
        ("grow_base", "filesystem growth unchecked", 'after["root_bytes"] > before["root_bytes"]', "True", "test_compare_admits_only_root_growth"),
        ("grow_base", "file list unchecked", 'after["files"] == before["files"] and ', "", "test_compare_admits_only_root_growth"),
        ("grow_base", "fractional size admitted", 'r"([1-9][0-9]*)G"', 'r"([0-9.]+)G"', "test_size_is_whole_gib"),
        ("closure", "manifest package left uninstalled", "Status: install ok installed", "Status: deinstall ok config-files", "test_synthetic_status_marks_every_manifest_package_installed"),
        ("closure", "manifest arch suffix kept in name", 'name, _, arch = fields[0].partition(":")', 'name, arch = fields[0], ""', "test_synthetic_status_marks_every_manifest_package_installed"),
        ("closure", "malformed manifest admitted", 'require(len(fields) == 2, "malformed manifest line")', "fields = (fields + [''])[:2]", "test_synthetic_status_marks_every_manifest_package_installed"),
        ("closure", "undated archive admitted", 're.fullmatch(r"[0-9]{8}T[0-9]{6}Z", snapshot)', "snapshot", "test_snapshot_source_is_dated_signed_and_codename_bound"),
        ("closure", "unsigned snapshot source", "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\\n", "Trusted: yes\\n", "test_snapshot_source_is_dated_signed_and_codename_bound"),
        ("closure", "security pocket dropped", " {codename}-security", "", "test_snapshot_source_is_dated_signed_and_codename_bound"),
        ("closure", "required package dropped", '"incus-agent", "docker.io"', '"docker.io"', "test_closure_requires_the_lock_packages"),
    ]
    for module, label, before, after, case in changes:
        source = (HERE / (module + ".py")).read_text()
        if before not in source:
            raise RuntimeError("missing mutation anchor: " + label)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / (module + ".py")
            path.write_text(source.replace(before, after))
            result = subprocess.run([sys.executable, __file__, "Helpers." + case], capture_output=True, text=True,
                                    env={**os.environ, "VM_HELPER_" + module.upper(): str(path)})
            if result.returncode == 0 or not any(kind + case in result.stderr for kind in ("FAIL: ", "ERROR: ")):
                raise RuntimeError("mutation survived: " + label + "\n" + result.stderr)
            print("RED verified: " + label)


if __name__ == "__main__":
    if "--mutations" in sys.argv:
        mutations()
    else:
        unittest.main()
