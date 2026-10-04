# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/basitalisandhu/claude-perm-sim/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/basitalisandhu/claude-perm-sim/releases/tag/v0.1.0
