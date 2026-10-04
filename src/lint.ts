import { bashPrefix } from './bash.js';
import { ruleIsInert } from './engine.js';
import { domainOfSpecifier } from './domains.js';
import { formatRule, paramRule, splitMcpName } from './rules.js';
import type { Finding, Rule, RuleSet } from './types.js';

/**
 * Static checks on the rule set: duplicates, allow rules a deny shadows, overly broad patterns, rules
 * that can never match, mixed slash styles, and rules in `allow` that look like they belong in `ask`.
 */

function sameRule(a: Rule, b: Rule): boolean {
  return a.list === b.list && a.tool === b.tool && a.specifier === b.specifier;
}

function duplicateFindings(set: RuleSet): Finding[] {
  const out: Finding[] = [];
  for (let i = 0; i < set.rules.length; i++) {
    for (let j = i + 1; j < set.rules.length; j++) {
      if (sameRule(set.rules[i], set.rules[j])) {
        out.push({
          id: 'LINT-DUP',
          severity: 'low',
          family: 'duplicate',
          title: 'duplicate rule',
          message: `${set.rules[j].raw} in ${set.rules[j].list} (${set.rules[j].source.file}) repeats the rule in ${set.rules[i].source.file}.`,
          rule: set.rules[j],
          suggestion: 'remove one copy',
        });
      }
    }
  }
  return out;
}

/** An allow rule whose covered calls a deny or ask rule also covers never takes effect for them. */
function shadowFindings(set: RuleSet): Finding[] {
  const out: Finding[] = [];
  const blockers = set.rules.filter((r) => r.list === 'deny' || r.list === 'ask');
  for (const allow of set.rules.filter((r) => r.list === 'allow')) {
    for (const b of blockers) {
      if (b.tool !== allow.tool) continue;
      const bSpec = b.specifier;
      const aSpec = allow.specifier;
      const covers =
        bSpec === undefined ||
        bSpec === '*' ||
        bSpec === aSpec ||
        (aSpec !== undefined && bashPrefix(bSpec) !== '' && aSpec.startsWith(bashPrefix(bSpec)) && (allow.tool === 'Bash' || allow.tool === 'PowerShell'));
      if (covers) {
        out.push({
          id: 'LINT-SHADOW',
          severity: 'medium',
          family: 'shadowed',
          title: `allow rule shadowed by ${b.list}`,
          message: `${allow.raw} (allow, ${allow.source.file}) is overridden by ${b.raw} (${b.list}, ${b.source.file}); deny and ask are evaluated before allow, so the allow never takes effect for the overlap.`,
          rule: allow,
          suggestion: b.list === 'deny' ? 'remove the allow rule or narrow the deny rule' : 'move the allow rule into ask, or narrow the ask rule',
        });
        break;
      }
    }
  }
  return out;
}

const BROAD: { test: (r: Rule) => boolean; message: string; suggestion: string }[] = [
  { test: (r) => (r.tool === 'Bash' || r.tool === 'PowerShell') && (r.specifier === undefined || r.specifier === '*'), message: 'allows every command', suggestion: 'list the command families you trust' },
  { test: (r) => (r.tool === 'Edit' || r.tool === 'Read') && (r.specifier === '**' || r.specifier === '/**' || r.specifier === '//**' || r.specifier === '~/**'), message: 'covers an entire tree', suggestion: 'scope to the directories you use' },
  { test: (r) => r.tool === 'mcp__*' || (r.tool.includes('*') && r.tool.startsWith('mcp__') && r.tool.replace('mcp__', '').replace(/_/g, '').replace('*', '') === ''), message: 'covers every MCP tool', suggestion: 'name one server, or one tool per rule' },
  { test: (r) => r.tool === '*', message: 'covers every tool', suggestion: 'name specific tools' },
  { test: (r) => r.tool === 'WebFetch' && domainOfSpecifier(r.specifier) === '*', message: 'allows every domain', suggestion: 'list the domains you fetch' },
];

function broadFindings(set: RuleSet): Finding[] {
  const out: Finding[] = [];
  for (const rule of set.rules) {
    if (rule.list !== 'allow') continue;
    for (const b of BROAD) {
      if (b.test(rule)) {
        out.push({ id: 'LINT-BROAD', severity: 'high', family: 'overly-broad', title: 'overly broad allow rule', message: `${rule.raw} ${b.message}.`, rule, suggestion: b.suggestion });
        break;
      }
    }
  }
  return out;
}

function neverMatchFindings(set: RuleSet): Finding[] {
  const out: Finding[] = [];
  for (const rule of set.rules) {
    const inert = ruleIsInert(rule);
    if (inert) {
      out.push({ id: 'LINT-INERT', severity: 'medium', family: 'never-matches', title: 'rule never matches', message: `${rule.raw} (${rule.list}, ${rule.source.file}): ${inert}.`, rule, suggestion: 'remove the rule or rewrite it in a form Claude Code applies' });
    }
  }
  return out;
}

function slashStyleFindings(set: RuleSet): Finding[] {
  const out: Finding[] = [];
  for (const rule of set.rules) {
    if ((rule.tool === 'Read' || rule.tool === 'Edit') && rule.specifier?.includes('\\')) {
      out.push({ id: 'LINT-SLASH', severity: 'low', family: 'mixed-slashes', title: 'backslash in a path rule', message: `${rule.raw} uses a backslash; Claude Code normalises paths to forward slashes before matching, so a backslash is treated as a literal character.`, rule, suggestion: 'use forward slashes, and // for an absolute Windows path such as //c/Users/you/.env' });
    }
  }
  return out;
}

const WRITE_VERB = /^(create|add|insert|update|set|put|patch|delete|remove|drop|send|post|publish|write|execute|run|deploy|move|rename|grant|revoke|install|uninstall)[_-]/i;

/** An allow rule for an MCP tool whose name reads like a write or destructive action. */
function wrongListFindings(set: RuleSet): Finding[] {
  const out: Finding[] = [];
  for (const rule of set.rules) {
    if (rule.list !== 'allow') continue;
    if (!rule.tool.startsWith('mcp__') || rule.tool.includes('*')) continue;
    const parts = splitMcpName(rule.tool);
    if (parts?.tool && WRITE_VERB.test(parts.tool)) {
      out.push({ id: 'LINT-WRONG-LIST', severity: 'medium', family: 'belongs-in-ask', title: 'write-like tool in allow', message: `${rule.raw} allows a tool whose name begins with a write or destructive verb. Tool annotations are hints, so a name like this usually belongs in ask.`, rule, suggestion: `move ${formatRule(rule)} to the ask list` });
    }
  }
  return out;
}

export function lint(set: RuleSet): Finding[] {
  return [
    ...broadFindings(set),
    ...neverMatchFindings(set),
    ...shadowFindings(set),
    ...wrongListFindings(set),
    ...duplicateFindings(set),
    ...slashStyleFindings(set),
  ];
}

export function paramRuleNote(rule: Rule): string | undefined {
  const p = paramRule(rule.tool, rule.specifier);
  return p ? `${rule.tool}(${p.name}:${p.value})` : undefined;
}
