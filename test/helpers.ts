import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuleSet, type LoadOptions } from '../src/settings.js';
import { evaluate } from '../src/engine.js';
import { parseCall } from '../src/call.js';
import type { Decision, RuleSet } from '../src/types.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const FIXTURES = path.join(ROOT, 'test', 'fixtures');
export const CLI = path.join(ROOT, 'dist', 'cli.js');

export function fixture(...parts: string[]): string {
  return path.join(FIXTURES, ...parts);
}

/** A rule set loaded from a fixture project, with only the files we name read. */
export function loadFixture(name: string, extra: Partial<LoadOptions> = {}): RuleSet {
  return loadRuleSet({
    project: fixture(name),
    local: 'none',
    user: 'none',
    managed: 'none',
    home: fixture('home'),
    ...extra,
  });
}

/** Decide a call written in rule form (e.g. "Bash(ls)") against a rule set. */
export function decide(set: RuleSet, call: string): Decision {
  return evaluate(parseCall(call), set).decision;
}

export interface CliRun {
  stdout: string;
  stderr: string;
  code: number;
}

/** Spawn the built CLI, for exit-code and end-to-end checks. */
export function runCli(args: string[]): Promise<CliRun> {
  return new Promise((resolve) => {
    execFile('node', [CLI, ...args], { env: { ...process.env } }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 0;
      resolve({ stdout, stderr, code });
    });
  });
}
