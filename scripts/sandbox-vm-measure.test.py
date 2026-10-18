#!/usr/bin/env python3
"""Hermetic consumer tests for the measurement orchestration; no daemon, VM or network.

python3 scripts/sandbox-vm-measure.test.py
The real orchestrators run against fake process boundaries: subprocess.run for
one-shot commands (so the production host Docker gate in command() is live) and
Popen for MCP streams. The PTY leg spawns a real child on a real PTY.
"""
import hashlib
import io
import tarfile
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(os.environ.get("SANDBOX_VM_SOURCE", ROOT / "scripts/lib/sandbox_vm.py"))
spec = importlib.util.spec_from_file_location("sandbox_vm", SOURCE)
vm = importlib.util.module_from_spec(spec)
sys.modules["sandbox_vm"] = vm
spec.loader.exec_module(vm)
measure_spec = importlib.util.spec_from_file_location("sandbox_vm_measure", SOURCE.with_name("sandbox_vm_measure.py"))
measure = importlib.util.module_from_spec(measure_spec)
measure_spec.loader.exec_module(measure)

REAL_POPEN, REAL_SLEEP = subprocess.Popen, time.sleep
IMAGE = "synthetic@sha256:" + "a" * 64
APP, OTHER, CANARY = "app-net", "probe-net", ("172.18.0.5", 6379)
QEMU_PID, CANARY_PORT = 4242, 40000
HOST_VERBS = {"inspect", "run", "exec", "wait"}


def result(stdout="", code=0, stderr=""):
    return SimpleNamespace(stdout=stdout, stderr=stderr, returncode=code)


def option(argv, flag):
    return argv[argv.index(flag) + 1]


class Clock:
    """Fake time for the long stream/poll loops; never blocks for real."""
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds
        REAL_SLEEP(0.001)


class Listener:
    def __init__(self, world):
        self.world = world

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def bind(self, address):
        self.world.timeline.append(("canary", address))

    def listen(self):
        pass

    def getsockname(self):
        return ("synthetic", CANARY_PORT)


class Sockets:
    """Host-namespace sockets: the positive controls and the host canary."""
    def __init__(self, world):
        self.world = world

    def create_connection(self, target, timeout):
        self.world.timeline.append(("connect", target))
        if not self.world.host_reachable:
            raise OSError("synthetic unreachable")
        return SimpleNamespace(close=lambda: None)

    def socket(self):
        return Listener(self.world)


class FakeMcp:
    """An MCP server behind real pipes, so Mcp's selector/os.read path is real."""
    def __init__(self, world, argv):
        self.world, self.cid = world, argv[argv.index("exec") + 2]
        read_in, write_in = os.pipe()
        read_out, self.write_out = os.pipe()
        self.stdin, self.stdout = os.fdopen(write_in, "wb"), os.fdopen(read_out, "rb")
        self.requests = os.fdopen(read_in, "rb")
        self.returncode, self.pid = None, -1
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        for line in self.requests:
            message = json.loads(line)
            if "id" not in message:
                continue
            reply = {}
            if message["method"] == "tools/list":
                reply = {"tools": [{"name": "synthetic"}]}
            elif message["method"] == "tools/call" and message["params"]["name"] == "bash":
                reply = {"content": [{"type": "text", "text": "1048576"}]}
            os.write(self.write_out, (json.dumps({"jsonrpc": "2.0", "id": message["id"],
                                                  "result": reply}) + "\n").encode())
        self.requests.close()
        os.close(self.write_out)

    def wait(self, timeout=None):
        # A removed container ends its exec stream; otherwise only stdin EOF does.
        if self.world.boxes[self.cid]["alive"]:
            self.thread.join(timeout)
            if self.thread.is_alive():
                raise subprocess.TimeoutExpired("docker", timeout)
        self.returncode = 0
        return 0

    def poll(self):
        return self.returncode

    def terminate(self):
        self.returncode = -15


class World:
    """Synthetic host + two guests. Policy: isolated unless a key is leaked/blocked."""
    def __init__(self, test, spike, proc):
        self.test, self.spike, self.proc = test, spike, proc
        self.timeline, self.boxes, self.listeners = [], {}, set()
        self.leaks, self.blocked, self.inconclusive = set(), set(), set()
        self.host_reachable = True
        self.lock = threading.Lock()
        self.release, self.finished = None, 0  # Optionally hold workloads until released.
        self.pids = iter(range(1000, 100000))
        (proc / "meminfo").write_text("MemAvailable:    8000000 kB\n")
        (proc / str(QEMU_PID)).mkdir()
        (proc / str(QEMU_PID) / "smaps_rollup").write_text("Pss:   500000 kB\n")

    def reachable(self, source, address, port):
        key = (source, address, port)
        if key in self.leaks or key in self.blocked:
            return key in self.leaks
        tls, own = self.spike.args.tls_port, {self.spike.address(i): i for i in range(2)}
        if source.startswith("guest"):
            index = int(source[-1])
            return own.get(address) == index and (port == tls or (port == tls + 1 and index in self.listeners))
        if source == APP:
            return (address in own and port == tls) or (address, port) == CANARY
        return False

    def probe(self, source, address, port):
        if (source, address, int(port)) in self.inconclusive:
            return result(code=1, stderr="Traceback")
        return result(code=0 if self.reachable(source, address, int(port)) else 3)

    def run(self, args, input=None, text=None, capture_output=None, timeout=None, env=None):
        with self.lock:
            self.timeline.append(("run", args, env))
        if args[0] == "docker":
            self.test.assertEqual([key for key in env if key.startswith("DOCKER_")], [])
            if args[1:3] == ("--host", vm.HOST_SOCKET):
                return self.docker("host", args[3:])
            self.test.assertEqual(args[1], "--config")
            return self.docker(Path(args[2]).parent.name, args[3:])
        if args[0] == "incus":
            return self.incus(args)
        if args[0] == "qemu-system-x86_64":
            return result("QEMU emulator version 8.2.2\n")
        self.test.fail("unexpected system command")

    def docker(self, where, argv):
        verb = argv[0]
        if verb == "inspect" and argv[1] == "--type":
            return result(json.dumps({"Id": "sha256:" + "b" * 64, "GraphDriver": {"Name": "overlay2"}}))
        if verb == "inspect" and argv[2] == "{{json .Config.Labels}}":
            box = self.boxes.get(argv[3])
            owned = box and box["where"] == where
            return result(json.dumps({"sandbox-vm-spike": box["label"] if owned else "foreign"}))
        if verb == "inspect" and argv[2] == "{{.State.Pid}}":
            return result(str(self.boxes[argv[3]]["pid"]) + "\n")
        if verb == "info":
            return result("guest-daemon\n")
        if verb == "run" and "-d" in argv:
            with self.lock:
                pid = next(self.pids)
                cid = f"{pid:064x}"
                self.boxes[cid] = {"where": where, "name": option(argv, "--name"), "pid": pid, "alive": True,
                                   "label": option(argv, "--label").split("=", 1)[1]}
            (self.proc / str(pid) / "task" / str(pid)).mkdir(parents=True)
            (self.proc / str(pid) / "status").write_text("VmRSS:\t   1000 kB\n")
            (self.proc / str(pid) / "task" / str(pid) / "children").write_text("")
            return result(cid + "\n")
        if verb == "run" and "node" in argv:
            return result("guest-daemon")  # The app image's default context reached guest 0.
        if verb == "run":
            return self.probe(option(argv, "--network"), argv[-3], argv[-2])
        if verb == "exec" and argv[-1] == "-":
            if self.release:
                self.release.wait(2)
            with self.lock:
                self.finished += 1
            return result(json.dumps([float(n + 1) for n in range(20)]))
        if verb == "exec":
            return self.probe("box", argv[-3], argv[-2])
        if verb == "wait":
            self.boxes[argv[1]]["alive"] = False
            return result("0\n")
        if verb == "rm":
            self.boxes[argv[2]]["alive"] = False
            return result()
        self.test.fail("unexpected Docker operation")

    def incus(self, args):
        rest = args[2:]
        if rest[0] == "--project":
            rest = rest[2:]
        if rest[0] == "query":
            return result(json.dumps({"pid": QEMU_PID}))
        self.test.assertEqual(rest[0], "exec")
        index = [self.spike.name(i) for i in range(2)].index(rest[1])
        argv = rest[rest.index("--") + 1:]
        if argv[:2] == ("python3", "-c"):
            return self.probe("guest" + str(index), argv[3], argv[4])
        if argv[0] == "sh":
            self.test.assertEqual(argv[3:], (measure.LISTENER, self.spike.address(index),
                                             str(self.spike.args.tls_port + 1)))
            self.listeners.add(index)
            return result()
        if argv[0] == "uname":
            return result("6.8.0-45-generic\n")
        self.test.fail("unexpected guest command")

    def popen(self, argv, stdin=None, stdout=None, stderr=None, env=None):
        with self.lock:
            self.timeline.append(("popen", tuple(argv), env))
        if stdin is subprocess.PIPE:
            return FakeMcp(self, argv)
        return REAL_POPEN(argv, stdin=stdin, stdout=stdout, stderr=stderr, env=env)


class Measurement(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(patch.stopall)
        root = Path(self.temp.name)
        proc, self.bin = root / "proc", root / "bin"
        proc.mkdir()
        self.bin.mkdir()
        args = vm.arguments(["spike", "--measure"])
        args.network = [ipaddress.IPv4Interface("192.0.2.1/24"), ipaddress.IPv4Interface("198.51.100.1/24")]
        args.app_bridge, args.app_network, args.probe_network = "app0", APP, OTHER
        args.data_canary = ":".join(map(str, CANARY))
        args.base_image = args.data_image = args.office_image = args.app_image = IMAGE
        self.spike = vm.Spike(args, root / "state")
        self.world = World(self, self.spike, proc)
        self.spike.checkpoint = lambda: self.world.timeline.append(("checkpoint",))
        patch.object(vm, "PRIVATE_LOG", None).start()
        patch.object(vm.subprocess, "run", self.world.run).start()
        patch.object(measure, "PROC", proc).start()
        patch.object(measure, "time", Clock()).start()
        patch.object(measure, "socket", Sockets(self.world)).start()
        patch.object(measure, "subprocess", SimpleNamespace(
            Popen=self.world.popen, PIPE=subprocess.PIPE, DEVNULL=subprocess.DEVNULL,
            TimeoutExpired=subprocess.TimeoutExpired)).start()
        # The real PTY child is a stand-in `docker` that records what it was given.
        self.spawned = root / "pty-spawn.json"
        docker = self.bin / "docker"
        docker.write_text(f"#!{sys.executable} -I\n"
                          "import json, os, sys\n"
                          f"with open({str(self.spawned)!r}, 'w') as log:\n"
                          "    json.dump({'argv': sys.argv[1:], 'env': {k: v for k, v in os.environ.items()\n"
                          "                                             if k.startswith('DOCKER_')}}, log)\n"
                          "os.execvp('sh', ['sh', '-c', sys.argv[-1].replace('sleep 3', 'sleep 1')])\n")
        docker.chmod(0o700)
        patch.dict(os.environ, {"PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
                                "DOCKER_HOST": "unix:///hostile.sock", "DOCKER_CONTEXT": "hostile",
                                "DOCKER_CONFIG": "/hostile"}).start()

    def boundary(self, kind=None):
        return [event for event in self.world.timeline if event[0] in ("run", "popen")
                and (kind is None or event[0] == kind)]

    def creations(self):
        return [i for i, event in enumerate(self.world.timeline) if event[0] == "run"
                and event[1][0] == "docker" and event[1][3] == "run"]

    def test_host_expiry_cleanup_accepts_exact_absence_at_both_windows(self):
        for count in (4, 8):
            for window in ("before inspect", "between inspect and wait"):
                with self.subTest(count=count, window=window):
                    original = self.world.docker
                    def boundary(where, argv):
                        if where == "host" and argv[0] == "wait":
                            if window == "between inspect and wait":
                                del self.world.boxes[argv[1]]
                                return result(code=1, stderr="Error response from daemon: No such container: " + argv[1])
                            response = original(where, argv)
                            self.world.boxes.clear()
                            return response
                        if where == "host" and argv[0] == "inspect" and argv[-1] not in self.world.boxes:
                            return result(code=1, stderr="Error: No such object: " + argv[-1])
                        return original(where, argv)
                    self.world.docker = boundary
                    try:
                        measure.concurrency(self.spike, count, False)
                        self.assertFalse(any(box["alive"] for box in self.world.boxes.values()))
                    finally:
                        self.world.docker = original
                        self.world.boxes.clear()

    def test_host_expiry_cleanup_refuses_ambiguous_errors_and_foreign_labels(self):
        cid = measure.start_box(self.spike, measure.endpoint(self.spike, False), IMAGE, "expiry")
        original = self.world.docker
        for operation in ("inspect", "wait"):
            for message in ("permission denied", "Cannot connect to the Docker daemon", "Error: No such object: " + "f" * 64):
                def boundary(where, argv):
                    if where == "host" and argv[0] == operation:
                        return result(code=1, stderr=message)
                    return original(where, argv)
                with self.subTest(operation=operation, message=message), patch.object(self.world, "docker", side_effect=boundary), self.assertRaises(RuntimeError):
                    measure.wait_host_box(self.spike, measure.endpoint(self.spike, False), cid)
        self.world.boxes[cid]["label"] = "foreign"
        with self.assertRaisesRegex(RuntimeError, "non-spike"):
            measure.wait_host_box(self.spike, measure.endpoint(self.spike, False), cid)
        self.assertFalse(any(event[1][3:4] == ("wait",) for event in self.boundary("run")[-1:]))

    def test_measure_orchestration_end_to_end(self):
        measure.measure(self.spike)
        metrics = self.spike.metrics
        for kind in ("baseline", "nested"):
            for count in (4, 8):
                for metric in ("work_p50_ms", "work_p95_ms", "memory_kib", "headroom_kib"):
                    self.assertIn(f"{kind}_concurrency{count}_{metric}", metrics)
        for flag in ("guest_metadata_unreachable", "guest_public_unreachable", "guest_app_data_refused",
                     "ingress_tls_only", "ingress_other_network_refused", "pty_resize", "stream_teardown"):
            self.assertIs(metrics[flag], True)
        vm.report(self.spike.state.parent, ["measure"], metrics)  # The closed schema accepts every key.
        timeline = self.world.timeline
        for index in self.creations():
            self.assertEqual(timeline[index - 1], ("checkpoint",), "container created without health check")
        names = [option(event[1], "--name") for event in self.boundary("run")
                 if event[1][0] == "docker" and event[1][3] == "run"]
        for side, count in (("host", 4), ("host", 8), ("vm", 4), ("vm", 8)):
            self.assertEqual(sum(f"-{side}-c{count}-" in name for name in names), count)
        for event in self.boundary("run"):
            argv = event[1]
            if argv[:3] != ("docker", "--host", vm.HOST_SOCKET):
                continue
            self.assertIn(argv[3], HOST_VERBS, "host Docker verb outside the measurement allow-list")
            if argv[3] == "run":
                tail = argv[4:]
                self.assertTrue(option(tail, "--name").startswith(self.spike.prefix + "-"))
                self.assertEqual(option(tail, "--label"), "sandbox-vm-spike=" + self.spike.token)
                for flag in ("--rm", "--pull=never", "--read-only", "--memory", "--cpus", "--pids-limit"):
                    self.assertIn(flag, tail)
                self.assertEqual((option(tail, "--cap-drop"), option(tail, "--entrypoint")), ("ALL", "timeout"))
                self.assertTrue(option(tail, "--entrypoint") and tail[tail.index("--entrypoint") + 3].isdigit())
        # Paired host boxes are waited out (never stopped), nested ones destroyed.
        paired = {side: {cid for cid, box in self.world.boxes.items() if f"-{side}-c" in box["name"]}
                  for side in ("host", "vm")}
        waits = {event[1][4] for event in self.boundary("run") if event[1][3:4] == ("wait",)}
        removed = {event[1][-1] for event in self.boundary("run") if event[1][3:4] == ("rm",)}
        self.assertEqual((len(paired["host"]), len(paired["vm"])), (12, 12))
        self.assertTrue(paired["host"] <= waits and paired["vm"] <= removed)
        for position, event in enumerate(timeline):
            if event[0] != "popen":
                continue
            self.assertIsNotNone(event[2], "stream inherits the hostile DOCKER_* environment")
            self.assertEqual([key for key in event[2] if key.startswith("DOCKER_")], [])
            cid = event[1][event[1].index("exec") + 2]
            gate = [e for e in timeline[:position] if e[0] == "run"][-1][1]
            self.assertEqual(gate[3:5] + gate[-1:], ("inspect", "--format", cid), "stream spawned before gate")
            self.assertEqual(gate[1:3] == ("--host", vm.HOST_SOCKET), event[1][1:3] == ("--host", vm.HOST_SOCKET))

    def started(self, nested, count):
        side = "vm" if nested else "host"
        return sum(f"-{side}-c{count}-" in box["name"] for box in self.world.boxes.values())

    def test_concurrency_sampling_checkpoint_aborts_running_workloads(self):
        for nested in (False, True):
            with self.subTest(nested=nested):
                self.world.release, self.world.finished, seen = threading.Event(), 0, []
                def checkpoint():
                    if self.started(nested, 4) == 4:  # Past box creation: sampling.
                        seen.append(self.world.finished)
                        self.world.release.set()
                        raise RuntimeError("synthetic memory reserve exhausted")
                self.spike.checkpoint = checkpoint
                with self.assertRaises(RuntimeError):
                    measure.concurrency(self.spike, 4, nested)
                self.assertEqual(seen, [0], "reserve only checked after the workloads finished")
                self.world.boxes.clear()

    def test_concurrency_checkpoints_after_last_sample_before_cleanup(self):
        class Fine(Clock):
            def sleep(self, seconds):
                super().sleep(seconds / 100)  # The throttle never fires on its own here.
        patch.object(measure, "time", Fine()).start()
        for nested in (False, True):
            with self.subTest(nested=nested):
                self.world.release, self.world.finished, seen = threading.Event(), 0, []
                def checkpoint():
                    self.world.timeline.append(("checkpoint",))
                    if self.started(nested, 4) == 4:
                        seen.append(self.world.finished)
                        self.world.release.set()
                self.spike.checkpoint = checkpoint
                measure.concurrency(self.spike, 4, nested)
                self.assertEqual((seen[0], seen[-1]), (0, 4))
                cleanup = [i for i, event in enumerate(self.world.timeline) if event[0] == "run"
                           and event[1][0] == "docker" and event[1][3] in ("rm", "wait")][0]
                last = max(i for i, event in enumerate(self.world.timeline) if event == ("checkpoint",))
                self.assertLess(last, cleanup)
                self.world.boxes.clear()
                self.world.timeline.clear()

    def test_attach_pty_child_gets_sanitized_env_and_guest_context(self):
        measure.attach(self.spike)
        spawn = json.loads(self.spawned.read_text())
        self.assertEqual(spawn["env"], {}, "PTY child inherited Docker endpoint overrides")
        self.assertEqual(spawn["argv"][:4], ["--config", str(self.spike.state / "client0/.docker"), "exec", "-it"])
        self.assertTrue(self.spike.metrics["pty_resize"] and self.spike.metrics["stream_teardown"])
        # The ten-minute hold is health-checked throughout, not only at box creation.
        self.assertGreaterEqual(self.world.timeline.count(("checkpoint",)), 60)

    def test_destroy_box_refuses_foreign_container_at_call_site(self):
        self.world.boxes["f" * 64] = {"where": "client0", "label": "foreign", "alive": True}
        with self.assertRaises(RuntimeError):
            measure.destroy_box(self.spike, "f" * 64)
        self.assertFalse(any(event[1][3:4] == ("rm",) for event in self.boundary("run")))
        self.assertTrue(self.world.boxes["f" * 64]["alive"])

    def test_host_endpoint_refuses_stop_at_production_gate(self):
        for verb in ("stop", "rm", "kill", "prune", "restart"):
            with self.subTest(verb=verb), self.assertRaises(RuntimeError):
                measure.endpoint(self.spike, False)(verb, "preexisting")
        self.assertEqual(self.boundary(), [])

    def test_mcp_streams_pass_ownership_gate_before_spawn(self):
        for nested, where in ((False, "host"), (True, "client0")):
            with self.subTest(nested=nested):
                self.world.boxes["e" * 64] = {"where": where, "label": "foreign", "alive": True}
                with self.assertRaises(RuntimeError):
                    measure.mcp_pair(self.spike, "e" * 64, nested)
                self.assertEqual(self.boundary("popen"), [])

    def test_checkpoint_failure_stops_before_any_container(self):
        def unhealthy():
            raise RuntimeError("synthetic regression")
        self.spike.checkpoint = unhealthy
        with self.assertRaises(RuntimeError):
            measure.measure(self.spike)
        self.assertEqual(self.creations(), [])

    def test_missing_probe_inputs_refuse_before_any_command(self):
        for field, value in (("data_canary", None), ("data_canary", "8.8.8.8:53"),
                             ("data_canary", "172.18.0.5"), ("probe_network", APP), ("probe_network", None)):
            with self.subTest(field=field, value=value), patch.object(self.spike.args, field, value):
                with self.assertRaises(RuntimeError):
                    measure.measure(self.spike)
                self.assertEqual(self.boundary(), [])

    def test_config_id_must_match_requested_content(self):
        self.spike.args.base_image = "sha256:" + "b" * 12 + "a" * 52
        with self.assertRaisesRegex(RuntimeError, "requested config ID"):
            measure.measure(self.spike)
        self.spike.args.base_image = self.spike.args.data_image = self.spike.args.office_image = "sha256:" + "b" * 64
        measure.measure(self.spike)
        self.assertTrue(self.spike.metrics["no_host_socket"])

    def config_fixture(self, entries=None):
        config = json.dumps({"os": "linux", "architecture": "amd64",
                             "rootfs": {"type": "layers", "diff_ids": []}}).encode()
        pin = "sha256:" + hashlib.sha256(config).hexdigest()
        archive = self.bin / "export.tar"
        entries = entries if entries is not None else [
            ("blobs/sha256/" + pin[7:], config),
            ("manifest.json", json.dumps([{"Config": "blobs/sha256/" + pin[7:], "Layers": []}]).encode())]
        with tarfile.open(archive, "w") as stream:
            for name, value in entries:
                member = tarfile.TarInfo(name)
                member.size = len(value)
                stream.addfile(member, io.BytesIO(value))
        shape = self.bin / "inspect.json"
        docker = self.bin / "docker"
        docker.write_text(f"#!{sys.executable} -I\nimport json,sys,time\nfrom pathlib import Path\n"
                          f"root=Path({str(self.bin)!r})\n"
                          "if 'inspect' in sys.argv: sys.stdout.write((root/'inspect.json').read_text())\n"
                          "else: sys.stdout.buffer.write((root/'export.tar').read_bytes())\n")
        def target(*args):
            child = REAL_POPEN([str(docker), *args], stdout=subprocess.PIPE)
            output, _ = child.communicate()
            self.assertEqual(child.returncode, 0)
            return result(output.decode())
        return pin, shape, target

    def test_config_identity_fake_docker_store_table(self):
        pin, shape, target = self.config_fixture()
        manifest = "sha256:" + "a" * 64
        shapes = [{"Id": pin, "GraphDriver": {"Name": "overlay2"}},
                  {"Id": manifest, "Descriptor": {"digest": manifest,
                   "mediaType": "application/vnd.oci.image.index.v1+json"}},
                  {"Id": manifest, "Descriptor": {"digest": manifest,
                   "mediaType": "application/vnd.docker.distribution.manifest.v2+json"}}]
        with patch.object(measure, "host_docker", target), patch.object(measure.subprocess, "Popen", REAL_POPEN):
            for store in shapes:
                with self.subTest(store=store):
                    shape.write_text(json.dumps(store))
                    self.assertEqual(measure.image_config_id(self.spike, IMAGE), pin)
            self.spike.remote = lambda index, *args: target(*args)
            self.assertEqual(measure.image_config_id(self.spike, IMAGE, 1), pin)
            shape.write_text(json.dumps(shapes[1]))
            with self.assertRaisesRegex(RuntimeError, "requested config ID"):
                measure.image_config_id(self.spike, manifest, 1)
            for invalid in ({"Id": manifest}, {"Id": manifest, "GraphDriver": {"Name": "overlayfs"}},
                            {"Id": "sha256:abcd", "GraphDriver": {"Name": "overlay2"}},
                            {"Id": manifest, "Descriptor": {"digest": pin, "mediaType": "unknown"}},
                            {"Id": pin, "Descriptor": {"digest": pin, "mediaType": "application/vnd.oci.image.index.v1+json"}},
                            {"Id": manifest, "GraphDriver": None}):
                shape.write_text(json.dumps(invalid))
                with self.assertRaises(RuntimeError):
                    measure.image_config_id(self.spike, IMAGE)

    def test_export_ambiguity_size_timeout_and_exit_refused(self):
        config = json.dumps({"os": "linux", "architecture": "amd64", "rootfs": {"type": "layers"}}).encode()
        valid = json.dumps([{"Config": "config.json"}]).encode()
        for entries in ([('manifest.json', b'[]')],
                        [('config.json', config), ('manifest.json', b'[{"Config":"config.json"},{"Config":"config.json"}]')],
                        [('manifest.json', b'[{"Config":"manifest.json"}]')],
                        [('config.json', config), ('manifest.json', valid), ('manifest.json', valid)],
                        [('../config.json', config), ('manifest.json', b'[{"Config":"../config.json"}]')]):
            self.config_fixture(entries)
            with patch.object(measure.subprocess, "Popen", REAL_POPEN), self.assertRaises(RuntimeError):
                measure.saved_config_id([str(self.bin / "docker"), "save", IMAGE])
        self.config_fixture()
        with patch.object(measure.subprocess, "Popen", REAL_POPEN):
            with patch.object(measure, "EXPORT_BYTES", 512), self.assertRaisesRegex(RuntimeError, "8 GiB"):
                measure.saved_config_id([str(self.bin / "docker"), "save", IMAGE])
            docker = self.bin / 'docker'
            docker.write_text(f'#!{sys.executable} -I\nimport sys,time\nfrom pathlib import Path\ntime.sleep(.2)\nsys.stdout.buffer.write(Path({str(self.bin / "export.tar")!r}).read_bytes())\n')
            with patch.object(measure, "EXPORT_SECONDS", .05), self.assertRaises(RuntimeError):
                measure.saved_config_id([str(docker), 'save', IMAGE])
            self.config_fixture()
            docker.write_text(docker.read_text() + 'sys.exit(1)\n')
            with self.assertRaisesRegex(RuntimeError, "export failed"):
                measure.saved_config_id([str(docker), 'save', IMAGE])

    def test_export_priority_and_environment(self):
        pin, _, _ = self.config_fixture()
        calls = []
        def spawn(argv, **kwargs):
            calls.append(argv)
            self.assertEqual(argv[:6], ['nice', '-n', '19', 'ionice', '-c', '3'])
            environment = kwargs.get('env') or os.environ
            self.assertFalse(any(key.startswith('DOCKER_') for key in environment))
            return REAL_POPEN(argv[6:], **kwargs)
        with patch.object(measure.subprocess, 'Popen', spawn), \
             patch.object(measure.shutil, 'which', return_value='/synthetic/ionice'):
            self.assertEqual(measure.saved_config_id([str(self.bin / 'docker'), 'save', IMAGE]), pin)
        self.assertEqual(len(calls), 1)

    def test_host_export_exact_flavours_only(self):
        args = ('docker', '--host', vm.HOST_SOCKET, 'save', IMAGE)
        vm.authorize_host_docker(args, self.spike)
        for tail in (('foreign@sha256:' + 'a' * 64,), ('synthetic:latest',),
                     ('--output=/tmp/foreign',), ('--output', '/tmp/foreign', IMAGE),
                     (IMAGE, IMAGE), (IMAGE, "--output=/tmp/foreign"), ('sha256:' + 'a' * 64,)):
            with self.subTest(tail=tail), self.assertRaises(RuntimeError):
                vm.authorize_host_docker(args[:4] + tail, self.spike)
        for invalid in ('synthetic:latest', '--output=/tmp/foreign', '-o@sha256:' + 'a' * 64, 'sha256:' + 'a' * 64):
            with patch.object(self.spike.args, "base_image", invalid), self.assertRaises(RuntimeError):
                vm.authorize_host_docker(args[:4] + (invalid,), self.spike)
        with self.assertRaises(RuntimeError):
            vm.authorize_host_docker(args)

    def test_containerd_config_matches_classic_before_workloads(self):
        original = self.world.docker
        def boundary(where, argv):
            if argv[:2] == ("inspect", "--type") and where == "host":
                return result(json.dumps({"Id": "sha256:" + "a" * 64,
                    "Descriptor": {"mediaType": "application/vnd.oci.image.index.v1+json",
                                   "digest": "sha256:" + "a" * 64}}))
            return original(where, argv)
        def paired(where, argv):
            if where != "host" and argv[:1] == ("run",):
                self.assertEqual(argv[argv.index("--entrypoint") + 2], "sha256:" + "b" * 64)
            return boundary(where, argv)
        self.world.docker = paired
        with patch.object(measure, "saved_config_id", return_value="sha256:" + "b" * 64) as saved:
            measure.measure(self.spike)
        self.assertEqual(saved.call_count, 3)
        inspections = [event[1] for event in self.boundary("run")
                       if event[1][:2] == ("docker", "--config") and event[1][3:5] == ("inspect", "--type")]
        self.assertEqual(len(inspections), 6)
        self.assertTrue(all(argv[-1] == "sha256:" + "b" * 64 for argv in inspections))
        self.assertEqual(self.spike.guest_image_ids, {IMAGE: "sha256:" + "b" * 64})
        self.assertTrue(self.spike.metrics["no_host_socket"])
        before = len(self.creations())
        with patch.object(measure, "saved_config_id", return_value="sha256:" + "c" * 64):
            with self.assertRaisesRegex(RuntimeError, "image content mismatch"):
                measure.measure(self.spike)
        self.assertEqual(len(self.creations()), before)

    def test_conflicting_guest_mapping_refused_before_workloads(self):
        original = self.world.docker
        def paired(where, argv):
            if argv[:2] == ("inspect", "--type"):
                if where == "host":
                    return result(json.dumps({"Id": "sha256:" + "a" * 64, "Descriptor": {
                        "digest": "sha256:" + "a" * 64, "mediaType": "application/vnd.oci.image.index.v1+json"}}))
                return result(json.dumps({"Id": argv[-1], "GraphDriver": {"Name": "overlay2"}}))
            return original(where, argv)
        self.world.docker = paired
        with patch.object(measure, "saved_config_id", side_effect=["sha256:" + c * 64 for c in "bcb"]), \
             self.assertRaisesRegex(RuntimeError, "ambiguous host config"):
            measure.measure(self.spike)
        self.assertEqual(self.creations(), [])
        self.assertFalse(hasattr(self.spike, "guest_image_ids"))

    def test_guest_mapping_refuses_unknown_run_image(self):
        self.spike.guest_image_ids = {IMAGE: "sha256:" + "b" * 64}
        for argv in (("run", IMAGE), ("run", "--entrypoint", "timeout", "foreign"),
                     ("run", "--entrypoint", "timeout")):
            with self.subTest(argv=argv), self.assertRaises(RuntimeError):
                self.spike.remote(0, *argv)
        self.assertEqual(self.creations(), [])

    def test_isolation_refusals_and_positive_controls_discriminate(self):
        tls, address = self.spike.args.tls_port, self.spike.address
        leaks = {"metadata": ("guest1", "169.254.169.254", 80), "public": ("guest0", "1.1.1.1", 443),
                 "app data": ("guest0",) + CANARY, "non-TLS ingress": (APP, address(0), tls + 1),
                 "other network": (OTHER, address(1), tls), "peer": ("guest0", address(1), tls),
                 "host canary": ("guest1", "198.51.100.1", CANARY_PORT), "network none": ("box", address(0), tls)}
        controls = {"data canary": (APP,) + CANARY, "guest listener": ("guest0", address(0), tls + 1),
                    "app TLS": (APP, address(1), tls), "guest probe": ("guest1", address(1), tls)}
        cases = [(label, "leaks", key) for label, key in leaks.items()]
        cases += [(label, "blocked", key) for label, key in controls.items()]
        cases += [("inconclusive " + label, "inconclusive", key) for label, key in leaks.items()]
        cases += [("host control", None, None)]
        measure.isolation(self.spike)  # Green under the isolated policy first.
        self.assertEqual([e[1] for e in self.world.timeline if e[0] == "connect"], [measure.PUBLIC],
                         "host metadata is denied by #646; only the public control runs on the host")
        for label, kind, key in cases:
            with self.subTest(case=label):
                self.world.leaks, self.world.blocked, self.world.inconclusive = set(), set(), set()
                self.world.listeners, self.world.host_reachable = set(), kind is not None
                if kind:
                    getattr(self.world, kind).add(key)
                with self.assertRaises(RuntimeError):
                    measure.isolation(self.spike)


if __name__ == "__main__":
    unittest.main()
