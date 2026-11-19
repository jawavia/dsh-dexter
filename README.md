# dsh-dexter

**The lighter parallel branch of `dsh-click-matrix`** — v0.10.0. It sits *alongside*
the 0.9.2 line rather than replacing it: a second, smaller line of the same idea, with
fewer tools and a smaller surface.

Same pixel injection underneath (the engine is vendored, unmodified), with the layer
around it rewritten: four model-facing tools instead of fourteen, one bounded
authorization instead of a latch, one hash-chained audit instead of per-engine files.
One settings page, one gate, one trail.

**Status: feature-frozen.** 0.10.0 is the version of record for this branch. Later
releases are bug fixes only — no new tools, no restructuring, no further feature
versions. See [Maintenance](#maintenance).

## Tools

| Tool | What it does |
|---|---|
| `hands_view` | read-only: `info` `list` `focus` `capture` `zoom` `locate` `text` `read` `wait` `wait_window` `uia` |
| `hands_act` | the only write entry: `move` `click` `drag` `scroll` `type` `key` `hotkey` (+ `stop`, which only revokes) |
| `hands_run` | a batch of the same steps under one human decision, with `resumeFrom` |
| `hands_status` | read-only: authorization, stop, pause, backends, config summary, audit tail |
| `stroke_toy` | **optional** (`toyStrokeEnabled=true`): a drawing toy (preset shapes, hard point cap, drawn in-repo with the MIT Win32 primitives), not a productivity tool |

Default surface: 4 tools, 7,034 B of description + schemas (the previous bundle: 25
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

> **Installed from source, by design.** There is no npm package and no binary
> distribution: the bundle is installed from this repository (clone, then pick the
> directory in DSH). If you are replacing `dsh-click-matrix`, keep the old bundle
> **disabled** — two tool sets and two gates on one desktop would leave their helpers
> fighting over the same global hotkeys. See `docs/MIGRATION.md` for what moved where.

1. The plugin is a bundle: `package.json` declares `dsh.bundle.patch`.
2. From DSH: **Plugins → Add plugin →** pick this directory (or install it with the
   plugin manager's install action). It is installed into the profile, not globally.
3. **No prerequisites.** The two engines ship inside `vendor/` (unmodified MIT code plus
   the `koffi` native module, ~5.5 MB), so a fresh machine can install this bundle and
   inject. An explicit path still wins when one is given:
   - `legacyPixelPath` / `legacyUiaPath` config values,
   - `DSH_DEXTER_LEGACY_ROOT` pointing at a tree with `engines/{pixel,control}`,
   - `local.config.json` next to this package (`{ "legacyRoot": "…" }`, git-ignored),
   - the packages installed next to this one in the profile.
   Resolution order: config → `vendor/` → env root → `local.config.json` → package.
4. Keep the old `dsh-desktop-hands` bundle **disabled** (it is on purpose: two gates
   on one desktop and two helpers competing for Ctrl+Alt+F11). `docs/MIGRATION.md` maps
   the old tool names, commands and defaults onto the new ones.

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

Three numbers are meant to change while the plugin runs:

| Key | Meaning | Range |
|---|---|---|
| `armMinutes` | how long one session grant lives | 1..480 |
| `armActions` | how many write actions it covers | 1..5000 |
| `maxActionsPerMinute` | rate cap (0 = no cap) | 0..600 |

Change them **on the desktop panel** (right-click → 设置 → 加减 / 恢复默认), or with
`/dexter set armMinutes 30`. Both write the same runtime-override layer
(`~/.dsh/dexter/runtime-overrides.json`) and take effect immediately — no reload.
Precedence: panel/command override → host config → `FIELD_SPEC` default.

Every key is declared once, in `kernel/config.js` (`FIELD_SPEC`); `test/03` fails if a second
declaration appears. The other keys are ordinary and live in the profile patch:
`/dexter set <key> <value>` (validated, written through the host config editor) or edit it
directly:

```yaml
- id: dsh-dexter
  config:
    askOnWrite: true
    hoverFree: true
```

The permanent deny list and the sensitive-target lists live in `kernel/targets.js` and are
deliberately **not** configurable: widening them is the one change that must require editing
code (DEVIATIONS.md D12).

> Why not a Settings page? DSH renders forms only for *volatile* fields, and no shipped
> client renders those forms yet; its config editor also refuses a nested include
> (`HMR transactions cannot be nested`). The panel is the honest answer — see DEVIATIONS D1
> and the development log.

## Human commands

`/dexter status | arm [45m] [300] | extend | stop | clear`

## Desktop panel

A small always-on-top strip that lives **outside** the DSH window, so it survives another
application covering the chat (`panelEnabled`, default on):

- **drag** it anywhere; **×** hides it to a 14 px tab on the right screen edge, click the
  tab to bring it back; **double-click** expands the detail line; **right-click** opens
  *Reset to top-right · Show/hide · Exit panel*. The same menu is on the tray icon, so a
  strip dragged off-screen can always be recovered;
- it is always clickable — there is **no click-through mode** on purpose: it is small and
  draggable, so making it unclickable would only create a way to lose it;
- it clamps itself to `Screen.WorkingArea`, which **excludes the taskbar**, so it cannot
  cover it — the old helper pill did, because it positioned itself against the full screen;
- position is kept in `~/.dsh/dexter/panel-pos.txt`; the text comes from
  `~/.dsh/dexter/state.txt` (refreshed every second from the audit/gate state);
- it is a separate `Panel.exe`, compiled once with the in-box `csc` into
  `~/.dsh/dexter/panel/`; disabling the plugin reaps it (verified 1 → 0). If it ever
  lingers: `Get-Process Panel | Stop-Process -Force`;
- `/dexter panel show|hide|reset|exit` writes a one-shot command the panel polls — useful
  when the pointer is busy somewhere else; `show` also restarts the process when it was
  closed (the tray's *Exit panel*, or the window being closed), so the strip is never
  unreachable until a reload;
- it is a **tool window** (`WS_EX_TOOLWINDOW` + `WS_EX_NOACTIVATE`): no taskbar button, no
  Alt+Tab entry, and clicking it never takes focus from the app being driven.

### Two buttons beside the composer

`client.js` contributes a small row to `conversation.composer.dock`:

| Button | Effect |
|---|---|
| 授权 | sends `/dexter arm 15m 100` (one click + no typing; the human still presses it) |
| 面板 | sends `/dexter panel show` |

They go through the documented `InputActions` facet (`captureInsertion` / `insertText` /
`setDraft` / `submit`) — nothing here can grant authority by itself, since the click is the
human's and the host command opens the grant. Client modules only load with the page, so a
DSH restart is needed before a rewritten `client.js` shows up.

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

## Version control

A public GitHub repository (`jawavia/dsh-dexter`). `v0.10.0` is the release this README
describes; `v0.1.0` is the first tag, kept as history. Nothing is published to npm, there
is no binary distribution, and CI runs static checks only — the GUI tests that inject
real input are deliberately not part of the workflow.

## Maintenance

**Feature-frozen at 0.10.0.** This is the final feature version of the branch: bug and
security fixes only — no new tools, no restructuring, no further feature versions. It is
declared a **parallel, lighter branch** of the `dsh-click-matrix` line: it does not
supersede 0.9.2, and it is not maintained as a general-purpose product.

What "maintained" still means: a failing test or a reproducible defect gets a fix, the
repository stays readable, and the security policy below stays in force. What it does not
mean: feature requests, new integrations, or a version number that keeps moving.


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

## Documentation index

| File | What it is |
|---|---|
| `docs/工具说明.md` | the four tools, their parameters, and a worked example |
| `docs/开发日志.md` | what was built, what broke, what fixed it (with commit ids) |
| `docs/MIGRATION.md` | old `dsh-click-matrix` tool and command → new ones |
| `docs/HANDS.md` | the model-facing handbook |
| `docs/DETAIL.md` | design detail and invariants |
| `evidence/验收报告.md` | acceptance report (A1–A15, the live loop, the limits) |
| `evidence/SUMMARY.md` | one-screen evidence index |
