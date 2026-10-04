import path from 'node:path';
import { expandHome } from './settings.js';
import type { Rule } from './types.js';

export interface PathContext {
  projectDir: string;
  home: string;
}

export interface CompiledPathRule {
  /** Absolute directory the pattern is relative to. */
  base: string;
  /** Pattern relative to `base`, gitignore syntax. */
  pattern: string;
  /** True when the pattern matches at any depth under `base`. */
  anyDepth: boolean;
  negated: boolean;
  regex: RegExp;
}

/** Resolve a requested path the way the file tools see it: `~` expanded, relative to the project, `.` and `..` collapsed. */
export function resolveRequestedPath(p: string, ctx: PathContext): string {
  return path.resolve(ctx.projectDir, expandHome(p, ctx.home));
}

/** Translate a gitignore-style glob into a RegExp source (no anchors). */
export function globToRegexSource(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atSegStart = i === 0 || glob[i - 1] === '/';
        if (atSegStart && glob[i + 2] === '/') {
          out += '(?:[^/]*/)*';
          i += 3;
          continue;
        }
        out += '.*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i++;
      continue;
    }
    if (c === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close > 0) {
        let body = glob.slice(i + 1, close);
        if (body.startsWith('!')) body = '^' + body.slice(1);
        out += '[' + body.replace(/\\/g, '\\\\') + ']';
        i = close + 1;
        continue;
      }
    }
    if (c === '\\' && i + 1 < glob.length) {
      out += glob[i + 1].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      i += 2;
      continue;
    }
    out += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    i++;
  }
  return out;
}

/**
 * Resolve a Read or Edit rule specifier to an anchor directory and a relative pattern:
 * `//path` is absolute, `~/path` is under the home directory, `/path` is relative to the settings
 * source, and `path` or `./path` is relative to the current directory. A bare name (no `/`) matches at
 * any depth; a single directory segment such as `src/**` matches at any depth in deny and ask rules
 * and only at the current directory in allow rules.
 */
export function compilePathRule(rule: Rule, ctx: PathContext): CompiledPathRule {
  let spec = (rule.specifier ?? '**').trim();
  let negated = false;
  if (spec.startsWith('!')) {
    negated = true;
    spec = spec.slice(1);
  }
  let base: string;
  let pattern: string;
  let relative = false;
  if (negated) {
    base = ctx.projectDir;
    pattern = spec.replace(/^\.\//, '');
    relative = true;
  } else if (spec.startsWith('//')) {
    base = '/';
    pattern = spec.slice(2);
  } else if (spec === '~' || spec.startsWith('~/')) {
    base = ctx.home;
    pattern = spec === '~' ? '**' : spec.slice(2);
  } else if (spec.startsWith('/')) {
    base = rule.source.anchor;
    pattern = spec.slice(1);
  } else if (spec.startsWith('./')) {
    base = ctx.projectDir;
    pattern = spec.slice(2);
  } else {
    base = ctx.projectDir;
    pattern = spec;
    relative = true;
  }
  if (pattern.endsWith('/') && pattern.length > 1) pattern = pattern.slice(0, -1);
  if (pattern === '') pattern = '**';
  let anyDepth = false;
  if (relative) {
    if (!pattern.includes('/')) anyDepth = true;
    else if (rule.list !== 'allow' && /^[^/*]+\/\*\*$/.test(pattern)) anyDepth = true;
  }
  const body = globToRegexSource(pattern);
  const regex = new RegExp('^' + (anyDepth ? '(?:[^/]*/)*' : '') + body + '$');
  return { base, pattern, anyDepth, negated, regex };
}

/** Path relative to `base` in POSIX form, or undefined when the path is not under `base`. */
function relativeTo(base: string, abs: string): string | undefined {
  if (base === '/') return abs.replace(/^\/+/, '');
  const rel = path.relative(base, abs);
  if (rel === '') return '';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}

/**
 * Does the compiled rule match the path itself (`self`) or one of its parent directories (`ancestor`)?
 * Matching a parent directory covers everything inside it, as in gitignore.
 */
export function matchCompiled(c: CompiledPathRule, abs: string): 'self' | 'ancestor' | undefined {
  const rel = relativeTo(c.base, abs);
  if (rel === undefined || rel === '') return undefined;
  if (c.regex.test(rel)) return 'self';
  const parts = rel.split('/');
  for (let n = parts.length - 1; n >= 1; n--) {
    if (c.regex.test(parts.slice(0, n).join('/'))) return 'ancestor';
  }
  return undefined;
}

/**
 * Match a path rule, applying `!` carve-outs from later rules in the same source and list. A carve-out
 * cannot reopen a file whose parent directory the rule matches as a whole.
 */
export function pathRuleMatches(rule: Rule, siblings: Rule[], abs: string, ctx: PathContext): boolean {
  const c = compilePathRule(rule, ctx);
  if (c.negated) return false;
  const hit = matchCompiled(c, abs);
  if (hit === undefined) return false;
  if (hit === 'ancestor' || rule.list === 'allow') return true;
  if (/^(\/|~)/.test((rule.specifier ?? '').trim())) return true; // carve-outs reach only path and ./path rules
  for (const s of siblings) {
    if (s.source !== rule.source || s.list !== rule.list || s.index <= rule.index) continue;
    if (!s.specifier?.startsWith('!')) continue;
    if (matchCompiled(compilePathRule(s, ctx), abs) !== undefined) return false;
  }
  return true;
}

export function isInside(dir: string, abs: string): boolean {
  const rel = path.relative(dir, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
