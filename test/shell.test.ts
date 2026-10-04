import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/shell.js';

function programs(src: string): string[] {
  return parseCommand(src).commands.map((c) => c.words[0]);
}

describe('command splitting', () => {
  it('splits on && || ; |', () => {
    expect(programs('a && b || c ; d | e')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('splits on newlines', () => {
    expect(programs('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });
  it('finds a command in $( )', () => {
    expect(programs('echo "$(git clean -f)"')).toContain('git');
  });
  it('finds a command in backticks', () => {
    expect(programs('echo `whoami`')).toContain('whoami');
  });
  it('finds a command in a ( ) subshell', () => {
    expect(programs('(cd /tmp && rm x)')).toContain('rm');
  });
  it('does not split inside single quotes', () => {
    expect(programs("echo 'a && b'")).toEqual(['echo']);
  });
  it('does not split inside double quotes', () => {
    expect(programs('echo "a ; b"')).toEqual(['echo']);
  });
  it('handles an escaped space in a word', () => {
    const cmd = parseCommand('cat a\\ b.txt');
    expect(cmd.commands[0].words).toEqual(['cat', 'a b.txt']);
  });
  it('marks a dangling && unparseable', () => {
    expect(parseCommand('npm test &&').unparseable).toBe(true);
  });
  it('marks an unbalanced quote unparseable', () => {
    expect(parseCommand("echo 'oops").unparseable).toBe(true);
  });
  it('records redirect targets', () => {
    const cmd = parseCommand('echo hi > out.txt');
    expect(cmd.commands[0].redirects[0]).toEqual({ op: '>', target: 'out.txt' });
  });
  it('treats 2> as a redirect with a numeric fd prefix', () => {
    const cmd = parseCommand('make 2> err.log');
    expect(cmd.commands[0].redirects.some((r) => r.target === 'err.log')).toBe(true);
    expect(cmd.commands[0].words).toEqual(['make']);
  });
  it('does not treat a fd duplication as a file target', () => {
    const cmd = parseCommand('make 2>&1');
    expect(cmd.commands[0].redirects.every((r) => r.target === undefined)).toBe(true);
  });
  it('skips a here-document body', () => {
    const cmd = parseCommand('cat <<EOF\nnot a command\nEOF\necho done');
    expect(programs('cat <<EOF\nnot a command\nEOF\necho done')).toEqual(['cat', 'echo']);
    expect(cmd.unparseable).toBe(false);
  });
  it('skips a comment', () => {
    expect(programs('echo hi # a comment\nls')).toEqual(['echo', 'ls']);
  });
  it('reads a for-loop body but not its header', () => {
    expect(programs('for f in a b; do rm "$f"; done')).toContain('rm');
  });
});
