/**
 * Sandbox Session Agent (persistent)
 *
 * The sandbox is **session-persistent**: `withSandbox({ id: sessionId })` keys
 * the VM to the conversation via the shared AttachmentTable, so every turn
 * reuses the same container with its /work files, installed packages, and env
 * intact — and it's the *same* container the interactive Shell terminal
 * attaches to (the PTY manager keys on sessionId too). Write a file with the
 * agent, then `cat` it in the Terminal tab's Shell; both see one workspace.
 *
 * Contrast with an *ephemeral* sandbox (a fresh, reset VM per turn): pick this
 * agent when follow-ups should build on prior state.
 */
'use server'

// @unocss-include — the icon class literal below must be extracted (see uno.config content.filesystem)
import {
  actorCritic,
  compactExecution,
  compactIntent,
  createActorControllerAdapter,
  createCriticAdapter,
  type ConfiguredPattern,
} from '../../harness-patterns'
import { withSandbox } from '../../sandbox/with-sandbox.server'
import type { SessionData } from '../session.server'
import type { AgentConfig } from '../registry.server'
import type { FewShot } from '../../../../baml_client/types'

const SANDBOX_SESSION_GUIDANCE = `
You have a PERSISTENT Linux sandbox for this conversation, shared with the
user's interactive terminal. Within a session, files under /work persist across
turns. Across sessions, only the durable folders below survive.

Workspace layout:
- /work/in  — uploads and files you saved in earlier sessions are RESTORED here
              at the start of each session. Look here for the user's inputs.
- /work/out — write any file the user should KEEP (a report, an updated
              spreadsheet, generated data) here. Files in /work/out are saved to
              the Data Stash and restored into /work/in next time.
- /work     — anything else is scratch; it is cleared when the sandbox recycles.

Available tools (all run inside the sandbox VM):
- sandbox_bash: run a shell command. Python 3 is available.
- sandbox_write / sandbox_read / sandbox_edit: manage files under /work.
- sandbox_list / sandbox_search: inspect the working directory.

Guidance:
1. Build incrementally — check /work/in and /work for files from earlier turns
   before recreating anything.
2. For anything computational, run code in the sandbox rather than guessing.
3. When a task produces a FILE the user should keep, write it to /work/out
   (don't just compute the answer with a throwaway python3 -c). That file is the
   deliverable and is what persists to the Data Stash.
4. To continue a partial or large file, APPEND to it (bash \`cat >> file <<'EOF'\`)
   — don't regenerate the whole file from scratch.
5. Let the critic decide completion — you don't need a Return tool. Focus on
   producing the right tool call; the critic ends the loop when the result is
   sufficient.
`.trim()

/**
 * Few-shot examples for the actor's `tool_args` JSON formatting (#85).
 * Sonnet 4.6 intermittently emits JS-object-literal args (unquoted keys, raw
 * newlines) that the dispatch guard rejects as "Invalid tool_args JSON",
 * wasting retries. Two shots anchor the two tricky shapes: a multi-line file
 * write (newlines escaped inside a double-quoted JSON string) and a bash
 * command containing quotes. Mirrors `code-mode`'s `CODE_MODE_FEW_SHOTS`.
 */
const SANDBOX_SESSION_FEW_SHOTS: FewShot[] = [
  {
    user: 'Write a hello-world Python script to /work/hi.py and run it.',
    reasoning:
      'Write the file first. Keys and string values are double-quoted; the newline inside the script is the escape sequence \\n, not a raw line break.',
    tool: 'sandbox_write',
    args: JSON.stringify({ path: '/work/hi.py', content: 'print("hello")\n' }),
  },
  {
    user: 'What Python version is in the sandbox?',
    reasoning:
      'Single bash call. The command string is double-quoted; any inner quotes are escaped.',
    tool: 'sandbox_bash',
    args: JSON.stringify({ command: 'python3 --version' }),
  },
]

async function createPatterns(sessionId: string): Promise<ConfiguredPattern<SessionData>[]> {
  const actor = createActorControllerAdapter({
    contextPrefix: SANDBOX_SESSION_GUIDANCE,
    fewShots: SANDBOX_SESSION_FEW_SHOTS,
  })
  const critic = createCriticAdapter()

  const loop = actorCritic<SessionData>(actor, critic, [], {
    patternId: 'sandbox-session-loop',
    availableTools: [],
    liveEvents: true,
    maxRetries: 6,
    // Sandbox work is linear (write file → run script → read output): calls in
    // a batch run strictly IN ORDER, so later calls see earlier calls' effects
    // on the VM filesystem — one actor round-trip instead of N. Not 'parallel':
    // concurrent sandbox_bash on one VM FS races.
    multiToolCalls: 'sequential',
  })

  // id: sessionId → the attachment table keys this VM to the conversation, so
  // it persists across turns AND is the same container the Shell terminal
  // attaches to (PtyManager keys on sessionId). Release decrements refCount
  // without resetting, so /work survives between turns.
  const sandboxedLoop = withSandbox({
    id: sessionId,
    sessionId,
    rootfs: 'base',
    egress: 'mcp-only',
    // Durable workspace (#89): hydrate the conversation's stored documents into
    // /work/in on first boot, promote /work/out deliverables back to the Data
    // Stash each turn — so uploads/outputs survive idle eviction and reconnects.
    syncWorkspace: true,
  })(loop)

  const synth = compactExecution<SessionData>({
    mode: 'thread',
    patternId: 'sandbox-session-synth',
    liveEvents: true,
    viewConfig: {
      eventTypes: ['user_message', 'controller_action', 'tool_call', 'tool_result', 'error'],
    },
  })

  // Rewrite the latest message into a self-contained brief before the actor
  // runs. This agent is router-less, so without it a follow-up like "I can't
  // find the file" reaches the actor with zero context for which file (#83).
  // On turn 1 (no history) it passes the message through and skips the LLM call.
  const intent = compactIntent<SessionData>({
    patternId: 'sandbox-session-intent',
    liveEvents: true,
  })

  return [intent, sandboxedLoop, synth]
}

export const sandboxSessionAgent: AgentConfig = {
  id: 'sandbox-session',
  name: 'Sandbox · Session',
  description:
    'Persistent sandbox VM shared across turns and with the interactive Shell — build incrementally, inspect files live.',
  icon: 'i-material-symbols-castle-outline',
  accent: 'orange',
  servers: [],
  createPatterns,
}
