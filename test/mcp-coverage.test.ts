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

describe('automatic MCP coverage', () => {
  it('discovers configured servers without executing commands or resolving environment values', () => {
    const root = project({ mcpServers: {
      alpha: { command: 'must-never-run', args: ['${SECRET}'] },
      beta: { url: 'https://must-never-fetch.invalid' },
    } });
    const result = run(args(root));
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('mcp__alpha');
    expect(result.stdout).toContain('mcp__beta');
    expect(result.stdout).not.toContain('${SECRET}');
  });
  it('recognizes server-wide deny coverage', () => {
    const root = project({ mcpServers: { alpha: { command: 'noop' } } }, { deny: ['mcp__alpha__*'] });
    expect(run(args(root)).stdout).not.toContain('BYP-MCP-SERVER-UNCOVERED');
  });
  it('lets an explicit MCP configuration override project discovery', () => {
    const root = project({ mcpServers: { alpha: {} } });
    const other = path.join(root, 'other.json');
    fs.writeFileSync(other, JSON.stringify({ mcpServers: { beta: {} } }));
    const output = run(args(root, '--mcp-from', other)).stdout;
    expect(output).toContain('mcp__beta');
    expect(output).not.toContain('mcp__alpha');
  });
  it('returns usage errors for malformed, missing explicit, and invalid configurations', () => {
    const root = project('{broken');
    expect(run(args(root)).code).toBe(2);
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: [] }));
    expect(run(args(root)).code).toBe(2);
    fs.rmSync(path.join(root, '.mcp.json'));
    expect(run(args(root, '--mcp-from', 'missing.json')).code).toBe(2);
    expect(run(args(root)).code).not.toBe(2);
  });
  it('includes newly exposed MCP servers in diff analysis', () => {
    const root = project({ mcpServers: { alpha: {} } });
    const before = path.join(root, 'before.json');
    const after = path.join(root, 'after.json');
    fs.writeFileSync(before, JSON.stringify({ permissions: { deny: ['mcp__alpha__*'] } }));
    fs.writeFileSync(after, JSON.stringify({ permissions: {} }));
    const result = run(['diff', before, after, '--project', root, '--format', 'json']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('mcp__alpha');
  });
  it('derives known servers from permission rules when no config exists', () => {
    const root = project({}, { allow: ['mcp__alpha__read'] });
    fs.rmSync(path.join(root, '.mcp.json'));
    expect(run(args(root)).stdout).toContain('BYP-MCP-SERVER-UNCOVERED');
    expect(run(args(root)).stdout).toContain('mcp__alpha');
  });
  it('does not confuse a specific deny with server-wide coverage', () => {
    const root = project({ mcpServers: { alpha: {} } }, { deny: ['mcp__alpha__delete'] });
    expect(run(args(root)).stdout).toContain('BYP-MCP-SERVER-UNCOVERED');
  });
  it('treats deliberate ask rules as server coverage', () => {
    const root = project({ mcpServers: { alpha: {} } }, { ask: ['mcp__alpha__*'] });
    expect(run(args(root)).stdout).not.toContain('BYP-MCP-SERVER-UNCOVERED');
  });
});
