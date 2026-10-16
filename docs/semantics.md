# Matching semantics

This file records how claude-perm-sim models Claude Code's permission engine, and which parts are
documented versus inferred. The sources are the Claude Code
[permissions](https://code.claude.com/docs/en/permissions),
[settings](https://code.claude.com/docs/en/settings),
[managed settings](https://code.claude.com/docs/en/managed-settings), and
[hooks](https://code.claude.com/docs/en/hooks) pages. Where a page states a rule exactly, the tool
follows it. Where behaviour is described only in prose, or not at all, the tool makes a conservative
choice and labels it "inferred" below. The docs change between versions, so treat the output as a close
model and confirm a specific case with `/permissions`.

This tool shows where a rule set is permissive; it does not generate attacks. The `bypass` command reads
your allow rules and reports structural weaknesses with inert placeholders; it never constructs or prints
a runnable command.

## Evaluation order (documented)

Rules are evaluated deny, then ask, then allow; the first match in that order decides, and specificity
does not change the order. A deny from any scope beats an allow from any other. When no rule matches, the
call is reported as `default`, which is the Manual-mode prompt.

## Settings precedence (documented)

Highest first: managed settings, command-line (`--settings`, `--allowedTools`, `--disallowedTools`),
project local (`.claude/settings.local.json`), shared project (`.claude/settings.json`), user
(`~/.claude/settings.json`). List keys such as `permissions.allow` merge across scopes rather than
overriding. Managed settings read `managed-settings.json` and then every `*.json` in `managed-settings.d/`
in alphabetical order; the platform directory is `/Library/Application Support/ClaudeCode` on macOS,
`/etc/claude-code` on Linux and WSL, and `C:\Program Files\ClaudeCode` on Windows.
`allowManagedPermissionRulesOnly` makes managed settings the only source of permission rules.

## Bash (documented, with inferred lists)

- Separators recognised for splitting: `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines (documented). A rule
  must match each subcommand for allow; a deny or ask rule applies when any subcommand matches, including
  inside a subshell, a command substitution, or a control-flow body (documented).
- A dangling `&&` or `||` makes the command unparseable, so allow rules do not apply (documented).
- Stripped wrappers: `timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`, `noglob`, and bare
  `xargs` (documented). `command -v` and `xargs` with flags are not stripped (documented). The exact flag
  arities for `timeout`, `nice`, and `stdbuf` are **inferred**.
- Leading assignments: for allow rules only a known-safe set is stripped; for deny and ask rules any
  leading assignment is skipped past (documented). The exact "known-safe" set is not published, so the
  list in `src/bash.ts` is **inferred** and deliberately short.
- Trailing `*` with a space also matches the bare command; the `:*` suffix is equivalent to a trailing
  ` *` and is only recognised at the end (documented).
- Read-only commands run without a rule. The documented set includes `ls`, `cat`, `echo`, `pwd`, `head`,
  `tail`, `grep`, `find`, `wc`, `which`, `diff`, `stat`, `du`, `cd`, and read-only forms of `git`. The full
  built-in set is not published; the list in `src/bash.ts` and the git read-only subcommand list are
  **inferred**. Many of the Manual-mode exceptions (globs for write-capable flags, `docker -H`, special
  shell variables) are not modelled.
- Exec wrappers (`watch`, `setsid`, `ionice`, `flock`) and `find` with an action that runs commands,
  deletes or writes files (`-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint`, `-fprint0`,
  `-fprintf`, `-fls`) or reads its paths from a file (`-files0-from`) cannot be approved by a rule with a
  `*` in it; only an exact rule with no `*` approves them, and such a `find` is not read-only
  ([documented](https://code.claude.com/docs/en/permissions#exec-wrappers-and-find-actions)). The docs
  name the wrappers with "such as", so the wrapper list is **inferred** as a minimum, and the `find`
  primaries beyond the four the docs name are **inferred** from GNU find.
- Environment runners that are **not** stripped (`npx`, `uvx`, `docker exec`, `devbox run`, `git -c`, ...)
  run their arguments, so an allow prefix ending in one is reported by `bypass`. The runner list is
  **inferred** from the docs' examples plus common tools.

## Redirections (documented, partial)

Output redirect targets (`>`, `>>`, `2>`) are checked against Edit rules and the working directories;
input redirect targets (`<`) against Read rules; `tee` targets against Edit rules. `/dev/null`, file
descriptor forms (`2>&1`), here-documents, and here-strings have no file behind them and are not checked
(documented). The exact working-directory and glob-target prompt conditions are modelled approximately.

## Read and Edit paths (documented)

- Four anchor types: `//path` absolute, `~/path` home, `/path` relative to the settings source, `path` or
  `./path` relative to the current directory.
- A bare filename matches at any depth. A single-segment directory pattern such as `src/**` matches only
  the top directory in an allow rule, but at any depth in a deny or ask rule. Every other shape matches at
  its anchored location, and `**/x/**` matches at any depth.
- A Read deny rule also blocks Edit and Write on the same path; NotebookEdit is not covered.
- `Write`, `NotebookEdit`, `Glob`, and `MultiEdit` path rules are accepted but never consulted; the tool
  reports them as inert.
- `!` negations carve matches out of earlier `path` and `./path` rules in the same source and list, and
  cannot reopen a file inside a wholly blocked directory, nor reach `/`, `~/`, or `//` rules (documented).
- Symlinks: an allow rule needs both the requested path and the resolved target to match; a deny or ask
  rule matches when either does. The tool models this when you supply the resolved path (the engine's
  `resolvedPath`); it does not resolve symlinks on disk itself.

## WebFetch domains (documented)

Matching is case-insensitive against the hostname, with a trailing `.` stripped from both sides. `*.host`
matches subdomains at any depth but not the apex; a bare `*` matches every host; a wildcard elsewhere
matches only the text between two dots. The tool uses the standard URL parser, so userinfo (`user@`) is
dropped and ports are not part of the host. A bare `WebFetch` rule versus `WebFetch(domain:*)` differ in
Claude Code's sandbox handling; the tool treats both as covering every host for decision purposes and does
not model the sandbox allowlist.

## MCP and other tools (documented)

`mcp__server` matches every tool on a server; `mcp__server__*` is equivalent; `mcp__server__tool` is
exact. Allow globs are honoured only after a literal `mcp__server__` prefix; an unanchored allow glob and
an `mcp__` rule with parentheses are inert. Tool-name globs in deny and ask (`*`, `mcp__*`) are honoured.
`Agent(param:value)` and other parameter rules apply to deny and ask only; a rule naming a primary content
field (`command`, `file_path`, `url`, ...) is inert.

Deny and ask rules, including a `*` glob deny, never apply to `EndConversation`: a deny cannot remove it
while any other tool remains and an ask never prompts for it
([documented](https://code.claude.com/docs/en/permissions#manage-permissions)). The simulator assumes
other tools remain and reports such a rule in the call's notes.

## acceptEdits (modelled)

`--mode acceptEdits` auto-approves edits only inside the working directory or
additional directories, checking both the requested and supplied resolved path.
Explicit deny and ask rules still win. A recorded `defaultMode` does not select
the simulation mode.

The filesystem-command subset is **inferred** from the
[permission-mode documentation](https://code.claude.com/docs/en/permission-modes):
one literal `mkdir`, `touch`, `mv` or `cp` command, only `mkdir -p` as an optional
flag, with in-directory paths and no wrappers, substitutions, globs or redirects.
Bash paths are lexical: no command is executed and symlink targets are not
discovered. Supply `resolvedPath` when modelling an Edit symlink.

Implicit mode approval excludes the documented static
[protected paths](https://code.claude.com/docs/en/permission-modes#protected-paths),
including `.git`, `.config/git`, editor/build configuration directories, `.claude`
except `.claude/worktrees`, and protected configuration filenames such as
`.mcp.json`. Nested protected paths inside a worktree remain excluded.
These calls retain their normal rule/default decision. This change does not
model the host's separate safety gate ahead of explicit allow rules, dynamically
loaded plugin directories, or the session-dependent auto-memory exception.

## dontAsk (modelled)

`--mode dontAsk` denies every call that would otherwise prompt, whether an ask rule matched or no rule
did; allow rules, built-in read-only commands and reads inside the working directories still run
([documented](https://code.claude.com/docs/en/permissions#permission-modes)). `--mode manual` is accepted
as an alias for `default`, matching Claude Code. The `requiresUserInteraction`, network-path and
connector exceptions are not modelled.

## Recorded modes and the disable keys (documented)

`load` reports the recorded `permissions.defaultMode`. A value that is not one of `default`, `manual`,
`acceptEdits`, `plan`, `auto`, `dontAsk` or `bypassPermissions` is warned about and ignored; `auto` and
`bypassPermissions` set in project or local settings are warned about and skipped, because they only
take effect from user or managed settings; `manual` is shown as `default`. `disableAutoMode` (top level
or under `permissions`) and `permissions.disableBypassPermissionsMode` take only the string `"disable"`,
so any other value, such as `true`, is reported as having no effect. Source:
[settings reference](https://code.claude.com/docs/en/settings-reference#permissions-defaultmode).

## Not modelled

Permission modes plan, auto, bypassPermissions and the auto-mode
classifier; sandbox interactions; PreToolUse hook decisions and mod answers; `requiresUserInteraction` and
organisation connector `ask` overrides (noted in output and the README, not applied as decisions); Windows
path normalisation beyond forward-slash handling; and the read-only Manual-mode exceptions listed above.
