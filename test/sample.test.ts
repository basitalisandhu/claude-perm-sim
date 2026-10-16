import { describe, expect, it } from 'vitest';
import { instantiateBash, instantiatePath } from '../src/sample.js';
import type { Rule, RuleSet } from '../src/types.js';

const set = { projectDir: '/project' } as RuleSet;
function rule(specifier: string | undefined, anchor = '/project'): Rule {
  return { tool: 'Read', specifier, raw: `Read(${specifier})`, list: 'allow', index: 0, source: { scope: 'project', file: 'x', anchor } };
}

describe('instantiateBash', () => {
  it.each([
    ['npm run *', 'npm run sample'],
    ['ls:*', 'ls sample'],
    ['git * main', 'git sample main'],
    ['make', 'make'],
  ])('%s becomes %s', (spec, out) => {
    expect(instantiateBash(spec)).toBe(out);
  });
});

describe('instantiatePath', () => {
  it.each([
    ['//etc/**', '/etc/sample.txt'],
    ['~/.ssh/*', '~/.ssh/sample'],
    ['~', '~/sample.txt'],
    ['/src/**', 'src/sample.txt'],
    ['./docs/', 'docs/sample.txt'],
    ['**', 'sample.txt'],
    ['**/node_modules/**', 'node_modules/sample.txt'],
    ['src/file[0-9].ts', 'src/filex.ts'],
    ['a?.txt', 'ax.txt'],
  ])('%s becomes %s', (spec, out) => {
    expect(instantiatePath(rule(spec), set)).toBe(out);
  });
  it('anchors a /path rule from user settings at its own directory', () => {
    expect(instantiatePath(rule('/notes/**', '/home/alice/.claude'), set)).toBe('/home/alice/.claude/notes/sample.txt');
  });
  it('treats a missing specifier as the whole tree', () => {
    expect(instantiatePath(rule(undefined), set)).toBe('sample.txt');
  });
});
