// Scaling test: load, lint and bypass on 2,000 and 20,000 rules. Linear growth gives about 10 times the
// runtime for 10 times the rules; the duplicate check used to compare every pair (quadratic).
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { run } from '../src/cli.js';

function project(n: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cps-scale-'));
  mkdirSync(path.join(dir, '.claude'));
  const allow: string[] = [];
  const deny: string[] = [];
  for (let i = 0; i < n / 4; i++) {
    allow.push(`mcp__s${i}__read`, `Edit(src/m${i}/**)`, `WebFetch(domain:d${i}.example.com)`);
    deny.push(`Read(secret${i}/**)`);
  }
  allow.push('mcp__s0__read'); // one duplicate
  writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow, deny } }));
  return dir;
}

function time(dir: string): number {
  const start = performance.now();
  for (const command of ['load', 'lint', 'bypass']) {
    const result = run([command, '--project', dir, '--local', 'none', '--user', 'none', '--managed', 'none']);
    expect([0, 1]).toContain(result.code);
  }
  return performance.now() - start;
}

it('load, lint and bypass grow linearly with the number of rules', () => {
  const small = time(project(2_000));
  const big = time(project(20_000));
  expect(big, `2,000 rules: ${small.toFixed(0)} ms, 20,000 rules: ${big.toFixed(0)} ms`).toBeLessThan(Math.max(small, 20) * 30);
});
