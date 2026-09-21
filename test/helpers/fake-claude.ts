import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpDir } from './tmp.js';

/**
 * Fake `claude` CLI for tests.
 *
 * The orchestrator spawns `claude -p <prompt> --permission-mode ...` and the
 * prompt interpolates the task body verbatim, so a task body drives the fake
 * through `FAKE:` directive lines. Directives must start at COLUMN 0 — the
 * enhance-task prompt re-embeds user task bodies indented by two spaces, and
 * the "Prior attempt context" block indents deferDetail; column-0 matching
 * keeps those copies inert.
 *
 *   FAKE: write <path>              write a small file at <path> (cwd-relative), print a line
 *   FAKE: append <path> <text>      append <text> + newline to <path>
 *   FAKE: writeln <path> <text>     write <text> + newline to <path>, truncating it (one-line file)
 *   FAKE: require <path>            exit 2 immediately if <path> is missing (dependency ordering)
 *   FAKE: mark <label>              append <label> to $FAKE_CLAUDE_MARKS (invocation order)
 *   FAKE: echo <text>               print <text> to stdout verbatim
 *   FAKE: stderr <text>             print <text> to stderr
 *   FAKE: defer because <reason>    end stdout with `FULLAUTO_RESULT: DEFER <reason>`
 *   FAKE: defer                     end stdout with a bare `FULLAUTO_RESULT: DEFER`
 *   FAKE: exit <code>               exit with <code> after all other directives ran
 *   FAKE: sleep <seconds>           sleep (SIGTERM-aware, so timeouts kill it promptly)
 *   FAKE: once <key> <directive>    run <directive> only the first time <key> is seen
 *                                   (stamp files live in $FAKE_CLAUDE_STATE_DIR)
 *   FAKE: nth <key> <n> <directive> run <directive> only on the n-th invocation that
 *                                   mentions <key> (counter files in $FAKE_CLAUDE_STATE_DIR;
 *                                   one increment per invocation, however many lines use the key)
 *   FAKE: copyfile <src> <dst>      copy an absolute <src> to cwd-relative <dst> (mkdir -p)
 *   FAKE: env-write <VAR> <dst>     write the value of env var <VAR> to <dst> (mkdir -p)
 *   FAKE: rate-limit                print a realistic rate-limit error to stderr, exit 1
 *                                   (combine with `once` / `nth` to rate-limit only the
 *                                   first N invocations, then let a later retry succeed)
 *
 * Prompts the tests do not author (planner / evolve shape / evolve assess)
 * carry no `FAKE:` lines, so the fake also accepts a SCRIPT FILE per prompt
 * kind: when $FAKE_CLAUDE_SCRIPT_DIR is set and `<dir>/<slug>.fake` exists —
 * <slug> = the prompt's first line (its `# H1`) lowercased with non-alphanumerics
 * collapsed to `-` — its lines are processed as directives BEFORE the prompt's
 * own lines. `FakeClaude.script(h1, body)` writes such a file.
 *
 * Every invocation appends the full prompt to $FAKE_CLAUDE_LOG (if set)
 * between `===== FAKE CLAUDE PROMPT =====` / `===== END PROMPT =====` lines.
 */
// `@{` is a sentinel for bash's `${` (a literal `${` would start a JS template
// interpolation); it is swapped back when the script is written to disk.
const SCRIPT_TEMPLATE = String.raw`#!/usr/bin/env bash
# Fake claude CLI written by test/helpers/fake-claude.ts — see that file.
set -u

prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p|--print)
      shift
      prompt="@{1:-}"
      ;;
    *)
      ;;
  esac
  [ $# -gt 0 ] && shift
done

if [ -n "@{FAKE_CLAUDE_LOG:-}" ]; then
  {
    printf '===== FAKE CLAUDE PROMPT =====\n'
    printf '%s\n' "$prompt"
    printf '===== END PROMPT =====\n'
  } >> "$FAKE_CLAUDE_LOG"
fi

state_dir="@{FAKE_CLAUDE_STATE_DIR:-@{TMPDIR:-/tmp}}"
exit_code=0
defer_marker=""

sleep_pid=""
on_term() {
  if [ -n "$sleep_pid" ]; then kill "$sleep_pid" 2>/dev/null; fi
  exit 143
}
trap on_term TERM INT

echo "fake-claude: starting"

# Keys whose nth counter was already bumped by THIS invocation.
nth_seen=" "

run_directives() {
  local text="$1"
  while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    "FAKE: "*) ;;
    *) continue ;;
  esac
  directive="@{line#FAKE: }"

  case "$directive" in
    once\ *)
      rest="@{directive#once }"
      key="@{rest%% *}"
      directive="@{rest#* }"
      stamp="$state_dir/fake-claude-once-$key"
      if [ -e "$stamp" ]; then
        echo "fake-claude: once($key) already consumed, skipping: $directive"
        continue
      fi
      : > "$stamp"
      ;;
    nth\ *)
      rest="@{directive#nth }"
      key="@{rest%% *}"
      rest="@{rest#* }"
      n="@{rest%% *}"
      directive="@{rest#* }"
      counter="$state_dir/fake-claude-nth-$key"
      case "$nth_seen" in
        *" $key "*) ;;
        *)
          cur=0
          [ -e "$counter" ] && cur="$(cat "$counter")"
          cur=$((cur + 1))
          printf '%s' "$cur" > "$counter"
          nth_seen="$nth_seen$key "
          ;;
      esac
      cur="$(cat "$counter")"
      if [ "$cur" != "$n" ]; then
        echo "fake-claude: nth($key)=$cur, not $n, skipping: $directive"
        continue
      fi
      ;;
  esac

  case "$directive" in
    copyfile\ *)
      rest="@{directive#copyfile }"
      src="@{rest%% *}"
      dst="@{rest#* }"
      mkdir -p "$(dirname "$dst")"
      cp "$src" "$dst"
      echo "fake-claude: copied $src -> $dst"
      ;;
    env-write\ *)
      rest="@{directive#env-write }"
      var="@{rest%% *}"
      dst="@{rest#* }"
      mkdir -p "$(dirname "$dst")"
      printf '%s' "@{!var:-}" > "$dst"
      echo "fake-claude: wrote \$$var -> $dst"
      ;;
    write\ *)
      path="@{directive#write }"
      mkdir -p "$(dirname "$path")"
      printf '// written by fake claude: %s\n' "$path" > "$path"
      echo "fake-claude: wrote $path"
      ;;
    append\ *)
      rest="@{directive#append }"
      path="@{rest%% *}"
      text="@{rest#* }"
      mkdir -p "$(dirname "$path")"
      printf '%s\n' "$text" >> "$path"
      echo "fake-claude: appended to $path"
      ;;
    writeln\ *)
      rest="@{directive#writeln }"
      path="@{rest%% *}"
      text="@{rest#* }"
      mkdir -p "$(dirname "$path")"
      printf '%s\n' "$text" > "$path"
      echo "fake-claude: wrote line to $path"
      ;;
    require\ *)
      path="@{directive#require }"
      if [ ! -e "$path" ]; then
        echo "fake-claude: required file missing: $path" >&2
        exit 2
      fi
      echo "fake-claude: required file present: $path"
      ;;
    mark\ *)
      label="@{directive#mark }"
      if [ -n "@{FAKE_CLAUDE_MARKS:-}" ]; then
        printf '%s\n' "$label" >> "$FAKE_CLAUDE_MARKS"
      fi
      echo "fake-claude: mark $label"
      ;;
    echo\ *)
      printf '%s\n' "@{directive#echo }"
      ;;
    stderr\ *)
      printf '%s\n' "@{directive#stderr }" >&2
      ;;
    rate-limit)
      printf '%s\n' 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your rate limit. resets at 3:45pm"}}' >&2
      echo "fake-claude: rate-limit"
      exit_code=1
      ;;
    defer\ because\ *)
      defer_marker="FULLAUTO_RESULT: DEFER @{directive#defer because }"
      ;;
    defer)
      defer_marker="FULLAUTO_RESULT: DEFER"
      ;;
    exit\ *)
      exit_code="@{directive#exit }"
      ;;
    sleep\ *)
      secs="@{directive#sleep }"
      sleep "$secs" >/dev/null 2>&1 &
      sleep_pid=$!
      wait "$sleep_pid"
      sleep_pid=""
      ;;
    *)
      echo "fake-claude: unknown directive: $directive" >&2
      ;;
  esac
  done <<< "$text"
}

if [ -n "@{FAKE_CLAUDE_SCRIPT_DIR:-}" ]; then
  h1="@{prompt%%$'\n'*}"
  h1="@{h1#\#}"
  slug="$(printf '%s' "$h1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  script_file="$FAKE_CLAUDE_SCRIPT_DIR/$slug.fake"
  if [ -f "$script_file" ]; then
    echo "fake-claude: running script $script_file"
    run_directives "$(cat "$script_file")"
  fi
fi
run_directives "$prompt"

echo "fake-claude: finished"
if [ -n "$defer_marker" ]; then
  printf '%s\n' "$defer_marker"
fi
exit "$exit_code"
`;
const SCRIPT = SCRIPT_TEMPLATE.replaceAll('@{', '${');


/** Same slug the bash script derives from a prompt's first line. */
export function promptSlug(h1: string): string {
  return h1
    .replace(/^#/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface FakeClaude {
  /** Directory containing the executable `claude` script. */
  binDir: string;
  /** Path to the executable itself. */
  scriptPath: string;
  /** Where every prompt is appended (FAKE_CLAUDE_LOG). */
  logPath: string;
  /** Where `FAKE: mark <label>` lines are appended (FAKE_CLAUDE_MARKS). */
  marksPath: string;
  /** Stamp dir for `FAKE: once` / `FAKE: nth` (FAKE_CLAUDE_STATE_DIR). */
  stateDir: string;
  /** Script files per prompt kind (FAKE_CLAUDE_SCRIPT_DIR); see `script()`. */
  scriptDir: string;
  /** `PATH` value that puts the fake first, followed by the current PATH. */
  pathPrefix: string;
  /** Env vars to merge into process.env before running the orchestrator. */
  env: Record<string, string>;
  /** Apply `env` to process.env; returns a restore function. */
  install(): () => void;
  /** All prompts logged so far, in invocation order. */
  prompts(): Promise<string[]>;
  /** All `mark` labels so far, in invocation order. */
  marks(): Promise<string[]>;
  /**
   * Install a directive script for every prompt whose first line is `h1`
   * (e.g. `# Task Decomposition Job`). Lines are `FAKE:` directives, run
   * before the prompt's own lines.
   */
  script(h1: string, body: string): Promise<void>;
  /** Clear log / marks / once-stamps / scripts between tests. */
  reset(): Promise<void>;
  /** Remove the temp bin dir. */
  dispose(): Promise<void>;
}

/**
 * Write the fake `claude` into a fresh temp bin dir and return handles for
 * putting it first on PATH plus reading back what it saw.
 */
export async function makeFakeClaude(): Promise<FakeClaude> {
  const root = await makeTmpDir('fake-claude-');
  const binDir = join(root, 'bin');
  const stateDir = join(root, 'state');
  const scriptDir = join(root, 'scripts');
  await mkdir(binDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(scriptDir, { recursive: true });
  const scriptPath = join(binDir, 'claude');
  await writeFile(scriptPath, SCRIPT, 'utf-8');
  await chmod(scriptPath, 0o755);

  const logPath = join(root, 'prompts.log');
  const marksPath = join(root, 'marks.log');
  const pathPrefix = `${binDir}:${process.env.PATH ?? ''}`;
  const env: Record<string, string> = {
    PATH: pathPrefix,
    FAKE_CLAUDE_LOG: logPath,
    FAKE_CLAUDE_MARKS: marksPath,
    FAKE_CLAUDE_STATE_DIR: stateDir,
    FAKE_CLAUDE_SCRIPT_DIR: scriptDir,
  };

  const readLines = async (p: string): Promise<string[]> => {
    if (!existsSync(p)) return [];
    const raw = await readFile(p, 'utf-8');
    return raw.split('\n').filter((l) => l.length > 0);
  };

  return {
    binDir,
    scriptPath,
    logPath,
    marksPath,
    stateDir,
    scriptDir,
    pathPrefix,
    env,
    install() {
      const saved: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(env)) {
        saved[k] = process.env[k];
        process.env[k] = v;
      }
      return () => {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      };
    },
    async prompts() {
      if (!existsSync(logPath)) return [];
      const raw = await readFile(logPath, 'utf-8');
      const out: string[] = [];
      const re =
        /===== FAKE CLAUDE PROMPT =====\n([\s\S]*?)\n===== END PROMPT =====\n/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null) out.push(m[1]);
      return out;
    },
    marks: () => readLines(marksPath),
    async script(h1, body) {
      await writeFile(join(scriptDir, `${promptSlug(h1)}.fake`), body.endsWith('\n') ? body : `${body}\n`, 'utf-8');
    },
    async reset() {
      await rm(logPath, { force: true });
      await rm(marksPath, { force: true });
      await rm(stateDir, { recursive: true, force: true });
      await mkdir(stateDir, { recursive: true });
      await rm(scriptDir, { recursive: true, force: true });
      await mkdir(scriptDir, { recursive: true });
    },
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
