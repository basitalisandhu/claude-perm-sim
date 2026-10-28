# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.1] - 2026-10-28

### Fixed

- `explain` (and the PreToolUse hook it can run as) could hang on a long command or path against a rule with many wildcards: Bash, MCP tool name, parameter and WebFetch `domain:` patterns were matched with regular expressions that backtrack exponentially (`Bash(*a*a*a...b)` against a 3,000-character command did not finish in 10 seconds), and Read and Edit path rules with repeated `**/` segments did the same on a deep path. Wildcards are now matched by a linear scan, path rules by a single pass that answers both "the path" and "a parent directory"; the answers are unchanged (checked against the old regular expressions on 60,000 random cases).
- `lint` compared every pair of rules to find duplicates and every allow rule with every deny and ask rule; both now group rules first. 20,000 rules: about 1.2 s down to 25 ms for load, lint and bypass together.

### Added

- Seeded fuzz tests: random rules and calls, wrong value types in settings, and bad bytes in a settings file, each run with a time limit; a scaling test (2,000 and 20,000 rules); a CI job that installs the packed tarball into an empty folder, runs the quick start and compares the README sample.
- A Troubleshooting section in the README with real messages and fixes.

## [0.3.0] - 2026-10-16

### Added

- `explain --from <file>` decides one call per line (rule form or hook JSON; `-` reads stdin), skipping blank lines and `#` comments, and prints a table or, with `--format json`, an array. A malformed line is reported with its line number and the rest are still decided (#7).
- A `prepare` script, so `npx github:basitalisandhu/claude-perm-sim` builds and runs without a GitHub Packages token. The README quick start now uses it and shows real output.

- `--mode dontAsk` denies every call that would otherwise prompt, and `--mode manual` is accepted as an alias for `default`. `plan`, `auto` and `bypassPermissions` are refused with a clear message instead of "unknown mode".
- `load` warns about a `permissions.defaultMode` that is not a permission mode, about `auto` or `bypassPermissions` set in project or local settings (they only take effect from user or managed settings), and about `disableAutoMode` or `disableBypassPermissionsMode` set to anything other than the string `"disable"`.

### Fixed

- A Bash allow rule with a `*` no longer approves an exec wrapper (`watch`, `setsid`, `ionice`, `flock`) or a `find` with an action such as `-delete`, `-exec` or `-fprint`; only an exact rule does, as the permissions docs state. `find` with `-fprint`, `-fprint0`, `-fprintf`, `-fls`, `-okdir` or `-files0-from` is no longer treated as read-only.
- Deny and ask rules, including a `*` glob deny, no longer apply to `EndConversation`, which Claude Code never removes or prompts for while other tools remain.
- `permissions.defaultMode: "manual"` is shown as `default`, and an `auto` or `bypassPermissions` default mode from project settings no longer hides the user-level one.

## [0.2.0] - 2026-10-09

### Added

- Add explicit `--mode default|acceptEdits`, preserving deny/ask precedence and limiting implicit filesystem approval to working directories outside static protected paths.

## [0.1.0] - 2026-10-04

First release. Published to two registries on GitHub Packages, using only the workflow's `GITHUB_TOKEN`:

- npm (`https://npm.pkg.github.com`): `@basitalisandhu/claude-perm-sim`. The package is scoped because GitHub Packages requires the owner's scope; the unscoped name `claude-perm-sim` is not published anywhere yet.
- GitHub Container Registry: `ghcr.io/basitalisandhu/claude-perm-sim`, tagged `0.1.0` and `latest`, for linux/amd64 and linux/arm64, with an SPDX SBOM, a build provenance attestation and a keyless cosign signature.

### Added

- `claude-perm-sim load`: merge managed (including `managed-settings.d/*.json`), `--settings`, local, project and user settings in the documented precedence, and print the effective allow, ask and deny lists with each rule's source. Lists merge across scopes; `allowManagedPermissionRulesOnly` and `--untrusted` are honoured.
- `claude-perm-sim explain "<tool call>"`: print the decision for one call, the exact rule and file that decided it, and the rules that also matched but lost. Reads a rule-form call or the JSON a PreToolUse hook receives.
- `claude-perm-sim bypass`: a structural, defensive report of where an allow rule admits more than it names, across Bash wildcard, exec-runner and trailing-wildcard families, Read and Edit scope escapes, WebFetch subdomain and lookalike families, and MCP wildcard and uncovered-tool cases. Each finding names the rule, the weakness class and a tighter rule, uses inert placeholders, and never prints a runnable command. Exits 1 on a HIGH finding.
- `claude-perm-sim lint`: static checks for duplicates, allow rules shadowed by deny, overly broad patterns, rules that never match, mixed slash styles, and write-like tools in allow.
- `claude-perm-sim diff <a.json> <b.json>`: which sample decisions flip between two settings files.
- Output formats `table`, `json` and `sarif`, plus `--format hook` which prints a PreToolUse hook snippet that runs `explain` for logging only.
- A matching engine modelling the documented Bash splitting, wrappers, read-only commands and redirections; Read and Edit path anchoring, depth rules, `!` carve-outs and symlink handling; WebFetch domain matching; and MCP and parameter rules. Behaviour inferred from prose is labelled in `docs/semantics.md`.
- Test suite with tight and permissive fixture rule sets, CI on Node 20 and 22, a container image published on version tags, and a guarded npmjs release workflow.

[Unreleased]: https://github.com/basitalisandhu/claude-perm-sim/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/basitalisandhu/claude-perm-sim/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/basitalisandhu/claude-perm-sim/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/basitalisandhu/claude-perm-sim/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/basitalisandhu/claude-perm-sim/releases/tag/v0.1.0
