import { describeCall, evaluate } from './engine.js';
import { instantiateBash, instantiatePath } from './sample.js';
import { domainOfSpecifier } from './domains.js';
import { paramRule } from './rules.js';
import type { Decision, RuleSet, ToolCall } from './types.js';

export interface Flip {
  call: ToolCall;
  label: string;
  before: Decision;
  after: Decision;
}

/**
 * A representative, inert call for each rule across both rule sets, plus a small baseline corpus. These
 * are structural samples, not attacks: they instantiate each rule's own pattern so the diff can show
 * which decisions change between two settings files.
 */
function sampleCalls(a: RuleSet, b: RuleSet): ToolCall[] {
  const out: ToolCall[] = [];
  const seen = new Set<string>();
  const push = (call: ToolCall): void => {
    const key = describeCall(call);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(call);
    }
  };
  for (const set of [a, b]) {
    for (const rule of set.rules) {
      const spec = rule.specifier;
      if (rule.tool === 'Bash' || rule.tool === 'PowerShell') {
        if (spec && spec !== '*' && !paramRule(rule.tool, spec)) push({ tool: rule.tool, input: { command: instantiateBash(spec) } });
      } else if (rule.tool === 'Read' || rule.tool === 'Edit') {
        if (spec && spec !== '*' && !spec.startsWith('!')) push({ tool: rule.tool, input: { file_path: instantiatePath(rule, set) } });
      } else if (rule.tool === 'WebFetch') {
        const d = domainOfSpecifier(spec);
        if (d && d !== '*') push({ tool: 'WebFetch', input: { url: `https://${d.replace(/^\*\./, 'sub.').replace(/\*/g, 'x')}/` } });
      } else if (rule.tool.startsWith('mcp__') && !rule.tool.includes('*')) {
        push({ tool: rule.tool, input: {} });
      }
    }
  }
  return out;
}

export function diffRuleSets(a: RuleSet, b: RuleSet): Flip[] {
  const flips: Flip[] = [];
  for (const call of sampleCalls(a, b)) {
    const before = evaluate(call, a).decision;
    const after = evaluate(call, b).decision;
    if (before !== after) flips.push({ call, label: describeCall(call), before, after });
  }
  return flips;
}
