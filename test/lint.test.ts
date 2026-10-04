import { describe, expect, it } from 'vitest';
import { lint } from '../src/lint.js';
import type { Finding } from '../src/types.js';
import { loadFixture } from './helpers.js';

function ids(findings: Finding[]): string[] {
  return findings.map((f) => f.id);
}

describe('lint on a deliberately bad rule set', () => {
  const findings = lint(loadFixture('lint-project'));

  it('flags overly broad allow rules', () => {
    const broad = findings.filter((f) => f.id === 'LINT-BROAD').map((f) => f.rule?.raw);
    expect(broad).toContain('Bash(*)');
    expect(broad).toContain('Edit(**)');
    expect(broad).toContain('mcp__*');
  });

  it('flags a rule that can never match', () => {
    expect(ids(findings)).toContain('LINT-INERT');
  });

  it('flags an allow rule shadowed by a deny', () => {
    const shadow = findings.find((f) => f.id === 'LINT-SHADOW');
    expect(shadow?.rule?.raw).toBe('Bash(git push *)');
  });

  it('flags a duplicate rule', () => {
    expect(ids(findings)).toContain('LINT-DUP');
  });

  it('flags a write-like MCP tool in allow', () => {
    const wrong = findings.find((f) => f.id === 'LINT-WRONG-LIST');
    expect(wrong?.rule?.raw).toBe('mcp__gh__delete_repo');
  });

  it('flags a backslash in a path rule', () => {
    expect(ids(findings)).toContain('LINT-SLASH');
  });

  it('flags the Write path rule as never consulted', () => {
    const inert = findings.filter((f) => f.id === 'LINT-INERT').map((f) => f.rule?.raw);
    expect(inert).toContain('Write(docs/**)');
  });
});

describe('lint on a tight rule set', () => {
  it('produces no findings', () => {
    expect(lint(loadFixture('tight'))).toHaveLength(0);
  });
});

describe('lint severity', () => {
  const findings = lint(loadFixture('lint-project'));
  it('broad rules are high', () => {
    expect(findings.filter((f) => f.id === 'LINT-BROAD').every((f) => f.severity === 'high')).toBe(true);
  });
  it('duplicate rules are low', () => {
    expect(findings.find((f) => f.id === 'LINT-DUP')?.severity).toBe('low');
  });
});
