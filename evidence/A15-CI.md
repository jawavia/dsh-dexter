# A15 — attempt record (one attempt, as instructed)

Instruction from the human: push **once**; if it fails, do **not** retry.

## What was attempted (2026-11-14 21:0x)

```powershell
cd D:\DEEPSEEKworkplace\dsh-dexter
gh repo create dsh-dexter --private --description "…" --source=. --remote=origin --push
```

## Result

| Step | Outcome |
|---|---|
| repository created | **yes** — https://github.com/jawavia/dsh-dexter (private) |
| remote `origin` added | yes — `https://github.com/jawavia/dsh-dexter.git` |
| push of `master` | **REJECTED**, nothing reached the repository |
| local work tree | unchanged, clean |

The rejection is a token scope, not a code problem:

```
! [remote rejected] HEAD -> master (refusing to allow an OAuth App to create or update
  workflow `.github/workflows/ci.yml` without `workflow` scope)
error: failed to push some refs to 'https://github.com/jawavia/dsh-dexter.git'
```

`gh auth status` showed scopes `gist, read:org, repo` — **`workflow` is missing**, and a push
that creates a file under `.github/workflows/` needs it.

A read-only follow-up (`git ls-remote origin`) then failed with
`Recv failure: Connection was reset`, so the git-over-HTTPS path may also be unstable right
now even though `gh` (API) worked. That was **not** retried either.

## What is needed before another attempt

1. **Token scope** — the account owner runs (account action):
   ```powershell
   gh auth refresh -s workflow
   ```
   or creates a PAT with `repo` + `workflow` scopes.
2. **Network** — confirm git-over-HTTPS works: `git ls-remote https://github.com/jawavia/dsh-dexter.git`.
3. Then exactly one push: `git push -u origin master` (and `git push origin v0.1.0`).

## State left behind

- private, empty repository `jawavia/dsh-dexter` (delete with `gh repo delete jawavia/dsh-dexter --yes` if unwanted);
- local remote `origin` pointing at it;
- nothing published, no Release, no npm, no secrets sent.

## Status of A15

**PREPARED, NOT PROVEN** — unchanged. The attempt failed before any code left the machine,
so there is nothing to record as a CI run.
