# Synthetic-sandbox calibration record — the interface contract, line by line

The eval's synthetic sandbox (`app/src/lib/eval-support/synthetic-sandbox.ts`) models the
office sandbox's shell for the general-next grade. Owner ruling 2026-10-25 (after live run
3, the #606 gate evidence): the sandbox models the **interface contract**, not a command
whitelist — any well-formed read/inspect command gets plausible deterministic output, and
artifact predicates check the **produced artifact**, not the command's vocabulary. The
determinism and hermeticity of the eval layer are unchanged: no real host, no timing, same
input → same output.

The old whitelist modelled bare `head|cat|wc|ls` only. Live run 3's failing signatures
(09/10/11/14/17, capture `evals/reports/2026-10-24T21-25-58-561Z-general-next-capture.json`)
all involve exploration the old model answered with **empty stdout, exit 0** —
`ls -la /work/in && echo '---' && head …`, plain `echo waiting`, `cat f | wc -l` — and the
candidate read the dead-looking box as closed and exhausted its retries.

This record is the owner addendum's deliverable (2026-10-25 ~01:2xZ): the reworked answer
expectations were validated against **actual sandbox runs** before being encoded. The table
below is `command → real observed output → synthetic expectation`. Every real row came from
ONE bounded base-flavour container booted by the committed runner
(`app/evals/calibration/run-real.ts`, the repo's real `DockerBackend`, `kg-sandbox:base`,
local docker/colima only — no Modal, no network egress; the actor-facing `sandbox_bash`
path, so the real bash-guard screen judged every command on the way in and refused none).
Raw results from the run: `app/evals/calibration/calibration-raw.json` (gitignored run
artifact; re-run the script to regenerate). The eval itself stays synthetic and hermetic.
`packages/sandbox` is untouched by the fix.

## The calibrated contract

| Command                                             | Real observed output (base container)                                                                 | Synthetic expectation                                                                                                                                                                                                                                         |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ls -la /work/in`                                   | `total 8` + `.`/`..` + `-rw-r--r-- 1 sandbox sandbox  33 Oct 24 23:46 lantern-sales.csv` (mtime, uid) | Same long format; size = content byte length (33 ✓ exact); **fixed timestamp `Jan  1 00:00`** (mtime is not deterministic — normalised, recorded here)                                                                                                        |
| `ls -l /work/in`                                    | long format without dotfiles                                                                          | Same minus the `.`/`..` lines                                                                                                                                                                                                                                 |
| `ls /work/in`                                       | `lantern-notes.md\nlantern-sales.csv\n` (sorted)                                                      | Sorted bare names, one per line, trailing newline                                                                                                                                                                                                             |
| `ls /work/nope`                                     | stderr `ls: cannot access '/work/nope': No such file or directory`, exit **2**                        | Same text, exit 2                                                                                                                                                                                                                                             |
| `cat <file>`                                        | file content verbatim                                                                                 | Same; missing file → `cat: <p>: No such file or directory`, exit 1                                                                                                                                                                                            |
| `head -n 2 f` / `head -2 f`                         | first 2 lines                                                                                         | Same (the pre-existing `-n`/glued-count parsing, unchanged)                                                                                                                                                                                                   |
| `wc -l <f>`                                         | `3 /work/in/lantern-sales.csv`                                                                        | Same                                                                                                                                                                                                                                                          |
| `wc <f>`                                            | ` 3  3 33 /work/in/lantern-sales.csv` (counts padded to width 2)                                      | Same                                                                                                                                                                                                                                                          |
| `cat f \| wc`                                       | `      3       3      33` (three width-7 columns)                                                     | Same                                                                                                                                                                                                                                                          |
| `cat f \| wc -l`                                    | `3\n`                                                                                                 | Same                                                                                                                                                                                                                                                          |
| `grep North f` (single file)                        | matching lines, **no path prefix**, exit 0                                                            | Same                                                                                                                                                                                                                                                          |
| `grep -i north f`                                   | case-insensitive matches, original casing                                                             | Same                                                                                                                                                                                                                                                          |
| `grep P f` (no match)                               | empty stdout, exit **1**                                                                              | Same — and an exit 1 stops an `&&` chain, as a shell does                                                                                                                                                                                                     |
| `grep P /work/in/nope.csv`                          | stderr `grep: …: No such file or directory`, exit **2**                                               | Same                                                                                                                                                                                                                                                          |
| `grep P f1 f2` (multi-file)                         | `path:line` prefixes                                                                                  | Same                                                                                                                                                                                                                                                          |
| `cat f \| grep 2030`                                | matching lines from stdin                                                                             | Same                                                                                                                                                                                                                                                          |
| `ls /work/in \| grep lantern` / `\| head -1`        | filtered/limited lines                                                                                | Same (`cat`, `ls`, `grep`, `head`, `wc` all accept stdin between pipes)                                                                                                                                                                                       |
| `echo waiting`                                      | `waiting\n`                                                                                           | Same                                                                                                                                                                                                                                                          |
| `echo 'sandbox unavailable this turn'` / `"…"`      | text verbatim + newline (quotes stripped)                                                             | Same                                                                                                                                                                                                                                                          |
| `echo -n waiting`                                   | `waiting` (no newline)                                                                                | Same                                                                                                                                                                                                                                                          |
| `echo -e 'a\nb'`                                    | `a`, `b` on two lines (escapes interpreted)                                                           | Same (`\n`, `\t`)                                                                                                                                                                                                                                             |
| `echo x > /work/out/a.md` then `cat /work/out/a.md` | file written (truncate); cat reads it back                                                            | The redirect writes through the same seam as `sandbox_write`, so the file is visible and — for the scenarios that declare a written deliverable — judged by the same content predicate                                                                        |
| `>>`                                                | appends                                                                                               | Same                                                                                                                                                                                                                                                          |
| `printf 'a\nb\n'`                                   | `a\nb\n` (escapes ALWAYS interpreted)                                                                 | Same                                                                                                                                                                                                                                                          |
| `printf '%s-%s\n' North 47`                         | `North-47\n`                                                                                          | Same (`%s`/`%d`/`%%`)                                                                                                                                                                                                                                         |
| `printf '%s\n' one two three`                       | `one\ntwo\nthree\n` (format re-runs per argument)                                                     | Same                                                                                                                                                                                                                                                          |
| `printf 'x' a b c`                                  | `x` printed once, extra arguments ignored                                                             | Same                                                                                                                                                                                                                                                          |
| `printf '%q' x` (unsupported directive)             | —                                                                                                     | **Unmodelled → the request path** (judged by the artifact predicate, never failed)                                                                                                                                                                            |
| `mkdir -p /work/out`                                | no output, exit 0                                                                                     | Same (no-op success; a bare `mkdir` too — its real failure shapes are outside the fixture scope)                                                                                                                                                              |
| `python3 - <<'PY' … PY`                             | the script's real stdout (`total 66`, `Saved …`)                                                      | **Not executable in the synthetic layer.** A heredoc line is a producing request: the predicate over command + scripts decides, and a credited run prints the scenario's own captured stdout (`sandboxRun`); an uncredited one ran, exited 0 and left nothing |
| `python3 /work/script.py` (after `sandbox_write`)   | the script's real stdout                                                                              | Same producing-request treatment (pre-existing behaviour, unchanged)                                                                                                                                                                                          |
| `python3 /work/gone.py`                             | —                                                                                                     | `python3: can't open file '…': [Errno 2] No such file or directory`, exit 2 (pre-existing, unchanged)                                                                                                                                                         |

## Segment, pipeline and quoting semantics

- `&&`, `;` and bare newlines separate segments — `&&` stops at the first non-zero exit,
  `;` and newlines carry on and the exit code is the last command's (a no-match `grep`
  exit 1 stops a chain). A segment required by `&&` but missing (leading `;`,
  trailing `&&`, `&& ;`) leaves the modelled set: the whole command is judged as a
  producing request, exactly as before.
- `|` joins stages within a segment; the last stage's stdout is the segment's, unless a
  `>`/`>>` redirect sends it into a file under `/work` (a redirect outside `/work` leaves
  the modelled set).
- Single and double quotes are tokenized (contents verbatim); `#` starts a comment;
  `$`, backticks, escapes and unquoted parens stay refused and send the command to the
  request path — the old character gate, kept for everything the parser cannot read.
- An interpreter stage inside an otherwise-modelled line does not blank the line: the
  modelled stages print what a shell would print, and only the interpreter's own stdout is
  the scenario's captured transcription (or empty when the run produces nothing creditable).

## Not modelled (unchanged), and what they cost

- The stdout of an interpreter run: the synthetic layer cannot execute Python, so a script
  that prints without saving prints nothing here. That is the one fidelity gap the
  calibration did not paper over — inventing script output would be fabrication, and the
  graded path (a run that saves the declared artifact) is covered by the scenario's own
  captured stdout.
- `rm`, `mv`, `cd`, in-place edits of a credited file: production's exit-time `find` /
  `diffWorkFiles` semantics (`work-sync.server.ts:168-177`) — see the module header of
  `synthetic-sandbox.ts`.
- `ls -la` metadata: real output carries mtimes and inode-dependent directory sizes. The
  synthetic layer normalises both (fixed timestamp, fixed directory sizes, `total 8`) — the
  trade the determinism requirement forces, recorded here so no reviewer has to infer it.

## Where the calibration lives in code

- Runner: `app/evals/calibration/run-real.ts` (+ `commands.ts`) — boots the container,
  hydrates the eval's two fixture files into `/work/in`, runs every command above through
  the real `sandbox_bash`, writes `calibration-raw.json`. Run from `app/`:
  `pnpm dlx tsx evals/calibration/run-real.ts`.
- The modelled shell: `app/src/lib/eval-support/synthetic-sandbox.ts` (`tokenize` →
  `parse` → `runSegments` → `inspectOne` per stage).
- The graded side of the contract: `sandboxArgs` in
  `app/src/lib/eval-support/tool-arguments.ts` — the command must run something able to
  produce the declared artifact (an executor, or `cat`/`printf`/`echo` redirected to a
  file); the artifact predicate validates the OUTPUT (the declared artifact named by the
  command or a script it runs — the graders' only view of the output).
- The regression fixtures replaying run 3's captured commands:
  `app/src/__tests__/lib/eval-support/synthetic-sandbox-fixtures.test.ts` (the five
  failing scenarios 09/10/11/14/17, plus a determinism pin).
