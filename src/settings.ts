import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRule } from './rules.js';
import type { ListName, Rule, RuleSet, Scope, Source } from './types.js';
import { LIST_ORDER, SCOPE_ORDER } from './types.js';

export class SettingsError extends Error {}

export interface LoadOptions {
  /** Primary working directory. Project and local settings are read from `<project>/.claude/`. */
  project: string;
  /** User settings file, or `none`. Default: `$CLAUDE_CONFIG_DIR/settings.json` or `~/.claude/settings.json`. */
  user?: string;
  /** Project settings file, or `none`. Default: `<project>/.claude/settings.json`. */
  projectFile?: string;
  /** Local settings file, or `none`. Default: `<project>/.claude/settings.local.json`. */
  local?: string;
  /** Managed settings file, or `none`. Default: the platform path, when it exists. */
  managed?: string;
  /** Files passed as `--settings`. */
  settings?: string[];
  /** Rules passed on the command line, as `--allowedTools` and `--disallowedTools` would. */
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Simulate a folder whose workspace trust dialog was not accepted: project allow rules and directories are held. */
  untrusted?: boolean;
  home?: string;
  platform?: NodeJS.Platform;
}

/** Documented system directory for managed settings, per platform. */
export function managedDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

export function defaultUserSettings(home: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  return path.join(configDir && configDir.length > 0 ? configDir : path.join(home, '.claude'), 'settings.json');
}

export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

interface SettingsDoc {
  permissions?: {
    allow?: unknown;
    ask?: unknown;
    deny?: unknown;
    additionalDirectories?: unknown;
    defaultMode?: unknown;
  };
  allowManagedPermissionRulesOnly?: unknown;
}

export function readSettings(file: string): SettingsDoc | undefined {
  if (!existsSync(file)) return undefined;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new SettingsError(`cannot read ${file}: ${(err as Error).message}`);
  }
  if (text.trim() === '') return {};
  try {
    const doc = JSON.parse(text) as unknown;
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new SettingsError(`${file} is not a JSON object`);
    }
    return doc as SettingsDoc;
  } catch (err) {
    if (err instanceof SettingsError) throw err;
    throw new SettingsError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
}

function stringList(value: unknown, where: string, warnings: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`${where} is not an array; ignored`);
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else warnings.push(`${where} has a non-string entry; ignored`);
  }
  return out;
}

interface LoadedFile {
  source: Source;
  doc: SettingsDoc;
}

/** Read every settings source in documented precedence and merge the permission lists. */
export function loadRuleSet(opts: LoadOptions): RuleSet {
  const home = opts.home ?? os.homedir();
  const project = path.resolve(opts.project);
  const warnings: string[] = [];
  const files: LoadedFile[] = [];

  const add = (scope: Scope, file: string | undefined, fallback: string, anchor: (f: string) => string): void => {
    if (file === 'none') return;
    const target = path.resolve(file ?? fallback);
    const doc = readSettings(target);
    if (doc === undefined) {
      if (file !== undefined) throw new SettingsError(`${scope} settings file not found: ${target}`);
      return;
    }
    files.push({ source: { scope, file: target, anchor: anchor(target) }, doc });
  };

  // Managed: managed-settings.json, then managed-settings.d/*.json in alphabetical order.
  if (opts.managed !== 'none') {
    const managedFile = opts.managed ?? path.join(managedDir(opts.platform), 'managed-settings.json');
    add('managed', opts.managed, managedFile, () => project);
    const dropIn = path.join(path.dirname(path.resolve(managedFile)), 'managed-settings.d');
    if (existsSync(dropIn) && statSync(dropIn).isDirectory()) {
      for (const name of readdirSync(dropIn).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort()) {
        add('managed', path.join(dropIn, name), '', () => project);
      }
    }
  }
  for (const file of opts.settings ?? []) add('cli', file, file, (f) => path.dirname(f));
  add('local', opts.local, path.join(project, '.claude', 'settings.local.json'), () => project);
  add('project', opts.projectFile, path.join(project, '.claude', 'settings.json'), () => project);
  add('user', opts.user, defaultUserSettings(home), (f) => path.dirname(f));

  const cliFlags: Source = { scope: 'cli', file: 'command line flags', anchor: project };
  const flagRules: { list: ListName; raw: string }[] = [
    ...(opts.disallowedTools ?? []).map((raw) => ({ list: 'deny' as const, raw })),
    ...(opts.allowedTools ?? []).map((raw) => ({ list: 'allow' as const, raw })),
  ];

  const managedOnly = files.some((f) => f.source.scope === 'managed' && f.doc.allowManagedPermissionRulesOnly === true);
  const rules: Rule[] = [];
  const additionalDirectories: RuleSet['additionalDirectories'] = [];
  let defaultMode: RuleSet['defaultMode'];

  const ordered = [...files].sort((a, b) => SCOPE_ORDER.indexOf(a.source.scope) - SCOPE_ORDER.indexOf(b.source.scope));
  const sources: Source[] = [];
  for (const { source, doc } of ordered) {
    sources.push(source);
    const perms = doc.permissions ?? {};
    if (typeof perms !== 'object' || perms === null) continue;
    const ignoreRules = managedOnly && source.scope !== 'managed';
    for (const list of LIST_ORDER) {
      const raws = stringList(perms[list], `${source.file}: permissions.${list}`, warnings);
      if (ignoreRules) continue;
      if (list === 'allow' && opts.untrusted && source.scope === 'project') continue;
      raws.forEach((raw, index) => rules.push({ ...parseRule(raw), raw, list, source, index }));
    }
    if (!(opts.untrusted && source.scope === 'project')) {
      for (const raw of stringList(perms.additionalDirectories, `${source.file}: permissions.additionalDirectories`, warnings)) {
        additionalDirectories.push({ raw, dir: path.resolve(project, expandHome(raw, home)), source });
      }
    }
    if (typeof perms.defaultMode === 'string' && defaultMode === undefined) {
      defaultMode = { value: perms.defaultMode, source };
    }
  }
  if (flagRules.length > 0) {
    if (!managedOnly) {
      sources.splice(sources.filter((s) => s.scope === 'managed').length, 0, cliFlags);
      const counters: Record<ListName, number> = { deny: 0, ask: 0, allow: 0 };
      for (const { list, raw } of flagRules) rules.push({ ...parseRule(raw), raw, list, source: cliFlags, index: counters[list]++ });
    } else {
      warnings.push('allowManagedPermissionRulesOnly is set in managed settings; command line rules are ignored');
    }
  }
  if (managedOnly) warnings.push('allowManagedPermissionRulesOnly is set: only managed permission rules apply');

  // Keep rules in precedence order: by scope, then file order, then position.
  const scopeRank = (r: Rule): number => SCOPE_ORDER.indexOf(r.source.scope);
  const fileRank = (r: Rule): number => sources.indexOf(r.source);
  rules.sort((a, b) => scopeRank(a) - scopeRank(b) || fileRank(a) - fileRank(b) || a.index - b.index);

  return { rules, sources, additionalDirectories, defaultMode, managedOnly, projectDir: project, home, warnings };
}

/** Build a rule set from one settings file read as project settings (used by `diff`). */
export function ruleSetFromFile(file: string, project: string, home = os.homedir()): RuleSet {
  return loadRuleSet({ project, projectFile: file, local: 'none', user: 'none', managed: 'none', home });
}

export function rulesIn(set: RuleSet, list: ListName): Rule[] {
  return set.rules.filter((r) => r.list === list);
}
