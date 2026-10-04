import type { ParsedRule } from './types.js';

/**
 * Parse `Tool` or `Tool(specifier)`. Parentheses inside the specifier are literal, so the
 * specifier runs from the first `(` to the final `)`.
 */
export function parseRule(raw: string): ParsedRule {
  const text = raw.trim();
  const open = text.indexOf('(');
  if (open > 0 && text.endsWith(')')) {
    return { tool: text.slice(0, open).trim(), specifier: text.slice(open + 1, -1) };
  }
  return { tool: text };
}

export function formatRule(rule: ParsedRule): string {
  return rule.specifier === undefined ? rule.tool : `${rule.tool}(${rule.specifier})`;
}

/** File tools whose path rules Claude Code consults: `Read` and `Edit` only. */
export const PATH_RULE_TOOLS = new Set(['Read', 'Edit']);

/** Tools whose path rules are accepted but never consulted. */
export const UNCONSULTED_PATH_TOOLS = new Set(['Write', 'NotebookEdit', 'Glob', 'MultiEdit']);

/** Primary content fields that a `Tool(param:value)` rule may not name. */
export const PRIMARY_FIELDS: Record<string, string> = {
  Bash: 'command',
  PowerShell: 'command',
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  Grep: 'path',
  Glob: 'path',
  NotebookEdit: 'notebook_path',
  WebFetch: 'url',
};

/** Input parameters recognised for `Tool(param:value)` rules on tools with their own specifier syntax. */
const KNOWN_PARAMS: Record<string, string[]> = {
  Bash: ['run_in_background', 'timeout', 'description', 'dangerouslyDisableSandbox'],
  PowerShell: ['run_in_background', 'timeout', 'description'],
  Agent: ['model', 'isolation', 'subagent_type', 'run_in_background', 'description', 'name'],
  Skill: ['skill', 'args'],
  WebFetch: ['prompt'],
  WebSearch: ['query'],
};

/** Built-in tool names, used to flag rules that name no known tool. */
export const KNOWN_TOOLS = new Set([
  'Agent',
  'AskUserQuestion',
  'Bash',
  'Cd',
  'Edit',
  'EndConversation',
  'Glob',
  'Grep',
  'Monitor',
  'MultiEdit',
  'NotebookEdit',
  'PowerShell',
  'Read',
  'Skill',
  'TaskStop',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
]);

export interface ParamRule {
  name: string;
  value: string;
}

/**
 * Recognise a `Tool(param:value)` rule. A Bash `prefix:*` rule is not a parameter rule; neither is a
 * WebFetch `domain:` rule. Primary content fields are returned so callers can report them as ignored.
 */
export function paramRule(tool: string, specifier: string | undefined): ParamRule | undefined {
  if (specifier === undefined) return undefined;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]*)$/.exec(specifier);
  if (!m) return undefined;
  const name = m[1];
  if (tool === 'WebFetch' && name === 'domain') return undefined;
  if (PRIMARY_FIELDS[tool] === name) return { name, value: m[2] };
  const known = KNOWN_PARAMS[tool];
  if (known) return known.includes(name) ? { name, value: m[2] } : undefined;
  if (PATH_RULE_TOOLS.has(tool) || UNCONSULTED_PATH_TOOLS.has(tool)) return undefined;
  if (tool.startsWith('mcp__')) return { name, value: m[2] };
  return name.length > 1 ? { name, value: m[2] } : undefined;
}

export function isGlob(text: string): boolean {
  return text.includes('*');
}

/** Escape a string for use inside a RegExp. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `*` matches any run of characters; everything else is literal. */
export function starGlobToRegex(glob: string, flags = ''): RegExp {
  return new RegExp('^' + glob.split('*').map(escapeRegex).join('[\\s\\S]*') + '$', flags);
}

/** Split `mcp__<server>__<tool>` into its parts. */
export function splitMcpName(name: string): { server: string; tool?: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined;
  const rest = name.slice(5);
  const sep = rest.indexOf('__');
  if (sep < 0) return { server: rest };
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}
