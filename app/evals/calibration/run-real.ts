/**
 * CALIBRATION RUNNER (untracked, one-time) — the owner's 2026-10-25 addendum for
 * the synthetic-sandbox fidelity fix. Boots ONE real `kg-sandbox:base` container
 * through the repo's real DockerBackend, hydrates /work/in with the eval's two
 * fixture files, runs each command listed in commands.ts through the REAL
 * `sandbox_bash` (actor-facing, so the bash-guard screen applies), and writes the
 * raw results to `calibration-raw.json`. Local docker/colima only; the eval
 * itself stays synthetic and hermetic.
 *
 * Run from `app/`: pnpm dlx tsx evals/calibration/run-real.ts
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DockerBackend } from '@hames-ai/sandbox'
import { COMMANDS, SALES, NOTES } from './commands'

async function main() {
  const backend = new DockerBackend()
  const vm = await backend.boot('base', { timeoutSec: 20 })
  console.log('booted', vm.id, vm.native.containerId)
  try {
    const mcp = await backend.connectMcp(vm)
    // The harness hydrates /work/in over the transport (work-sync.server.ts); the
    // calibration mirrors it with an internal mkdir + the two seeded files.
    const mkdir = await mcp.callTool(
      'sandbox_bash',
      { command: 'mkdir -p /work/in /work/out' },
      { internal: true },
    )
    if (!mkdir.success) throw new Error(`mkdir failed: ${JSON.stringify(mkdir)}`)
    for (const [name, text] of [
      ['lantern-sales.csv', SALES],
      ['lantern-notes.md', NOTES],
    ] as const) {
      const w = await mcp.callTool('sandbox_write', { path: `/work/in/${name}`, content: text })
      if (!w.success) throw new Error(`hydrate failed: ${JSON.stringify(w)}`)
    }
    // The prompt's own write-then-run shape: sandbox_write, then run the script.
    const totalsPy = `import csv\nrows = list(csv.DictReader(open('/work/in/lantern-sales.csv')))\nwriter = csv.writer(open('/work/out/lantern-totals.csv', 'w'))\nfor r in rows:\n    writer.writerow([r['region'], r['revenue']])\nwriter.writerow(['Total', 66])\n`
    const write = await mcp.callTool('sandbox_write', {
      path: '/work/totals.py',
      content: totalsPy,
    })
    const out: Record<string, unknown> = {
      'write-then-run: sandbox_write': { command: 'sandbox_write /work/totals.py', result: write },
    }
    const scriptCommands: ReadonlyArray<readonly [string, string]> = [
      ['write-then-run: python3 /work/totals.py', 'python3 /work/totals.py'],
    ]
    for (const [label, command] of [...COMMANDS, ...scriptCommands]) {
      const res = await mcp.callTool('sandbox_bash', { command })
      out[label] = { command, result: res }
      console.log(
        `== ${label}\n   cmd: ${JSON.stringify(command).slice(0, 160)}\n   ${JSON.stringify(res).slice(0, 500)}`,
      )
    }
    await mcp.close()
    writeFileSync(
      resolve('evals/calibration/calibration-raw.json'),
      JSON.stringify({ vm: vm.id, rootfs: vm.rootfs, results: out }, null, 2),
    )
    console.log('written evals/calibration/calibration-raw.json')
  } finally {
    await backend.destroy(vm)
  }
}
main().catch((err) => {
  console.error(err)
  process.exit(1)
})
