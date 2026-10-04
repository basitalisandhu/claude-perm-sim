# Good first issues

Issues the maintainer intends to open under the `good first issue` label, written out so they can be
filed in one sitting. Each is self-contained and has acceptance criteria that `npm test` can verify. Read
[CONTRIBUTING.md](../CONTRIBUTING.md) first: TypeScript strict mode, no new runtime dependencies, a test
for every behaviour, and a note in [docs/semantics.md](semantics.md) for anything you infer from prose
rather than from a documented rule.

## 1. Add `--format markdown` to `load`, `bypass`, and `lint`

**Context.** A pull-request comment or a CI job summary reads better as Markdown than as the table.

**Acceptance criteria.**

- `--format markdown` prints a heading and a table for `load` (the three lists with sources), and a table
  of findings for `bypass` and `lint` with severity, id, rule, and suggestion columns.
- `--format` still accepts `table`, `json`, `sarif`, and `hook`; `markdown` is added to the usage text and
  the `--format` validation.
- Tests in `test/format.test.ts` assert the heading and one table row for each command.

## 2. Model `acceptEdits` permission mode

**Context.** The engine reports `default` (Manual prompt) when no rule matches. In `acceptEdits` mode,
Claude Code auto-accepts file edits and common filesystem commands (`mkdir`, `touch`, `mv`, `cp`) for
paths in the working directories.

**Acceptance criteria.**

- A `--mode <default|acceptEdits>` flag changes an unmatched Edit or filesystem-command call inside the
  working directories from `default` to `allow`, with a built-in reason naming the mode.
- `docs/semantics.md` gains an "acceptEdits (modelled)" entry and marks the filesystem-command list as
  inferred.
- Tests cover an Edit and a `mkdir` inside and outside the working directory.

## 3. Read servers from `.mcp.json` for `bypass` coverage automatically

**Context.** `bypass` takes known MCP tools with `--mcp-tool` and server names with `--mcp-from`. When a
project has a `.mcp.json`, the tool could read the server names itself.

**Acceptance criteria.**

- Without `--mcp-from`, `bypass` reads `<project>/.mcp.json` when it exists and uses its server names, and
  reports a wildcard allow rule for a server that is no longer configured as a separate low finding.
- Nothing is connected to; only names are read.
- A fixture `.mcp.json` and tests in `test/bypass.test.ts`.

## 4. Add a `BYP-PATH-SYMLINK-NOTE` informational finding

**Context.** The engine models symlinks when given a resolved path, but `bypass` does not call it out. A
Read or Edit allow scope that includes a directory which commonly holds symlinks (for example
`node_modules`) is worth an informational note.

**Acceptance criteria.**

- `bypass` emits an `info` finding for an allow scope whose pattern names a directory from a short,
  documented list (such as `node_modules`), explaining that a symlink inside it can point outside the
  scope and that the allow rule needs both paths to match.
- The list lives in one place and is covered by `docs/semantics.md`.
- Tests assert the finding on a fixture and its absence on the tight fixture.

## 5. `diff --format sarif`

**Context.** `diff` prints a table or JSON. A SARIF document would let a code-scanning dashboard show which
decisions a settings change flips.

**Acceptance criteria.**

- `diff --format sarif` emits SARIF 2.1.0 with one result per flipped call, the rule id `DIFF-FLIP`, a
  level derived from the direction (a loosened decision is `warning`, a tightened one is `note`), and the
  before and after decisions in `properties`.
- Tests in `test/format.test.ts` parse the document and assert the structure.

## 6. Explain a whole file of calls

**Context.** `explain` takes one call. A reviewer often has a list.

**Acceptance criteria.**

- `explain --from <file>` reads one call per line (rule form or hook JSON), decides each, and prints a
  table of call and decision, or a JSON array with `--format json`.
- Blank lines and lines starting with `#` are skipped; a malformed line is reported with its line number
  and does not stop the rest.
- Tests cover a mixed file and a file with one bad line.
