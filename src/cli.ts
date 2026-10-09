#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCall, CallError } from './call.js';
import { diffRuleSets } from './diff.js';
import { evaluate } from './engine.js';
import {
  formatDiff,
  formatExplain,
  formatFindings,
  formatLoad,
  hookSnippet,
  type Format,
} from './format.js';
import { lint } from './lint.js';
import { findBypasses, type BypassContext } from './probes.js';
import { loadRuleSet, ruleSetFromFile, SettingsError, type LoadOptions } from './settings.js';
import { SEVERITY_RANK, type Severity } from './types.js';

export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const USAGE = `Usage: claude-perm-sim <command> [options]

Load your merged Claude Code permission settings, see which rule decides a tool call,
and find where the rules are more permissive than they look.

Commands:
  load                     Print the effective allow, ask and deny lists with each rule's source
  explain "<tool call>"    Show the decision for one call and the rule and file that decided it
  bypass                   Report where an allow rule admits more than it names (structural, no attacks)
  lint                     Static checks: duplicates, shadowed allows, broad patterns, dead rules
  diff <a.json> <b.json>   Show which sample decisions change between two settings files

Settings sources (override the files that are read):
  --project <dir>          Project directory (default: current directory)
  --user <file|none>       User settings file (default: ~/.claude/settings.json)
  --local <file|none>      Local settings file (default: <project>/.claude/settings.local.json)
  --managed <file|none>    Managed settings file (default: the platform path, when present)
  --settings <file>        Extra settings file, applied above local (repeatable)
  --allow-tool <rule>      Add a command-line allow rule (repeatable)
  --deny-tool <rule>       Add a command-line deny rule (repeatable)
  --untrusted              Model a folder whose workspace trust was not accepted

Options:
  --mode <mode>            Explicit simulation mode: default (default), acceptEdits
  --format <fmt>           table (default), json, sarif, hook
  --mcp-tool <name>        Known MCP tool to check coverage of in bypass (repeatable)
  --mcp-from <file>        Read MCP server names from a .mcp.json for bypass coverage
  --fail-on <severity>     Exit 1 when a finding is at or above this severity (default: high)
  --exe <cmd>              Command used in the --format hook snippet (default: claude-perm-sim)
  -h, --help               Show this help
  -V, --version            Show the version

Exit codes: 0 success, 1 findings at or above --fail-on (bypass, lint), 2 usage or settings error.
`;

export class UsageError extends Error {}

export interface CliOptions {
  command?: string;
  positionals: string[];
  load: LoadOptions;
  format: Format;
  mode: 'default' | 'acceptEdits';
  mcpTools: string[];
  mcpFrom?: string;
  failOn: Severity;
  exe: string;
  help: boolean;
  version: boolean;
}

function takeValue(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined) throw new UsageError(`${flag} needs a value`);
  return v;
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    positionals: [],
    load: { project: process.cwd(), settings: [], allowedTools: [], disallowedTools: [] },
    format: 'table',
    mode: 'default',
    mcpTools: [],
    failOn: 'high',
    exe: 'claude-perm-sim',
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline: string | undefined;
    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const val = (): string => {
      if (inline !== undefined) return inline;
      return takeValue(argv, i++, arg);
    };
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-V':
      case '--version':
        opts.version = true;
        break;
      case '--project':
        opts.load.project = val();
        break;
      case '--user':
        opts.load.user = val();
        break;
      case '--local':
        opts.load.local = val();
        break;
      case '--managed':
        opts.load.managed = val();
        break;
      case '--settings':
        opts.load.settings!.push(val());
        break;
      case '--allow-tool':
        opts.load.allowedTools!.push(val());
        break;
      case '--deny-tool':
        opts.load.disallowedTools!.push(val());
        break;
      case '--untrusted':
        opts.load.untrusted = true;
        break;
      case '--format': {
        const f = val();
        if (!['table', 'json', 'sarif', 'hook'].includes(f)) throw new UsageError(`unknown format: ${f}`);
        opts.format = f as Format;
        break;
      }
      case '--mode': {
        const mode = val();
        if (mode !== 'default' && mode !== 'acceptEdits') throw new UsageError(`unknown mode: ${mode}`);
        opts.mode = mode;
        break;
      }
      case '--mcp-tool':
        opts.mcpTools.push(val());
        break;
      case '--mcp-from':
        opts.mcpFrom = val();
        break;
      case '--fail-on': {
        const s = val();
        if (!['high', 'medium', 'low', 'info'].includes(s)) throw new UsageError(`unknown severity: ${s}`);
        opts.failOn = s as Severity;
        break;
      }
      case '--exe':
        opts.exe = val();
        break;
      default:
        if (arg.startsWith('-')) throw new UsageError(`unknown argument: ${arg}`);
        if (opts.command === undefined) opts.command = arg;
        else opts.positionals.push(arg);
    }
  }
  return opts;
}

function mcpContext(opts: CliOptions): BypassContext {
  const servers: string[] = [];
  if (opts.mcpFrom) {
    try {
      const doc = JSON.parse(readFileSync(opts.mcpFrom, 'utf8')) as { mcpServers?: Record<string, unknown> };
      if (doc.mcpServers) servers.push(...Object.keys(doc.mcpServers));
    } catch (err) {
      throw new UsageError(`cannot read --mcp-from ${opts.mcpFrom}: ${(err as Error).message}`);
    }
  }
  return { mcpServers: servers, mcpTools: opts.mcpTools };
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function run(argv: string[]): RunResult {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return { stdout: '', stderr: `${(err as Error).message}\n\n${USAGE}`, code: 2 };
  }
  if (opts.version) return { stdout: `${VERSION}\n`, stderr: '', code: 0 };
  if (opts.help) return { stdout: USAGE, stderr: '', code: 0 };
  if (opts.command === undefined) return { stdout: USAGE, stderr: '', code: 2 };
  if (opts.format === 'hook') {
    return { stdout: hookSnippet(opts.exe, ['explain', '--format', 'json']) + '\n', stderr: '', code: 0 };
  }

  try {
    const load = () => ({ ...loadRuleSet(opts.load), mode: opts.mode });
    switch (opts.command) {
      case 'load': {
        const set = load();
        return { stdout: formatLoad(set, opts.format) + '\n', stderr: '', code: 0 };
      }
      case 'explain': {
        if (opts.positionals.length === 0) throw new UsageError('explain needs a tool call, for example explain "Edit(src/app.ts)"');
        const set = load();
        const call = parseCall(opts.positionals.join(' '));
        const verdict = evaluate(call, set);
        return { stdout: formatExplain(verdict, opts.format) + '\n', stderr: '', code: 0 };
      }
      case 'bypass': {
        const set = load();
        const findings = findBypasses(set, mcpContext(opts));
        const out = formatFindings(findings, opts.format, 'bypass', VERSION);
        const code = exitForFindings(findings.map((f) => f.severity), opts.failOn);
        return { stdout: out + '\n', stderr: '', code };
      }
      case 'lint': {
        const set = load();
        const findings = lint(set);
        const out = formatFindings(findings, opts.format, 'lint', VERSION);
        const code = exitForFindings(findings.map((f) => f.severity), opts.failOn);
        return { stdout: out + '\n', stderr: '', code };
      }
      case 'diff': {
        if (opts.command === 'diff' && opts.positionals.length < 2) throw new UsageError('diff needs two settings files: diff a.json b.json');
        const [aFile, bFile] = opts.positionals;
        for (const f of [aFile, bFile]) if (!existsSync(f)) throw new SettingsError(`settings file not found: ${f}`);
        const a = ruleSetFromFile(aFile, opts.load.project, opts.load.home);
        const b = ruleSetFromFile(bFile, opts.load.project, opts.load.home);
        a.mode = opts.mode;
        b.mode = opts.mode;
        const flips = diffRuleSets(a, b);
        return { stdout: formatDiff(flips, opts.format, path.basename(aFile), path.basename(bFile)) + '\n', stderr: '', code: 0 };
      }
      default:
        return { stdout: '', stderr: `unknown command: ${opts.command}\n\n${USAGE}`, code: 2 };
    }
  } catch (err) {
    if (err instanceof UsageError) return { stdout: '', stderr: `${err.message}\n\n${USAGE}`, code: 2 };
    if (err instanceof SettingsError || err instanceof CallError) return { stdout: '', stderr: `error: ${err.message}\n`, code: 2 };
    throw err;
  }
}

function exitForFindings(severities: Severity[], failOn: Severity): number {
  const threshold = SEVERITY_RANK[failOn];
  return severities.some((s) => SEVERITY_RANK[s] >= threshold) ? 1 : 0;
}

function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    // argv[1] is a symlink under node_modules/.bin when installed through npm
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const result = run(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
