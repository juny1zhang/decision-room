# Captured CLI output

Real output of the official CLIs, used by [tests/unit/contract.test.mjs](../../unit/contract.test.mjs) to check the adapters in `src/providers/` against what the CLIs print. The mock CLIs in `tests/support/mock-cli.mjs` encode the maintainers' assumptions, so a change in a real CLI keeps the rest of the suite green; these files do not. [scripts/check-cli-contract.mjs](../../../scripts/check-cli-contract.mjs) runs the same checks against the CLIs installed on a machine, and the [CLI canary workflow](../../../.github/workflows/cli-canary.yml) runs it every week against the latest releases.

Captured 2026-11-12 on Linux x64 with Node.js 22, without a login: no account was signed in, and no command sent a prompt.

| File | CLI and version | Command |
| --- | --- | --- |
| `claude-2.1.322-version.txt` | Claude Code 2.1.322 | `claude --version` |
| `claude-2.1.322-help.txt` | Claude Code 2.1.322 | `claude --help` (excerpt) |
| `codex-0.167.2-version.txt` | Codex CLI 0.167.2 (npm `@openai/codex`) | `codex --version` |
| `codex-0.167.2-help.txt` | Codex CLI 0.167.2 | `codex --help` (excerpt) |
| `codex-0.167.2-exec-help.txt` | Codex CLI 0.167.2 | `codex exec --help` (excerpt) |
| `codex-0.167.2-debug-models.json` | Codex CLI 0.167.2 | `codex debug models` (excerpt) |
| `codex-0.167.2-login-status-logged-out.json` | Codex CLI 0.167.2 | `codex login status`, logged out |

## What the excerpts keep

- Help: the excerpts keep only the option blocks the app uses; every line is verbatim. Each file keeps the `Usage:` line, then, for every flag the adapters pass and a few related ones (`-c` in `codex --help`, Claude's `--include-partial-messages` for streaming), its option line and the description lines that follow it, up to the next option or blank line. Nothing is reworded, re-wrapped or reordered. Codex also printed a `WARNING:` line about PATH aliases on stderr, which is not part of the help.
- `codex debug models` prints one line of 745 KB. The excerpt keeps all 12 models in the order printed, 9 with `"visibility": "list"` and 3 with `"hide"`, with the fields `slug`, `display_name`, `visibility`, `supported_in_api`, `default_reasoning_level` and the `effort` of each `supported_reasoning_levels` entry. Values are unchanged; the JSON is indented with two spaces.
- The login status file records the arguments, exit code, stdout and stderr of the command: logged out, Codex 0.167.2 prints `Not logged in` on stderr and exits with 1.

Keep the files byte for byte as captured: `.prettierignore` and the ESLint configuration leave this folder alone, and an editor must not trim or re-wrap them.

## Cursor Agent

No Cursor Agent output is captured: its installer (`curl https://cursor.com/install -fsS | bash`) was blocked in the sandbox where these files were made. The Cursor adapter is covered only by the hand-written mock in `tests/support/mock-cli.mjs`. The canary workflow installs the latest Cursor Agent and checks it, but that path could not be verified, so its result does not fail the workflow. To close the gap, capture `agent --version`, `agent --help` and `agent status --help` as `cursor-<version>-version.txt`, `-help.txt` and `-status-help.txt`, and add them to `CAPTURED` in the contract test.

## Refreshing a capture

When the canary or `node scripts/check-cli-contract.mjs` reports a change, install the new version and capture the commands above again, without a login. Trim the help as described, keeping the option blocks of every flag in the adapter's `contract`, name the files after the new version, and update `CAPTURED` in `tests/unit/contract.test.mjs`. If the new version no longer lists a flag the app passes, change the adapter and its `contract` before the fixtures.
