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

describe('parser edge cases', () => {
  const p = parseCommand;
  it('splits on |& and a background &', () => {
    expect(programs('make |& tee log & echo hi')).toEqual(['make', 'tee', 'echo']);
  });
  it('marks a dangling | unparseable', () => {
    expect(p('ls |').unparseable).toBe(true);
  });
  it('reports an unterminated here-document', () => {
    expect(p('cat <<EOF\nbody').reasons).toContain('here-document is not terminated');
  });
  it('accepts a tab-indented terminator for <<-', () => {
    const r = p('cat <<-EOF\n\tbody\n\tEOF\nls');
    expect(r.unparseable).toBe(false);
    expect(r.commands.map((c) => c.words[0])).toEqual(['cat', 'ls']);
  });
  it('records a here-string without a file target', () => {
    const r = p('grep x <<< "text"');
    expect(r.commands[0].redirects).toEqual([{ op: '<<<' }]);
  });
  it('records &> and >> targets', () => {
    expect(p('make &> all.log').commands[0].redirects[0]).toEqual({ op: '&>', target: 'all.log' });
    expect(p('echo a >> out').commands[0].redirects[0]).toEqual({ op: '>>', target: 'out' });
  });
  it('treats >& with a file name as a file target', () => {
    expect(p('make >& build.log').commands[0].redirects[0]).toEqual({ op: '>&', target: 'build.log' });
  });
  it('reports a redirect with no target', () => {
    expect(p('echo hi >').reasons[0]).toMatch(/has no target/);
  });
  it('keeps a redirect-only command so its target is still checked', () => {
    const r = p('> out.txt');
    expect(r.commands[0].words).toEqual([]);
    expect(r.commands[0].redirects[0].target).toBe('out.txt');
  });
  it('does not parse an arithmetic expansion as a command', () => {
    expect(programs('echo $((1 + 2))')).toEqual(['echo']);
  });
  it('finds commands in process substitutions', () => {
    expect(programs('diff <(sort a) >(tee b)')).toEqual(['sort', 'tee', 'diff']);
  });
  it('finds a backtick command inside double quotes', () => {
    expect(programs('echo "now `date`"')).toContain('date');
  });
  it('follows a line continuation', () => {
    expect(p('npm \\\n test').commands[0].words).toEqual(['npm', 'test']);
  });
  it.each([
    ['echo $(ls', 'unbalanced $('],
    ['echo `ls', 'unbalanced backtick'],
    ['echo "a', 'unbalanced double quote'],
    ['(ls', 'unbalanced ('],
    ['diff <(ls', 'unbalanced <('],
    ['ls )', 'unexpected )'],
    ['case x in a) ls;; esac', 'case constructs are not followed'],
    ['f() { ls; }', 'unexpected )'],
    ['function f { ls; }', 'function constructs are not followed'],
  ])('marks %s unparseable', (src, reason) => {
    const r = p(src);
    expect(r.unparseable).toBe(true);
    expect(r.reasons).toContain(reason);
  });
  it('strips control-flow keywords and skips a while header body correctly', () => {
    expect(programs('if test -f a; then rm a; else touch a; fi')).toEqual(['test', 'rm', 'touch']);
  });
  it('marks nested commands', () => {
    const r = p('echo $(whoami)');
    expect(r.commands.find((c) => c.words[0] === 'whoami')?.nested).toBe(true);
    expect(r.commands.find((c) => c.words[0] === 'echo')?.nested).toBe(false);
  });
  it('handles an escaped quote inside double quotes', () => {
    expect(p('echo "a \\" b"').commands[0].words).toEqual(['echo', 'a \\" b']);
  });
});
