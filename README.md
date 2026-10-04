# claude-perm-sim: Claude Code permission rule simulator

**claude-perm-sim loads your merged Claude Code permission settings, tells you which rule decides any given tool call, and finds the bypasses: commands that slip past a Bash pattern, paths that escape an Edit scope, and MCP tools nothing covers.**

[![CI](https://github.com/basitalisandhu/claude-perm-sim/actions/workflows/ci.yml/badge.svg)](https://github.com/basitalisandhu/claude-perm-sim/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-20%2B-blue.svg)](package.json)

## What it does, who it is for, and why

Claude Code decides every tool call against permission rules spread across managed, command-line, local, project, and user settings, evaluated deny first, then ask, then allow. The rules match the text the model writes, with wildcards, wrappers, compound-command splitting, and gitignore-style path anchoring, and the [docs say plainly](https://code.claude.com/docs/en/permissions) a Bash rule "isn't a security boundary around the program". That leaves two everyday questions hard to answer by reading the files: which rule actually decides a call, and where a rule you wrote admits more than you meant.

claude-perm-sim answers both. It is for developers and teams who hand-write Claude Code permission rules and want to see the effective rule set, trace one decision, and catch a rule that is broader than it looks before it ships.

- `load` merges the settings files in the documented precedence and prints the effective allow, ask, and deny lists with the source file of each rule.
- `explain "<tool call>"` prints the decision and the exact rule and file that decided it, plus the rules that also matched but lost.
- `bypass` reads your allow rules and reports, structurally, where one admits more than it names: a Bash prefix that runs an arbitrary inner command, an Edit or Read scope that resolves outside its directory, a WebFetch rule that admits subdomains or lookalikes, and MCP tools no rule covers. It does not generate attacks (see [What this is not](#what-this-is-not)).
- `lint` runs static checks on the rule set: duplicates, allow rules shadowed by deny, overly broad patterns, rules that can never match, mixed slash styles, and allow rules that belong in ask.
- `diff` shows what changed between two settings files in decision terms: which sample calls flip.

Output is `table` (default), `json`, or `sarif`; `--format hook` prints a PreToolUse hook snippet that runs `explain` for logging. TypeScript, Node 20 or newer, no runtime dependencies.

## Install

Requires Node 20 or newer.

Every release is published by `publish-github-packages.yml` in two places on GitHub Packages: the npm package `@basitalisandhu/claude-perm-sim` and the container image `ghcr.io/basitalisandhu/claude-perm-sim`. The package is not on npmjs.com yet; when it is, it will use the same scoped name.

### npm from GitHub Packages

Point the `@basitalisandhu` scope at GitHub Packages in `~/.npmrc` (GitHub's npm registry asks for a token with the `read:packages` scope even for public packages, exported as `GITHUB_TOKEN`):

```
@basitalisandhu:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
npx @basitalisandhu/claude-perm-sim load                 # run without installing
npm install -g @basitalisandhu/claude-perm-sim@0.1.0     # or install the claude-perm-sim command
```

### Container image

The image runs as the non-root `node` user with `/work` as the working directory; mount your project there:

```bash
docker run --rm -v "$PWD:/work" ghcr.io/basitalisandhu/claude-perm-sim:0.1.0 load
```

## Quickstart

```bash
# From the root of a project that has .claude/settings.json:
claude-perm-sim load                                  # the effective rule set, with sources
claude-perm-sim explain "Bash(cd /tmp && git clean -f)"   # which rule decides it
claude-perm-sim explain "Edit(src/app.ts)"
claude-perm-sim explain "WebFetch(domain:evil.example)"
claude-perm-sim bypass                                # where allow rules are too permissive
claude-perm-sim lint                                  # static problems in the rule set
claude-perm-sim diff before.json after.json           # which decisions change
```

`explain` also reads the JSON a PreToolUse hook receives on stdin, so you can pass a real tool call:

```bash
claude-perm-sim explain '{"tool_name":"Bash","tool_input":{"command":"npm run build"}}'
```

By default the tool reads the same files Claude Code does. Override any source with `--project <dir>`, `--user <file|none>`, `--local <file|none>`, `--managed <file|none>`, add one with `--settings <file>`, or inject command-line rules with `--allow-tool` and `--deny-tool`. Use `--untrusted` to model a folder whose workspace trust dialog was not accepted, where project allow rules are held back.

## When to use this

- **Which rule is deciding this call?** `explain "<call>"` prints the deciding rule, its file, and the rules that also matched but lost to deny-then-ask-then-allow order.
- **Is my allow list broader than I think?** `bypass` reports each allow rule that admits more than it names, with the weakness class and a tighter rule. It exits 1 on a HIGH finding, so CI can gate on it.
- **Did this settings change widen anything?** `diff old.json new.json` lists the sample calls whose decision flips.
- **Are there dead or dangerous rules?** `lint` finds duplicates, shadowed allows, broad patterns, and rules Claude Code accepts but never applies.
- **Can I log every decision during a session?** `--format hook` prints a PreToolUse hook that runs `explain` for logging only; it never changes a decision.

## Bypass families

Each finding names the rule, the weakness class, and a tighter rule, and uses an inert placeholder for illustration. It never prints a runnable command.

| Family | What it flags | Tighter rule it suggests |
| --- | --- | --- |
| `bash-wildcard` | `Bash(*)` or a pattern whose wildcard stands in for the program | one rule per command family |
| `bash-exec-runner` | an allow prefix (`sh`, `node`, `npx`, `git -c`, `docker run`, ...) that runs whatever follows it | one exact rule per inner command |
| `bash-trailing-wildcard` | a trailing `*` that also covers long, unintended argument tails | narrow the wildcard; add deny rules for risky programs |
| `path-unbounded` | a Read or Edit scope that covers an entire tree (`**`, `/**`, `~/**`) | scope to the directories you use |
| `path-escape` | a scope with a `..` segment that climbs out of its directory | anchor with `/` or `//`, remove the `..` |
| `domain-subdomain` | `*.example.com`, which admits any subdomain an attacker could register | name each subdomain you trust |
| `domain-wildcard` | `domain:*` or a mid-label wildcard that admits lookalikes | list exact hostnames |
| `mcp-wildcard` | `mcp__server__*`, which also allows tools added in a future version | allow one tool per rule |
| `mcp-uncovered` | an MCP tool no rule covers, so Claude Code prompts (default ask) | decide the tool explicitly |

## How matching is modelled

The matching semantics come from the Claude Code [permissions](https://code.claude.com/docs/en/permissions), [settings](https://code.claude.com/docs/en/settings), [managed settings](https://code.claude.com/docs/en/managed-settings), and [hooks](https://code.claude.com/docs/en/hooks) pages. Where the docs state a rule exactly, the tool follows it; where behaviour is described only in prose, the tool labels its reading as inferred in [docs/semantics.md](docs/semantics.md). Because the docs can change between Claude Code versions, treat a decision from this tool as a close model, not a guarantee, and confirm a specific case with `/permissions` in Claude Code.

## Frequently asked questions

**Does this change my settings?**
No. Every command is read-only. It reads settings files and prints results; it never writes a settings file and never runs any command it analyses.

**Is the output exactly what Claude Code will do?**
It models the documented rules closely and is tested against them, but Claude Code's parser, version, and undocumented built-ins can differ. Use it to understand and tighten a rule set, then verify a specific decision in Claude Code with `/permissions`.

**Does `bypass` produce exploits I can run?**
No. It is structural: it reads your allow rules and reports where one is more permissive than it looks, using inert placeholders such as `<command-after-separator>` and `sub.<domain>`. It never emits a runnable command or URL. See [What this is not](#what-this-is-not).

**How does this relate to agent-config-audit?**
[agent-config-audit](https://github.com/basitalisandhu/agent-config-audit) flags risky rules, secrets, and unpinned servers across a project's whole agent configuration; claude-perm-sim simulates the permission engine itself: which rule decides a call, and where a rule admits more than it names. Use both.

**Why does Claude Code still prompt for a call this tool says is allowed?**
Several documented reasons: an ask rule from any settings file prompts even when an allow rule also matches; a project's allow rules apply only after you accept the workspace trust dialog; a tool marked `requiresUserInteraction` prompts on every call; and a connector tool your organisation set to `ask` is never auto-approved. `load` shows every rule and its source so you can see which one applies.

## What this is not

- **It is not a sandbox.** It models permission rules; it does not enforce anything. For OS-level filesystem and network enforcement, use [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing).
- **It cannot replace OS-level controls.** A Bash rule matches command text, not the program, so it is not a boundary around a program; the docs say so. Pair rules with the sandbox and PreToolUse hooks for enforcement.
- **It does not generate attacks.** `bypass` shows where a rule set is permissive; it does not generate attacks. Findings are structural and use inert placeholders.

## Development

```bash
npm install
npm test            # builds, then runs vitest against the fixture rule sets
npm run typecheck
```

Fixtures under `test/fixtures/` hold tight and permissive settings files with no real paths and no secrets. See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/good-first-issues.md](docs/good-first-issues.md), [docs/semantics.md](docs/semantics.md), and [SECURITY.md](SECURITY.md).

## Related projects

More tools by the same author: https://github.com/basitalisandhu

- [claude-mcp-allow](https://github.com/basitalisandhu/claude-mcp-allow): generate least-privilege Claude Code permission rules from MCP tool annotations.
- [cc-plugin-lock](https://github.com/basitalisandhu/cc-plugin-lock): pin and verify Claude Code plugins and skills against content hashes.
- [agent-config-audit](https://github.com/basitalisandhu/agent-config-audit): audit agent configuration files for risky permissions, secrets, and prompt-injection text.
- [cc-hooks](https://github.com/basitalisandhu/cc-hooks): typed SDK and offline test runner for Claude Code hooks.

## Licence

MIT, see [LICENSE](LICENSE). Copyright 2026 Muhammad Basit Ali.
