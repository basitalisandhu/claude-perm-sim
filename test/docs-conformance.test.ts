import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/engine.js';
import { parseCall } from '../src/call.js';
import { loadRuleSet } from '../src/settings.js';
import { parseArgs, UsageError } from '../src/cli.js';
import type { RuleSet, SimMode } from '../src/types.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Cases taken from https://code.claude.com/docs/en/permissions (fetched 2026-10-16). Each describe block
 * names the section it checks.
 */

function rs(allow: string[] = [], deny: string[] = [], mode?: SimMode): RuleSet {
  const set = loadRuleSet({ project: '/project', local: 'none', user: 'none', managed: 'none', home: '/home/alice', allowedTools: allow, disallowedTools: deny });
  set.mode = mode;
  return set;
}

const decide = (set: RuleSet, call: string) => evaluate(parseCall(call), set).decision;

describe('#exec-wrappers-and-find-actions', () => {
  it.each([
    ['Bash(watch *)', 'Bash(watch make)'],
    ['Bash(setsid *)', 'Bash(setsid make)'],
    ['Bash(ionice *)', 'Bash(ionice -c3 make)'],
    ['Bash(flock *)', 'Bash(flock /tmp/lock make)'],
    ['Bash(find *)', 'Bash(find build -type f -delete)'],
    ['Bash(find *)', 'Bash(find . -exec rm {} ;)'],
    ['Bash(find *)', 'Bash(find . -fprint out.txt)'],
  ])('a prefix rule %s cannot approve %s', (rule, call) => {
    const v = evaluate(parseCall(call), rs([rule]));
    expect(v.decision).toBe('default');
    expect(v.notes.join(' ')).toMatch(/only an exact rule/);
  });

  it('an exact rule with no * approves find with an action', () => {
    expect(decide(rs(['Bash(find build -type f -delete)']), 'Bash(find build -type f -delete)')).toBe('allow');
  });

  it('a prefix rule still approves an exec wrapper inside a deny check (deny is unaffected)', () => {
    expect(decide(rs([], ['Bash(watch *)']), 'Bash(watch make)')).toBe('deny');
  });

  it.each(['Bash(find . -fprint out.txt)', 'Bash(find . -files0-from list.txt)', 'Bash(find . -fls out.txt)'])(
    'find with a writing or file-list primary is not read-only: %s',
    (call) => {
      expect(decide(rs(), call)).toBe('default');
    },
  );

  it('plain find stays read-only', () => {
    expect(decide(rs(), 'Bash(find . -name x)')).toBe('allow');
  });
});

describe('#manage-permissions: EndConversation', () => {
  it('a bare deny rule does not remove EndConversation', () => {
    const v = evaluate(parseCall('EndConversation'), rs([], ['EndConversation']));
    expect(v.decision).toBe('default');
    expect(v.notes[0]).toMatch(/do not apply to EndConversation/);
  });
  it('a glob deny rule does not remove EndConversation', () => {
    expect(decide(rs([], ['*']), 'EndConversation')).toBe('default');
  });
  it('the glob deny still removes other tools', () => {
    expect(decide(rs([], ['*']), 'Agent(Explore)')).toBe('deny');
  });
});

describe('#permission-modes: dontAsk and the manual alias', () => {
  it('dontAsk denies a call that would prompt', () => {
    const v = evaluate(parseCall('Bash(npm publish)'), rs([], [], 'dontAsk'));
    expect(v.decision).toBe('deny');
    expect(v.decidedBy[0].builtin).toMatch(/dontAsk/);
  });
  it('dontAsk denies a call an ask rule matches', () => {
    const set = rs(['Bash(git *)'], [], 'dontAsk');
    set.rules.push({ tool: 'Bash', specifier: 'git push *', raw: 'Bash(git push *)', list: 'ask', source: set.sources[0] ?? { scope: 'cli', file: 't', anchor: '/project' }, index: 0 });
    expect(decide(set, 'Bash(git push origin main)')).toBe('deny');
  });
  it('dontAsk still runs pre-approved tools and read-only commands', () => {
    expect(decide(rs(['Bash(npm test *)'], [], 'dontAsk'), 'Bash(npm test)')).toBe('allow');
    expect(decide(rs([], [], 'dontAsk'), 'Bash(ls -la)')).toBe('allow');
    expect(decide(rs([], [], 'dontAsk'), 'Read(/project/src/a.ts)')).toBe('allow');
  });
  it('--mode manual is an alias for default', () => {
    expect(parseArgs(['explain', 'Bash(ls)', '--mode', 'manual']).mode).toBe('default');
    expect(parseArgs(['explain', 'Bash(ls)', '--mode', 'dontAsk']).mode).toBe('dontAsk');
  });
  it.each(['plan', 'auto', 'bypassPermissions'])('--mode %s is refused as not modelled', (m) => {
    expect(() => parseArgs(['load', '--mode', m])).toThrow(/not modelled/);
  });
  it('an unknown mode is a usage error', () => {
    expect(() => parseArgs(['load', '--mode', 'yolo'])).toThrow(UsageError);
  });
});

describe('settings-reference: defaultMode and the disable keys', () => {
  function project(settings: object, user?: object): RuleSet {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cps-'));
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(settings));
    let userFile = 'none';
    if (user) {
      userFile = path.join(dir, 'user.json');
      writeFileSync(userFile, JSON.stringify(user));
    }
    return loadRuleSet({ project: dir, local: 'none', user: userFile, managed: 'none', home: dir });
  }

  it.each(['auto', 'bypassPermissions'])('defaultMode %s does not take effect from project settings', (mode) => {
    const set = project({ permissions: { defaultMode: mode } }, { permissions: { defaultMode: 'plan' } });
    expect(set.defaultMode?.value).toBe('plan');
    expect(set.warnings.join('\n')).toMatch(/does not take effect from project settings/);
  });
  it('defaultMode manual is recorded as default', () => {
    expect(project({ permissions: { defaultMode: 'manual' } }).defaultMode?.value).toBe('default');
  });
  it('an unknown defaultMode is warned about and ignored', () => {
    const set = project({ permissions: { defaultMode: 'yolo' } });
    expect(set.defaultMode).toBeUndefined();
    expect(set.warnings.join('\n')).toMatch(/not a permission mode/);
  });
  it('disable keys set to true have no effect and are warned about', () => {
    const set = project({ disableAutoMode: true, permissions: { disableBypassPermissionsMode: true } });
    expect(set.warnings.filter((w) => /only the string "disable"/.test(w))).toHaveLength(2);
  });
  it('disable keys set to "disable" are accepted silently', () => {
    const set = project({ disableAutoMode: 'disable', permissions: { disableBypassPermissionsMode: 'disable', disableAutoMode: 'disable' } });
    expect(set.warnings).toEqual([]);
  });
});
