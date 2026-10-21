#!/usr/bin/env python3
"""Hermetic checks for grow_base.py and closure.py decision logic. No libguestfs, apt or network.

`--mutations` applies each named source edit and requires its test to fail.

The libguestfs calls run against a recording fake (`FakeGuest`), so the offline
and read-only handles, the e2fsck-before-resize2fs order and every refusal are
pinned here. What only the real library can answer (that the partition resize
and the filesystem check do what they are asked to) stays covered by the
off-host rehearsal, which grows a real stock image.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent


def load(name):
    path = Path(os.environ.get("VM_HELPER_" + name.upper(), HERE / (name + ".py")))
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


grow = load("grow_base")
closure = load("closure")


class FakeGuest:
    """Just enough libguestfs for grow() and inventory(): per-path disk state, every call recorded."""
    disks = {}
    handles = []

    def __init__(self, python_return_dict=False):
        self.calls = []
        FakeGuest.handles.append(self)

    def version(self):
        return {"major": 1, "minor": 0, "release": 0}

    def set_network(self, enabled):
        self.calls.append(("set_network", enabled))

    def add_drive_opts(self, path, format, readonly):
        self.path = path
        self.calls.append(("add_drive", path, readonly))

    def launch(self):
        self.calls.append(("launch",))

    def part_list(self, device):
        return [dict(p) for p in FakeGuest.disks[self.path]["parts"]]

    def part_get_gpt_type(self, device, num):
        return "T%d" % num

    def part_get_gpt_guid(self, device, num):
        return "G%d" % num

    def mount_ro(self, device, mountpoint):
        self.calls.append(("mount_ro", device))

    def statvfs(self, mountpoint):
        return {"blocks": FakeGuest.disks[self.path]["fs_blocks"], "frsize": 512}

    def find0(self, directory, listing):
        Path(listing).write_bytes(b"\0".join(FakeGuest.disks[self.path]["files"]) + b"\0")

    def part_expand_gpt(self, device):
        self.calls.append(("part_expand_gpt",))

    def blockdev_getsz(self, device):
        return FakeGuest.disks[self.path]["sectors"]

    def part_resize(self, device, num, end):
        self.calls.append(("part_resize", num, end))
        for p in FakeGuest.disks[self.path]["parts"]:
            if p["part_num"] == num:
                p["part_end"] = end * 512

    def e2fsck(self, device, forceall):
        self.calls.append(("e2fsck", forceall))

    def resize2fs(self, device):
        self.calls.append(("resize2fs",))
        disk = FakeGuest.disks[self.path]
        disk["fs_blocks"] = disk["parts"][0]["part_end"] // 512

    def shutdown(self):
        self.calls.append(("shutdown",))

    def close(self):
        self.calls.append(("close",))


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

    def test_status_must_be_a_dpkg_status_file(self):
        good = "Package: adduser\nStatus: install ok installed\nVersion: 3\n\nPackage: libc6\nStatus: install ok installed\n"
        self.assertEqual(closure.checked_status(good), good)
        for broken in ("", "adduser\t3.153\n", "Package: adduser\nVersion: 3\n", good + "\nStatus: install ok installed\n"):
            with self.subTest(broken=broken), self.assertRaises(RuntimeError):
                closure.checked_status(broken)

    def test_archive_source_is_signed_and_codename_bound(self):
        source = closure.sources("resolute")
        self.assertIn("Suites: resolute resolute-updates resolute-security\n", source)
        self.assertIn("Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n", source)
        for codename in ("../x", "", "resolute main"):
            with self.subTest(codename=codename), self.assertRaises(RuntimeError):
                closure.sources(codename)

    def test_closure_requires_the_lock_packages(self):
        self.assertEqual(set(closure.REQUIRED), set(load("build").REQUIRED))


class GrowWithFakes(unittest.TestCase):
    STOCK_BYTES = 3 * 1024 ** 3

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.stock = Path(self.directory.name) / "stock.img"
        self.output = Path(self.directory.name) / "grown.qcow2"
        self.stock.write_bytes(b"stock")
        self.info = {"format": "qcow2", "virtual-size": self.STOCK_BYTES}
        self.log = []
        sectors = self.STOCK_BYTES // 512
        FakeGuest.disks = {str(self.stock): {
            "parts": [{"part_num": 1, "part_start": 2048 * 512, "part_end": grow.aligned_end(sectors) * 512},
                      {"part_num": 15, "part_start": 100 * 512, "part_end": 900 * 512}],
            "sectors": sectors, "fs_blocks": 1000, "files": [b"/a", b"/b"]}}
        FakeGuest.handles = []
        fake_module = types.ModuleType("guestfs")
        fake_module.GuestFS = FakeGuest
        fake_module = types.ModuleType("guestfs")
        fake_module.GuestFS = FakeGuest
        for patch in (mock.patch.dict(sys.modules, {"guestfs": fake_module}),
                      mock.patch.object(grow, "qemu_img", self.qemu_img)):
            patch.start()
            self.addCleanup(patch.stop)

    def qemu_img(self, *args):
        self.log.append(args)
        if args[0] == "info":
            return json.dumps(self.info)
        if args[0] == "convert":
            Path(args[-1]).write_bytes(b"grown")
            FakeGuest.disks[args[-1]] = copy.deepcopy(FakeGuest.disks[args[-2]])
        if args[0] == "resize":
            FakeGuest.disks[args[-2]]["sectors"] = grow.size_bytes(args[-1]) // 512
        return "qemu-img version 0\n" if args[0] == "--version" else ""

    def test_growth_is_offline_checked_and_resized_in_order(self):
        provenance = grow.grow(self.stock, self.output, "4G")
        self.assertGreater(provenance["after"]["root_bytes"], provenance["before"]["root_bytes"])
        drives = [handle for handle in FakeGuest.handles if handle.calls]  # the bare version() handle never opens one
        self.assertEqual(len(drives), 3)
        for handle in drives:
            self.assertIn(("set_network", False), handle.calls)
        opened = [next(call[2] for call in handle.calls if call[0] == "add_drive") for handle in drives]
        self.assertEqual(opened, [1, 0, 1])  # stock read-only, output writable, grown output read-only
        self.assertIn(("add_drive", str(self.stock), 1), drives[0].calls)
        writer = drives[1]
        steps = [call[0] for call in writer.calls]
        self.assertEqual([step for step in steps if step in ("part_resize", "e2fsck", "resize2fs", "shutdown")],
                         ["part_resize", "e2fsck", "resize2fs", "shutdown"])
        self.assertIn(("e2fsck", True), writer.calls)

    def test_a_disk_that_is_not_a_standalone_qcow2_is_refused(self):
        for label, change in {"raw": {"format": "raw"}, "backing file": {"backing-filename": "x.img"},
                              "encrypted": {"encrypted": True},
                              "external data file": {"format-specific": {"data": {"data-file": "d"}}}}.items():
            with self.subTest(label), self.assertRaises(RuntimeError):
                grow.standalone_size({**self.info, **change})
        self.assertEqual(grow.standalone_size(self.info), self.STOCK_BYTES)

    def test_the_output_must_be_fresh(self):
        self.output.write_bytes(b"x")
        with self.assertRaises(RuntimeError):
            grow.grow(self.stock, self.output, "4G")
        self.output.unlink()
        with self.assertRaises(RuntimeError):
            grow.grow(self.stock, Path(self.directory.name) / "missing" / "grown.qcow2", "4G")

    def test_the_target_must_exceed_the_stock_disk(self):
        for size in ("2G", "3G"):
            with self.subTest(size), self.assertRaises(RuntimeError):
                grow.grow(self.stock, self.output, size)
        self.assertFalse([entry for entry in self.log if entry[0] == "convert"])

    def test_a_root_that_already_fills_the_disk_is_refused(self):
        self.assertEqual(grow.grow_end(8 * 1024 ** 2, 1000 * 512), grow.aligned_end(8 * 1024 ** 2))
        with self.assertRaises(RuntimeError):
            grow.grow_end(8 * 1024 ** 2, grow.aligned_end(8 * 1024 ** 2) * 512)


class ClosureCommands(unittest.TestCase):
    STATE = Path("/state")

    def test_apt_is_confined_to_the_state_directory(self):
        self.assertEqual(closure.apt_options(self.STATE), [
            "-o", "Dir::State::status=/state/status", "-o", "Dir::State::Lists=/state/lists",
            "-o", "Dir::Cache::archives=/state/archives", "-o", "Dir::Etc::sourcelist=/state/archive.sources",
            "-o", "Dir::Etc::sourceparts=-", "-o", "APT::Get::List-Cleanup=0"])

    def test_install_reinstalls_the_required_packages_download_only(self):
        update, install = closure.apt_commands(self.STATE)
        self.assertEqual(update[-1], "update")
        tail = install[install.index("install"):]
        self.assertEqual(tail[:5], ["install", "--download-only", "--reinstall", "-y", "--no-install-recommends"])
        self.assertEqual(tail[5:], list(closure.REQUIRED))
        self.assertEqual(install[:len(closure.apt_options(self.STATE)) + 1],
                         ["apt-get", *closure.apt_options(self.STATE)])

    def test_the_archive_is_the_ubuntu_one_and_includes_universe(self):
        source = closure.sources("resolute")
        self.assertIn("URIs: http://archive.ubuntu.com/ubuntu\n", source)
        self.assertIn("Components: main universe\n", source)  # docker.io lives in universe

    def test_the_closure_must_be_complete_and_free_of_duplicates(self):
        closure.complete([*closure.REQUIRED, "libc6"])
        for label, names in {"missing": list(closure.REQUIRED[1:]),
                             "duplicated": [*closure.REQUIRED, "libc6", "libc6"]}.items():
            with self.subTest(label), self.assertRaises(RuntimeError):
                closure.complete(names)

    def test_the_output_directory_must_be_empty(self):
        with tempfile.TemporaryDirectory() as directory:
            closure.fresh_output(Path(directory))
            (Path(directory) / "stale.deb").write_bytes(b"x")
            with self.assertRaises(RuntimeError):
                closure.fresh_output(Path(directory))
            with self.assertRaises(RuntimeError):
                closure.fresh_output(Path(directory) / "missing")

    def test_status_package_lines_are_anchored(self):
        for broken in ("Depends: Package: adduser\nStatus: install ok installed\n",
                       "Package: adduser extra\nStatus: install ok installed\n"):
            with self.subTest(broken=broken), self.assertRaises(RuntimeError):
                closure.checked_status(broken)


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
        ("closure", "status file unchecked", 'require(stanzas and all(', 'require(True or all(', "test_status_must_be_a_dpkg_status_file"),
        ("closure", "stanza without Status admitted", ' and re.search(r"^Status: ", stanza, re.M)', '', "test_status_must_be_a_dpkg_status_file"),
        ("closure", "codename unchecked", 'require(re.fullmatch(r"[a-z]+", codename), "codename required")', "pass", "test_archive_source_is_signed_and_codename_bound"),
        ("closure", "unsigned archive source", "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\\n", "Trusted: yes\\n", "test_archive_source_is_signed_and_codename_bound"),
        ("closure", "security pocket dropped", " {codename}-security", "", "test_archive_source_is_signed_and_codename_bound"),
        ("closure", "required package dropped", '"incus-agent", "docker.io"', '"docker.io"', "test_closure_requires_the_lock_packages"),
        ("grow_base", "backing file admitted", ' and not info.get("backing-filename")', "", "GrowWithFakes.test_a_disk_that_is_not_a_standalone_qcow2_is_refused"),
        ("grow_base", "encrypted disk admitted", ' and not info.get("encrypted")', "", "GrowWithFakes.test_a_disk_that_is_not_a_standalone_qcow2_is_refused"),
        ("grow_base", "external data file admitted", ' and not info.get("format-specific", {}).get("data", {}).get("data-file")', "", "GrowWithFakes.test_a_disk_that_is_not_a_standalone_qcow2_is_refused"),
        ("grow_base", "stale output admitted", 'require(not output.exists() and output.parent.is_dir(), "fresh output path required")', "pass", "GrowWithFakes.test_the_output_must_be_fresh"),
        ("grow_base", "smaller target admitted", 'require(standalone_qcow2(stock) < size_bytes(size), "target size must exceed the stock disk")', "standalone_qcow2(stock)", "GrowWithFakes.test_the_target_must_exceed_the_stock_disk"),
        ("grow_base", "no-growth admitted", 'require(end > root_end_bytes // 512, "nothing to grow")', "pass", "GrowWithFakes.test_a_root_that_already_fills_the_disk_is_refused"),
        ("grow_base", "filesystem check skipped", "g.e2fsck(device, forceall=True)", "pass", "GrowWithFakes.test_growth_is_offline_checked_and_resized_in_order"),
        ("grow_base", "filesystem not resized", "g.resize2fs(device)", "pass", "GrowWithFakes.test_growth_is_offline_checked_and_resized_in_order"),
        ("grow_base", "guest network enabled", "g.set_network(False)", "g.set_network(True)", "GrowWithFakes.test_growth_is_offline_checked_and_resized_in_order"),
        ("grow_base", "stock disk opened writable", "g = handle(path, readonly=True)", "g = handle(path, readonly=False)", "GrowWithFakes.test_growth_is_offline_checked_and_resized_in_order"),
        ("grow_base", "read-only flag ignored", "readonly=1 if readonly else 0", "readonly=0", "GrowWithFakes.test_growth_is_offline_checked_and_resized_in_order"),
        ("closure", "base status not used", '"-o", "Dir::State::status=" + str(state / "status"),', "", "ClosureCommands.test_apt_is_confined_to_the_state_directory"),
        ("closure", "host source parts read", '"-o", "Dir::Etc::sourceparts=-",', "", "ClosureCommands.test_apt_is_confined_to_the_state_directory"),
        ("closure", "reinstall dropped", '"--reinstall", ', "", "ClosureCommands.test_install_reinstalls_the_required_packages_download_only"),
        ("closure", "download-only dropped", '"--download-only", ', "", "ClosureCommands.test_install_reinstalls_the_required_packages_download_only"),
        ("closure", "universe dropped", "Components: main universe", "Components: main", "ClosureCommands.test_the_archive_is_the_ubuntu_one_and_includes_universe"),
        ("closure", "archive moved", "http://archive.ubuntu.com/ubuntu", "http://archive.example.invalid/ubuntu", "ClosureCommands.test_the_archive_is_the_ubuntu_one_and_includes_universe"),
        ("closure", "duplicates admitted", " and len(names) == len(set(names))", "", "ClosureCommands.test_the_closure_must_be_complete_and_free_of_duplicates"),
        ("closure", "missing package admitted", "set(REQUIRED) <= set(names) and ", "", "ClosureCommands.test_the_closure_must_be_complete_and_free_of_duplicates"),
        ("closure", "stale output admitted", " and not any(out.iterdir())", "", "ClosureCommands.test_the_output_directory_must_be_empty"),
        ("closure", "package line unanchored", 'r"^Package: [a-z0-9][a-z0-9+.-]*$"', 'r"Package: [a-z0-9][a-z0-9+.-]*$"', "ClosureCommands.test_status_package_lines_are_anchored"),
        ("closure", "package name unbounded", 'r"^Package: [a-z0-9][a-z0-9+.-]*$"', 'r"^Package: [a-z0-9][a-z0-9+.-]*"', "ClosureCommands.test_status_package_lines_are_anchored"),
    ]
    for module, label, before, after, case in changes:
        source = (HERE / (module + ".py")).read_text()
        if before not in source:
            raise RuntimeError("missing mutation anchor: " + label)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / (module + ".py")
            path.write_text(source.replace(before, after))
            result = subprocess.run([sys.executable, __file__, case if "." in case else "Helpers." + case], capture_output=True, text=True,
                                    env={**os.environ, "VM_HELPER_" + module.upper(): str(path)})
            method = case.split(".")[-1]
            if result.returncode == 0 or not any(kind + method in result.stderr for kind in ("FAIL: ", "ERROR: ")):
                raise RuntimeError("mutation survived: " + label + "\n" + result.stderr)
            print("RED verified: " + label)


if __name__ == "__main__":
    if "--mutations" in sys.argv:
        mutations()
    else:
        unittest.main()
