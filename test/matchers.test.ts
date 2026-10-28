// The wildcard matchers give the same answers as the regular expressions they replaced, and finish in
// time on patterns that made those regular expressions backtrack without end.
import { describe, expect, it } from 'vitest';
import { starGlobToRegex, starMatch } from '../src/rules.js';
import { compileGlob, globToRegexSource } from '../src/paths.js';
import { domainPatternMatches, normaliseHost } from '../src/domains.js';
import { bashPatternMatches } from '../src/bash.js';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(r: () => number, alphabet: string[], max: number): string {
  let s = '';
  const n = Math.floor(r() * max);
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
}

function oldPathMatch(glob: string, anyDepth: boolean, rel: string): 'self' | 'ancestor' | undefined {
  const re = new RegExp('^' + (anyDepth ? '(?:[^/]*/)*' : '') + globToRegexSource(glob) + '$');
  if (re.test(rel)) return 'self';
  const parts = rel.split('/');
  for (let n = parts.length - 1; n >= 1; n--) if (re.test(parts.slice(0, n).join('/'))) return 'ancestor';
  return undefined;
}

describe('starMatch', () => {
  it('agrees with the regular expression on random input', () => {
    const r = rng(1);
    for (let i = 0; i < 20_000; i++) {
      const glob = pick(r, ['*', 'a', 'b', ' ', '\n', '.'], 8);
      const text = pick(r, ['a', 'b', ' ', '\n', '.'], 10);
      expect(starMatch(glob, text), `${JSON.stringify(glob)} ${JSON.stringify(text)}`).toBe(starGlobToRegex(glob).test(text));
    }
  });

  it('is fast on many stars against a long command', () => {
    const start = performance.now();
    expect(starMatch('*a'.repeat(25) + 'b', 'a'.repeat(5000))).toBe(false);
    expect(bashPatternMatches('*a'.repeat(25) + 'b', 'a'.repeat(5000))).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('compileGlob', () => {
  it('agrees with the regular expression on random input', () => {
    const r = rng(2);
    for (let i = 0; i < 20_000; i++) {
      const glob = pick(r, ['*', '**', '/', 'a', 'b', '?', '[ab]', '[!a]', '\\*', '.'], 6);
      const rel = pick(r, ['a', 'b', '/', '*', '.', 'ab'], 8).replace(/^\/+/, '');
      for (const anyDepth of [false, true]) {
        expect(compileGlob(glob, anyDepth)(rel), `${JSON.stringify(glob)} ${anyDepth} ${JSON.stringify(rel)}`).toBe(
          oldPathMatch(glob, anyDepth, rel),
        );
      }
    }
  });

  it('is fast on repeated globstar segments against a deep path', () => {
    const start = performance.now();
    expect(compileGlob('**/a'.repeat(20) + '/b', false)('a/'.repeat(2000) + 'c')).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('domainPatternMatches', () => {
  it('agrees with the regular expression on random input', () => {
    const r = rng(3);
    for (let i = 0; i < 20_000; i++) {
      const p = normaliseHost(pick(r, ['*', 'a', 'b', '.'], 7) || 'a');
      const h = normaliseHost(pick(r, ['a', 'b', '.'], 8) || 'a');
      if (p === '*' || p.startsWith('*.') || !p.includes('*')) continue;
      const re = new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^.]*') + '$');
      expect(domainPatternMatches(p, h), `${p} ${h}`).toBe(re.test(h));
    }
  });

  it('is fast on many stars against a long label', () => {
    const start = performance.now();
    expect(domainPatternMatches('*a'.repeat(15) + 'b', 'a'.repeat(60))).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
