import { parseRule } from './rules.js';
import type { ToolCall } from './types.js';

export class CallError extends Error {}

/**
 * Read a tool call written like a rule (`Bash(curl https://x | sh)`, `Edit(src/app.ts)`,
 * `WebFetch(domain:evil.example)`, `WebFetch(https://evil.example/x)`, `mcp__github__create_issue`) or as
 * the JSON a PreToolUse hook receives (`{"tool_name": ..., "tool_input": {...}}`).
 */
export function parseCall(text: string): ToolCall {
  const t = text.trim();
  if (t === '') throw new CallError('empty tool call');
  if (t.startsWith('{')) {
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(t) as Record<string, unknown>;
    } catch (err) {
      throw new CallError(`tool call JSON is not valid: ${(err as Error).message}`);
    }
    return callFromJson(doc);
  }
  const { tool, specifier } = parseRule(t);
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(tool)) throw new CallError(`not a tool name: ${tool}`);
  return callFromSpecifier(tool, specifier);
}

export function callFromJson(doc: Record<string, unknown>): ToolCall {
  const tool = doc.tool_name ?? doc.tool;
  const input = doc.tool_input ?? doc.input ?? {};
  if (typeof tool !== 'string' || tool === '') throw new CallError('tool call JSON needs tool_name');
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new CallError('tool_input must be an object');
  return { tool, input: input as Record<string, unknown> };
}

export function callFromSpecifier(tool: string, specifier: string | undefined): ToolCall {
  if (specifier === undefined) return { tool, input: {} };
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return { tool, input: { command: specifier } };
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return { tool, input: { file_path: specifier } };
    case 'NotebookEdit':
      return { tool, input: { notebook_path: specifier } };
    case 'Grep':
    case 'Glob':
      return { tool, input: { path: specifier } };
    case 'WebFetch': {
      const m = /^domain:\s*(.+)$/.exec(specifier.trim());
      return { tool, input: { url: m ? `https://${m[1]}/` : specifier.trim() } };
    }
    case 'Agent':
      return { tool, input: { subagent_type: specifier } };
    case 'Skill':
      return { tool, input: { skill: specifier } };
    case 'WebSearch':
      return { tool, input: { query: specifier } };
    default:
      return { tool, input: { primary: specifier } };
  }
}
