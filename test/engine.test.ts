import { describe, expect, it } from 'vitest';
import { loadRuleSet } from '../src/settings.js';
import { evaluate } from '../src/engine.js';
import { parseCall } from '../src/call.js';
import type { RuleSet } from '../src/types.js';
import { fixture, loadFixture, decide } from './helpers.js';

function withRules(allow: string[] = [], ask: string[] = [], deny: string[] = []): RuleSet {
  return loadRuleSet({
    project: '/project',
    local: 'none',
    user: 'none',
    managed: 'none',
    home: '/home/alice',
    allowedTools: allow,
    disallowedTools: deny,
    settings: [],
    // ask rules only come from files; inject via a synthetic by re-parsing below
  }) as RuleSet & { __ask?: string[] };
}

/** Build a rule set directly from arrays, including ask. */
function rs(lists: { allow?: string[]; ask?: string[]; deny?: string[] }): RuleSet {
  const base = withRules(lists.allow ?? [], [], lists.deny ?? []);
  // Append ask rules with a cli source for test purposes.
  if (lists.ask) {
    const src = base.sources.find((s) => s.scope === 'cli') ?? { scope: 'cli' as const, file: 'test', anchor: '/project' };
    lists.ask.forEach((raw, index) => {
      const open = raw.indexOf('(');
      const rule = open > 0 && raw.endsWith(')') ? { tool: raw.slice(0, open), specifier: raw.slice(open + 1, -1) } : { tool: raw };
      base.rules.push({ ...rule, raw, list: 'ask', source: src, index });
    });
    base.rules.sort((a, b) => (a.list === b.list ? 0 : a.list === 'deny' ? -1 : b.list === 'deny' ? 1 : a.list === 'ask' ? -1 : 1));
  }
  return base;
}

describe('evaluation order: deny, then ask, then allow', () => {
  it('deny beats a more specific allow', () => {
    const set = rs({ allow: ['Bash(git push origin main)'], deny: ['Bash(git push *)'] });
    expect(decide(set, 'Bash(git push origin main)')).toBe('deny');
  });

  it('ask beats a more specific allow', () => {
    const set = rs({ allow: ['Bash(git push origin main)'], ask: ['Bash(git push *)'] });
    expect(decide(set, 'Bash(git push origin main)')).toBe('ask');
  });

  it('returns default ask when no rule matches', () => {
    const set = rs({ allow: ['Bash(npm run *)'] });
    expect(decide(set, 'Bash(cargo build)')).toBe('default');
  });

  it('reports the deciding rule and the rules that also matched', () => {
    const set = rs({ allow: ['Bash(git push origin main)', 'Bash(git *)'], deny: ['Bash(git push *)'] });
    const v = evaluate(parseCall('Bash(git push origin main)'), set);
    expect(v.decision).toBe('deny');
    expect(v.decidedBy[0].rule?.raw).toBe('Bash(git push *)');
    expect(v.alsoMatched.length).toBeGreaterThan(0);
  });
});

describe('bash wildcard matching', () => {
  it('npm run * matches the bare command and subcommands', () => {
    const set = rs({ allow: ['Bash(npm run *)'] });
    expect(decide(set, 'Bash(npm run)')).toBe('allow');
    expect(decide(set, 'Bash(npm run build --watch)')).toBe('allow');
    expect(decide(set, 'Bash(npm install)')).toBe('default');
  });

  it('exact rule matches only the exact command', () => {
    const set = rs({ allow: ['Bash(npm run build)'] });
    expect(decide(set, 'Bash(npm run build)')).toBe('allow');
    expect(decide(set, 'Bash(npm run build --watch)')).toBe('default');
  });

  it('a trailing star with a space does not match a longer program name', () => {
    const set = rs({ allow: ['Bash(ls *)'] });
    expect(decide(set, 'Bash(ls -la)')).toBe('allow');
    expect(decide(set, 'Bash(ls)')).toBe('allow');
    expect(decide(set, 'Bash(lsof)')).toBe('default');
  });

  it('no space before the star matches a longer program name', () => {
    const set = rs({ allow: ['Bash(ls*)'] });
    expect(decide(set, 'Bash(lsof)')).toBe('allow');
  });

  it('the :* suffix is equivalent to a trailing space-star', () => {
    const set = rs({ allow: ['Bash(ls:*)'] });
    expect(decide(set, 'Bash(ls -la)')).toBe('allow');
    expect(decide(set, 'Bash(ls)')).toBe('allow');
  });
});

describe('compound commands and wrappers', () => {
  it('a rule must match each subcommand for allow', () => {
    const set = rs({ allow: ['Bash(npm run build)'] });
    expect(decide(set, 'Bash(npm run build && curl https://x)')).toBe('default');
  });

  it('a deny rule applies when any subcommand matches', () => {
    const set = rs({ allow: ['Bash(echo *)'], deny: ['Bash(rm *)'] });
    expect(decide(set, 'Bash(echo hi && rm -rf build)')).toBe('deny');
  });

  it('a deny rule matches inside a command substitution', () => {
    const set = rs({ deny: ['Bash(git clean *)'] });
    expect(decide(set, 'Bash(echo "$(git clean -f)")')).toBe('deny');
  });

  it('a dangling && makes the command unparseable for allow rules', () => {
    const set = rs({ allow: ['Bash(npm run *)'] });
    const v = evaluate(parseCall('Bash(npm run build &&)'), set);
    expect(v.decision).toBe('default');
    expect(v.notes.join(' ')).toContain('could not be split');
  });

  it('strips timeout, nice and nohup wrappers for allow', () => {
    const set = rs({ allow: ['Bash(npm test *)'] });
    expect(decide(set, 'Bash(timeout 30 npm test)')).toBe('allow');
    expect(decide(set, 'Bash(nice -n 5 npm test)')).toBe('allow');
    expect(decide(set, 'Bash(nohup npm test)')).toBe('allow');
  });

  it('strips a known-safe env assignment for allow but not an arbitrary one', () => {
    const set = rs({ allow: ['Bash(npm test *)'] });
    expect(decide(set, 'Bash(NODE_ENV=test npm test)')).toBe('allow');
    expect(decide(set, 'Bash(SECRET=x npm test)')).toBe('default');
  });

  it('a deny rule matches past any leading assignment', () => {
    const set = rs({ deny: ['Bash(rm *)'] });
    expect(decide(set, 'Bash(FOO=bar rm -rf tmp)')).toBe('deny');
  });

  it('strips bare xargs but not xargs with flags', () => {
    const set = rs({ allow: ['Bash(grep *)'] });
    expect(decide(set, 'Bash(xargs grep pattern)')).toBe('allow');
    expect(decide(set, 'Bash(xargs -n1 grep pattern)')).toBe('default');
  });

  it('does not strip command -v (the query form)', () => {
    const set = rs({ allow: ['Bash(node *)'] });
    expect(decide(set, 'Bash(command node --version)')).toBe('allow');
    expect(decide(set, 'Bash(command -v node)')).toBe('default');
  });
});

describe('built-in read-only commands', () => {
  it('cat and ls run without a rule', () => {
    const set = rs({});
    expect(decide(set, 'Bash(ls -la)')).toBe('allow');
    expect(decide(set, 'Bash(cat README.md)')).toBe('allow');
  });

  it('git status is read-only but git clean is not', () => {
    const set = rs({});
    expect(decide(set, 'Bash(git status)')).toBe('allow');
    expect(decide(set, 'Bash(git clean -f)')).toBe('default');
  });

  it('find with -delete is not read-only', () => {
    const set = rs({});
    expect(decide(set, 'Bash(find . -name x)')).toBe('allow');
    expect(decide(set, 'Bash(find . -delete)')).toBe('default');
  });
});

describe('read and edit path rules', () => {
  const home = '/home/alice';
  function fileRs(lists: { allow?: string[]; deny?: string[] }): RuleSet {
    return loadRuleSet({ project: '/project', local: 'none', user: 'none', managed: 'none', home, allowedTools: lists.allow ?? [], disallowedTools: lists.deny ?? [] });
  }

  it('Edit(src/**) as allow matches only the top src directory', () => {
    const set = fileRs({ allow: ['Edit(src/**)'] });
    expect(decide(set, 'Edit(src/app.ts)')).toBe('allow');
    expect(decide(set, 'Edit(vendor/pkg/src/lib.js)')).toBe('default');
  });

  it('Read(secrets/**) as deny matches at any depth', () => {
    const set = fileRs({ deny: ['Read(secrets/**)'] });
    expect(decide(set, 'Read(secrets/key.txt)')).toBe('deny');
    expect(decide(set, 'Read(vendor/secrets/key.txt)')).toBe('deny');
  });

  it('a bare filename matches at any depth', () => {
    const set = fileRs({ deny: ['Read(.env)'] });
    expect(decide(set, 'Read(.env)')).toBe('deny');
    expect(decide(set, 'Read(config/.env)')).toBe('deny');
  });

  it('~/ expands to the home directory', () => {
    const set = fileRs({ deny: ['Read(~/.ssh/id_rsa)'] });
    expect(decide(set, 'Read(~/.ssh/id_rsa)')).toBe('deny');
  });

  it('// is an absolute path, a single / is settings-relative', () => {
    const abs = fileRs({ deny: ['Read(//tmp/secret)'] });
    expect(decide(abs, 'Read(//tmp/secret)')).toBe('deny');
    const rel = fileRs({ allow: ['Edit(/src/**)'] });
    expect(decide(rel, 'Edit(src/app.ts)')).toBe('allow');
  });

  it('a Read deny rule also blocks Edit and Write on the same path', () => {
    const set = fileRs({ deny: ['Read(./.env)'] });
    expect(decide(set, 'Edit(.env)')).toBe('deny');
    expect(decide(set, 'Write(.env)')).toBe('deny');
  });

  it('allow needs both the requested path and its symlink target', () => {
    const set = fileRs({ allow: ['Edit(project/**)'], deny: ['Read(~/.ssh/**)'] });
    // a link inside project that resolves to ~/.ssh is blocked by the deny
    expect(decide(set, 'Edit(project/key)')).toBe('allow');
    const v = evaluate({ tool: 'Edit', input: { file_path: 'project/key' }, resolvedPath: '~/.ssh/id_rsa' }, set);
    expect(v.decision).toBe('deny');
  });

  it('reads inside the working directory need no rule', () => {
    const set = fileRs({});
    expect(decide(set, 'Read(src/app.ts)')).toBe('allow');
  });

  it('a ! carve-out reopens a file in deny', () => {
    const set = fileRs({ deny: ['Read(*.env)', 'Read(!sample.env)'] });
    expect(decide(set, 'Read(prod.env)')).toBe('deny');
    expect(decide(set, 'Read(sample.env)')).not.toBe('deny');
  });
});

describe('webfetch domain rules', () => {
  function webRs(lists: { allow?: string[]; deny?: string[] }): RuleSet {
    return loadRuleSet({ project: '/p', local: 'none', user: 'none', managed: 'none', home: '/h', allowedTools: lists.allow ?? [], disallowedTools: lists.deny ?? [] });
  }
  it('matches the exact host', () => {
    const set = webRs({ allow: ['WebFetch(domain:example.com)'] });
    expect(decide(set, 'WebFetch(https://example.com/x)')).toBe('allow');
    expect(decide(set, 'WebFetch(https://evil.com/x)')).toBe('default');
  });
  it('*.example.com matches subdomains but not the apex', () => {
    const set = webRs({ allow: ['WebFetch(domain:*.example.com)'] });
    expect(decide(set, 'WebFetch(https://api.example.com/x)')).toBe('allow');
    expect(decide(set, 'WebFetch(https://a.b.example.com/x)')).toBe('allow');
    expect(decide(set, 'WebFetch(https://example.com/x)')).toBe('default');
  });
  it('userinfo and ports do not change the host', () => {
    const set = webRs({ allow: ['WebFetch(domain:example.com)'] });
    expect(decide(set, 'WebFetch(https://user@example.com:8443/x)')).toBe('allow');
  });
  it('a mid wildcard matches only within a label', () => {
    const set = webRs({ allow: ['WebFetch(domain:example.*)'] });
    expect(decide(set, 'WebFetch(https://example.org/x)')).toBe('allow');
    expect(decide(set, 'WebFetch(https://example.evil.com/x)')).toBe('default');
  });
});

describe('mcp rules', () => {
  function mcpRs(lists: { allow?: string[]; deny?: string[] }): RuleSet {
    return loadRuleSet({ project: '/p', local: 'none', user: 'none', managed: 'none', home: '/h', allowedTools: lists.allow ?? [], disallowedTools: lists.deny ?? [] });
  }
  it('an exact tool rule matches that tool only', () => {
    const set = mcpRs({ allow: ['mcp__github__get_issue'] });
    expect(decide(set, 'mcp__github__get_issue')).toBe('allow');
    expect(decide(set, 'mcp__github__create_issue')).toBe('default');
  });
  it('a server wildcard matches every tool on the server', () => {
    const set = mcpRs({ allow: ['mcp__github__*'] });
    expect(decide(set, 'mcp__github__anything')).toBe('allow');
    expect(decide(set, 'mcp__slack__anything')).toBe('default');
  });
  it('a bare server rule matches every tool on the server', () => {
    const set = mcpRs({ allow: ['mcp__github__get_issue'], deny: ['mcp__github'] });
    expect(decide(set, 'mcp__github__get_issue')).toBe('deny');
  });
  it('mcp__* in deny matches every mcp tool', () => {
    const set = mcpRs({ allow: ['mcp__github__get_issue'], deny: ['mcp__*'] });
    expect(decide(set, 'mcp__github__get_issue')).toBe('deny');
  });
  it('an uncovered tool is default ask', () => {
    const set = mcpRs({});
    expect(decide(set, 'mcp__slack__post_message')).toBe('default');
  });
});

describe('fixtures end to end', () => {
  it('the tight fixture denies env reads and allows scoped edits', () => {
    const set = loadFixture('tight');
    expect(decide(set, 'Read(.env)')).toBe('deny');
    expect(decide(set, 'Edit(src/app.ts)')).toBe('allow');
    expect(decide(set, 'Edit(.git/config)')).toBe('deny');
  });

  it('the permissive fixture allows broad git and subdomains', () => {
    const set = loadFixture('permissive');
    expect(decide(set, 'Bash(git commit -m x)')).toBe('allow');
    expect(decide(set, 'WebFetch(https://api.example.com/x)')).toBe('allow');
  });
});
