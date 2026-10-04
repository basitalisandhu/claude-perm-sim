/** Settings levels, highest precedence first (managed, command line, local, project, user). */
export type Scope = 'managed' | 'cli' | 'local' | 'project' | 'user';

export const SCOPE_ORDER: readonly Scope[] = ['managed', 'cli', 'local', 'project', 'user'];

export type ListName = 'deny' | 'ask' | 'allow';

/** Lists in evaluation order: deny, then ask, then allow. */
export const LIST_ORDER: readonly ListName[] = ['deny', 'ask', 'allow'];

export interface Source {
  scope: Scope;
  /** File the rules came from, or a label such as "--allowed-tools". */
  file: string;
  /** Directory a single-slash path pattern (`/path`) anchors at for rules from this source. */
  anchor: string;
}

export interface ParsedRule {
  /** Tool name or tool-name glob, for example `Bash`, `mcp__github__*`, `*`. */
  tool: string;
  /** Text inside the parentheses, or undefined for a bare tool rule. */
  specifier?: string;
}

export interface Rule extends ParsedRule {
  raw: string;
  list: ListName;
  source: Source;
  /** Position inside its list in its source file. */
  index: number;
}

export interface RuleSet {
  rules: Rule[];
  sources: Source[];
  /** Absolute directories from `permissions.additionalDirectories`, with the source of each. */
  additionalDirectories: { dir: string; raw: string; source: Source }[];
  defaultMode?: { value: string; source: Source };
  /** True when managed settings set `allowManagedPermissionRulesOnly`. */
  managedOnly: boolean;
  /** Primary working directory of the simulated session. */
  projectDir: string;
  home: string;
  warnings: string[];
}

export type Decision = 'deny' | 'ask' | 'allow' | 'default';

/** A tool call to simulate. */
export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
  /** For path tools: the file a symlinked path resolves to, when modelling a symlink. */
  resolvedPath?: string;
}

/** Why part of a call got its outcome. */
export interface Step {
  decision: Decision;
  /** The rule that matched, when a rule decided. */
  rule?: Rule;
  /** Built-in behaviour that decided when no rule did, for example "built-in read-only command". */
  builtin?: string;
  /** The part of the call this step is about: a subcommand, a redirect target, a path. */
  subject: string;
}

export interface Verdict {
  call: ToolCall;
  /** Final outcome. `default` means no rule matched and Claude Code prompts (Manual mode). */
  decision: Decision;
  /** `allow` that comes from built-in behaviour rather than a rule is still `allow`; see `steps`. */
  decidedBy: Step[];
  /** Rules that matched the call but did not decide it. */
  alsoMatched: Rule[];
  notes: string[];
}

export type Severity = 'high' | 'medium' | 'low' | 'info';

export const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1, info: 0 };

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  message: string;
  /** The rule the finding is about (lint) or the rule that allowed the probe (bypass). */
  rule?: Rule;
  /** The probe call, for bypass findings. */
  probe?: string;
  family?: string;
  suggestion?: string;
}
