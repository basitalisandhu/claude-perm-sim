# Contributing

Thanks for considering a contribution. The project is small on purpose: load settings, decide a call,
report where allow rules are permissive. The most useful contributions are matching-semantics fixes
against the current Claude Code docs, more fixture rule sets, and documentation corrections.

## Set up

Requires Node 20 or newer.

```bash
git clone https://github.com/basitalisandhu/claude-perm-sim
cd claude-perm-sim
npm install
npm test            # builds first, then runs vitest
```

`npm run build` compiles `src/` to `dist/`; `npm run typecheck` runs the compiler without emitting. The
tests load the fixture rule sets under `test/fixtures/` and run the CLI in-process, so nothing on your
machine is read or written.

## Before you open a pull request

- `npm test` passes on Node 20 and 22 (CI runs both).
- New behaviour has a test. Add tight-versus-permissive fixture rules when you add a matching rule or a
  bypass family.
- Behaviour that mirrors Claude Code (precedence, rule syntax, path anchoring, wrappers) cites the page of
  the Claude Code docs it follows, in the pull request or a code comment. Anything you infer from prose
  rather than a stated rule gets a line in [docs/semantics.md](docs/semantics.md) marked "inferred".
- Add a line under `Unreleased` in `CHANGELOG.md`.

## Style

- TypeScript strict mode, ESM, no runtime dependencies.
- No model or vendor identifiers in the repository. Claude Code, the host product, is fine to name.
- The `bypass` and `lint` commands are defensive. They report where a rule set is permissive and suggest a
  tighter rule; they must never construct, print, or imply a runnable command, URL, or other payload. Use
  inert placeholders such as `<command-after-separator>` and `sub.<domain>`.
- Plain language in messages: say which rule and file, what the weakness is, and the tighter rule.
- Deterministic output: findings are sorted by severity then id, and there are no timestamps.

## Reporting security issues

See [SECURITY.md](SECURITY.md).
