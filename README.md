# dsh-dexter

Windows-only desktop hands for DeepSeek Harness.

One bundle, one settings page, one authorization gate, one audit trail, four
model-facing tools. The proven injection code is **not** rewritten: the pixel engine
and the UIA engine stay where they are, behind two adapters, and the kernel owns
everything around them (routing, authorization, human pause, verification, audit).

## Tools

| Tool | What it does |
|---|---|
| `hands_view` | read-only: `info` `list` `focus` `capture` `zoom` `locate` `text` `read` `wait` `wait_window` `uia` |
| `hands_act` | the only write entry: `move` `click` `drag` `scroll` `type` `key` `hotkey` (+ `stop`, which only revokes) |
| `hands_run` | a batch of the same steps under one human decision, with `resumeFrom` |
| `hands_status` | read-only: authorization, stop, pause, backends, config summary, audit tail |
| `stroke_toy` | **optional** (`toyStrokeEnabled=true`): a drawing toy (preset shapes, hard point cap, drawn in-repo with the MIT Win32 primitives), not a productivity tool |

Default surface: 4 tools, 6,606 B of description + schemas (the previous bundle: 25
tools, 35,201 B). With the toy enabled: 5 tools, 7,691 B.

## How a write actually happens

```
dryRun? ──> preview, no input, no approval consumed
   │
human busy? ──> refused (suspends while the human uses the machine)
   │
authorization ──> platform approval service (one decision per call, default)
   │              or a human-opened bounded grant (/dexter arm, Ctrl+Alt+F12)
   │              or an explicitly bounded latched grant
target → UIA control path (re-measured) | window+fx/fy | x/y
inject → legacy-pixel (Win32 helper) or legacy-uia (SendInput/UIA)
settle → verify → one audit row
```

`hands_act action=stop`, `/dexter stop`, `Esc`, `Ctrl+Alt+F11` (hard) and
`Ctrl+Shift+F11` (soft) all revoke authorization; the next write is refused until a
human grants again. A `stop.signal` file in the data root is honoured too.

## Install (local bundle)

> **Not installed here, by request.** This repository is deliberately local-only:
> nothing is pushed, published or enabled in a live profile until acceptance is
> mature. Installing it next to `dsh-desktop-hands` would put two tool sets and two
> gates on one desktop (see the warnings below).

1. The plugin is a bundle: `package.json` declares `dsh.bundle.patch`.
2. From DSH: **Plugins → Add plugin →** pick this directory (or install it with the
   plugin manager's install action). It is installed into the profile, not globally.
3. `dsh-click-matrix` and `dsh-x2` must be reachable (they supply the injection; no
   other package is needed — the stroke toy draws in-repo since 2026-11-14). Any of:
   - `legacyPixelPath` / `legacyUiaPath` config values,
   - `DSH_DEXTER_LEGACY_ROOT` pointing at a tree with `engines/{pixel,control}`,
   - `local.config.json` next to this package (`{ "legacyRoot": "…" }`, git-ignored),
   - the packages installed next to this one in the profile.
4. Do **not** enable the old `dsh-desktop-hands` bundle at the same time: the tools
   would be duplicated and two gates would guard the same desktop.

`hands_status` reports which engines resolved and from where. A missing engine is
reported per tool call, never silently ignored.

## Authorization in one screen

Two ways a write can happen, and two things no authorization can ever cover.

| Situation | Behaviour |
|---|---|
| Bare cursor move (`move`) | **free** — audited as `hover(free)`, rate-capped, refused while any mouse button is held |
| No session open | every other write asks the human once (`askOnWrite`); nothing is injected without a yes |
| Session open (`/dexter arm`, `Ctrl+Alt+F12`) | writes run without asking, within the configured **minutes**, **action budget** and **rate** |
| Session numbers | edited in settings (`armMinutes` 15 · `armActions` 100 · `maxActionsPerMinute` 30), or per call `/dexter arm 45m 300` |
| Quick adjust while working | `Ctrl+Alt+F12` open · `Ctrl+Alt+F10` extend · `Ctrl+Alt+F11` / `Esc` stop |
| **System / security target** | **permanently refused** — no grant covers registry, task manager, security software, credential managers, system settings, or elevated windows |
| **Private / payment target** | still **one question per write**, even inside a session (chat, mail, banking, password-looking titles, `.kdbx`) |

A session grant always expires (minutes), runs out (actions) and is capped (rate); a
stop revokes it immediately. The model can only revoke, never grant — every grant comes
from a human's command or hotkey, and each use is a separate audit row
(`session:12/100`, `ask`, `ask:sensitive`, or `hover(free)`).

## Configuration

Every key is declared once, in `kernel/config.js` (`FIELD_SPEC`), and exposed to
Plugin Manager as one schema — that page is the single place to change numbers. There
is no `config-overrides.json` and no second precedence rule. A profile-level patch can
target the row by id:

```yaml
- id: dsh-dexter
  config:
    armMinutes: 45
    armActions: 300
    maxActionsPerMinute: 80
```

The permanent deny list and the sensitive-target lists live in `kernel/targets.js` and
are deliberately **not** configurable: widening them is the one change that must require
editing code (DEVIATIONS.md D12).

## Human commands

`/dexter status | arm [45m] [300] | extend | stop | clear`

## Allowed and not allowed uses

**Intended:** personal desktop automation / RPA on a machine you own and are sitting
at — filling your own forms, driving an app that has no API, repetitive GUI work you
would otherwise do by hand, with a human decision in front of every write.

**Not allowed, and not supported by the design:** password fields, payment and
banking screens, OTP/CAPTCHA prompts, other people's accounts, anything on a machine
you are not authorized to control, unattended mass actions, or using the plugin to
work around another product's terms or anti-abuse controls. The pixel backend keeps a
window deny list (security software, credential managers, system configuration) and
the kernel refuses to inject while a human is at the keyboard.

## Version control (local only)

The repository is a plain local git repository:

```
git log --oneline        # a3e143e Initial commit: dsh-dexter v0.1.0 (local-only)
git tag -l               # v0.1.0
git remote -v            # empty on purpose — nothing is pushed
```

- **no remote is configured and nothing is pushed**; that is a standing rule from the
  human (`DEVIATIONS.md` D11) — publishing / pushing / npm waits for an explicit go;
- `local.config.json` (the machine wiring) and `baseline/local/` (raw measurements with
  machine paths) are git-ignored, so the tree stays publishable as-is;
- the commit identity is repo-local (`dsh-dexter (local) <dexter@localhost>`), not a global
  git identity, and no credentials are involved;
- a zip snapshot from before the first commit is kept outside the tree
  (`..\dsh-dexter-snapshot-20261114-183331.zip`).

## What is deliberately not here

- no network calls, no telemetry, no uploads;
- no `mouse_*` / `screen_*` tool names (hidden aliases were dropped: this is a new
  bundle, not a migration shim);
- no agent-side authorization gain;
- no elevation and no UAC.

See `SECURITY.md` for the threat model, `THIRD-PARTY-NOTICES.md` for what is loaded
and under which license, and `DEVIATIONS.md` for the places where this build
deviates from the repair order.

## Tests and evidence

```
node tools/measure-surface.mjs dexter        # A1/A2 surface weight
node test/01-surface.test.mjs                # tool set, capability ownership, toy toggle
node test/02-auth-invariants.test.mjs        # A4/A5/A7/A8/A9/A10
node test/03-config-single-source.test.mjs   # A6
node tools/dual-run.mjs                      # A11 old-vs-new behaviour (moves the cursor)
node tools/rule-probe.mjs                    # the one deliberate rule difference (move gating)
node test/live-smoke.mjs                     # real backends, real input, real audit
node test/toy-live.mjs                       # stroke helper reachability, no drag
node tools/check-repo.mjs                    # A13 repository hygiene
node tools/ci-local.mjs                      # A15: run the CI definition locally (static only)
```

Measured results for this build are in `evidence/`.
