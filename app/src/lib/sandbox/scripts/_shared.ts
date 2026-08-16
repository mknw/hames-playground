/**
 * Shared helpers for the sandbox smoke scripts.
 *
 * Not a server module — runs as a `tsx` script from the CLI. Imports
 * server-side modules; the `assertServerOnImport` guards pass because tsx
 * runs in Node.
 */

import type { ContextEvent, PatternScope } from '../../harness-patterns/types'

/** Print every tracked event in execution order, summarized to one line each.
 *  Covers the four event shapes the smoke scripts care about — controller
 *  actions, tool calls/results, critic outcomes — plus any errors. */
export function printEventSummary(scope: PatternScope<unknown>): void {
  const events = (scope as { events?: ContextEvent[] }).events ?? []
  console.log('\n— Event log —')
  if (events.length === 0) {
    console.log('  (no events tracked)')
    return
  }
  for (const ev of events) {
    const t = new Date(ev.ts).toISOString().slice(11, 23)
    switch (ev.type) {
      case 'controller_action': {
        const data = ev.data as { action: { tool_name: string; tool_args: string }; turn: number }
        console.log(
          `[${t}] turn ${data.turn} actor → ${data.action.tool_name}(${truncate(data.action.tool_args, 100)})`,
        )
        break
      }
      case 'tool_result': {
        const data = ev.data as { tool: string; success: boolean; result: unknown; error?: string }
        const ok = data.success ? '✓' : '✗'
        const payload = data.success
          ? truncate(safeJson(data.result), 120)
          : data.error ?? 'error'
        console.log(`           ${ok} ${data.tool} → ${payload}`)
        break
      }
      case 'critic_result': {
        const data = ev.data as {
          result: { is_sufficient: boolean; explanation?: string; suggested_approach?: string }
        }
        const verdict = data.result.is_sufficient ? 'OK' : 'reject'
        const reason = data.result.explanation ?? data.result.suggested_approach ?? ''
        console.log(`           critic: ${verdict} — ${reason}`)
        break
      }
      case 'error': {
        const data = ev.data as { error: string }
        console.log(`           ✗ ERROR: ${data.error}`)
        break
      }
      default:
        // ignore other event types in the summary
        break
    }
  }
  console.log()
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function safeJson(x: unknown): string {
  if (typeof x === 'string') return x
  try {
    return JSON.stringify(x)
  } catch {
    return String(x)
  }
}

/** Pre-flight: complain loudly if the rootfs image isn't built. The wrapper
 *  would fail more cryptically later. */
export async function checkRootfsImage(): Promise<void> {
  const { spawn } = await import('node:child_process')
  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', ['image', 'inspect', 'kg-sandbox:base'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve()
      reject(
        new Error(
          'kg-sandbox:base image not found. Build it first:\n' +
            '  cd rootfs && docker build -t kg-sandbox:base .\n' +
            '(See rootfs/README.md for the nix-shell DOCKER_CONFIG bridge.)',
        ),
      )
    })
  })
}
