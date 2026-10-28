import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { findBypasses } from '../src/probes.js';
import type { Finding } from '../src/types.js';
import { fixture, loadFixture } from './helpers.js';

function ids(findings: Finding[]): string[] {
  return findings.map((f) => f.id);
}

describe('bypass is structural and never prints an executable example', () => {
  const findings = findBypasses(loadFixture('permissive'), { mcpTools: ['mcp__slack__post_message'] });

  it('flags a prefix that runs an arbitrary inner command', () => {
    expect(ids(findings)).toContain('BYP-BASH-EXEC-RUNNER');
  });

  it('flags a subdomain wildcard', () => {
    const f = findings.find((x) => x.id === 'BYP-WEB-SUBDOMAIN');
    expect(f).toBeDefined();
    expect(f!.rule?.raw).toBe('WebFetch(domain:*.example.com)');
  });

  it('flags a mid-label domain wildcard as admitting lookalikes', () => {
    expect(ids(findings)).toContain('BYP-WEB-MIDWILDCARD');
  });

  it('flags a server wildcard MCP rule', () => {
    expect(ids(findings)).toContain('BYP-MCP-WILDCARD');
  });

  it('flags an uncovered MCP tool', () => {
    const f = findings.find((x) => x.id === 'BYP-MCP-UNCOVERED');
    expect(f?.severity).toBe('info');
  });

  it('flags a path scope that reaches above its directory', () => {
    const f = findings.find((x) => x.id === 'BYP-PATH-PARENT');
    expect(f).toBeDefined();
    expect(f!.rule?.raw).toBe('Edit(../shared/**)');
  });

  it('names a tighter rule in every suggestion', () => {
    for (const f of findings) expect(f.suggestion && f.suggestion.length).toBeTruthy();
  });

  it('never includes a runnable payload', () => {
    const text = JSON.stringify(findings);
    expect(text).not.toMatch(/curl\s+-/);
    expect(text).not.toMatch(/\|\s*sh\b/);
    expect(text).not.toContain('rm -rf');
    expect(text).not.toMatch(/https?:\/\/[a-z0-9.-]+\.(sh|com|org|net)\//i);
  });

  it('uses inert placeholders only', () => {
    const withPlaceholders = findings.filter((f) => f.probe?.includes('<'));
    expect(withPlaceholders.length).toBeGreaterThan(0);
  });
});

describe('a tight rule set produces no high bypass findings', () => {
  const findings = findBypasses(loadFixture('tight'), { mcpTools: ['mcp__github__get_issue', 'mcp__github__create_issue'] });

  it('has no high or medium findings', () => {
    expect(findings.filter((f) => f.severity === 'high' || f.severity === 'medium')).toHaveLength(0);
  });

  it('does not flag an exact bash rule', () => {
    expect(ids(findings)).not.toContain('BYP-BASH-EXEC-RUNNER');
  });

  it('does not flag an exact domain rule', () => {
    expect(ids(findings)).not.toContain('BYP-WEB-SUBDOMAIN');
  });

  it('does not flag covered MCP tools', () => {
    expect(ids(findings)).not.toContain('BYP-MCP-UNCOVERED');
  });
});

describe('bypass severity classes', () => {
  it('a bare Bash allow is high', () => {
    const findings = findBypasses(loadFixture('lint-project'));
    expect(findings.find((f) => f.id === 'BYP-BASH-ALL')?.severity).toBe('high');
  });
  it('a wildcard-at-start Bash allow is high', () => {
    const set = loadFixture('tight', { allowedTools: ['Bash(* --version)'] });
    const findings = findBypasses(set);
    expect(findings.find((f) => f.id === 'BYP-BASH-LEADING-STAR')?.severity).toBe('high');
  });
  it('a domain:* allow is high', () => {
    const set = loadFixture('tight', { allowedTools: ['WebFetch(domain:*)'] });
    expect(findBypasses(set).find((f) => f.id === 'BYP-WEB-ALL')?.severity).toBe('high');
  });
});

describe('a wildcard allow for a server the configuration does not list', () => {
  const cliArgs = ['bypass', '--project', fixture('mcp-stale-server'), '--local', 'none', '--user', 'none', '--managed', 'none', '--format', 'json', '--fail-on', 'info'];
  const cliFindings = (stdout: string): { id: string; severity: string; rule?: string }[] =>
    (JSON.parse(stdout) as { findings: { id: string; severity: string; rule?: string }[] }).findings;

  it('flags the unconfigured server as a low stale grant', () => {
    const result = run(cliArgs);
    expect(result.code).toBe(1);
    const stale = cliFindings(result.stdout).filter((f) => f.id === 'BYP-MCP-STALE-SERVER');
    expect(stale).toHaveLength(1);
    expect(stale[0].severity).toBe('low');
    expect(stale[0].rule).toBe('mcp__old__*');
  });

  it('does not flag a server the configuration lists', () => {
    const result = run(cliArgs);
    const stale = cliFindings(result.stdout).filter((f) => f.id === 'BYP-MCP-STALE-SERVER');
    expect(stale.map((f) => f.rule)).not.toContain('mcp__github__*');
  });

  it('flags the stale server when the context carries a read configuration', () => {
    const findings = findBypasses(loadFixture('mcp-stale-server'), { mcpServers: ['github'] });
    expect(ids(findings)).toContain('BYP-MCP-STALE-SERVER');
  });

  it('does not run when no configuration file was read', () => {
    const findings = findBypasses(loadFixture('mcp-stale-server'));
    expect(ids(findings)).not.toContain('BYP-MCP-STALE-SERVER');
  });
});
