import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function project(config: unknown, permissions: unknown = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-mcp-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions }));
  fs.writeFileSync(path.join(root, '.mcp.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return root;
}
function args(root: string, ...extra: string[]) {
  return ['bypass', '--project', root, '--local', 'none', '--user', 'none', '--managed', 'none', '--format', 'json', '--fail-on', 'info', ...extra];
}
function stale(stdout: string): string[] {
  const findings = (JSON.parse(stdout) as { findings: { id: string; rule?: string }[] }).findings;
  return findings.filter((f) => f.id === 'BYP-MCP-STALE-SERVER').map((f) => f.rule ?? '');
}

describe('automatic MCP coverage', () => {
  it('discovers configured servers without executing commands or resolving environment values', () => {
    const root = project({ mcpServers: {
      alpha: { command: 'must-never-run', args: ['${SECRET}'] },
      beta: { url: 'https://must-never-fetch.invalid' },
    } }, { allow: ['mcp__alpha__*', 'mcp__old__*'] });
    const result = run(args(root));
    expect(stale(result.stdout)).toEqual(['mcp__old__*']);
    expect(result.stdout).not.toContain('${SECRET}');
  });
  it('lets an explicit MCP configuration override project discovery', () => {
    const root = project({ mcpServers: { alpha: {} } }, { allow: ['mcp__alpha__*', 'mcp__beta__*'] });
    const other = path.join(root, 'other.json');
    fs.writeFileSync(other, JSON.stringify({ mcpServers: { beta: {} } }));
    expect(stale(run(args(root, '--mcp-from', other)).stdout)).toEqual(['mcp__alpha__*']);
  });
  it('flags a wildcard allow whose server only appears in rules', () => {
    const root = project({ mcpServers: { beta: {} } }, { allow: ['mcp__alpha__*'] });
    const result = run(args(root));
    expect(stale(result.stdout)).toEqual(['mcp__alpha__*']);
  });
  it('does not flag a specific tool rule, an ask rule, or a deny rule', () => {
    const root = project({ mcpServers: { beta: {} } }, {
      allow: ['mcp__old__read'],
      ask: ['mcp__asked__*'],
      deny: ['mcp__denied__*'],
    });
    expect(stale(run(args(root)).stdout)).toEqual([]);
  });
  it('skips the stale-server check when no configuration file exists', () => {
    const root = project({}, { allow: ['mcp__old__*'] });
    fs.rmSync(path.join(root, '.mcp.json'));
    const result = run(args(root));
    expect(stale(result.stdout)).toEqual([]);
    expect(result.stderr).toBe('');
  });
  it('warns and continues when the implicit project configuration is malformed', () => {
    const root = project('{broken', { allow: ['mcp__old__*'] });
    const result = run(args(root));
    expect(result.code).not.toBe(2);
    expect(result.stderr).toContain('warning');
    expect(result.stderr).toContain('.mcp.json');
    expect(stale(result.stdout)).toEqual([]);
  });
  it('exits 2 for a malformed, invalid, or missing explicit --mcp-from', () => {
    const root = project({ mcpServers: { alpha: {} } });
    const bad = path.join(root, 'bad.json');
    fs.writeFileSync(bad, '{broken');
    expect(run(args(root, '--mcp-from', bad)).code).toBe(2);
    fs.writeFileSync(bad, JSON.stringify({ mcpServers: [] }));
    expect(run(args(root, '--mcp-from', bad)).code).toBe(2);
    fs.writeFileSync(bad, JSON.stringify({ mcpServers: { '': {} } }));
    expect(run(args(root, '--mcp-from', bad)).code).toBe(2);
    expect(run(args(root, '--mcp-from', path.join(root, 'missing.json'))).code).toBe(2);
  });
});
