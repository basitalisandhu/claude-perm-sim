import { describe, expect, it } from 'vitest';
import { run, parseArgs, VERSION, UsageError } from '../src/cli.js';
import { fixture } from './helpers.js';

const base = (name: string): string[] => ['--project', fixture(name), '--local', 'none', '--user', 'none', '--managed', 'none'];

describe('argument parsing', () => {
  it('reads and validates the explicit permission mode', () => {
    expect(parseArgs(['explain', 'Edit(file)', '--mode=acceptEdits']).mode).toBe('acceptEdits');
    expect(() => parseArgs(['explain', 'Edit(file)', '--mode', 'bypassPermissions'])).toThrow(UsageError);
  });
  it('reads a command and positionals', () => {
    const o = parseArgs(['explain', 'Bash(ls)']);
    expect(o.command).toBe('explain');
    expect(o.positionals).toEqual(['Bash(ls)']);
  });
  it('accepts --flag=value form', () => {
    expect(parseArgs(['load', '--format=json']).format).toBe('json');
  });
  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['load', '--bogus'])).toThrow(UsageError);
  });
  it('rejects an unknown format', () => {
    expect(() => parseArgs(['load', '--format', 'xml'])).toThrow(UsageError);
  });
  it('collects repeated settings sources', () => {
    const o = parseArgs(['load', '--settings', 'a.json', '--settings', 'b.json']);
    expect(o.load.settings).toEqual(['a.json', 'b.json']);
  });
});

describe('run() in-process', () => {
  it('applies the explicit mode in explain, not just in argument parsing', () => {
    const args = ['explain', 'Edit(src/new.ts)', '--project', '/project', '--local', 'none', '--user', 'none', '--managed', 'none', '--format', 'json'];
    expect(JSON.parse(run(args).stdout).decision).toBe('default');
    expect(JSON.parse(run([...args, '--mode', 'acceptEdits']).stdout).decision).toBe('allow');
  });
  it('prints help with no command and exits 2', () => {
    const r = run([]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('Usage: claude-perm-sim');
  });
  it('prints help with --help and exits 0', () => {
    expect(run(['--help']).code).toBe(0);
  });
  it('prints the version', () => {
    expect(run(['--version']).stdout.trim()).toBe(VERSION);
  });
  it('load prints the lists', () => {
    const r = run(['load', ...base('tight')]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('allow');
  });
  it('explain decides a call', () => {
    const r = run(['explain', 'Read(.env)', ...base('tight')]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('deny');
  });
  it('explain without a call is a usage error', () => {
    expect(run(['explain', ...base('tight')]).code).toBe(2);
  });
  it('explain reads the JSON a hook receives', () => {
    const r = run(['explain', JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'src/x.ts' } }), ...base('tight')]);
    expect(r.stdout).toContain('allow');
  });
  it('bypass exits 1 on a high finding by default', () => {
    const r = run(['bypass', ...base('permissive')]);
    expect(r.code).toBe(1);
  });
  it('bypass exits 0 on a tight rule set', () => {
    const r = run(['bypass', ...base('tight')]);
    expect(r.code).toBe(0);
  });
  it('bypass --fail-on info exits 1 when only info findings exist', () => {
    const r = run(['bypass', ...base('tight'), '--mcp-tool', 'mcp__x__y', '--fail-on', 'info']);
    expect(r.code).toBe(1);
  });
  it('lint exits 1 on broad rules', () => {
    expect(run(['lint', ...base('lint-project')]).code).toBe(1);
  });
  it('lint exits 0 on a tight rule set', () => {
    expect(run(['lint', ...base('tight')]).code).toBe(0);
  });
  it('diff needs two files', () => {
    expect(run(['diff', fixture('diff-a.json')]).code).toBe(2);
  });
  it('diff reports flips', () => {
    const r = run(['diff', fixture('diff-a.json'), fixture('diff-b.json'), '--project', fixture('tight')]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('change');
  });
  it('diff errors on a missing file', () => {
    expect(run(['diff', fixture('nope.json'), fixture('diff-b.json')]).code).toBe(2);
  });
  it('--format hook prints a PreToolUse snippet', () => {
    const r = run(['explain', 'Bash(ls)', '--format', 'hook', ...base('tight')]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hooks.PreToolUse).toBeDefined();
  });
  it('--format json on bypass parses', () => {
    const r = run(['bypass', ...base('permissive'), '--format', 'json']);
    expect(JSON.parse(r.stdout).findings.length).toBeGreaterThan(0);
  });
  it('--format sarif on lint is valid SARIF', () => {
    const r = run(['lint', ...base('lint-project'), '--format', 'sarif']);
    expect(JSON.parse(r.stdout).version).toBe('2.1.0');
  });
  it('invalid settings JSON is a settings error (exit 2)', () => {
    const r = run(['load', '--project', fixture('tight'), '--local', 'none', '--user', fixture('bad.json'), '--managed', 'none']);
    expect(r.code).toBe(2);
  });
  it('--allow-tool adds a command-line rule visible in load', () => {
    const r = run(['load', ...base('tight'), '--allow-tool', 'Bash(echo *)']);
    expect(r.stdout).toContain('Bash(echo *)');
  });
});
