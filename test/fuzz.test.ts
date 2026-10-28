// Seeded fuzz tests: random settings files, rules and tool calls through the CLI entry point.
// Every run must return exit code 0, 1 or 2 with no exception, and finish within a time limit, so a hang or a
// regular expression that backtracks without end fails the test instead of stalling CI.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

function rng(seed: number): () => number {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  'Bash', 'Read', 'Edit', 'Write', 'WebFetch', 'mcp__srv__tool', 'mcp__*', 'Agent', '(', ')', '*', '**', ' ', ':*', ':',
  '/', '//', '~/', './', '..', 'domain:', 'git', 'push', 'rm -rf', '&&', '||', ';', '|', '"', "'", '\\', '$(', '`',
  '\n', 'sudo', 'env', 'timeout 5', 'xargs', 'a', 'é', '‮', '\u0000', '{', '}', '[', ']', '#', '=', 'command:',
];

function junk(r: () => number, max: number): string {
  let s = '';
  const n = Math.floor(r() * max) + 1;
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(r() * PIECES.length)];
  return s;
}

const WRONG: unknown[] = [null, true, 7, -1.5, 'x', [], {}, [1, [2]], { a: { b: null } }, ['Bash(*)', 3, null]];

function project(dir: string, settings: unknown, raw?: string): string {
  mkdirSync(path.join(dir, '.claude'), { recursive: true });
  writeFileSync(path.join(dir, '.claude', 'settings.json'), raw ?? JSON.stringify(settings));
  return dir;
}

function timed(argv: string[], limitMs = 2000): { code: number; ms: number } {
  const start = performance.now();
  let code: number;
  try {
    code = run(argv).code;
  } catch (err) {
    throw new Error(`claude-perm-sim ${argv.join(' ')} threw: ${(err as Error).stack}`);
  }
  const ms = performance.now() - start;
  expect(ms, `claude-perm-sim ${JSON.stringify(argv)} took ${ms.toFixed(0)} ms`).toBeLessThan(limitMs);
  return { code, ms };
}

const COMMON = ['--local', 'none', '--user', 'none', '--managed', 'none'];

describe('fuzz', () => {
  it('random rules and calls never throw or hang', () => {
    const r = rng(20261028);
    const base = mkdtempSync(path.join(os.tmpdir(), 'cps-fuzz-'));
    for (let i = 0; i < 150; i++) {
      const rules = () => Array.from({ length: Math.floor(r() * 6) }, () => junk(r, 8));
      const dir = project(path.join(base, `p${i}`), { permissions: { allow: rules(), ask: rules(), deny: rules() } });
      for (const command of ['load', 'bypass', 'lint']) {
        expect([0, 1, 2]).toContain(timed([command, '--project', dir, ...COMMON]).code);
      }
      for (let j = 0; j < 5; j++) {
        const call = junk(r, 10);
        expect([0, 1, 2]).toContain(timed(['explain', call, '--project', dir, ...COMMON]).code);
      }
    }
  }, 120_000);

  it('wrong value types in settings never throw', () => {
    const r = rng(7);
    const base = mkdtempSync(path.join(os.tmpdir(), 'cps-types-'));
    const keys = ['permissions', 'allow', 'ask', 'deny', 'additionalDirectories', 'defaultMode', 'disableBypassPermissionsMode'];
    for (let i = 0; i < 200; i++) {
      const doc: Record<string, unknown> = { permissions: { allow: ['Bash(npm run *)'], deny: ['Read(.env)'] } };
      const perms = doc.permissions as Record<string, unknown>;
      const key = keys[Math.floor(r() * keys.length)];
      const value = WRONG[Math.floor(r() * WRONG.length)];
      if (key === 'permissions') doc.permissions = value;
      else perms[key] = value;
      const dir = project(path.join(base, `p${i}`), doc);
      for (const argv of [['load'], ['bypass'], ['lint'], ['explain', 'Bash(npm run test)']]) {
        expect([0, 1, 2]).toContain(timed([...argv, '--project', dir, ...COMMON]).code);
      }
    }
  }, 120_000);

  it('bad bytes in a settings file are exit code 2 naming the file', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'cps-bytes-'));
    const cases: Record<string, string> = {
      truncated: '{"permissions": {"allow": [',
      array: '[1, 2]',
      deep: '['.repeat(100_000) + ']'.repeat(100_000),
      deepObject: '{"a":'.repeat(50_000) + '1' + '}'.repeat(50_000),
      nul: '\u0000\u0000',
      notUtf8: Buffer.from([0xff, 0xfe, 0x00, 0x7b]).toString('latin1'),
    };
    for (const [name, raw] of Object.entries(cases)) {
      const dir = project(path.join(base, name), undefined, raw);
      const result = run(['load', '--project', dir, ...COMMON]);
      if (name === 'deepObject') {
        // Valid JSON, just deep: either read (no permissions) or refused, never a crash.
        expect([0, 2]).toContain(result.code);
        continue;
      }
      expect(result.code, name).toBe(2);
      expect(result.stderr).toContain('settings.json');
    }
  });

  it('wildcard-heavy rules against long calls finish in time', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'cps-slow-'));
    // Each of these took longer than 10 s before matching stopped using backtracking regular expressions.
    const cases: [string, string][] = [
      ['Bash(' + '*a'.repeat(25) + 'b)', 'Bash(' + 'a'.repeat(3000) + ')'],
      ['Read(' + '**/a'.repeat(20) + '/b)', 'Read(' + 'a/'.repeat(2000) + 'c)'],
      ['mcp__' + '*_'.repeat(20) + 'x', 'mcp__' + '_'.repeat(3000)],
      ['WebFetch(domain:' + '*a'.repeat(15) + 'b)', 'WebFetch(https://' + 'a'.repeat(60) + '/)'],
    ];
    cases.forEach(([rule, call], i) => {
      const dir = project(path.join(base, `p${i}`), { permissions: { allow: [rule], deny: [rule] } });
      expect([0, 1, 2]).toContain(timed(['explain', call, '--project', dir, ...COMMON], 3000).code);
    });
  });
});
