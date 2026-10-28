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
  /** Does a POSIX path relative to `base` match the pattern (`self`), or does one of its parent directories? */
  match: (rel: string) => 'self' | 'ancestor' | undefined;
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

type GlobToken =
  | { kind: 'char'; test: (c: string) => boolean }
  | { kind: 'star' } // [^/]*
  | { kind: 'any' } // .*
  | { kind: 'dirs' }; // (?:[^/]*/)*

const LINE_BREAK = /[\n\r\u2028\u2029]/;

/** The tokens of `globToRegexSource(glob)`, for the matcher below. */
function globTokens(glob: string): GlobToken[] {
  const out: GlobToken[] = [];
  const lit = (ch: string): GlobToken => ({ kind: 'char', test: (c) => c === ch });
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atSegStart = i === 0 || glob[i - 1] === '/';
        if (atSegStart && glob[i + 2] === '/') {
          out.push({ kind: 'dirs' });
          i += 3;
          continue;
        }
        out.push({ kind: 'any' });
        i += 2;
        continue;
      }
      out.push({ kind: 'star' });
      i++;
      continue;
    }
    if (c === '?') {
      out.push({ kind: 'char', test: (ch) => ch !== '/' });
      i++;
      continue;
    }
    if (c === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close > 0) {
        // One character class: a regular expression that matches a single character cannot backtrack.
        const cls = new RegExp('^' + globToRegexSource(glob.slice(i, close + 1)) + '$');
        out.push({ kind: 'char', test: (ch) => cls.test(ch) });
        i = close + 1;
        continue;
      }
    }
    if (c === '\\' && i + 1 < glob.length) {
      out.push(lit(glob[i + 1]));
      i += 2;
      continue;
    }
    out.push(lit(c));
    i++;
  }
  return out;
}

// A matcher with the same answers as the regular expression built from globToRegexSource(glob), with
// the any-depth prefix when anyDepth is set, run as a set of positions in the pattern advanced one
// character at a time. Its time is the path length times the pattern length; the regular expression
// backtracks exponentially on a pattern that repeats a globstar directory segment against a deep path.
export function compileGlob(glob: string, anyDepth: boolean): (text: string) => 'self' | 'ancestor' | undefined {
  const tokens = globTokens(glob);
  if (anyDepth) tokens.unshift({ kind: 'dirs' });
  const n = tokens.length;
  // States 0..n are "before token k"; n + 1 + k is "inside a segment of the dirs token k".
  const closure = (states: Set<number>): Set<number> => {
    const stack = [...states];
    while (stack.length > 0) {
      const s = stack.pop()!;
      if (s < n && tokens[s].kind !== 'char' && !states.has(s + 1)) {
        states.add(s + 1);
        stack.push(s + 1);
      }
    }
    return states;
  };
  // One pass gives both answers: the whole path matches (self), or the text before some "/" does (a
  // parent directory, which gitignore treats as covering everything inside it).
  return (text: string) => {
    let current = closure(new Set([0]));
    let ancestor = false;
    let index = 0;
    for (const ch of text) {
      if (ch === '/' && index > 0 && current.has(n)) ancestor = true;
      index += ch.length;
      const next = new Set<number>();
      for (const s of current) {
        if (s > n) {
          // inside a dirs segment: [^/]* then "/"
          if (ch === '/') next.add(s - n - 1);
          else next.add(s);
          continue;
        }
        if (s === n) continue;
        const t = tokens[s];
        if (t.kind === 'char') {
          if (t.test(ch)) next.add(s + 1);
        } else if (t.kind === 'star') {
          if (ch !== '/') next.add(s);
        } else if (t.kind === 'any') {
          if (!LINE_BREAK.test(ch)) next.add(s);
        } else if (ch === '/') next.add(s);
        else next.add(n + 1 + s);
      }
      if (next.size === 0) return ancestor ? 'ancestor' : undefined;
      current = closure(next);
    }
    if (current.has(n)) return 'self';
    return ancestor ? 'ancestor' : undefined;
  };
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
  const matcher = compileGlob(pattern, anyDepth);
  return { base, pattern, anyDepth, negated, match: matcher };
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
  return c.match(rel);
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
