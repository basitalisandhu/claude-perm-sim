import type { Rule, RuleSet } from './types.js';

/**
 * Turn a rule's own pattern into a concrete, inert sample so the engine can decide it. These are not
 * attacks: a trailing wildcard becomes a literal word, a path glob becomes a placeholder filename, and a
 * domain wildcard becomes `sub.<apex>`. They exist only to show which decisions a rule produces.
 */

export function instantiateBash(specifier: string): string {
  let s = specifier.endsWith(':*') ? specifier.slice(0, -2) + ' *' : specifier;
  if (s.endsWith(' *')) s = s.slice(0, -2) + ' sample';
  return s.replace(/\*/g, 'sample');
}

export function instantiatePath(rule: Rule, set: RuleSet): string {
  let spec = (rule.specifier ?? '**').trim();
  let prefix = '';
  if (spec.startsWith('//')) {
    prefix = '/';
    spec = spec.slice(2);
  } else if (spec === '~' || spec.startsWith('~/')) {
    prefix = '~/';
    spec = spec === '~' ? '' : spec.slice(2);
  } else if (spec.startsWith('/')) {
    spec = spec.slice(1);
    if (rule.source.anchor !== set.projectDir) prefix = rule.source.anchor.replace(/\/?$/, '/');
  } else if (spec.startsWith('./')) {
    spec = spec.slice(2);
  }
  let p = spec
    .replace(/\/\*\*$/, '/sample.txt')
    .replace(/^\*\*$/, 'sample.txt')
    .replace(/\*\*\//g, '')
    .replace(/\[[^\]]*\]/g, 'x')
    .replace(/\*/g, 'sample')
    .replace(/\?/g, 'x');
  if (p === '' || p.endsWith('/')) p += 'sample.txt';
  return prefix + p;
}
