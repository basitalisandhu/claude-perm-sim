import { escapeRegex } from './rules.js';
import type { SimpleCommand } from './shell.js';

/**
 * Leading environment assignments an allow rule may match past. The docs say "certain known-safe
 * environment variables" without listing them; this list is inferred and kept short.
 */
export const SAFE_ENV_VARS = new Set([
  'NODE_ENV',
  'CI',
  'DEBUG',
  'LANG',
  'LC_ALL',
  'TZ',
  'NO_COLOR',
  'FORCE_COLOR',
  'RUST_BACKTRACE',
  'RUST_LOG',
  'PYTHONUNBUFFERED',
  'TERM',
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export interface Stripped {
  /** Text Claude Code matches rules against, after wrappers and assignments are removed. */
  text: string;
  /** Program name (first word after stripping). */
  program: string;
  words: string[];
  /** Wrappers and assignments that were removed, for explanations. */
  removed: string[];
}

/** Number of leading words a documented wrapper occupies, or 0 when the word is not a stripped wrapper. */
function wrapperLength(words: string[], k: number): number {
  const w = words[k];
  const next = words[k + 1];
  switch (w) {
    case 'nohup':
    case 'builtin':
    case 'noglob':
      return 1;
    case 'time': {
      let n = 1;
      while (words[k + n] === '-p') n++;
      return n;
    }
    case 'command':
      if (next === '-v' || next === '-V') return 0; // query form, not stripped
      return next === '-p' ? 2 : 1;
    case 'xargs':
      return next !== undefined && next.startsWith('-') ? 0 : 1;
    case 'nice': {
      let n = 1;
      while (words[k + n] !== undefined && words[k + n].startsWith('-')) {
        const opt = words[k + n];
        n += opt === '-n' || opt === '--adjustment' ? 2 : 1;
      }
      return n;
    }
    case 'stdbuf': {
      let n = 1;
      while (words[k + n] !== undefined && words[k + n].startsWith('-')) {
        const opt = words[k + n];
        n += /^-[ioe]$/.test(opt) ? 2 : 1;
      }
      return n;
    }
    case 'timeout': {
      let n = 1;
      while (words[k + n] !== undefined && words[k + n].startsWith('-')) {
        const opt = words[k + n];
        n += opt === '-s' || opt === '-k' || opt === '--signal' || opt === '--kill-after' ? 2 : 1;
      }
      return words[k + n] !== undefined ? n + 1 : 0; // the duration
    }
    default:
      return 0;
  }
}

/**
 * Strip the documented wrappers (`timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`,
 * `noglob`, bare `xargs`) and leading assignments. For allow rules only known-safe assignments are
 * stripped; for deny and ask rules every leading assignment is.
 */
export function stripCommand(cmd: SimpleCommand, forAllow: boolean): Stripped {
  const removed: string[] = [];
  let k = 0;
  for (;;) {
    let progressed = false;
    while (k < cmd.words.length && ASSIGNMENT.test(cmd.words[k])) {
      const name = cmd.words[k].slice(0, cmd.words[k].indexOf('='));
      if (forAllow && !SAFE_ENV_VARS.has(name)) break;
      removed.push(cmd.words[k]);
      k++;
      progressed = true;
    }
    const n = k < cmd.words.length ? wrapperLength(cmd.words, k) : 0;
    if (n > 0 && k + n < cmd.words.length) {
      removed.push(cmd.words.slice(k, k + n).join(' '));
      k += n;
      progressed = true;
    }
    if (!progressed) break;
  }
  if (k >= cmd.words.length) return { text: '', program: '', words: [], removed };
  const text = cmd.source.slice(cmd.starts[k], cmd.ends[cmd.ends.length - 1]).trim();
  return { text, program: cmd.words[k], words: cmd.words.slice(k), removed };
}

/** True when a Bash rule specifier matches the command text. */
export function bashPatternMatches(specifier: string, text: string): boolean {
  let spec = specifier;
  if (spec === '*') return true;
  if (spec.endsWith(':*')) spec = spec.slice(0, -2) + ' *';
  const stars = spec.split('*').length - 1;
  if (stars === 0) return spec === text;
  const re = new RegExp('^' + spec.split('*').map(escapeRegex).join('[\\s\\S]*') + '$');
  if (re.test(text)) return true;
  // A trailing " *" that is the only wildcard also matches the bare command.
  return stars === 1 && spec.endsWith(' *') && text === spec.slice(0, -2);
}

/** Literal text before the first `*`, with the `:*` suffix normalised. */
export function bashPrefix(specifier: string): string {
  const spec = specifier.endsWith(':*') ? specifier.slice(0, -2) + ' *' : specifier;
  const star = spec.indexOf('*');
  return (star < 0 ? spec : spec.slice(0, star)).trim();
}

/**
 * Programs Claude Code treats as read-only. The docs list `ls`, `cat`, `echo`, `pwd`, `head`, `tail`,
 * `grep`, `find`, `wc`, `which`, `diff`, `stat`, `du`, `cd` and read-only forms of `git`, and say the set
 * includes these; the full built-in set is longer and not published.
 */
const READ_ONLY = new Set(['ls', 'cat', 'echo', 'pwd', 'head', 'tail', 'grep', 'find', 'wc', 'which', 'diff', 'stat', 'du', 'cd']);
const GIT_READ_ONLY = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'blame', 'ls-files', 'describe', 'shortlog']);

/** Returns a reason when the stripped command is a documented read-only command, otherwise undefined. */
export function readOnlyReason(s: Stripped): string | undefined {
  if (s.program === 'find') {
    if (s.words.some((w) => w === '-exec' || w === '-execdir' || w === '-delete' || w === '-ok')) return undefined;
    return 'built-in read-only command (find)';
  }
  if (s.program === 'git') {
    // Any global option before the subcommand (-c, -C, --git-dir) is not treated as read-only here.
    const sub = s.words[1];
    if (sub !== undefined && GIT_READ_ONLY.has(sub)) {
      if (s.words.some((w) => w.startsWith('--output') || w === '--ext-diff' || w.startsWith('--exec'))) return undefined;
      return `built-in read-only command (git ${sub})`;
    }
    return undefined;
  }
  if (READ_ONLY.has(s.program)) return `built-in read-only command (${s.program})`;
  return undefined;
}

/** Bash file commands whose path arguments Claude Code checks against Read rules. */
export const READ_FILE_COMMANDS = new Set(['cat', 'head', 'tail', 'sed']);

/** Path arguments of a recognised file command (non-option words after the program). */
export function fileArguments(s: Stripped): { read: string[]; write: string[] } {
  const read: string[] = [];
  const write: string[] = [];
  const args = s.words.slice(1);
  if (s.program === 'tee') {
    for (const a of args) if (!a.startsWith('-')) write.push(a);
    return { read, write };
  }
  if (!READ_FILE_COMMANDS.has(s.program)) return { read, write };
  let skipNext = false;
  let sawScript = s.program !== 'sed';
  for (const a of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (a.startsWith('-')) {
      if (/^-[nce]$/.test(a)) skipNext = true;
      if (s.program === 'sed' && a === '-e') sawScript = true;
      continue;
    }
    if (!sawScript) {
      sawScript = true; // first non-option argument of sed is the script
      continue;
    }
    read.push(a);
  }
  return { read, write };
}

/** Programs that run another program, a script or code given in their arguments. */
export const EXEC_CAPABLE = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'env',
  'eval',
  'exec',
  'source',
  '.',
  'python',
  'python3',
  'node',
  'deno',
  'bun',
  'ruby',
  'perl',
  'php',
  'npx',
  'bunx',
  'uvx',
  'pipx',
  'xargs',
  'find',
  'watch',
  'setsid',
  'sudo',
  'doas',
  'su',
  'ssh',
  'awk',
  'docker',
  'podman',
  'kubectl',
  'direnv',
  'devbox',
  'mise',
  'make',
]);

/** Runner forms of common tools that execute an arbitrary package or script. */
const EXEC_PREFIXES = ['npm exec', 'npm x', 'pnpm exec', 'pnpm dlx', 'yarn dlx', 'yarn exec', 'git -c', 'docker run', 'docker exec', 'uv run', 'poetry run', 'cargo run', 'go run'];

/** True when a Bash allow rule prefix lets the trailing wildcard choose the program or the code that runs. */
export function isExecCapablePrefix(prefix: string): boolean {
  const p = prefix.trim();
  if (p === '') return true;
  const program = p.split(/\s+/)[0];
  if (EXEC_CAPABLE.has(program) && p.split(/\s+/).length === 1) return true;
  if (program === 'git' && p.split(/\s+/).length === 1) return true;
  return EXEC_PREFIXES.some((e) => p === e || p.startsWith(e + ' '));
}
