import { bashPatternMatches, fileArguments, readOnlyReason, stripCommand } from './bash.js';
import { domainOfSpecifier, domainPatternMatches, hostOf } from './domains.js';
import { isInside, pathRuleMatches, resolveRequestedPath, type PathContext } from './paths.js';
import { PRIMARY_FIELDS, UNCONSULTED_PATH_TOOLS, paramRule, splitMcpName, starGlobToRegex } from './rules.js';
import { parseCommand } from './shell.js';
import type { Decision, ListName, Rule, RuleSet, Step, ToolCall, Verdict } from './types.js';

export const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function ctxOf(set: RuleSet): PathContext {
  return { projectDir: set.projectDir, home: set.home };
}

/** Does the rule's tool position cover the call's tool? */
export function toolNameMatches(rule: Rule, tool: string): boolean {
  const name = rule.tool;
  if (name.includes('*')) {
    if (rule.list === 'allow') {
      // Allow globs only after a literal mcp__<server>__ prefix.
      const m = /^mcp__([^*]+?)__/.exec(name);
      if (!m) return false;
    }
    return starGlobToRegex(name).test(tool);
  }
  if (name.startsWith('mcp__')) {
    const r = splitMcpName(name)!;
    const c = splitMcpName(tool);
    if (!c) return false;
    if (r.tool === undefined) return c.server === r.server;
    return name === tool;
  }
  if (name === tool) return true;
  // Read rules cover the file-reading tools and Edit rules every file-editing tool.
  if (name === 'Read' && READ_TOOLS.has(tool)) return true;
  if (name === 'Edit' && EDIT_TOOLS.has(tool)) return true;
  return false;
}

/** True when a rule never takes effect for any call (documented as skipped or ignored). */
export function ruleIsInert(rule: Rule): string | undefined {
  if (rule.tool.includes('*') && rule.list === 'allow' && !/^mcp__[^*]+?__/.test(rule.tool)) {
    return 'unanchored allow globs are skipped with a warning and approve nothing';
  }
  if (rule.tool.startsWith('mcp__') && rule.specifier !== undefined) {
    return 'mcp__ rules with parentheses are skipped when a settings file is loaded';
  }
  if (rule.tool.includes('*') && rule.specifier !== undefined) {
    return 'a tool-name glob with a specifier matches nothing';
  }
  if (UNCONSULTED_PATH_TOOLS.has(rule.tool) && rule.specifier !== undefined && rule.specifier !== '*') {
    return `${rule.tool} path rules are accepted but never consulted; use Edit or Read`;
  }
  const param = paramRule(rule.tool, rule.specifier);
  if (param) {
    if (PRIMARY_FIELDS[rule.tool] === param.name) return `${rule.tool}(${param.name}:...) names the primary content field and is ignored`;
    if (rule.list === 'allow') return 'parameter rules apply to deny and ask lists only';
  }
  if (rule.tool === 'Bash' && rule.specifier !== undefined && /:\*./.test(rule.specifier)) {
    return 'the :* suffix is only recognised at the end of a pattern';
  }
  if (rule.tool === 'WebFetch' && rule.specifier !== undefined && rule.specifier !== '*' && domainOfSpecifier(rule.specifier) === undefined && !param) {
    return 'WebFetch rules need a domain: prefix';
  }
  if ((rule.tool === 'Read' || rule.tool === 'Edit') && rule.specifier?.startsWith('!') && rule.list === 'allow') {
    return 'a ! carve-out only applies in deny and ask lists';
  }
  return undefined;
}

function primaryString(call: ToolCall): string | undefined {
  const i = call.input;
  for (const key of ['subagent_type', 'skill', 'query', 'primary', 'path', 'command']) {
    if (typeof i[key] === 'string') return i[key] as string;
  }
  return undefined;
}

export function callPath(call: ToolCall): string | undefined {
  const i = call.input;
  const p = i.file_path ?? i.notebook_path ?? i.path;
  return typeof p === 'string' ? p : undefined;
}

/** Match one rule against a whole non-Bash call (or the tool-level part of a Bash call). */
export function ruleMatchesCall(rule: Rule, call: ToolCall, set: RuleSet): boolean {
  if (ruleIsInert(rule)) return false;
  if (!toolNameMatches(rule, call.tool)) return false;
  const spec = rule.specifier;
  if (spec === undefined || (spec === '*' && !READ_TOOLS.has(call.tool) && !EDIT_TOOLS.has(call.tool))) return true;
  const param = paramRule(rule.tool, spec);
  if (param) {
    const v = call.input[param.name];
    if (v === undefined || v === null) return false;
    const value = param.value.trim();
    return value.includes('*') ? starGlobToRegex(value).test(String(v)) : String(v) === value;
  }
  if (rule.tool === 'Bash' || rule.tool === 'PowerShell') return false; // command patterns are matched per subcommand
  if (READ_TOOLS.has(call.tool) || EDIT_TOOLS.has(call.tool)) {
    const p = callPath(call);
    if (p === undefined) return false;
    const ctx = ctxOf(set);
    const requested = resolveRequestedPath(p, ctx);
    const hitRequested = pathRuleMatches(rule, set.rules, requested, ctx);
    if (call.resolvedPath === undefined) return hitRequested;
    const hitResolved = pathRuleMatches(rule, set.rules, resolveRequestedPath(call.resolvedPath, ctx), ctx);
    // Allow rules need both the requested path and its target; deny and ask rules need either.
    return rule.list === 'allow' ? hitRequested && hitResolved : hitRequested || hitResolved;
  }
  if (call.tool === 'WebFetch') {
    const domain = domainOfSpecifier(spec);
    if (domain === undefined) return false;
    const url = typeof call.input.url === 'string' ? call.input.url : undefined;
    const host = url === undefined ? undefined : hostOf(url);
    return host !== undefined && domainPatternMatches(domain, host);
  }
  const primary = primaryString(call);
  if (primary === undefined) return false;
  return spec.includes('*') ? starGlobToRegex(spec).test(primary) : primary === spec;
}

interface Match {
  rule: Rule;
  subject: string;
}

function workingDirs(set: RuleSet): string[] {
  return [set.projectDir, ...set.additionalDirectories.map((d) => d.dir)];
}

function insideWorkingDirs(set: RuleSet, abs: string): string | undefined {
  return workingDirs(set).find((d) => isInside(d, abs));
}

function pathCall(tool: string, p: string): ToolCall {
  return { tool, input: { file_path: p } };
}

const rulesFor = (set: RuleSet, list: ListName): Rule[] => set.rules.filter((r) => r.list === list);

/** Conservative subset of acceptEdits: one literal filesystem command, no expansion or redirects. */
function modeFiles(command: string): string[] {
  const parsed = parseCommand(command);
  if (parsed.unparseable || parsed.commands.length !== 1) return [];
  const cmd = parsed.commands[0];
  if (cmd.nested || cmd.redirects.length || /[$`*?[\]{}~]/.test(command)) return [];
  const [program, ...args] = cmd.words;
  if (!['mkdir', 'touch', 'mv', 'cp'].includes(program)) return [];
  const paths = args.filter((arg) => !(program === 'mkdir' && arg === '-p'));
  if (paths.some((arg) => !arg || arg.startsWith('-'))) return [];
  if (paths.length < (program === 'cp' || program === 'mv' ? 2 : 1)) return [];
  return paths;
}

function bashMatches(set: RuleSet, list: ListName, command: string, call: ToolCall): { matches: Match[]; uncovered: string[]; steps: Step[]; unparseable: boolean; reasons: string[] } {
  const parsed = parseCommand(command);
  const rules = rulesFor(set, list);
  const matches: Match[] = [];
  const steps: Step[] = [];
  const uncovered: string[] = [];
  const forAllow = list === 'allow';
  const modePaths = set.mode === 'acceptEdits' ? modeFiles(command) : [];

  const toolLevel = rules.filter((r) => (r.tool === 'Bash' || (r.tool.includes('*') && r.tool !== 'Bash')) && ruleMatchesCall(r, call, set) && (r.specifier === undefined || r.specifier === '*' || paramRule('Bash', r.specifier) !== undefined));
  for (const r of toolLevel) matches.push({ rule: r, subject: command });

  const bashRules = rules.filter((r) => r.tool === 'Bash' && r.specifier !== undefined && r.specifier !== '*' && !ruleIsInert(r) && !paramRule('Bash', r.specifier));
  const fileCheck = (tool: 'Read' | 'Edit', target: string): Match | undefined => {
    const fileRules = rules.filter((r) => r.tool === tool && r.specifier !== undefined);
    const fc = pathCall(tool, target);
    const hit = fileRules.find((r) => ruleMatchesCall(r, fc, set));
    return hit ? { rule: hit, subject: `${tool === 'Read' ? 'reads' : 'writes'} ${target}` } : undefined;
  };

  if (forAllow && parsed.unparseable) {
    if (toolLevel.length === 0) uncovered.push(command);
    else steps.push({ decision: 'allow', rule: toolLevel[0], subject: command });
    return { matches, uncovered, steps, unparseable: true, reasons: parsed.reasons };
  }

  if (!forAllow && parsed.unparseable) {
    for (const r of bashRules) if (bashPatternMatches(r.specifier!, command.trim())) matches.push({ rule: r, subject: command.trim() });
  }

  for (const cmd of parsed.commands) {
    const s = stripCommand(cmd, forAllow);
    if (s.text !== '') {
      const hits = bashRules.filter((r) => bashPatternMatches(r.specifier!, s.text));
      for (const r of hits) matches.push({ rule: r, subject: s.text });
      const files = fileArguments(s);
      // Mode candidates must still consult explicit path restrictions.
      if (modePaths.length) {
        files.read.push(...modePaths);
        files.write.push(...modePaths);
      }
      const fileHits: Match[] = [];
      for (const f of files.read) {
        const m = fileCheck('Read', f);
        if (m) fileHits.push(m);
      }
      for (const f of files.write) {
        const m = fileCheck('Edit', f);
        if (m) fileHits.push(m);
      }
      if (!forAllow) matches.push(...fileHits);
      if (forAllow) {
        if (toolLevel.length > 0) steps.push({ decision: 'allow', rule: toolLevel[0], subject: s.text });
        else if (hits.length > 0) steps.push({ decision: 'allow', rule: hits[0], subject: s.text });
        else {
          const ro = readOnlyReason(s);
          if (ro) steps.push({ decision: 'allow', builtin: ro, subject: s.text });
          else if (modePaths.length && modePaths.every((p) => insideWorkingDirs(set, resolveRequestedPath(p, ctxOf(set))))) {
            steps.push({ decision: 'allow', builtin: 'acceptEdits filesystem command inside working directories', subject: s.text });
          }
          else uncovered.push(s.text);
        }
        for (const f of files.write) {
          if (fileHits.some((h) => h.subject === `writes ${f}`)) continue;
          const modeAllowed = modePaths.length > 0 && modePaths.every((p) => insideWorkingDirs(set, resolveRequestedPath(p, ctxOf(set))));
          if (toolLevel.length === 0 && !modeAllowed) uncovered.push(`${s.program} writes ${f}`);
        }
      }
    }
    for (const r of cmd.redirects) {
      if (r.target === undefined || r.target === '/dev/null') continue;
      const isWrite = r.op !== '<';
      const m = fileCheck(isWrite ? 'Edit' : 'Read', r.target);
      if (!forAllow) {
        if (m) matches.push({ rule: m.rule, subject: `redirect ${r.op} ${r.target}` });
        continue;
      }
      if (m) {
        steps.push({ decision: 'allow', rule: m.rule, subject: `redirect ${r.op} ${r.target}` });
        continue;
      }
      if (!isWrite) {
        const abs = resolveRequestedPath(r.target, ctxOf(set));
        const wd = insideWorkingDirs(set, abs);
        if (wd && !/[*?[]/.test(r.target)) {
          steps.push({ decision: 'allow', builtin: 'input redirect inside a working directory', subject: `redirect < ${r.target}` });
          continue;
        }
      }
      uncovered.push(`redirect ${r.op} ${r.target}`);
    }
  }
  return { matches, uncovered, steps, unparseable: false, reasons: parsed.reasons };
}

function uniqueRules(ms: Match[]): Rule[] {
  const out: Rule[] = [];
  for (const m of ms) if (!out.includes(m.rule)) out.push(m.rule);
  return out;
}

/** Evaluate one tool call against the merged rule set: deny, then ask, then allow, first match wins. */
export function evaluate(call: ToolCall, set: RuleSet): Verdict {
  const notes: string[] = [];
  if (call.tool === 'Bash') {
    const command = typeof call.input.command === 'string' ? call.input.command : '';
    const deny = bashMatches(set, 'deny', command, call);
    const ask = bashMatches(set, 'ask', command, call);
    const allow = bashMatches(set, 'allow', command, call);
    if (allow.unparseable) notes.push(`command could not be split (${allow.reasons.join('; ')}), so allow rules do not apply`);
    const all = [...deny.matches, ...ask.matches];
    const allowRules = allow.steps.filter((s) => s.rule).map((s) => s.rule!);
    if (deny.matches.length > 0) {
      const first = deny.matches[0];
      return {
        call,
        decision: 'deny',
        decidedBy: [{ decision: 'deny', rule: first.rule, subject: first.subject }],
        alsoMatched: [...uniqueRules(all).filter((r) => r !== first.rule), ...allowRules.filter((r, i, a) => a.indexOf(r) === i)],
        notes,
      };
    }
    if (ask.matches.length > 0) {
      const first = ask.matches[0];
      return {
        call,
        decision: 'ask',
        decidedBy: [{ decision: 'ask', rule: first.rule, subject: first.subject }],
        alsoMatched: [...uniqueRules(all).filter((r) => r !== first.rule), ...allowRules.filter((r, i, a) => a.indexOf(r) === i)],
        notes,
      };
    }
    if (allow.uncovered.length === 0 && allow.steps.length > 0) {
      return { call, decision: 'allow', decidedBy: allow.steps, alsoMatched: [], notes };
    }
    for (const u of allow.uncovered) notes.push(`no allow rule covers: ${u}`);
    return {
      call,
      decision: 'default',
      decidedBy: [{ decision: 'default', builtin: 'no rule matched every part of the command', subject: command }],
      alsoMatched: allowRules.filter((r, i, a) => a.indexOf(r) === i),
      notes,
    };
  }

  const matched: Rule[] = [];
  for (const r of set.rules) {
    if (ruleMatchesCall(r, call, set)) matched.push(r);
  }
  // A Read deny rule also blocks Edit and Write on the same path (NotebookEdit is not covered).
  if (EDIT_TOOLS.has(call.tool) && call.tool !== 'NotebookEdit') {
    const p = callPath(call);
    if (p !== undefined) {
      const asRead: ToolCall = { tool: 'Read', input: { file_path: p }, resolvedPath: call.resolvedPath };
      for (const r of set.rules) {
        if (r.list === 'deny' && r.tool === 'Read' && r.specifier !== undefined && ruleMatchesCall(r, asRead, set) && !matched.includes(r)) matched.push(r);
      }
    }
  }
  for (const list of ['deny', 'ask', 'allow'] as const) {
    const first = matched.find((r) => r.list === list);
    if (first) {
      return {
        call,
        decision: list,
        decidedBy: [{ decision: list, rule: first, subject: describeCall(call) }],
        alsoMatched: matched.filter((r) => r !== first),
        notes,
      };
    }
  }
  if (set.mode === 'acceptEdits' && EDIT_TOOLS.has(call.tool) && callPath(call) !== undefined) {
    const targets = [callPath(call)!, ...(call.resolvedPath === undefined ? [] : [call.resolvedPath])];
    if (targets.every((p) => insideWorkingDirs(set, resolveRequestedPath(p, ctxOf(set))))) {
      return {
        call, decision: 'allow',
        decidedBy: [{ decision: 'allow', builtin: 'acceptEdits edit inside working directories', subject: describeCall(call) }],
        alsoMatched: [], notes,
      };
    }
  }
  if (READ_TOOLS.has(call.tool)) {
    const p = callPath(call) ?? '.';
    const ctx = ctxOf(set);
    const abs = resolveRequestedPath(p, ctx);
    const targets = call.resolvedPath === undefined ? [abs] : [abs, resolveRequestedPath(call.resolvedPath, ctx)];
    const dirs = targets.map((t) => insideWorkingDirs(set, t));
    if (dirs.every((d) => d !== undefined)) {
      const dir = dirs[dirs.length - 1]!;
      return {
        call,
        decision: 'allow',
        decidedBy: [{ decision: 'allow', builtin: dir === set.projectDir ? 'reads inside the working directory need no approval' : `reads inside additional directory ${dir} need no approval`, subject: describeCall(call) }],
        alsoMatched: [],
        notes,
      };
    }
  }
  return { call, decision: 'default', decidedBy: [{ decision: 'default', builtin: 'no rule matched', subject: describeCall(call) }], alsoMatched: [], notes };
}

export function describeCall(call: ToolCall): string {
  if (call.tool === 'Bash') return `Bash(${String(call.input.command ?? '')})`;
  const p = callPath(call);
  if (p !== undefined) return `${call.tool}(${p}${call.resolvedPath ? ` -> ${call.resolvedPath}` : ''})`;
  if (call.tool === 'WebFetch') return `WebFetch(${String(call.input.url ?? '')})`;
  const primary = primaryString(call);
  return primary === undefined ? call.tool : `${call.tool}(${primary})`;
}

export function decisionLabel(d: Decision): string {
  return d === 'default' ? 'default ask' : d;
}
