# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | yes |

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability") rather than a public issue. Include the version, the settings files or rules that reproduce the problem (with secrets removed), the tool call you ran, and what you expected.

You will get an acknowledgement within 7 days and a fix or a mitigation plan within 30 days for confirmed issues. Credit is given in the release notes unless you prefer otherwise.

## Scope

claude-perm-sim reads Claude Code settings files and prints an analysis. It is read-only: it never writes a settings file and never runs any command it analyses. Issues of interest include:

- A decision that does not follow the documented matching semantics for a case the docs state exactly (cite the docs page).
- A `bypass` or `lint` finding that prints, constructs, or implies a runnable command, URL, or other executable payload. The tool is meant to be structural and to use inert placeholders only; anything that could function as an attack is a bug.
- A missed `bypass` finding where an allow rule clearly admits more than it names under the documented semantics.
- Path handling for `--project`, `--user`, `--local`, `--managed`, and the managed drop-in directory that reads a file outside the sources named on the command line.
- Reading or echoing a secret-shaped value from a settings file into output.

What is not a vulnerability in this tool: a difference from Claude Code on behaviour the docs describe only in prose or leave undocumented. Those cases are modelled conservatively and labelled "inferred" in [docs/semantics.md](docs/semantics.md). The tool is not a sandbox and does not enforce anything; for enforcement, use Claude Code sandboxing and PreToolUse hooks.
