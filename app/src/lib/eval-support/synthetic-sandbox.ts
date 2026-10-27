/** The eval's stand-in for the in-VM sandbox: the production tool names, no execution.
 *
 * The transport is not the grader. A request is judged the way production would judge
 * it — a shell runs what it is given and says only what a shell says — and the scenario's
 * predicate (`valid` on the trace) is applied afterwards, to the command plus the scripts
 * it runs. So a refusal never carries the predicate's rule: a request that does not meet
 * it runs, exits 0 and leaves nothing behind, exactly as a script that never saves would.
 *
 * The shell models the INTERFACE CONTRACT, not a command whitelist (owner ruling
 * 2026-10-25, after live run 3: the old bare-`head|cat|wc|ls` whitelist returned empty
 * stdout for the candidates' legitimate exploration — `ls -la /work/in && echo '---' &&
 * head …`, pipelines, plain `echo` — and the model read the dead-looking box as closed).
 * A well-formed read/inspect command gets the deterministic output the calibrated real
 * container prints (`evals/calibration/`): `ls` (short and `-l`/`-la` long form), `cat`,
 * `head`, `wc`, `grep`, `echo`, `mkdir -p`, stages joined by `|`, and `>`/`>>` redirects.
 * Long-form metadata is normalised — byte length for sizes, one fixed timestamp — so runs
 * stay deterministic; every normalisation is recorded in the calibration record. A
 * redirect writes the file exactly as a `sandbox_write` would and is judged by the same
 * `judgeWrite`, so a transcription of a declared deliverable is credited from a shell
 * line too. Anything outside the modelled set — an interpreter, a quoted pipe the parser
 * cannot read — is still judged by the predicate, never failed: it runs, exits 0 and
 * leaves nothing behind, while the modelled parts of the same command line still print
 * what a shell would print.
 *
 * Production promotes any new or changed file under /work/out to an artifact at turn exit
 * (`promoteOutputs`, `packages/sandbox/work-artifacts.server.ts:164-197`, called from
 * `with-sandbox.server.ts:841`), whichever tool wrote it. Here an accepted shell request
 * records the scenario's artifacts, a `sandbox_write` or `sandbox_edit` of
 * `/work/out/<name>` records one ONLY for a scenario that declares `writtenArtifacts` (a
 * transcription, not a computation) and only when the file's resulting text meets that
 * file's predicate, and a modelled `>`/`>>` redirect is judged the same way — the last
 * write of a file decides, as the exit-time diff over its final bytes would.
 *
 * Not modelled: `rm`, `mv` and in-place shell edits of a credited file (the synthetic
 * shell cannot run arbitrary commands; production's exit-time `find` would not see a
 * deleted file, and `diffWorkFiles` ignores deletions, `work-sync.server.ts:168-177`),
 * `cd`, heredoc bodies (a `<<` makes the whole line a producing request), and the stdout
 * of interpreter runs (the one shape whose output the synthetic layer cannot transcribe;
 * a credited run prints the scenario's own captured stdout instead). */
import type {
  ConfiguredPattern,
  MCPToolDescription,
  ToolTransport,
} from '@hames-ai/harness-patterns'
import type { SandboxAttach } from '@hames-ai/agents'
import { V0_IN_VM_SERVERS } from '@hames-ai/sandbox/types'
import { sandboxShapeError, type ArgsPredicate } from './tool-arguments'
import type { ConversationScenario, ConversationTrace } from './conversation'

const schema = (properties: Record<string, object>, required: string[]) => ({
  type: 'object',
  properties,
  required,
})
const PATH = { type: 'string', description: 'File path under /work.' }

/** The sandbox's file tools as production exposes them (rust-mcp-filesystem tools under
 * the `sandbox_` prefix, `packages/sandbox` V0_IN_VM_SERVERS). Hermetic stand-ins only:
 * their descriptions are NOT the server's text. Live mode derives all five from the
 * gateway's own entries (`evals/general-next/tool-catalog.ts`), so it never uses these. */
export const SANDBOX_FILE_TOOLS: MCPToolDescription[] = [
  {
    name: 'sandbox_write',
    description: 'Write a file in /work.',
    inputSchema: schema({ path: PATH, content: { type: 'string' } }, ['path', 'content']),
  },
  {
    name: 'sandbox_read',
    description: 'Read a text file from /work.',
    inputSchema: schema({ path: PATH }, ['path']),
  },
  {
    name: 'sandbox_edit',
    description: 'Replace text in a file under /work.',
    inputSchema: schema(
      {
        path: PATH,
        edits: {
          type: 'array',
          items: schema({ oldText: { type: 'string' }, newText: { type: 'string' } }, [
            'oldText',
            'newText',
          ]),
        },
      },
      ['path', 'edits'],
    ),
  },
  {
    name: 'sandbox_list',
    description: 'List a directory under /work.',
    inputSchema: schema({ path: PATH }, ['path']),
  },
  {
    name: 'sandbox_search',
    description: 'Search file contents under /work.',
    inputSchema: schema({ path: PATH, query: { type: 'string' } }, ['path', 'query']),
  },
]

/** Live mode: the sandbox's file tools ARE the gateway's rust-mcp-filesystem entries, renamed by
 * V0_IN_VM_SERVERS. Derived, never restated, so the description is the server's own text; an
 * entry the gateway does not list is an error, not a stand-in. */
export function sandboxFileToolsFromGateway(gateway: MCPToolDescription[]): MCPToolDescription[] {
  return V0_IN_VM_SERVERS.flatMap((server) => Object.entries(server.tools))
    .filter(([, exposed]) => exposed !== 'sandbox_bash')
    .map(([native, exposed]) => {
      const tool = gateway.find((t) => t.name === native)
      if (!tool) throw new Error(`Production tool metadata missing: ${native} (${exposed})`)
      return { ...tool, name: exposed }
    })
}

/** Every in-VM tool name a sandbox exposes, derived from the SAME registry production's
 * `withSandbox` declares in `capabilities.tools` (`packages/sandbox/with-sandbox.server.ts:54`)
 * — never restated, so the declaration and the synthetic transport cannot drift apart. */
export const IN_VM_TOOL_NAMES: readonly string[] = V0_IN_VM_SERVERS.flatMap((server) =>
  Object.values(server.tools),
)

/** The eval's stand-in for the production `withSandbox` dep. It mirrors production's
 * capabilities merge — the in-VM tool names over the wrapped pattern's own declaration
 * (`packages/sandbox/with-sandbox.server.ts:432-436`) — so `collectToolNames` sees the
 * `sandbox_` tools and the egress gate's `localTools` treats in-VM calls as LOCAL rather
 * than outgoing (ordiag finding 2026-10-26: the missing declaration emptied `localTools`,
 * every `sandbox_*` call was refused as egress at τe, the route closed and the budget
 * exhausted). The attach config is accepted and ignored: there is no VM to boot, the
 * synthetic transport is scoped per turn through the run frame below.
 *
 * `amendRunFrame` is imported INSIDE `fn`, not at module top: this module is statically
 * imported by unit tests that run under jsdom without mocking `assert.server`
 * (`tool-catalog.test.ts`), and `run-frame.server` self-asserts server-only at load. */
export function createSyntheticWithSandbox(
  transport: ToolTransport,
): <T>(config: SandboxAttach) => (pattern: ConfiguredPattern<T>) => ConfiguredPattern<T> {
  return () => (pattern) => ({
    ...pattern,
    capabilities: {
      ...pattern.capabilities,
      tools: [...new Set([...(pattern.capabilities?.tools ?? []), ...IN_VM_TOOL_NAMES])],
    },
    children: [pattern],
    fn: async (scope, view) => {
      const { amendRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
      return amendRunFrame({ transports: [transport] }, () => pattern.fn(scope, view))
    },
  })
}

export interface SyntheticSandboxState {
  scenario: () => ConversationScenario
  /** A new trace is a new run: the actor's written files do not outlive it. */
  trace: () => ConversationTrace | undefined
  turn: () => number
  /** Stash contents by file name: the uploaded inputs, and every artifact created. */
  documents: Map<string, string>
  descriptions: MCPToolDescription[]
}

const WORK = '/work/'
const IN = `${WORK}in/`
const OUT = `${WORK}out/`

const withinWork = (path: string) =>
  (path === '/work' || path.startsWith(WORK)) && !path.split('/').includes('..')

type Result = { success: boolean; data: unknown; error?: string }

export function createSyntheticSandbox(state: SyntheticSandboxState): ToolTransport {
  const written = new Map<string, string>()
  let current: unknown
  const ok = (data: unknown) => ({ success: true, data })
  const fail = (error: string) => ({ success: false, data: null, error })

  const produced = () => state.trace()?.artifacts ?? []
  /** Every file the actor could see: inputs, what a shell request produced, what it wrote. */
  const files = (): Map<string, string> => {
    const all = new Map<string, string>()
    const made = state.scenario().sandboxRun?.files ?? {}
    for (const [name, text] of state.documents)
      all.set(produced().includes(name) ? `${OUT}${name}` : `${IN}${name}`, made[name] ?? text)
    for (const [path, text] of written) all.set(path, text)
    return all
  }
  const shell = (stdout: string, code = 0, stderr = '', artifacts: unknown[] = []) => ({
    success: code === 0,
    data: { artifacts, stdout, stderr, exit_code: code, timed_out: false },
  })

  // ==========================================================================
  // The modelled shell. One quote-aware tokenizer feeds segment → pipeline →
  // stage evaluation; every verb's output below is the calibrated container's
  // (`evals/calibration/`), made deterministic by fixed metadata.
  // ==========================================================================

  type Word = { text: string; quoted: boolean }
  /** `&&`, `;`, a bare newline, `|`, and the two redirects. */
  type Op = '&&' | ';' | '\n' | '|' | '>' | '>>'
  type Tok = Word | { op: Op }

  /** Tokenize one command line, honouring single and double quotes (contents verbatim —
   * the calibrated container's `echo` prints them so) and `#` comments. `$`, backticks,
   * escapes and unquoted parens are refused (undefined), which sends the command to the
   * request path — the old character gate, kept for everything the parser cannot read. */
  const tokenize = (command: string): Tok[] | undefined => {
    const toks: Tok[] = []
    let word = ''
    let quoted: "'" | '"' | undefined
    let started = false
    let comment = false
    const flush = () => {
      if (started) toks.push({ text: word, quoted: false })
      word = ''
      started = false
    }
    for (let i = 0; i < command.length; i++) {
      const ch = command[i]
      if (comment) {
        if (ch === '\n') {
          comment = false
          toks.push({ op: '\n' })
        }
        continue
      }
      if (quoted) {
        if (ch === quoted) {
          toks.push({ text: word, quoted: true })
          word = ''
          quoted = undefined
        } else word += ch
        continue
      }
      if (ch === "'" || ch === '"') {
        flush()
        quoted = ch
        continue
      }
      if (ch === '\\' || ch === '$' || ch === '`' || ch === '(' || ch === ')') return undefined
      if (ch === ' ' || ch === '\t') {
        flush()
        continue
      }
      if (ch === '#') {
        flush()
        comment = true
        continue
      }
      if (ch === '|') {
        flush()
        toks.push({ op: '|' })
        continue
      }
      if (ch === ';' || ch === '\n') {
        flush()
        toks.push({ op: ch as Op })
        continue
      }
      if (ch === '>') {
        flush()
        if (command[i + 1] === '>') {
          toks.push({ op: '>>' })
          i++
        } else toks.push({ op: '>' })
        continue
      }
      if (ch === '&') {
        flush()
        if (command[i + 1] === '&') {
          toks.push({ op: '&&' })
          i++
          continue
        }
        return undefined
      }
      word += ch
      started = true
    }
    if (quoted || comment) return undefined
    flush()
    return toks
  }

  type Stage = { words: Word[]; redirect?: { append: boolean; target: string } }
  type Segment = { stages: Stage[]; separator: Op | 'start' }

  /** Group tokens into `&&`/`;`/newline-separated segments of `|`-joined stages, each with
   * at most one redirect (`separator` is the operator that JOINS the segment to the one
   * before it). Any shape outside the modelled grammar is undefined, which sends the whole
   * command to the request path (judged, never failed). */
  const parse = (toks: Tok[]): Segment[] | undefined => {
    const segments: Segment[] = []
    let stages: Stage[] = []
    let words: Word[] = []
    let redirect: Stage['redirect'] | undefined
    let separator: Op | 'start' = 'start'
    const push = () => {
      stages.push({ words, redirect })
      words = []
      redirect = undefined
    }
    for (const tok of toks) {
      if ('op' in tok) {
        if (tok.op === '|') {
          if (!words.length || redirect) return undefined
          push()
        } else if (tok.op === '>' || tok.op === '>>') {
          if (redirect) return undefined
          redirect = { append: tok.op === '>>', target: '' }
        } else {
          if (redirect && !redirect.target) return undefined
          if (words.length || stages.length) {
            push()
            segments.push({ stages, separator })
            stages = []
            separator = tok.op
          } else if (separator === 'start' || separator === '&&') return undefined
          else separator = tok.op
        }
      } else if (redirect && !redirect.target) redirect.target = tok.text
      else words.push(tok)
    }
    if (redirect && !redirect.target) return undefined
    if (words.length || stages.length) {
      push()
      segments.push({ stages, separator })
    } else if (separator === '&&') return undefined
    return segments
  }

  const resolve = (p: string, cwd: string) =>
    p.startsWith('/') ? p : `${cwd.replace(/\/$/, '')}/${p}`
  const byteLen = (text: string) => new TextEncoder().encode(text).length
  /** The normalised timestamp column of the long listing: real mtimes are not
   * deterministic, so every entry carries one fixed stamp (calibration record). */
  const STAMP = 'Jan  1 00:00'
  const pad = (n: number, w: number) => String(n).padStart(w)
  /** `\n` and `\t` — the two escapes `echo -e` and `printf` interpret (calibrated). */
  const unescape = (text: string) => text.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
  /** Newline count — what `wc -l` actually counts (calibrated: ` 3  3 33 <path>`). */
  const lineCount = (text: string) => text.split('\n').length - 1

  /** `[FILE] name` / `[DIR] name` lines for the direct children of `dir` (trailing slash). */
  function listing(all: Map<string, string>, dir: string): string[] {
    const entries = new Set<string>(dir === WORK ? ['[DIR] in', '[DIR] out'] : [])
    for (const path of all.keys()) {
      if (!path.startsWith(dir)) continue
      const [head, ...below] = path.slice(dir.length).split('/')
      entries.add(`${below.length ? '[DIR]' : '[FILE]'} ${head}`)
    }
    return [...entries]
  }

  const longLine = (dir: boolean, name: string, size: number) =>
    `${dir ? 'drwxr-xr-x' : '-rw-r--r--'} ${dir ? 2 : 1} sandbox sandbox ${pad(size, 5)} ${STAMP} ${name}`

  /** Directories the modelled box always has, plus any a file sits under. */
  const knownDir = (all: Map<string, string>, dir: string) =>
    ['/work/', IN, OUT].includes(dir) || [...all.keys()].some((p) => p.startsWith(dir))

  /** One modelled stage — `inspectOne`: a single command between pipes. Its stdout, or
   * `err`/`code` when the calibrated container would error; undefined for anything outside
   * the modelled verb set (the caller sends the segment to the request path). */
  const inspectOne = (
    stage: Stage,
    stdin: string,
    cwd: string,
    all: Map<string, string>,
  ): { out: string; err?: string; code?: number } | undefined => {
    const [prog, ...rest] = stage.words
    if (!prog || prog.quoted) return undefined
    const args = rest.map((w) => w.text)
    const operands = args.filter((a) => !a.startsWith('-'))
    const paths = operands.map((a) => resolve(a, cwd))
    const missing = (program: string, path: string, code: number) => ({
      out: '',
      err: `${program}: ${path}: No such file or directory\n`,
      code,
    })
    switch (prog.text) {
      case 'mkdir': {
        const flags = args.filter((a) => a.startsWith('-'))
        if (!flags.every((f) => f === '-p') || !operands.length) return undefined
        if (!paths.every(withinWork)) return undefined
        return { out: '' }
      }
      case 'ls': {
        const flags = args.filter((a) => a.startsWith('-'))
        if (flags.some((f) => [...f].some((c) => c !== '-' && c !== 'l' && c !== 'a')))
          return undefined
        const long = flags.some((f) => f.includes('l'))
        const dotfiles = flags.some((f) => f.includes('a'))
        const dirs = paths.length ? paths : [cwd.endsWith('/') ? cwd : `${cwd}/`]
        for (const dir of dirs) {
          const names = `${dir.replace(/\/$/, '')}/`
          if (!knownDir(all, names)) return missing('ls', `cannot access '${dir}'`, 2)
        }
        let out = ''
        for (const dir of dirs) {
          const names = `${dir.replace(/\/$/, '')}/`
          const lines = listing(all, names)
            .map((l) => l.replace(/^\[\w+\] /, ''))
            .sort()
          if (long) {
            out += 'total 8\n'
            if (dotfiles) out += `${longLine(true, '.', 80)}\n${longLine(true, '..', 120)}\n`
            for (const name of lines)
              out += `${longLine(false, name, byteLen(all.get(`${names}${name}`) ?? ''))}\n`
          } else for (const name of lines) out += `${name}\n`
        }
        return { out }
      }
      case 'cat': {
        let out = stdin
        for (const path of paths) {
          const text = all.get(path)
          if (text === undefined) return missing('cat', path, 1)
          out += text
        }
        return { out }
      }
      case 'head': {
        let lines = 10
        const words = [...args]
        const glued = /^-n?(\d+)$/.exec(words[0] ?? '')
        if (glued) {
          lines = Number(glued[1])
          words.shift()
        } else if (words[0] === '-n' && /^\d+$/.test(words[1] ?? '')) {
          lines = Number(words[1])
          words.splice(0, 2)
        }
        const targets = words.filter((a) => !a.startsWith('-')).map((a) => resolve(a, cwd))
        if (targets.some((p) => !all.has(p)))
          return missing(
            'head',
            targets.find((p) => !all.has(p))!,
            1,
          )
        const source = targets.length ? targets.map((p) => all.get(p)!).join('') : stdin
        return { out: source.split('\n').slice(0, lines).join('\n') }
      }
      case 'wc': {
        const flags = args.filter((a) => a.startsWith('-'))
        if (flags.some((f) => [...f].some((c) => c !== '-' && c !== 'l'))) return undefined
        const linesOnly = flags.some((f) => f.includes('l'))
        if (paths.length > 1) return undefined
        if (paths.length) {
          const [path] = paths
          const text = all.get(path)
          if (text === undefined) return missing('wc', path, 1)
          if (linesOnly) return { out: `${lineCount(text)} ${path}\n` }
          return {
            out: `${pad(lineCount(text), 2)} ${pad(text.trim().split(/\s+/).filter(Boolean).length, 2)} ${pad(byteLen(text), 2)} ${path}\n`,
          }
        }
        if (linesOnly) return { out: `${lineCount(stdin)}\n` }
        return {
          out: [lineCount(stdin), stdin.trim().split(/\s+/).filter(Boolean).length, byteLen(stdin)]
            .map((n) => pad(n, 7))
            .join(''),
        }
      }
      case 'grep': {
        const flags = args.filter((a) => a.startsWith('-'))
        if (flags.some((f) => [...f].some((c) => c !== '-' && c !== 'i'))) return undefined
        const insensitive = flags.some((f) => f.includes('i'))
        const [pattern, ...fileArgs] = operands
        if (!pattern) return undefined
        const match = (line: string) =>
          (insensitive ? line.toLowerCase() : line).includes(
            insensitive ? pattern.toLowerCase() : pattern,
          )
        if (!fileArgs.length) {
          const hits = stdin.split('\n').filter(match)
          return {
            out: hits.join('\n') + (hits.length ? '\n' : ''),
            code: hits.length ? undefined : 1,
          }
        }
        const targets = fileArgs.map((a) => resolve(a, cwd))
        if (targets.some((p) => !all.has(p)))
          return missing(
            'grep',
            targets.find((p) => !all.has(p))!,
            2,
          )
        const lines = targets.flatMap((path) =>
          (all.get(path) ?? '')
            .split('\n')
            .filter(match)
            .map((line) => (targets.length > 1 ? `${path}:${line}` : line)),
        )
        return {
          out: lines.join('\n') + (lines.length ? '\n' : ''),
          code: lines.length ? undefined : 1,
        }
      }
      case 'echo': {
        // bash treats -n/-e as options only while they lead; after the first non-option
        // token everything is literal, so the flag scan stops there.
        let i = 0
        let newline = true
        let escape = false
        while (i < rest.length && !rest[i].quoted && /^-[ne]+$/.test(rest[i].text)) {
          if (rest[i].text.includes('n')) newline = false
          if (rest[i].text.includes('e')) escape = true
          i++
        }
        const text = rest
          .slice(i)
          .map((w) => (escape ? unescape(w.text) : w.text))
          .join(' ')
        return { out: text + (newline ? '\n' : '') }
      }
      case 'printf': {
        // Calibrated: escapes are ALWAYS interpreted, `%s`/`%d` consume one argument
        // each, a format with placeholders re-runs for the remaining arguments, and a
        // directive-free format is printed once regardless of extra arguments.
        if (!rest.length) return undefined
        const format = unescape(rest[0].text)
        if (/(?:^|[^%])%[^%sd]/.test(format)) return undefined
        const values = rest.slice(1).map((w) => w.text)
        const render = (chunk: string[]): string | undefined => {
          let used = 0
          let out = ''
          for (const part of format.split(/(%[sd]|%%)/)) {
            if (part === '%%') out += '%'
            else if (part === '%s' || part === '%d') {
              const value = chunk[used++]
              if (value === undefined) return undefined
              out += value
            } else out += part
          }
          return out
        }
        const slots = (format.match(/%[sd]/g) ?? []).length
        let out = ''
        if (!values.length || !slots) {
          const once = render(values.slice(0, slots || undefined))
          if (once === undefined) return undefined
          out = once
        } else {
          let at = 0
          while (at < values.length) {
            const chunk = render(values.slice(at, at + slots))
            if (chunk === undefined) return undefined
            out += chunk
            at += slots
          }
        }
        return { out }
      }
      default:
        return undefined
    }
  }

  /** How the missing-script refusal shapes an unmodelled `python3 <path>.py` stage. */
  const missingScript = (stage: Stage, all: Map<string, string>): string | undefined => {
    const [prog, ...rest] = stage.words
    if (!prog || !/^python3?$/.test(prog.text)) return undefined
    const script = rest.find((w) => /^\/\S+\.py$/.test(w.text))?.text
    if (script && !all.has(script))
      return `python3: can't open file '${script}': [Errno 2] No such file or directory\n`
    return undefined
  }

  /** Run parsed segments left to right as a shell would (`&&` stops at the first
   * failure). Two seams let `bash` judge while this stays a pure shell model:
   * `write` records a `>`/`>>` redirect the way `sandbox_write` does, and `produce`
   * answers an unmodelled (interpreter) stage with the transcription of what the
   * scenario's real run prints — or '' when nothing is credited. */
  const runSegments = (
    segments: Segment[],
    cwd: string,
    write: (path: string, text: string) => boolean | undefined,
    produce: (stage: Stage) => { stdout: string; missing?: string } | undefined,
  ): { stdout: string; stderr: string; exit_code: number } | undefined => {
    let stdout = ''
    let stderr = ''
    let code = 0
    let stop = false
    for (const segment of segments) {
      if (!segment.stages.length) {
        if (segment.separator === '&&') return undefined
        continue
      }
      // `a && b ; c`: a fails, b is skipped, the `;` resumes c.
      if (stop) {
        if (segment.separator === '&&') continue
        stop = false
      }
      let stageOut = ''
      let failed: { err: string; code: number } | undefined
      for (const stage of segment.stages) {
        const run = inspectOne(stage, stageOut, cwd, files())
        if (!run) {
          const made = produce(stage)
          if (!made) return undefined
          if (made.missing) {
            failed = { err: made.missing, code: 2 }
            break
          }
          stageOut = made.stdout
          if (stage.redirect) {
            const target = resolve(stage.redirect.target, cwd)
            if (!withinWork(target)) return undefined
            written.set(target, stageOut)
            write(target, stageOut)
            stageOut = ''
          }
          continue
        }
        stageOut = run.out
        if (run.err !== undefined || run.code !== undefined) {
          failed = { err: run.err ?? '', code: run.code ?? (run.err !== undefined ? 1 : 0) }
          break
        }
        if (stage.redirect) {
          const target = resolve(stage.redirect.target, cwd)
          if (!withinWork(target)) return undefined
          const text = stage.redirect.append ? (files().get(target) ?? '') + stageOut : stageOut
          written.set(target, text)
          write(target, text)
          stageOut = ''
        }
      }
      if (failed) {
        stderr += failed.err
        code = failed.code
        stop = true
        continue
      }
      stop = false
      stdout += stageOut && stdout && !stdout.endsWith('\n') ? `\n${stageOut}` : stageOut
      code = 0
    }
    return { stdout, stderr, exit_code: code }
  }

  const record = (file: string, text: string) => {
    state.documents.set(file, text)
    const trace = state.trace()
    if (trace && !trace.artifacts.includes(file)) trace.artifacts.push(file)
    if (trace && file.endsWith('.md') && !trace.indexed.includes(file)) trace.indexed.push(file)
  }
  /** The file's last write is not a deliverable (any more): what the exit-time diff would
   * promote is that write, so an earlier credit for the same file is withdrawn. */
  const unrecord = (file: string) => {
    const trace = state.trace()
    if (trace) {
      trace.artifacts = trace.artifacts.filter((f) => f !== file)
      trace.indexed = trace.indexed.filter((f) => f !== file)
    }
    state.documents.delete(file)
  }
  /** Whether a write is the scenario's declared deliverable: `/work/out/<name>` itself (no
   * subdirectory, no `/work/in`), non-empty, and meeting its predicate. Undefined when the
   * scenario declares none, so every other scenario's trace is untouched. */
  const judgeWrite = (path: string, content: string): boolean | undefined => {
    const declared = state.scenario().writtenArtifacts
    if (!declared) return undefined
    const file = path.startsWith(OUT) ? path.slice(OUT.length) : ''
    if (!file || !Object.hasOwn(declared, file)) return false
    const credited = content.trim() !== '' && declared[file](content)
    if (credited) record(file, content)
    else unrecord(file)
    return credited
  }

  /** The bare names a successful `sandbox_read` returned earlier in THIS turn: the trace
   * entry for the call being judged is pushed after the verdict, so every same-turn read
   * in the trace is an earlier one. Bare names, as the scenario predicates declare them
   * (R6DIAG row 14: the run-6 script transcribed notes it had read with `sandbox_read`).
   * Only `sandbox_read` is credited: it is the one read that returns a file's whole
   * content, which is what a transcription needs. */
  const readThisTurn = (): string[] => {
    const trace = state.trace()
    if (!trace) return []
    return [
      ...new Set(
        trace.tools
          .filter((t) => t.turn === state.turn() && t.name === 'sandbox_read' && t.success)
          .map((t) =>
            typeof t.args.path === 'string' ? (t.args.path.split('/').at(-1) ?? '') : '',
          ),
      ),
    ].filter(Boolean)
  }

  /** The producing-request path, shared by heredoc lines and unparseable commands: the
   * scenario's captured run stands in for the interpreter, and the predicate over the
   * command plus the scripts it runs decides. Returns the predicate's verdict too — a
   * shell result is success:true either way, and the valid flag is the GRADE. */
  const produceRequest = (
    args: Record<string, unknown>,
    scripts: string,
  ): { result: Result; valid: boolean } => {
    const scenario = state.scenario()
    const predicate = scenario.expectedArgs?.sandbox_bash as ArgsPredicate | undefined
    if (!predicate?.(args, scripts, readThisTurn())) return { result: shell(''), valid: false }
    const made = scenario.sandboxRun?.files ?? {}
    for (const file of scenario.artifacts)
      record(file, made[file] ?? state.documents.get('lantern-notes.md') ?? '')
    return {
      result: shell(
        scenario.sandboxRun?.stdout ?? scenario.artifacts.map((n) => `Saved ${OUT}${n}`).join('\n'),
        0,
        '',
        scenario.artifacts.map((n) => ({ name: n, url: `stash://fixture/${n}` })),
      ),
      valid: true,
    }
  }

  const bash = (args: Record<string, unknown>): { result: Result; valid?: boolean } => {
    const shape = sandboxShapeError(args)
    if (shape) return { result: fail(`Invalid arguments for sandbox_bash: ${shape}.`) }
    const command = args.command as string
    const cwd = typeof args.cwd === 'string' ? args.cwd : '/work'
    const scriptsOf = () =>
      [...written]
        .filter(([p]) => command.includes(p))
        .map(([, text]) => text)
        .join('\n')
    // A heredoc feeds the interpreter from the command's own text: the whole line is a
    // producing request, judged once.
    if (/<<-?\s*['"]?\w/.test(command)) {
      const script = /\bpython3?\s+(\/\S+\.py)/.exec(command)?.[1]
      if (script && !files().has(script))
        return {
          result: shell(
            '',
            2,
            `python3: can't open file '${script}': [Errno 2] No such file or directory`,
          ),
          valid: false,
        }
      const result = produceRequest(args, scriptsOf())
      return { result: result.result, valid: result.valid }
    }
    const toks = tokenize(command)
    const segments = toks && parse(toks)
    if (!segments || !segments.length) {
      // Outside the modelled grammar: the request path, judged as before.
      const script = /\bpython3?\s+(\/\S+\.py)/.exec(command)?.[1]
      if (script && !files().has(script))
        return {
          result: shell(
            '',
            2,
            `python3: can't open file '${script}': [Errno 2] No such file or directory`,
          ),
          valid: false,
        }
      const result = produceRequest(args, scriptsOf())
      return { result: result.result, valid: result.valid }
    }
    let lastJudge: boolean | undefined
    let predicateResult: boolean | undefined
    const evaluated = runSegments(
      segments,
      cwd,
      // A redirect leaves a file exactly as sandbox_write would: visible, and judged.
      (path, text) => {
        const judged = judgeWrite(path, text)
        if (judged !== undefined) lastJudge = judged
        return judged
      },
      // An interpreter stage: the scenario's captured stdout stands in once the
      // predicate over command + scripts passes; otherwise it ran and left nothing.
      (stage) => {
        const missing = missingScript(stage, files())
        if (missing) return { stdout: '', missing }
        predicateResult ??=
          (state.scenario().expectedArgs?.sandbox_bash as ArgsPredicate | undefined)?.(
            args,
            scriptsOf(),
            readThisTurn(),
          ) ?? false
        if (predicateResult) {
          lastJudge = true
          const scenario = state.scenario()
          const made = scenario.sandboxRun?.files ?? {}
          for (const file of scenario.artifacts)
            record(file, made[file] ?? state.documents.get('lantern-notes.md') ?? '')
          return {
            stdout:
              scenario.sandboxRun?.stdout ??
              scenario.artifacts.map((n) => `Saved ${OUT}${n}`).join('\n'),
          }
        }
        return { stdout: '' }
      },
    )
    if (!evaluated) {
      const produced = produceRequest(args, scriptsOf())
      return { result: produced.result, valid: produced.valid }
    }
    return {
      result: shell(evaluated.stdout, evaluated.exit_code, evaluated.stderr),
      valid: lastJudge ?? false,
    }
  }

  const call: ToolTransport['callTool'] = async (name, args) => {
    if (state.trace() !== current) {
      written.clear()
      current = state.trace()
    }
    const path = typeof args.path === 'string' ? args.path : ''
    const inWork = withinWork(path)
    let valid: boolean | undefined
    const result = ((): Result => {
      if (name === 'sandbox_bash') {
        const run = bash(args)
        valid = run.valid
        return run.result
      }
      if (name === 'sandbox_write') {
        if (!inWork || typeof args.content !== 'string')
          return fail('write_file: path must be under /work and content must be a string.')
        written.set(path, args.content)
        valid = judgeWrite(path, args.content)
        return ok(`Successfully wrote to ${path}`)
      }
      if (name === 'sandbox_read') {
        const content = inWork ? files().get(path) : undefined
        return content === undefined ? fail(`read_text_file: no such file: ${path}`) : ok(content)
      }
      if (name === 'sandbox_edit') {
        const text = inWork ? written.get(path) : undefined
        if (text === undefined || !Array.isArray(args.edits))
          return fail(`edit_file: no such file: ${path}`)
        let next = text
        for (const e of args.edits as Array<{ oldText?: unknown; newText?: unknown }>) {
          if (
            typeof e.oldText !== 'string' ||
            typeof e.newText !== 'string' ||
            !next.includes(e.oldText)
          )
            return fail(`edit_file: could not find the text to replace in ${path}`)
          next = next.replace(e.oldText, () => e.newText as string)
        }
        written.set(path, next)
        // The bytes production would promote are the file's FINAL ones: re-judge them.
        valid = judgeWrite(path, next)
        return ok(`Edited ${path}`)
      }
      if (name === 'sandbox_list') {
        if (!inWork) return fail('list_directory: path must be under /work.')
        return ok(listing(files(), path.endsWith('/') ? path : `${path}/`).join('\n'))
      }
      if (name === 'sandbox_search') {
        if (!inWork || typeof args.query !== 'string')
          return fail('search_files_content: bad arguments.')
        const dir = path.endsWith('/') ? path : `${path}/`
        const hits = [...files()]
          .filter(([p]) => p.startsWith(dir))
          .flatMap(([p, text]) =>
            text
              .split('\n')
              .flatMap((line, i) =>
                line.includes(args.query as string) ? [`${p}:${i + 1}: ${line}`] : [],
              ),
          )
        return ok(hits.join('\n') || 'No matches found')
      }
      return fail(`${name}: not available in the synthetic sandbox.`)
    })()
    state.trace()?.tools.push({
      name,
      args,
      success: result.success,
      turn: state.turn(),
      ...(valid === undefined ? {} : { valid }),
    })
    return result
  }
  return {
    id: 'general-eval-synthetic-sandbox',
    ownsTool: (name) => state.descriptions.some((t) => t.name === name),
    namespaceFor: () => 'sandbox',
    listTools: async () => state.descriptions,
    callTool: call,
  }
}
