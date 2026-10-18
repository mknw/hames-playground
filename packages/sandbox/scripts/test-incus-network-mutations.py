#!/usr/bin/env python3
"""Offline #663 guard mutations; run serially with no other reader of the source."""
import os
import re
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / 'packages/sandbox/incus-environment.server.ts'
# (label, exact source edit, replacement, discriminating Vitest title)
MUTATIONS = [
    ('seed installed after start', '        if (existingSeed === undefined) {', "        await api(c.tls, 'PUT', `/1.0/instances/${instance}/state`, { action: 'start', timeout: 30 })\n        if (existingSeed === undefined) {", 'seeds a static address'),
    ('name-based seed', 'match: { macaddress: mac.toLowerCase() }', "match: { name: 'eth0' }", 'seeds a static address'),
    ('address omitted', 'addresses: [`${o.address}/${prefix}`],', '', 'seeds a static address'),
    ('wrong prefix', '${o.address}/${prefix}', '${o.address}/${prefix + 1}', 'seeds a static address'),
    ('route omitted', "routes: [{ to: 'default', via: gateway }],", '', 'seeds a static address'),
    ('DHCPv4 re-enabled', 'dhcp4: false', 'dhcp4: true', 'seeds a static address'),
    ('DHCPv6 enabled', 'dhcp6: false', 'dhcp6: true', 'seeds a static address'),
    ('wrong MAC', 'mac.toLowerCase()', "'00:16:3e:12:34:56'", 'normalizes the generated MAC'),
    ('MAC case preserved', 'mac.toLowerCase()', 'mac', 'normalizes the generated MAC'),
    ('MAC type unchecked', "typeof mac !== 'string' ||", '', 'refuses invalid generated MAC'),
    ('MAC final newline accepted', '[0-9a-f]{2}$/i.test(mac)', '[0-9a-f]{2}/i.test(mac)', 'refuses invalid generated MAC'),
    ('MAC octet count relaxed', '[0-9a-f]{2}:){5}', '[0-9a-f]{2}:){4,5}', 'refuses invalid generated MAC'),
    ('MAC first octet width relaxed', '(?:[0-9a-f]{2}:)', '(?:[0-9a-f]{1,2}:)', 'refuses invalid generated MAC'),
    ('MAC syntax unchecked', '!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)', 'false', 'refuses invalid generated MAC'),
    ('initial drift unchecked', 'checkVm(vm, existingSeed === undefined ? config : { ...config, [networkKey]: existingSeed })', '', 'refuses initial VM drift'),
    ('running VM seeded', 'status.status_code !== 102 || ', '', 'refuses unseeded VMs'),
    ('first-boot proof omitted', "vm.config?.['volatile.apply_template'] !== 'create'", 'false', 'refuses unseeded VMs'),
    ('seed write omitted', 'config: { [networkKey]: networkConfig }', 'config: {}', 'seeds a static address'),
    ('seed write failure ignored', "await api(c.tls, 'PATCH', `/1.0/instances/${instance}`, {\n            config: { [networkKey]: networkConfig },\n          })", "await api(c.tls, 'PATCH', `/1.0/instances/${instance}`, {\n            config: { [networkKey]: networkConfig },\n          }).catch(() => undefined)", 'retains an unbooted VM'),
    ('MAC readback unchecked', "vm.config?.['volatile.eth0.hwaddr'] !== mac", 'false', 'reads back seed and MAC'),
    ('seed readback unchecked', 'checkVm(vm, seededConfig)', '', 'reads back seed and MAC'),
    ('existing seed drift ignored', 'checkVm(vm, seededConfig)', '', 'refuses drifted network seeds'),
    ('existing MAC drift ignored', 'checkVm(vm, seededConfig)', '', 'refuses a changed generated MAC'),
    ('public helper added', 'function same(', 'export function same(', 'operator-only API'),
    ('reviewer: MAC start anchor removed', '!/^(?:', '!/(?:', 'refuses invalid generated MAC'),
    ('reviewer: optional flipped', 'optional: true', 'optional: false', 'seeds a static address'),
    ('reviewer: readback GET dropped', "          })\n          vm = await api(c.tls, 'GET', `/1.0/instances/${instance}`)\n          if (vm.config", '          })\n          if (vm.config', 'reads back seed and MAC'),
    ('reviewer: existing seed ignored', '        checkVm(vm, seededConfig)', '        if (existingSeed === undefined) checkVm(vm, seededConfig)', 'refuses drifted network seeds'),
    ('reviewer: copy template accepted', "vm.config?.['volatile.apply_template'] !== 'create'", "!['create', 'copy'].includes(vm.config?.['volatile.apply_template'])", 'refuses unseeded VMs'),
    ('reviewer: drifted seed repaired', '        checkVm(vm, seededConfig)', "        if (existingSeed !== undefined) {\n          await api(c.tls, 'PATCH', `/1.0/instances/${instance}`, { config: { [networkKey]: networkConfig } })\n          vm = await api(c.tls, 'GET', `/1.0/instances/${instance}`)\n        }\n        checkVm(vm, seededConfig)", 'refuses drifted network seeds'),
    ('reviewer: set-name introduced', 'optional: true,', "optional: true, 'set-name': 'eth0',", 'seeds a static address'),
    ('reviewer: seed PATCH project scope omitted', 'config: { [networkKey]: networkConfig },\n          })', 'config: { [networkKey]: networkConfig },\n          }, false)', 'seeds a static address'),
    ('wrong gateway', "routes: [{ to: 'default', via: gateway }],", "routes: [{ to: 'default', via: o.address }],", 'seeds a static address'),
    ('nameservers introduced', 'optional: true,', 'optional: true, nameservers: { addresses: [gateway] },', 'seeds a static address'),
]


def main():
    original = SOURCE.read_text()
    env = {**os.environ, 'CI': '1', 'TEST_DATABASE_URL': 'postgresql://x:x@127.0.0.1:59999/x'}
    try:
        for label, before, after, title in MUTATIONS:
            if original.count(before) != 1:
                raise RuntimeError('mutation anchor must occur exactly once: ' + label)
            SOURCE.write_text(original.replace(before, after))
            result = subprocess.run(
                ['corepack', 'pnpm', 'exec', 'vitest', 'run', '--root', '../packages/sandbox',
                 '__tests__/incus-environment.test.ts', '-t', title],
                cwd=ROOT / 'app', env=env, capture_output=True, text=True, timeout=90,
            )
            output = result.stdout + result.stderr
            # An infrastructure/import error is not evidence that a pin guards.
            if result.returncode != 1 or not re.search(r'FAIL[^\n]* > [^\n]*' + re.escape(title), output):
                raise RuntimeError('mutation survived or did not fail on its pin: ' + label)
            print('RED verified: ' + label, flush=True)
    finally:
        SOURCE.write_text(original)
    print(str(len(MUTATIONS)) + ' mutations verified red')


if __name__ == '__main__':
    main()
