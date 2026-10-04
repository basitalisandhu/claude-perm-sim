import { describe, expect, it } from 'vitest';
import { lint } from '../src/lint.js';
import { findBypasses } from '../src/probes.js';
import { evaluate } from '../src/engine.js';
import { parseCall } from '../src/call.js';
import { diffRuleSets } from '../src/diff.js';
import { formatDiff, formatExplain, formatFindings, formatLoad, hookSnippet, toSarif } from '../src/format.js';
import { ruleSetFromFile } from '../src/settings.js';
import { fixture, loadFixture } from './helpers.js';

describe('load output', () => {
  const set = loadFixture('tight');
  it('table output lists each list with sources', () => {
    const out = formatLoad(set, 'table');
    expect(out).toContain('deny');
    expect(out).toContain('allow');
    expect(out).toContain('tight');
  });
  it('json output parses and carries the three lists', () => {
    const doc = JSON.parse(formatLoad(set, 'json')) as { permissions: { allow: unknown[]; ask: unknown[]; deny: unknown[] } };
    expect(Array.isArray(doc.permissions.allow)).toBe(true);
    expect(doc.permissions.deny.length).toBeGreaterThan(0);
  });
});

describe('explain output', () => {
  const set = loadFixture('tight');
  it('json names the decision and the deciding rule', () => {
    const v = evaluate(parseCall('Read(.env)'), set);
    const doc = JSON.parse(formatExplain(v, 'json')) as { decision: string; decidedBy: { rule?: string }[] };
    expect(doc.decision).toBe('deny');
    expect(doc.decidedBy[0].rule).toBe('Read(.env)');
  });
  it('table shows the decision line', () => {
    const v = evaluate(parseCall('Edit(src/app.ts)'), set);
    expect(formatExplain(v, 'table')).toContain('decision: allow');
  });
});

describe('findings output', () => {
  const findings = lint(loadFixture('lint-project'));
  it('json lists findings with id and severity', () => {
    const doc = JSON.parse(formatFindings(findings, 'json', 'lint', '0.1.0')) as { findings: { id: string; severity: string }[] };
    expect(doc.findings.length).toBe(findings.length);
    expect(doc.findings[0]).toHaveProperty('severity');
  });
  it('table reports a count', () => {
    expect(formatFindings(findings, 'table', 'lint', '0.1.0')).toContain('finding(s)');
  });
  it('an empty finding list reads cleanly', () => {
    expect(formatFindings([], 'table', 'bypass', '0.1.0')).toBe('bypass: no findings');
  });
});

describe('SARIF output', () => {
  const findings = findBypasses(loadFixture('permissive'), { mcpTools: ['mcp__slack__post'] });
  const doc = JSON.parse(toSarif(findings, '0.1.0')) as {
    version: string;
    runs: { tool: { driver: { name: string; rules: { id: string }[] } }; results: { ruleId: string; level: string; locations: unknown[] }[] }[];
  };
  it('is SARIF 2.1.0 with one run', () => {
    expect(doc.version).toBe('2.1.0');
    expect(doc.runs).toHaveLength(1);
  });
  it('names the driver and declares every rule it reports', () => {
    expect(doc.runs[0].tool.driver.name).toBe('claude-perm-sim');
    const declared = new Set(doc.runs[0].tool.driver.rules.map((r) => r.id));
    for (const res of doc.runs[0].results) expect(declared.has(res.ruleId)).toBe(true);
  });
  it('gives every result a level and a location', () => {
    for (const res of doc.runs[0].results) {
      expect(['error', 'warning', 'note']).toContain(res.level);
      expect(res.locations).toHaveLength(1);
    }
  });
});

describe('hook snippet', () => {
  const doc = JSON.parse(hookSnippet('claude-perm-sim', ['explain', '--format', 'json'])) as {
    hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string; args: string[] }[] }[] };
  };
  it('is a PreToolUse hook in exec form', () => {
    const h = doc.hooks.PreToolUse[0].hooks[0];
    expect(h.type).toBe('command');
    expect(h.command).toBe('claude-perm-sim');
    expect(h.args).toEqual(['explain', '--format', 'json']);
  });
  it('matches every tool', () => {
    expect(doc.hooks.PreToolUse[0].matcher).toBe('*');
  });
});

describe('diff output', () => {
  const a = ruleSetFromFile(fixture('diff-a.json'), fixture('tight'));
  const b = ruleSetFromFile(fixture('diff-b.json'), fixture('tight'));
  const flips = diffRuleSets(a, b);
  it('reports flipped decisions', () => {
    expect(flips.length).toBeGreaterThan(0);
  });
  it('json lists before and after per call', () => {
    const doc = JSON.parse(formatDiff(flips, 'json', 'a', 'b')) as { flips: { before: string; after: string }[] };
    expect(doc.flips[0]).toHaveProperty('before');
    expect(doc.flips[0]).toHaveProperty('after');
  });
  it('an identical pair reports no change', () => {
    const same = diffRuleSets(a, a);
    expect(formatDiff(same, 'table', 'a', 'a')).toContain('no decisions change');
  });
});
