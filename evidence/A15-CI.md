# A15 — CI ran on GitHub (PASS)

2026-11-14. The static workflow executed on a **fresh Windows runner**, not on this machine.

## Run

| | |
|---|---|
| workflow | `static checks` (`.github/workflows/ci.yml`) |
| run | **[43598260178](https://github.com/jawavia/dsh-dexter/actions/runs/43598260178)** |
| repo | `jawavia/dsh-dexter` (**private**) |
| commit | `dfb5aaa` (`headSha`), the pushed `master` |
| trigger | `push` → `master` |
| job | `static` — **✓ success**, 20 s (run total 23 s) |
| runner | `windows-latest`, Node 22 (`actions/setup-node@v4`) |

## What the run did

1. `node test/01-surface.test.mjs` — tool surface 19 checks
2. `node test/02-auth-invariants.test.mjs` — authorization/audit invariants 75 checks
3. `node test/03-config-single-source.test.mjs` — config single source 14 checks
4. `node tools/check-repo.mjs` — paths, secrets, licenses, manifest coverage
5. `node tools/measure-surface.mjs dexter` — schema weight (4 tools / 7,034 B)

Green means: **a clean machine, with no `local.config.json`, can install and pass the static
contract** — including the vendored engines (`vendor/`) and their licenses.

## What it does **not** prove

- GUI injection (`test/live-smoke.mjs`, `tools/dual-run.mjs`, `test/clipboard-live.mjs`,
  `test/panel-*.mjs`, `tools/e2e-live.mjs`) is deliberately **not** in the workflow: those
  drive a real mouse/keyboard and need a desktop. They were run here locally instead — see
  `evidence/E2E.md`, `evidence/CLICK-BENCH.md`, `evidence/REVIEW-FIXES.md`.
- It does not prove behaviour on a machine without Windows, or with a different DPI/monitor
  topology.

## History of this criterion

| when | what | result |
|---|---|---|
| before 2026-11-14 | workflow written, only reproducible locally via `tools/ci-local.mjs` (3/3) | PREPARED, NOT PROVEN |
| 2026-11-14 20:5x | first push attempt: repo created, push **rejected** — OAuth app lacked the `workflow` scope | still not proven |
| 2026-11-14 21:08 | `gh auth refresh -s workflow` (human approved the device code) → single push (`master` + tag `v0.1.0`) | **PASS** |

The instruction was “push once, do not retry on failure”; the failed attempt was recorded
instead of retried, and the successful push happened only after the scope was granted.

## One annotation worth keeping

GitHub reports on the run:

> Node.js 20 is deprecated. `actions/checkout@v4` and `actions/setup-node@v4` are being
> forced to run on Node.js 24.

That is a warning about the actions' own runtime, not about this project; the job still ran
on Node 22 as configured. When the actions publish v5 (or the forced version stops working),
bumping `uses:` lines is the fix.

## Stop line

This was the **only** outward action of the project: one private repository, one push of
`master` plus the `v0.1.0` tag, one workflow run. No npm publish, no Release, no assets, no
public repository.
