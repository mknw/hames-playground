"""Opt-in synthetic measurements; imported only by Spike.measure()."""
import concurrent.futures
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import pty
import re
import selectors
import socket
import struct
import subprocess
import termios
import time

from sandbox_vm import HOST_SOCKET, authorize_host_docker, command, docker_env, host_docker, percentiles, require

PROC = Path("/proc")
# Connect-only targets; nothing is requested from them. Exit 3 is a connect
# failure, so a missing interpreter or a crash can never pass as refused.
METADATA, PUBLIC = ("169.254.169.254", 80), ("1.1.1.1", 443)
PROBE = '''
import socket,sys,time
for attempt in range(int(sys.argv[3])):
    try:
        socket.create_connection((sys.argv[1],int(sys.argv[2])),timeout=3).close()
        sys.exit(0)
    except OSError:
        time.sleep(.5)
sys.exit(3)
'''
LISTENER = 'import socket,sys,time; s=socket.socket(); s.bind((sys.argv[1],int(sys.argv[2]))); s.listen(); time.sleep(60)'


WORKLOAD = '''
import csv,io,json,time
from pathlib import Path
kind=KIND
samples=[]
for run in range(20):
    start=time.perf_counter()
    if kind=='cpu':
        assert sum(i*i for i in range(500000)) > 0
    elif kind in ('pandas','polars'):
        # A repeatable, synthetic 100k-row CSV; no uploads or host bind mounts.
        source=io.StringIO('key,value\\n'+''.join(f'{i%100},{i%37}\\n' for i in range(100000)))
        if kind=='pandas':
            import pandas as pd
            frame=pd.read_csv(source)
            assert len(frame.groupby('key').value.sum())==100
            # Exercise the xlsx engine on a smaller slice as well.
            output=io.BytesIO(); frame.head(1000).to_excel(output,index=False)
            output.seek(0); assert len(pd.read_excel(output))==1000
        else:
            import polars as pl
            assert pl.read_csv(source).group_by('key').agg(pl.col('value').sum()).height==100
    else:
        import pymupdf
        doc=pymupdf.open()
        for page in range(20):
            doc.new_page().insert_text((50,50),'Synthetic spike fixture')
        raw=doc.tobytes(); reopened=pymupdf.open(stream=raw,filetype='pdf')
        assert sum(len(p.get_text()) for p in reopened)>0
    samples.append((time.perf_counter()-start)*1000)
print(json.dumps(samples))
'''


def owned_container(spike, endpoint, cid):
    inspect = endpoint("inspect", "--format", '{{json .Config.Labels}}', cid)
    labels = json.loads(inspect.stdout)
    require(labels.get("sandbox-vm-spike") == spike.token, "refuse non-spike container")


def destroy_box(spike, cid):
    # Destruction exists only behind the guest context and exact token check.
    owned_container(spike, endpoint(spike, True), cid)
    spike.remote(0, "rm", "-f", cid)


def endpoint(spike, nested):
    def target(*args, **kw):
        if args[0] == "run":
            spike.checkpoint()  # Every container creation follows a passing health check.
        if nested:
            return spike.remote(0, *args, **kw)
        # Host create/exec pass the production gate in command(); host_docker stays read-only.
        return command("docker", "--host", HOST_SOCKET, *args, host_scope=spike, **kw)
    return target


def exec_argv(spike, nested, flags, cid, *argv):
    # Streaming children bypass command(), so they pass the same gates first.
    if nested:
        owned_container(spike, endpoint(spike, True), cid)
        return ["docker", "--config", str(spike.state / "client0/.docker"), "exec", *flags, cid, *argv]
    args = ("docker", "--host", HOST_SOCKET, "exec", *flags, cid, *argv)
    authorize_host_docker(args, spike)
    return list(args)


def start_box(spike, target, image, suffix, ttl=60):
    name = spike.prefix + "-" + suffix
    require(name.startswith(spike.prefix + "-"), "invalid spike container name")
    # Self expires even if the client dies. No stop/rm/kill/prune on host Docker.
    cid = target("run", "--rm", "--pull=never", "-d", "--name", name,
                 "--label", "sandbox-vm-spike=" + spike.token,
                 "--memory", "512m", "--cpus", "0.5", "--pids-limit", "128",
                 "--cap-drop", "ALL", "--read-only", "--security-opt", "no-new-privileges",
                 "--network", "none", "--tmpfs", "/tmp:rw,nosuid,size=64m",
                 "--tmpfs", "/work:rw,nosuid,size=256m,mode=1777",
                 "--entrypoint", "timeout", image, str(ttl), "sleep", str(ttl - 1)).stdout.strip()
    require(re.fullmatch(r"[a-f0-9]{12,64}", cid), "invalid new container ID")
    owned_container(spike, target, cid)
    return cid


class Mcp:
    def __init__(self, argv, environment=None):
        self.process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, env=environment)
        self.pending = b""
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.counter = 0
        try:
            self.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                       "clientInfo": {"name": "synthetic-spike", "version": "1"}})
            self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
            result = self.request("tools/list", {})
            require(bool(result.get("tools")), "MCP listTools returned no tools")
        except BaseException:
            self.close()
            raise

    def send(self, value):
        self.process.stdin.write((json.dumps(value) + "\n").encode())
        self.process.stdin.flush()

    def request(self, method, params):
        self.counter += 1
        identifier = self.counter
        self.send({"jsonrpc": "2.0", "id": identifier, "method": method, "params": params})
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if b"\n" not in self.pending:
                require(self.selector.select(max(0, deadline - time.monotonic())), "MCP timed out")
                data = os.read(self.process.stdout.fileno(), 65536)
                require(data, "MCP stream closed")
                self.pending += data
                require(len(self.pending) < 8 * 1024 * 1024, "MCP response too large")
                continue
            line, self.pending = self.pending.split(b"\n", 1)
            response = json.loads(line)
            if response.get("id") == identifier:
                require("result" in response, "MCP error response")
                return response["result"]
        raise RuntimeError("MCP timed out")

    def close(self):
        self.selector.close()
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)
        self.process.stdout.close()


def mcp_pair(spike, cid, nested):
    pair = []
    try:
        for server in ("filesystem", "shell"):
            pair.append(Mcp(exec_argv(spike, nested, ("-i",), cid, "/opt/mcp/init.sh", "serve", server),
                            docker_env()))
        return pair
    except BaseException:
        for stream in pair:
            stream.close()
        raise


def boot_samples(spike, nested):
    target = endpoint(spike, nested)
    values, resets = [], []
    for run in range(20):
        start = time.monotonic()
        cid = start_box(spike, target, spike.args.base_image, f"{'vm' if nested else 'host'}-boot{run}")
        pair = mcp_pair(spike, cid, nested)
        values.append((time.monotonic() - start) * 1000)
        for stream in pair:
            stream.close()
        # Natural TTL teardown avoids ANY destructive host Docker command.
        # Include the whole expiration + replacement cycle, report it separately.
        start = time.monotonic()
        owned_container(spike, target, cid)
        if nested:
            destroy_box(spike, cid)
        else:
            target("wait", cid, timeout=70)
        replacement = start_box(spike, target, spike.args.base_image,
                                f"{'vm' if nested else 'host'}-reset{run}", ttl=10)
        pair = mcp_pair(spike, replacement, nested)
        resets.append((time.monotonic() - start) * 1000)
        for stream in pair:
            stream.close()
    kind = "nested" if nested else "baseline"
    for label, samples in (("boot", values), ("reset", resets)):
        p50, p95 = percentiles(samples)
        spike.metrics[f"{kind}_{label}_p50_ms"] = p50
        spike.metrics[f"{kind}_{label}_p95_ms"] = p95


def workloads(spike, nested):
    target = endpoint(spike, nested)
    kind = "nested" if nested else "baseline"
    for work, image in (("cpu", spike.args.base_image), ("pandas", spike.args.data_image),
                        ("polars", spike.args.data_image), ("pdf", spike.args.office_image)):
        cid = start_box(spike, target, image, f"{kind}-{work}", ttl=180)
        owned_container(spike, target, cid)
        raw = target("exec", "-i", cid, "python3", "-", timeout=170,
                     input=WORKLOAD.replace("KIND", repr(work))).stdout
        samples = json.loads(raw)
        require(all(type(n) in (int, float) and n >= 0 for n in samples), "invalid workload samples")
        p50, p95 = percentiles(samples)
        spike.metrics[f"{kind}_{work}_p50_ms"] = p50
        spike.metrics[f"{kind}_{work}_p95_ms"] = p95


def attach(spike):
    target = endpoint(spike, True)
    cid = start_box(spike, target, spike.args.base_image, "attach", ttl=750)
    pair = mcp_pair(spike, cid, True)
    try:
        # Base64 via the shell MCP, matching work-sync's transport, >= 1 MiB.
        import base64
        payload = base64.b64encode(b"s" * (1024 * 1024)).decode()
        staged = pair[0].request("tools/call", {"name": "write_file", "arguments": {
            "path": "/work/staged.b64", "content": payload}})
        require(not staged.get("isError"), "base64 staging write failed")
        result = pair[1].request("tools/call", {"name": "bash", "arguments": {
            "command": "base64 -d /work/staged.b64 > /work/staged && wc -c < /work/staged"}})
        require(not result.get("isError") and "1048576" in json.dumps(result), "staging failed")
        spike.metrics["staging_bytes"] = 1024 * 1024
        started = time.monotonic()
        while time.monotonic() - started < 600:
            spike.checkpoint()
            for stream in pair:
                stream.request("tools/list", {})
            time.sleep(10)
        spike.metrics["stream_seconds"] = time.monotonic() - started
        owned_container(spike, target, cid)
        master, slave = pty.openpty()
        process = None
        try:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
            process = subprocess.Popen(exec_argv(spike, True, ("-it",), cid,
                                                 "sh", "-c", "stty size; sleep 3; stty size"),
                                       stdin=slave, stdout=slave, stderr=slave, env=docker_env())
            os.close(slave)
            slave = None
            pty_output(master, b"24 80")
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 37, 91, 0, 0))
            os.kill(process.pid, signal_winch())
            pty_output(master, b"37 91")
            require(process.wait(timeout=15) == 0, "PTY resize failed")
            spike.metrics["pty_resize"] = True
        finally:
            if process and process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
            os.close(master)
            if slave is not None:
                os.close(slave)
        destroy_box(spike, cid)
        for stream in pair:
            stream.process.wait(timeout=15)
        spike.metrics["stream_teardown"] = True
    finally:
        for stream in pair:
            stream.close()


def pty_output(master, expected):
    # Read before the child exits: some kernels discard PTY output on last close.
    data = b""
    with selectors.DefaultSelector() as ready:
        ready.register(master, selectors.EVENT_READ)
        while expected not in data:
            require(ready.select(10), "PTY output timed out")
            try:
                chunk = os.read(master, 4096)
            except OSError:
                chunk = b""  # EIO is how Linux reports a closed PTY slave.
            require(chunk, "PTY closed before expected size")
            data += chunk


def signal_winch():
    import signal
    return signal.SIGWINCH


def no_socket_path(spike):
    # The app image has the Docker CLI. Mount only this environment's context;
    # clear the parent environment exactly as the SDK does. No host socket.
    # Client's default HOME/.docker context is the routing seam under test.
    cid = start_box(spike, endpoint(spike, True), spike.args.base_image, "app-target", ttl=60)
    owned_container(spike, endpoint(spike, True), cid)
    script = '''
const fs = require('node:fs'), cp = require('node:child_process');
if (fs.existsSync('/var/run/docker.sock')) process.exit(2);
const env = { HOME:'/client', PATH:process.env.PATH, USER:'root', TERM:'xterm' };
const result = cp.spawnSync('docker',['info','--format','{{.ID}}'],{env,encoding:'utf8'});
if(result.status !== 0 || !result.stdout.trim()) process.exit(3);
const daemon=result.stdout.trim();
async function list(server) {
  const child=cp.spawn('docker',['exec','-i','CID','/opt/mcp/init.sh','serve',server],{env});
  return new Promise((resolve,reject)=>{
    let pending='';
    const send=(value)=>child.stdin.write(JSON.stringify(value)+'\\n');
    child.on('error',reject);
    child.on('exit',(code)=>{if(code!==0) reject(new Error('exec failed'));});
    child.stdout.on('data',(bytes)=>{
      pending+=bytes;
      while(pending.includes('\\n')) {
        const end=pending.indexOf('\\n'), line=pending.slice(0,end); pending=pending.slice(end+1);
        const reply=JSON.parse(line);
        if(reply.id===1) {
          if(!reply.result) return reject(new Error('initialize failed'));
          send({jsonrpc:'2.0',method:'notifications/initialized'});
          send({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});
        }
        if(reply.id===2) {
          if(!reply.result?.tools?.length) return reject(new Error('listTools failed'));
          child.stdin.end(); child.kill(); resolve();
        }
      }
    });
    send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',
      capabilities:{},clientInfo:{name:'synthetic-spike',version:'1'}}});
  });
}
Promise.all(['filesystem','shell'].map(list)).then(()=>process.stdout.write(daemon))
  .catch(()=>process.exit(4));
'''
    expected = spike.remote(0, "info", "--format", "{{.ID}}").stdout.strip()
    observed = endpoint(spike, False)(
        "run", "--rm", "--pull=never", "--name", spike.prefix + "-app-probe",
        "--label", "sandbox-vm-spike=" + spike.token,
        "--memory", "256m", "--cpus", "0.5", "--pids-limit", "128",
        "--network", spike.args.app_network, "--user", "0", "--read-only",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--mount", f"type=bind,src={spike.state / 'client0/.docker'},dst=/client/.docker,readonly",
        "--entrypoint", "timeout", spike.args.app_image, "30", "node", "-e", script.replace("CID", cid))
    require(observed.stdout.strip() == expected, "default context reached wrong daemon")
    spike.metrics["no_host_socket"] = True


def memory_headroom():
    match = re.search(r"^MemAvailable:\s+(\d+) kB", (PROC / "meminfo").read_text(), re.M)
    require(match, "memory headroom unavailable")
    return int(match[1])


def rss_tree(pid):
    rss = re.search(r"^VmRSS:\s+(\d+)", (PROC / str(pid) / "status").read_text(), re.M)
    require(rss, "container RSS unavailable")
    total = int(rss[1])
    for child in (PROC / str(pid) / "task" / str(pid) / "children").read_text().split():
        try:
            total += rss_tree(int(child))
        except FileNotFoundError:
            pass  # A short-lived child exited; the held MCP servers remain.
    return total


def container_pid(cid):
    return int(host_docker("inspect", "--format", '{{.State.Pid}}', cid).stdout)


def memory(spike, cid):
    spike.metrics["baseline_memory_kib"] = rss_tree(container_pid(cid))
    spike.metrics["nested_memory_kib"] = qemu_pss(spike)


def qemu_pss(spike):
    raw = spike.incus("query", f"/1.0/instances/{spike.name(0)}/state?project={spike.project}")
    pid = int(json.loads(raw.stdout)["pid"])
    pss = re.search(r"^Pss:\s+(\d+)", (PROC / str(pid) / "smaps_rollup").read_text(), re.M)
    require(pss, "QEMU PSS unavailable")
    return int(pss[1])


def concurrency(spike, count, nested):
    # Paired with the host-runc baseline: same image, caps, workload and box count.
    target = endpoint(spike, nested)
    kind = f"{'nested' if nested else 'baseline'}_concurrency{count}"
    boxes = [start_box(spike, target, spike.args.base_image, f"{'vm' if nested else 'host'}-c{count}-{i}",
                       ttl=60) for i in range(count)]
    if nested:
        footprint = lambda: qemu_pss(spike)
    else:
        pids = [container_pid(cid) for cid in boxes]
        footprint = lambda: sum(rss_tree(pid) for pid in pids)
    def run(cid):
        owned_container(spike, target, cid)
        return json.loads(target("exec", "-i", cid, "python3", "-", timeout=50,
                                 input=WORKLOAD.replace("KIND", "'cpu'")).stdout)
    with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
        futures = [pool.submit(run, box) for box in boxes]
        headroom, peak, checked = memory_headroom(), footprint(), None
        while True:
            headroom, peak = min(headroom, memory_headroom()), max(peak, footprint())
            done = all(future.done() for future in futures)
            # A low reserve or regressed container aborts mid-run, not only after it;
            # the last pass checks after the last sample. Throttled: each check
            # inspects every pre-existing container, which would load the benchmark.
            if done or checked is None or time.monotonic() - checked >= 1:
                spike.checkpoint()
                checked = time.monotonic()
            if done:
                break
            time.sleep(.1)
        samples = [sample for future in futures for sample in future.result()]
    p50, p95 = percentiles(samples)
    spike.metrics[f"{kind}_work_p50_ms"] = p50
    spike.metrics[f"{kind}_work_p95_ms"] = p95
    spike.metrics[f"{kind}_headroom_kib"] = headroom
    spike.metrics[f"{kind}_memory_kib"] = peak
    # Idle boxes must not count against the next round. Host boxes only expire.
    for cid in boxes:
        if nested:
            destroy_box(spike, cid)
        else:
            owned_container(spike, target, cid)
            target("wait", cid, timeout=70)


def reached(result):
    require(result.returncode in (0, 3), "network probe inconclusive")
    return result.returncode == 0


def from_guest(spike, index, address, port, attempts=1):
    return reached(spike.guest(index, "python3", "-c", PROBE, address, str(port), str(attempts), check=False))


def from_network(spike, network, address, port, label):
    return reached(endpoint(spike, False)(
        "run", "--rm", "--pull=never", "--name", spike.prefix + "-probe-" + label,
        "--label", "sandbox-vm-spike=" + spike.token,
        "--memory", "64m", "--cpus", "0.5", "--pids-limit", "32", "--read-only",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--network", network,
        "--entrypoint", "timeout", spike.args.base_image, "30",
        "python3", "-c", PROBE, address, str(port), "1", check=False))


def host_reaches(address, port):
    try:
        socket.create_connection((address, port), timeout=3).close()
        return True
    except OSError:
        return False


def data_canary(spike):
    address, _, port = (spike.args.data_canary or "").rpartition(":")
    try:
        address, port = ipaddress.IPv4Address(address), int(port)
    except ValueError:
        address = None
    require(address and address.is_private and 0 < port < 65536, "--data-canary IPv4:port required")
    require(spike.args.probe_network and spike.args.probe_network != spike.args.app_network,
            "--probe-network must name a second Docker network")
    return str(address), port


def isolation(spike):
    # Harmless canaries: connect and close only, no real service/credential is
    # probed. Refusals are paired with a control showing the same probe can
    # succeed, so a broken probe never reads as isolation. Metadata has no live
    # control on purpose (#646 denies it in host OUTPUT): the evidence there is
    # the guest's own TLS control plus the generated firewall denies, and no
    # claim is made that the metadata service itself is up.
    canary = data_canary(spike)
    tls, plain = spike.args.tls_port, spike.args.tls_port + 1
    require(plain < 65536, "no port above the TLS port for the ingress listener")
    require(host_reaches(*PUBLIC), "public egress positive control failed")
    require(from_network(spike, spike.args.app_network, *canary, "data"), "data canary positive control failed")
    for index in range(2):
        own, label = spike.address(index), str(index)
        require(from_guest(spike, index, own, tls), "guest probe positive control failed")
        require(not from_guest(spike, index, spike.address(1 - index), tls), "other environment reachable")
        with socket.socket() as listener:
            listener.bind((str(spike.args.network[index].ip), 0))
            listener.listen()
            require(not from_guest(spike, index, str(spike.args.network[index].ip), listener.getsockname()[1]),
                    "host canary reachable from VM")
        require(not from_guest(spike, index, *METADATA), "metadata reachable from VM")
        require(not from_guest(spike, index, *PUBLIC), "public address reachable from VM")
        require(not from_guest(spike, index, *canary), "app data network reachable from VM")
        spike.guest(index, "sh", "-c", 'setsid -f timeout 60 python3 -c "$0" "$1" "$2" </dev/null >/dev/null 2>&1',
                    LISTENER, own, str(plain))
        require(from_guest(spike, index, own, plain, attempts=10), "guest listener positive control failed")
        require(from_network(spike, spike.args.app_network, own, tls, "tls" + label), "app to guest TLS refused")
        require(not from_network(spike, spike.args.app_network, own, plain, "plain" + label),
                "app network reaches a non-TLS guest port")
        require(not from_network(spike, spike.args.probe_network, own, tls, "other" + label),
                "another Docker network reaches the guest")
    cid = start_box(spike, endpoint(spike, True), spike.args.base_image, "no-egress", ttl=15)
    owned_container(spike, endpoint(spike, True), cid)
    require(not reached(spike.remote(0, "exec", cid, "python3", "-c", PROBE, spike.address(0), str(tls), "1",
                                     check=False)), "network-none sandbox reached outside")
    spike.metrics.update(host_unreachable=True, other_env_unreachable=True, no_egress=True,
                         guest_metadata_unreachable=True, guest_public_unreachable=True,
                         guest_app_data_refused=True, ingress_tls_only=True,
                         ingress_other_network_refused=True)


def measure(spike):
    data_canary(spike)  # Refuse before any measurement starts a container.
    # Matching content digests are mandatory; never pull/build on the host.
    for image in (spike.args.base_image, spike.args.data_image, spike.args.office_image):
        host = host_docker("inspect", "--type", "image", "--format", '{{.Id}}', image).stdout.strip()
        for index in range(2):
            guest = spike.remote(index, "inspect", "--type", "image", "--format", '{{.Id}}', image).stdout.strip()
            require(host == guest and host.startswith("sha256:"), "image content mismatch")
    no_socket_path(spike)
    isolation(spike)
    for nested in (False, True):
        boot_samples(spike, nested)
        workloads(spike, nested)
    cid = start_box(spike, endpoint(spike, False), spike.args.base_image, "rss", ttl=60)
    guest_cid = start_box(spike, endpoint(spike, True), spike.args.base_image, "rss", ttl=60)
    pairs = []
    try:
        pairs.extend(mcp_pair(spike, cid, False))
        pairs.extend(mcp_pair(spike, guest_cid, True))
        memory(spike, cid)
    finally:
        for stream in pairs:
            stream.close()
    attach(spike)
    for count in (4, 8):
        for nested in (False, True):
            concurrency(spike, count, nested)
    for prefix, output in (("kernel", spike.guest(0, "uname", "-r").stdout),
                           ("qemu", command("qemu-system-x86_64", "--version").stdout)):
        match = re.search(r"(\d+)\.(\d+)\.(\d+)", output)
        require(match, "version unreadable")
        for part, value in zip(("major", "minor", "patch"), match.groups()):
            spike.metrics[prefix + "_" + part] = int(value)
    spike.metrics.update(kvm_nonroot=True, nested_paging=True)
