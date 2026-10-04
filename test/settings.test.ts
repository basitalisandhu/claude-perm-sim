import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadRuleSet, managedDir, ruleSetFromFile, SettingsError, rulesIn } from '../src/settings.js';
import { fixture, loadFixture } from './helpers.js';

describe('settings loading and precedence', () => {
  it('reads project settings and sorts rules into deny, ask, allow', () => {
    const set = loadFixture('tight');
    expect(rulesIn(set, 'deny').length).toBeGreaterThan(0);
    expect(rulesIn(set, 'ask').map((r) => r.raw)).toContain('mcp__github__create_issue');
    expect(rulesIn(set, 'allow').map((r) => r.raw)).toContain('Bash(npm run build)');
  });

  it('records the source file and scope of every rule', () => {
    const set = loadFixture('permissive');
    for (const r of set.rules) {
      expect(r.source.scope).toBe('project');
      expect(r.source.file).toContain('permissive');
    }
  });

  it('merges lists across scopes instead of overriding', () => {
    const set = loadRuleSet({
      project: fixture('layered'),
      user: 'none',
      managed: 'none',
      home: fixture('home'),
    });
    const allow = rulesIn(set, 'allow').map((r) => r.raw);
    expect(allow).toContain('Bash(npm run *)'); // project
    expect(allow).toContain('Bash(git status)'); // local
  });

  it('orders local above project above user', () => {
    const set = loadRuleSet({
      project: fixture('layered'),
      user: fixture('layered-user', 'settings.json'),
      managed: 'none',
      home: fixture('home'),
    });
    const allowScopes = rulesIn(set, 'allow').map((r) => r.source.scope);
    expect(allowScopes.indexOf('local')).toBeLessThan(allowScopes.indexOf('project'));
    expect(allowScopes.indexOf('project')).toBeLessThan(allowScopes.indexOf('user'));
  });

  it('reads additionalDirectories with home expansion', () => {
    const set = loadRuleSet({
      project: fixture('layered'),
      user: fixture('layered-user', 'settings.json'),
      managed: 'none',
      home: '/home/alice',
    });
    expect(set.additionalDirectories.map((d) => d.dir)).toContain('/home/alice/shared-data');
  });

  it('places managed rules at the top of precedence', () => {
    const set = loadRuleSet({
      project: fixture('managed'),
      managed: fixture('managed', 'managed.json'),
      user: 'none',
      home: fixture('home'),
    });
    expect(set.sources[0].scope).toBe('managed');
    expect(rulesIn(set, 'deny').map((r) => r.raw)).toContain('Bash(git push *)');
  });

  it('adds command-line allow and deny rules with cli scope', () => {
    const set = loadRuleSet({
      project: fixture('tight'),
      user: 'none',
      managed: 'none',
      home: fixture('home'),
      allowedTools: ['Bash(echo *)'],
      disallowedTools: ['Bash(rm *)'],
    });
    const cli = set.rules.filter((r) => r.source.scope === 'cli');
    expect(cli.map((r) => r.raw)).toContain('Bash(echo *)');
    expect(cli.map((r) => r.raw)).toContain('Bash(rm *)');
  });

  it('honours allowManagedPermissionRulesOnly by ignoring lower scopes', () => {
    const set = loadRuleSet({
      project: fixture('managed'),
      managed: fixture('managed', 'managed-only.json'),
      user: 'none',
      home: fixture('home'),
    });
    expect(set.managedOnly).toBe(true);
    // The project allow rule Bash(ls *) is ignored; only managed rules remain.
    expect(set.rules.every((r) => r.source.scope === 'managed')).toBe(true);
    expect(set.warnings.some((w) => w.includes('allowManagedPermissionRulesOnly'))).toBe(true);
  });

  it('throws on a named settings file that does not exist', () => {
    expect(() => loadRuleSet({ project: fixture('tight'), user: fixture('nope.json'), managed: 'none', home: '/tmp' })).toThrow(SettingsError);
  });

  it('throws on invalid JSON', () => {
    expect(() => ruleSetFromFile(fixture('bad.json'), fixture('tight'))).toThrow(SettingsError);
  });

  it('reports the documented managed directory per platform', () => {
    expect(managedDir('darwin')).toBe('/Library/Application Support/ClaudeCode');
    expect(managedDir('linux')).toBe('/etc/claude-code');
    expect(managedDir('win32')).toBe('C:\\Program Files\\ClaudeCode');
  });

  it('holds project allow rules when the folder is untrusted', () => {
    const trusted = loadFixture('permissive');
    const untrusted = loadFixture('permissive', { untrusted: true });
    expect(rulesIn(trusted, 'allow').length).toBeGreaterThan(rulesIn(untrusted, 'allow').length);
    // deny and ask rules still apply
    expect(rulesIn(untrusted, 'deny').length).toBe(rulesIn(trusted, 'deny').length);
  });

  it('treats an empty settings file as no rules', () => {
    const set = loadRuleSet({ project: fixture('tight'), local: 'none', user: 'none', managed: 'none', home: fixture('home'), projectFile: fixture('empty.json') });
    expect(set).toBeDefined();
  });

  it('anchors a /path rule from user settings at the user config directory', () => {
    const set = loadRuleSet({
      project: fixture('layered'),
      user: fixture('layered-user', 'settings.json'),
      managed: 'none',
      home: fixture('home'),
    });
    const userRule = rulesIn(set, 'allow').find((r) => r.source.scope === 'user');
    expect(userRule?.source.anchor).toBe(path.dirname(fixture('layered-user', 'settings.json')));
  });
});
