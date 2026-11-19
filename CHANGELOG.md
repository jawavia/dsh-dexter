# Changelog

Format: one entry per released tag. This project is **feature-frozen at 0.10.0**; later
entries are bug and security fixes only.

## 0.10.0 — 2026-11-19

First public release. **Feature-frozen: no further feature versions are planned.**

The code is the 0.1.0 build; this release is about position and documentation, not new
capability.

- **Declared the lighter parallel branch of `dsh-click-matrix`** — a second, smaller line
  alongside the 0.9.2 release, not a replacement for it. Four model-facing tools, one
  authorization gate, one hash-chained audit.
- **Repository is public; nothing is published to npm.** Install is from source (clone,
  then pick the directory in DSH); there is no prebuilt helper binary in the release.
- **`SECURITY.md` states what the project is not**: not a research/red-team tool, not a
  way around another product's terms, anti-abuse or integrity controls, not for
  unattended use on someone else's machine, not a distribution channel for arbitrary
  code. No auto-start and no telemetry.
- **`README.md` drops the internal-only wording** and documents the maintenance policy:
  bug and security fixes only, no new tools, no restructuring.
- **`DEVIATIONS.md` D15** records the decision that supersedes D11 (which had declared
  the repository local-only with no push and no release).
- Version metadata: `package.json` is no longer `private`, and carries repository,
  issues and homepage links. Documentation version stamps updated to `0.10.0`.

Not changed in this release: the tool surface (4 tools; 5 with the optional stroke toy),
the authorization model, the target deny lists, the audit format, the vendored engines.

## 0.1.0 — 2026-11-14

First build and first CI run: the kernel rewrite around the vendored engines (four tools,
a bounded authorization session, one hash-chained audit, one settings page, the desktop
panel). Evidence in `evidence/`.
