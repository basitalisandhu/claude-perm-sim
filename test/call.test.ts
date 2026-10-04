import { describe, expect, it } from 'vitest';
import { parseCall, CallError } from '../src/call.js';
import { parseRule, formatRule } from '../src/rules.js';

describe('parseCall from rule form', () => {
  it('reads a Bash call', () => {
    expect(parseCall('Bash(npm run build)').input.command).toBe('npm run build');
  });
  it('reads an Edit call', () => {
    expect(parseCall('Edit(src/app.ts)').input.file_path).toBe('src/app.ts');
  });
  it('reads a WebFetch domain into a url', () => {
    expect(parseCall('WebFetch(domain:evil.example)').input.url).toBe('https://evil.example/');
  });
  it('reads a WebFetch url directly', () => {
    expect(parseCall('WebFetch(https://x.example/y)').input.url).toBe('https://x.example/y');
  });
  it('reads a bare MCP tool name', () => {
    expect(parseCall('mcp__github__create_issue').tool).toBe('mcp__github__create_issue');
  });
  it('keeps parentheses inside a specifier', () => {
    expect(parseCall('Bash(echo $(date))').input.command).toBe('echo $(date)');
  });
  it('rejects empty input', () => {
    expect(() => parseCall('')).toThrow(CallError);
  });
});

describe('parseCall from hook JSON', () => {
  it('reads tool_name and tool_input', () => {
    const c = parseCall(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
    expect(c.tool).toBe('Bash');
    expect(c.input.command).toBe('ls');
  });
  it('requires tool_name', () => {
    expect(() => parseCall(JSON.stringify({ tool_input: {} }))).toThrow(CallError);
  });
  it('rejects a non-object tool_input', () => {
    expect(() => parseCall(JSON.stringify({ tool_name: 'Bash', tool_input: 'x' }))).toThrow(CallError);
  });
  it('rejects malformed JSON', () => {
    expect(() => parseCall('{ not json')).toThrow(CallError);
  });
});

describe('rule parsing round-trip', () => {
  it('parses and formats a tool rule', () => {
    expect(formatRule(parseRule('Bash(npm run *)'))).toBe('Bash(npm run *)');
  });
  it('parses a bare tool rule', () => {
    expect(parseRule('Bash')).toEqual({ tool: 'Bash' });
  });
});
