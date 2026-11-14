# A15 — handover: one CI run on GitHub (account action belongs to the human)

Decision (2026-11-14): **option B** — create a **private** repository, push `master` once,
let the static workflow run, record the result, then stop. No npm publish, no Release.

## What will be pushed

| | |
|---|---|
| branch | `master`, 32 commits |
| tag | `v0.1.0` (annotated → `a3e143e`) |
| tracked files | 348 |
| work tree size | 5.9 MB (includes the vendored engines) |
| remote | none yet |
| `local.config.json` | **not tracked** (git-ignored) |
| `baseline/local/`, `evidence/local/` | **not tracked** |
| secret scan over all commits | `gho_`/`ghp_`/`npm_`/`sk-` → **0 hits** |

`git log --oneline` is in the chat record; every commit message states what it changed.

## The workflow that will run (`.github/workflows/ci.yml`)

`runs-on: windows-latest`, Node 22, three steps — **static only**:

1. `node test/01-surface.test.mjs`, `02-auth-invariants`, `03-config-single-source`
2. `node tools/check-repo.mjs` (paths, secrets, licenses, manifest coverage)
3. `node tools/measure-surface.mjs dexter`

The GUI tests (`test/live-smoke.mjs`, `tools/dual-run.mjs`, `test/clipboard-live.mjs`,
`test/panel-*.mjs`, `tools/e2e-live.mjs`) inject real input and need a desktop, so they are
deliberately excluded — CI green means "the static contract holds on a clean machine", not
"the desktop injection works there".

## Commands for the human (PowerShell, needs the account)

```powershell
cd D:\DEEPSEEKworkplace\dsh-dexter

# 1. create the private repo and push master (gh is logged in as jawavia)
gh repo create dsh-dexter --private --source=. --remote=origin --push

# 2. push the tag as well (gh --push sends the branch only)
git push origin v0.1.0

# 3. watch the run
gh run list --limit 3
gh run watch            # or open the URL it prints

# 4. if it fails, this prints the failing step's log
gh run view --log-failed
```

If `gh` refuses because the repository already exists, use:

```powershell
git remote add origin https://github.com/jawavia/dsh-dexter.git
git push -u origin master
git push origin v0.1.0
```

## What to send back

- the run URL (or the `gh run list` output line), and
- the conclusion (`success` / `failure`) plus, on failure, the failing step's log.

With those I will:

1. write `evidence/A15-CI.md` (URL, run id, conclusion, what it proves and what it does not);
2. flip A15 in `evidence/SUMMARY.md` from **PREPARED, NOT PROVEN** to **PASS**;
3. commit both (local commits only), and report.

## Stop line

This is the only outward action in the whole project. Nothing else leaves the machine:
no npm publish, no Release, no release assets, no public repository. If the run is red,
the fix happens locally first and the push is repeated only with a new explicit "go".
