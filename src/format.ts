import { decisionLabel, describeCall } from './engine.js';
import type { Finding, Rule, RuleSet, Severity, Verdict } from './types.js';
import type { Flip as FlipType } from './diff.js';

export type Format = 'table' | 'json' | 'sarif' | 'hook';

const SEV_ORDER: Severity[] = ['high', 'medium', 'low', 'info'];

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || a.id.localeCompare(b.id));
}

function ruleLocation(rule: Rule | undefined): string {
  if (!rule) return '';
  return `${rule.source.scope}:${rule.source.file}`;
}

// ---- load ----

export function formatLoad(set: RuleSet, format: Format): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        projectDir: set.projectDir,
        sources: set.sources.map((s) => ({ scope: s.scope, file: s.file })),
        managedOnly: set.managedOnly,
        defaultMode: set.defaultMode?.value ?? 'default',
        additionalDirectories: set.additionalDirectories.map((d) => ({ dir: d.dir, raw: d.raw, source: d.source.file })),
        permissions: {
          deny: set.rules.filter((r) => r.list === 'deny').map((r) => ({ rule: r.raw, source: r.source.file, scope: r.source.scope })),
          ask: set.rules.filter((r) => r.list === 'ask').map((r) => ({ rule: r.raw, source: r.source.file, scope: r.source.scope })),
          allow: set.rules.filter((r) => r.list === 'allow').map((r) => ({ rule: r.raw, source: r.source.file, scope: r.source.scope })),
        },
        warnings: set.warnings,
      },
      null,
      2,
    );
  }
  const lines: string[] = [];
  lines.push(`Effective permissions for ${set.projectDir}`);
  lines.push(`default mode: ${set.defaultMode?.value ?? 'default (Manual)'}`);
  if (set.managedOnly) lines.push('allowManagedPermissionRulesOnly: only managed rules apply');
  for (const list of ['deny', 'ask', 'allow'] as const) {
    const rules = set.rules.filter((r) => r.list === list);
    lines.push('');
    lines.push(`${list} (${rules.length})`);
    if (rules.length === 0) lines.push('  (none)');
    for (const r of rules) lines.push(`  ${r.raw}    [${r.source.scope}] ${r.source.file}`);
  }
  if (set.additionalDirectories.length > 0) {
    lines.push('');
    lines.push('additionalDirectories');
    for (const d of set.additionalDirectories) lines.push(`  ${d.raw} -> ${d.dir}    [${d.source.scope}] ${d.source.file}`);
  }
  if (set.warnings.length > 0) {
    lines.push('');
    lines.push('warnings');
    for (const w of set.warnings) lines.push(`  ${w}`);
  }
  return lines.join('\n');
}

// ---- explain ----

export function formatExplain(verdict: Verdict, format: Format): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        call: describeCall(verdict.call),
        tool: verdict.call.tool,
        decision: verdict.decision,
        decidedBy: verdict.decidedBy.map((s) => ({ decision: s.decision, rule: s.rule?.raw, source: s.rule ? s.rule.source.file : undefined, scope: s.rule?.source.scope, builtin: s.builtin, subject: s.subject })),
        alsoMatched: verdict.alsoMatched.map((r) => ({ rule: r.raw, list: r.list, source: r.source.file, scope: r.source.scope })),
        notes: verdict.notes,
      },
      null,
      2,
    );
  }
  const lines: string[] = [];
  lines.push(`${describeCall(verdict.call)}`);
  lines.push(`decision: ${decisionLabel(verdict.decision)}`);
  for (const s of verdict.decidedBy) {
    if (s.rule) lines.push(`  ${s.decision}: ${s.rule.raw}  [${s.rule.source.scope}] ${s.rule.source.file}  (matched: ${s.subject})`);
    else lines.push(`  ${s.decision}: ${s.builtin}  (${s.subject})`);
  }
  if (verdict.alsoMatched.length > 0) {
    lines.push('also matched (did not decide):');
    for (const r of verdict.alsoMatched) lines.push(`  ${r.list}: ${r.raw}  [${r.source.scope}] ${r.source.file}`);
  }
  for (const n of verdict.notes) lines.push(`note: ${n}`);
  return lines.join('\n');
}

// ---- findings (bypass, lint) ----

export function formatFindings(findings: Finding[], format: Format, title: string, toolVersion: string): string {
  const sorted = sortFindings(findings);
  if (format === 'json') {
    return JSON.stringify(
      {
        tool: 'claude-perm-sim',
        version: toolVersion,
        findings: sorted.map((f) => ({ id: f.id, severity: f.severity, family: f.family, title: f.title, message: f.message, rule: f.rule?.raw, source: f.rule ? ruleLocation(f.rule) : undefined, probe: f.probe, suggestion: f.suggestion })),
      },
      null,
      2,
    );
  }
  if (format === 'sarif') return toSarif(sorted, toolVersion);
  if (sorted.length === 0) return `${title}: no findings`;
  const lines: string[] = [`${title}: ${sorted.length} finding(s)`];
  for (const f of sorted) {
    lines.push('');
    lines.push(`${f.severity.toUpperCase()}  ${f.id}  ${f.title}`);
    if (f.rule) lines.push(`  rule:       ${f.rule.raw}  [${f.rule.source.scope}] ${f.rule.source.file}`);
    if (f.probe) lines.push(`  example:    ${f.probe}`);
    lines.push(`  why:        ${f.message}`);
    if (f.suggestion) lines.push(`  suggestion: ${f.suggestion}`);
  }
  return lines.join('\n');
}

const SARIF_LEVEL: Record<Severity, string> = { high: 'error', medium: 'warning', low: 'note', info: 'note' };
const SARIF_RANK: Record<Severity, number> = { high: 90, medium: 60, low: 30, info: 10 };

export function toSarif(findings: Finding[], toolVersion: string): string {
  const ruleIds = Array.from(new Set(findings.map((f) => f.id)));
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'claude-perm-sim',
            informationUri: 'https://github.com/basitalisandhu/claude-perm-sim',
            version: toolVersion,
            rules: ruleIds.map((id) => {
              const first = findings.find((f) => f.id === id)!;
              return { id, name: first.family ?? id, shortDescription: { text: first.title }, defaultConfiguration: { level: SARIF_LEVEL[first.severity] } };
            }),
          },
        },
        results: findings.map((f) => ({
          ruleId: f.id,
          level: SARIF_LEVEL[f.severity],
          rank: SARIF_RANK[f.severity],
          message: { text: f.suggestion ? `${f.message} Suggestion: ${f.suggestion}` : f.message },
          properties: { family: f.family, severity: f.severity, rule: f.rule?.raw, example: f.probe },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.rule ? toUri(f.rule.source.file) : 'permissions' },
                region: { startLine: 1 },
              },
            },
          ],
        })),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}

function toUri(file: string): string {
  return file.replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
}

// ---- diff ----

export function formatDiff(flips: FlipType[], format: Format, aLabel: string, bLabel: string): string {
  if (format === 'json') {
    return JSON.stringify({ a: aLabel, b: bLabel, flips: flips.map((f) => ({ call: f.label, tool: f.call.tool, before: f.before, after: f.after })) }, null, 2);
  }
  if (flips.length === 0) return `no decisions change between ${aLabel} and ${bLabel}`;
  const lines = [`${flips.length} decision(s) change between ${aLabel} and ${bLabel}`, ''];
  for (const f of flips) lines.push(`  ${decisionLabel(f.before)} -> ${decisionLabel(f.after)}   ${f.label}`);
  return lines.join('\n');
}

// ---- hook snippet ----

export function hookSnippet(exe: string, args: string[]): string {
  return JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: exe,
                args,
                timeout: 30,
                statusMessage: 'claude-perm-sim: logging the matching rule for this tool call',
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  );
}

export type { Flip } from './diff.js';
