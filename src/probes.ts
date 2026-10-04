import { bashPrefix, isExecCapablePrefix } from './bash.js';
import { domainOfSpecifier } from './domains.js';
import { compilePathRule } from './paths.js';
import { paramRule, splitMcpName } from './rules.js';
import { rulesIn } from './settings.js';
import type { Finding, RuleSet, Severity } from './types.js';

/**
 * The bypass analysis is structural and defensive. It reads the allow rules the loader produced and,
 * using the matching semantics implemented elsewhere in this package, reports where a rule admits more
 * than it names. It never constructs, prints, or runs an attack: every finding names the rule, the
 * weakness class, and a tighter rule, and uses inert placeholders such as `<command-after-separator>`,
 * `<path-outside-scope>`, and `sub.<domain>` for illustration only.
 */

export interface BypassContext {
  /** MCP server names the project configures (from `.mcp.json` or `--mcp-server`). */
  mcpServers?: string[];
  /** Fully qualified MCP tool names known to exist (`mcp__server__tool`), to flag ones no rule covers. */
  mcpTools?: string[];
}

const PLACEHOLDER = {
  command: '<command-after-separator>',
  path: '<path-outside-scope>',
  subdomain: 'sub.<domain>',
  lookalike: '<lookalike-domain>',
  mcpTool: '<tool>',
};

/** Bash allow rules whose prefix lets unrelated commands through. */
function bashFindings(set: RuleSet): Finding[] {
  const out: Finding[] = [];
  for (const rule of rulesIn(set, 'allow')) {
    if (rule.tool !== 'Bash' && rule.tool !== 'PowerShell') continue;
    const spec = rule.specifier;
    if (spec === undefined || spec === '*') {
      out.push({
        id: 'BYP-BASH-ALL',
        severity: 'high',
        family: 'bash-wildcard',
        title: 'every command is allowed',
        message: `${rule.raw} allows every ${rule.tool} command, so no deny or ask rule aside, any command runs without a prompt.`,
        rule,
        probe: PLACEHOLDER.command,
        suggestion: 'replace with one rule per command family you trust, such as Bash(npm run *) and Bash(git commit *)',
      });
      continue;
    }
    if (paramRule(rule.tool, spec)) continue;
    const prefix = bashPrefix(spec);
    if (prefix === '') {
      out.push({
        id: 'BYP-BASH-LEADING-STAR',
        severity: 'high',
        family: 'bash-wildcard',
        title: 'wildcard stands in for the program',
        message: `${rule.raw} begins its match with a wildcard, so the program itself is unconstrained and any program can satisfy the rule.`,
        rule,
        probe: PLACEHOLDER.command,
        suggestion: 'name the program before the first * , such as Bash(node --version)',
      });
      continue;
    }
    if (isExecCapablePrefix(prefix)) {
      out.push({
        id: 'BYP-BASH-EXEC-RUNNER',
        severity: 'high',
        family: 'bash-exec-runner',
        title: 'prefix runs an arbitrary inner command',
        message: `${rule.raw} fixes a prefix (${prefix}) that executes whatever follows it, so the trailing wildcard chooses the program or code that runs.`,
        rule,
        probe: `${prefix} ${PLACEHOLDER.command}`,
        suggestion: `write one exact rule per inner command, such as ${rule.tool}(${prefix} <specific-inner-command>), rather than a trailing wildcard`,
      });
    }
    // A trailing " *" with a space admits anything after the prefix, including a separator or wrapper.
    if (spec.endsWith(' *') || spec.endsWith(':*')) {
      const sev: Severity = /\b(rm|curl|wget|chmod|chown|dd|mkfs|git push|sudo|kill)\b/.test(prefix) ? 'medium' : 'low';
      out.push({
        id: 'BYP-BASH-TRAILING',
        severity: sev,
        family: 'bash-trailing-wildcard',
        title: 'trailing wildcard matches the whole tail',
        message: `${rule.raw} matches everything after "${prefix}". Claude Code splits separators (&&, ||, ;, |, newline) and strips the documented wrappers, so each subcommand is matched on its own; the risk is that the trailing wildcard also covers long argument tails you did not intend. Pair it with deny rules for dangerous programs.`,
        rule,
        probe: `${prefix} <arguments>`,
        suggestion: 'narrow the wildcard to the arguments you expect, and add deny rules for curl, wget, rm and similar programs',
      });
    }
  }
  return out;
}

/** Read and Edit allow scopes that resolve outside their apparent directory. */
function pathFindings(set: RuleSet): Finding[] {
  const out: Finding[] = [];
  const ctx = { projectDir: set.projectDir, home: set.home };
  for (const rule of rulesIn(set, 'allow')) {
    if (rule.tool !== 'Read' && rule.tool !== 'Edit') continue;
    const spec = (rule.specifier ?? '').trim();
    if (spec === '' || spec === '*' || spec.startsWith('!')) continue;
    const c = compilePathRule(rule, ctx);
    if (spec === '**' || spec === '//**' || spec === '/**' || spec === '~/**' || spec === './**') {
      out.push({
        id: 'BYP-PATH-ALL',
        severity: rule.tool === 'Edit' ? 'high' : 'medium',
        family: 'path-unbounded',
        title: 'scope covers an entire tree',
        message: `${rule.raw} grants ${rule.tool === 'Edit' ? 'edit' : 'read'} access to everything under ${c.base}. One line removes the per-directory boundary the rest of your rules rely on.`,
        rule,
        probe: PLACEHOLDER.path,
        suggestion: 'scope the rule to the directories you actually edit, such as Edit(src/**) and Edit(test/**)',
      });
      continue;
    }
    if (spec.includes('..')) {
      out.push({
        id: 'BYP-PATH-PARENT',
        severity: 'high',
        family: 'path-escape',
        title: 'scope reaches above its directory',
        message: `${rule.raw} contains a parent segment (..), so the directory it names is not the directory it grants. Parent segments let a path climb out of the intended scope.`,
        rule,
        probe: PLACEHOLDER.path,
        suggestion: 'remove the .. and anchor the rule at the directory you mean with a leading / (settings-relative) or // (absolute)',
      });
    }
    // Deny/ask single-segment directory rules match at any depth; an allow rule with the same shape does not,
    // which can read as broader than it is. Flag the inverse risk: a bare filename allow with no directory.
    if (!spec.includes('/') && rule.tool === 'Edit' && /[*?]/.test(spec)) {
      out.push({
        id: 'BYP-PATH-BARE-GLOB',
        severity: 'medium',
        family: 'path-depth',
        title: 'bare glob name is broad',
        message: `${rule.raw} has no directory part. A bare name follows gitignore semantics; as an allow rule it matches at the current directory, but it is easy to misread as one directory when it covers every match there.`,
        rule,
        probe: PLACEHOLDER.path,
        suggestion: 'put the directory in the rule, such as Edit(src/**/*.ts)',
      });
    }
  }
  // A Read or Edit deny that a symlink could sidestep: note the resolved-path rule, informational.
  return out;
}

/** WebFetch domain rules that admit more hosts than the apex they appear to name. */
function domainFindings(set: RuleSet): Finding[] {
  const out: Finding[] = [];
  for (const rule of rulesIn(set, 'allow')) {
    if (rule.tool !== 'WebFetch') continue;
    const domain = domainOfSpecifier(rule.specifier);
    if (rule.specifier === undefined) continue; // bare WebFetch handled by lint
    if (domain === undefined) continue;
    const d = domain.trim().toLowerCase();
    if (d === '*') {
      out.push({
        id: 'BYP-WEB-ALL',
        severity: 'high',
        family: 'domain-wildcard',
        title: 'every domain is allowed',
        message: `${rule.raw} allows fetches to any host and, in the sandbox, lets commands reach any host.`,
        rule,
        probe: `https://${PLACEHOLDER.lookalike}/`,
        suggestion: 'list the specific domains you fetch, such as WebFetch(domain:docs.example.com)',
      });
      continue;
    }
    if (d.startsWith('*.')) {
      out.push({
        id: 'BYP-WEB-SUBDOMAIN',
        severity: 'medium',
        family: 'domain-subdomain',
        title: 'wildcard admits every subdomain',
        message: `${rule.raw} matches ${PLACEHOLDER.subdomain} at any depth. A subdomain an attacker can register under ${d.slice(2)} would be admitted; the apex itself is not.`,
        rule,
        probe: PLACEHOLDER.subdomain,
        suggestion: `name each subdomain you trust, such as WebFetch(domain:api.${d.slice(2)})`,
      });
      continue;
    }
    if (d.includes('*')) {
      out.push({
        id: 'BYP-WEB-MIDWILDCARD',
        severity: 'medium',
        family: 'domain-wildcard',
        title: 'wildcard label admits lookalikes',
        message: `${rule.raw} uses a wildcard inside the hostname. It matches the text between two dots, so sibling labels an attacker could register may be admitted.`,
        rule,
        probe: PLACEHOLDER.lookalike,
        suggestion: 'replace the wildcard label with the exact hostnames you fetch',
      });
    }
  }
  return out;
}

/** MCP tools that no rule covers (default ask) and wildcard MCP allow rules. */
function mcpFindings(set: RuleSet, bctx: BypassContext): Finding[] {
  const out: Finding[] = [];
  for (const rule of rulesIn(set, 'allow')) {
    if (!rule.tool.startsWith('mcp__')) continue;
    if (rule.tool.endsWith('__*') || rule.tool.includes('*')) {
      const parts = splitMcpName(rule.tool.replace(/\*+$/, ''));
      out.push({
        id: 'BYP-MCP-WILDCARD',
        severity: 'medium',
        family: 'mcp-wildcard',
        title: 'wildcard allows every tool on a server',
        message: `${rule.raw} allows every tool the ${parts?.server ?? 'named'} server exposes now and every tool it adds later, including a destructive one shipped in a future version.`,
        rule,
        probe: `mcp__${parts?.server ?? '<server>'}__${PLACEHOLDER.mcpTool}`,
        suggestion: 'allow one tool at a time, such as mcp__server__read_only_tool, so a new tool is not auto-approved',
      });
    }
  }
  const tools = bctx.mcpTools ?? [];
  for (const tool of tools) {
    const covered = set.rules.some((r) => {
      if (r.list !== 'allow') return false;
      if (r.tool === tool) return true;
      if (r.tool.includes('*')) {
        const m = /^mcp__([^*]+?)__/.exec(r.tool);
        if (!m) return false;
        return new RegExp('^' + r.tool.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(tool);
      }
      const rn = splitMcpName(r.tool);
      const tn = splitMcpName(tool);
      return rn !== undefined && tn !== undefined && rn.tool === undefined && rn.server === tn.server;
    });
    const denied = set.rules.some((r) => (r.list === 'deny' || r.list === 'ask') && (r.tool === tool || r.tool === 'mcp__*' || r.tool === '*'));
    if (!covered && !denied) {
      out.push({
        id: 'BYP-MCP-UNCOVERED',
        severity: 'info',
        family: 'mcp-uncovered',
        title: 'tool is covered by no rule',
        message: `${tool} matches no allow, ask, or deny rule, so Claude Code prompts for it (default ask). An unattended run stalls on it.`,
        probe: tool,
        suggestion: `decide the tool explicitly: allow it if it is read-only (${tool}), or add it to ask or deny`,
      });
    }
  }
  return out;
}

export function findBypasses(set: RuleSet, bctx: BypassContext = {}): Finding[] {
  return [...bashFindings(set), ...pathFindings(set), ...domainFindings(set), ...mcpFindings(set, bctx)];
}
