# Deviations from the repair order

Every entry states the evidence, the decision, and what it costs. Nothing here
silently weakens an acceptance criterion; where a criterion is only *partly* met,
that is written down.

---

## D15 — Public release at 0.10.0 supersedes D11 (2026-11-19)

**What D11 said:** the repository is local-only; no remote, no push, no tag push, no
release, no upload, each time.

**What the human decided (2026-11-19):** publish **v0.10.0** on GitHub — the repository
becomes public and gets one Release — then freeze the branch. D11 rules 1 and 2 are
therefore superseded; rules 3 and 4 (do not install into the live profile next to
`dsh-desktop-hands`; do not sharpen the gate further) still stand.

**Scope actually taken:**

| Item | Decision |
|---|---|
| Channel | **GitHub only**: public repository + tag `v0.10.0` + one Release |
| npm | **Not published.** No npm package, ever, for this branch |
| Assets | No binaries. The Release carries source only; the vendored engines stay as MIT source in `vendor/` |
| Position | Declared a **parallel, lighter branch** of `dsh-click-matrix` — not a replacement for 0.9.2 |
| Maintenance | **Feature-frozen at 0.10.0**: bug and security fixes only, no further feature versions |

**Why the lighter branch exists at all:** `dsh-click-matrix` was withdrawn from npm on
2026-11-04 and the package was removed by npm Support on 2026-11-18. This branch keeps
the capability the human uses, with a smaller model-facing surface (4 tools, ~7 KB of
schemas) and a stricter target policy, and it is distributed as source that a human
installs deliberately.

**What it costs:** the repository is public, so the capability and its limits are
visible to anyone; source installs are less convenient than a package; and "public"
means the code can be cloned and read without the author's presence. Accepted.

---

## D14 — The plugin owns its arm hotkeys; the engine keeps the stop ones (2026-11-14)

**Problem found during acceptance:** the status line said
`CTRL+ALT+F12 被占用 · CTRL+ALT+F11 被占用`, and the occupier was **our own pixel helper**: it
hardcodes Ctrl+Alt+F12 (its arm toggle), Ctrl+Alt+F11 (abort) and Ctrl+Shift+F11 (soft stop).
The plugin never registered any of them, so pressing F12 opened the *engine's* gate — which this
plugin bypasses — and the human's real authorization stayed closed. The keys looked dead.

**Decision (human chose option B):** the plugin owns the keys that matter for its own gate.

| Combo | Owner | Effect |
|---|---|---|
| Ctrl+Alt+F12 | **plugin** (`ui/Hotkeys.cs` listener) | opens a bounded session grant for this plugin |
| Ctrl+Alt+F10 | **plugin** (same listener) | extends it |
| Ctrl+Alt+F11 | engine helper (unchanged) | emergency stop at the injection level |
| Ctrl+Shift+F11 | engine helper (unchanged) | soft stop at the injection level |

**How the arm combo became free:** one environment-gated line in the vendored
`runtime/helper.cs` (see `THIRD-PARTY-NOTICES.md`): `DSH_DEXTER_HOTKEYS=arm` makes the helper
release Ctrl+Alt+F12 only. The stop combos deliberately stay with the engine, so a listener
crash still leaves a working stop, and a stop press never depends on the plugin's event loop.

**Cost:** if the listener cannot start (compile failure, combo taken by another app), the
authorize hotkey does not work — the button and `/dexter arm` still do, and `hands_status`
says which combos the listener actually holds. Tests never start the listener
(`DSH_DEXTER_NO_HOTKEYS=1`), because a test run must not steal the real hotkeys from the
running plugin.

**Evidence:** `test/12-hotkeys.test.mjs` (protocol, action mapping, source invariants);
live proof: a posted `WM_HOTKEY` (id 1) reached the listener and produced
`gate · grant-opened` plus `hotkey · input · arm` in the audit trail.

## D13 — Free hover, and the numbers the human chose (2026-11-14)

**Decisions from the review meeting:** hover exemption (方案 C), session defaults
15 min / 100 actions / 30 per minute, keep `dsh-desktop-hands` installed but disabled.

**Free hover (`hoverFree`, default on):**

| Guard | Behaviour |
|---|---|
| no session, no approval channel | a `move` still runs — approval `hover(free)`, audited, rate-capped |
| any mouse button held | refused (`button-held`); a move with a button down is a drag |
| button probe unavailable | refused from the free path; the call falls back to the normal gate |
| system / security target | still permanently refused |
| rate | counted against `maxActionsPerMinute` like every other action |
| session credit | **not** consumed — hovering never eats the click budget |

This is an explicit departure from order 4.3 ("every write passes the gate"). It is
safe to state because: the capability is non-destructive by construction (no button
events), it is visible to the human in real time, it is audited and rate-capped, and
the failure mode that would matter (a held button) is checked before every hover.
`test/02-auth-invariants.test.mjs` covers each line.

**Why the hovering numbers are small (15/100/30):** the human wants to re-affirm
periodically rather than grant a long window, and 30 actions/minute is still fast
enough for a GUI task while making a runaway loop visible immediately.

---

## D12 — Authorization is a bounded session plus two non-negotiable target rules

**Human's requirements (2026-11-14):** numbers must be adjustable by the human (minutes,
action count, frequency); quick adjustment from buttons/hotkeys while working; numbers
in settings; **system targets permanently forbidden**; **private targets step-by-step**.

**What exists now (replacing the earlier per-action/latched pair):**

| Piece | Where | Adjustable? |
|---|---|---|
| `armMinutes` / `armActions` / `maxActionsPerMinute` | settings page (plugin config) | yes, and per call `/dexter arm 45m 300` |
| `askOnWrite` | settings | yes (off = refuse instead of asking) |
| `sensitiveAsk` | settings | yes (the *lists* stay in code) |
| hotkeys F12 arm / F10 extend / F11 stop / Esc stop | `kernel/stopbus.js` | fixed on purpose |
| **system target deny list** | `kernel/targets.js` | **no** |
| **sensitive target list** | `kernel/targets.js` | **no** (only the "always ask" switch) |

**Why the deny list is not a config key:** it is the one rule a tired human must not be
able to widen from a settings form. Changing it means editing code and re-reading the
tests. A session grant of any length never covers: registry editor, task manager,
services/group-policy/event-viewer tools, security software panels, credential managers,
system settings, elevated windows.

**Honest limits:** classification is process-name + title-substring matching
(`kernel/targets.js`), so a renamed binary or an unusual title can slip through; the
legacy engine's own window deny list still applies on top, and nothing here replaces a
real operating-system boundary. A password *field* inside a normal app is not detected —
that is stated in SECURITY.md, not hidden.

**Consequence for A7 in the order:** "latched off by default, bounded when on" is
satisfied differently — there is no latched mode any more; instead there is no session by
default (per-write asking), and every session carries both bounds plus a rate cap.
`test/02-auth-invariants.test.mjs` covers each line.

---

## D11 — Standing rules from the human (2026-11-14, after the build)

1. **No push, no publish, no upload until acceptance is mature.** The repository is
   local-only; `git remote`, `npm publish`, releases and any external upload stay off
   until the human says otherwise, each time (this also restates order §7 / R7).
2. **Version control is local-only.** The repository has no remote, no push, no tag
   push: committing locally is fine (that is how changes stay reviewable), publishing
   is not. Repo-local identity, no credentials, `local.config.json` and `baseline/local/`
   are ignored.
3. **Do not install the bundle into the live DSH profile yet.** It would sit next to
   `dsh-desktop-hands`, and two tool sets + two gates on one desktop is exactly what
   order §8 warns about. Installability is proven structurally and through `apply()`,
   not by switching the human's tooling.
4. **Authorization stays, but is not sharpened further for now.** The human's model:
   the gate only has to cover the tool entry path, not act as a system sandbox. The
   current design already does exactly that (one gate in front of every write; the
   audit is explicitly *not* a security boundary). No redesign was done.

---

## D1 — Settings: one config schema page, no custom web settings section

**Order (4.1):** "一个设置分页".
**What exists:** the plugin exports one Schemastery `Config` built from
`kernel/config.js:FIELD_SPEC`, so Plugin Manager shows exactly one settings page for
this plugin row. The previous bundle had a custom web-UI section (pixel
`client.js:392`) and no section at all for the other two engines.
**Deviation (revised 2026-11-14):** DSH renders forms only for *volatile* fields
(`dsh-settings`: “Forms expose only volatile fields … Ordinary configuration remains
editable through Cordis configuration files”). So the three numbers a human tunes —
`armMinutes`, `armActions`, `maxActionsPerMinute` — are declared `.volatile()` in
`buildSchema`, which puts a form on the Settings page; the gate and the commands read them
through `liveConfig()` so a change applies without a reload. The remaining keys are ordinary
and stay in the profile patch, changeable with `/dexter set <key> <value>` (validated,
persisted through the host config editor). A small `client.js` exists, but only for two
composer buttons (授权 / 面板).
**Why:** a settings UI would be a second place to declare defaults, and the profile
config row is already the single source. `hands_status` and `/dexter status` carry
the live state, and the desktop panel shows it when the DSH window is covered.
**Evidence:** `evidence/P1.md`, `test/03-config-single-source.test.mjs` (schema
defaults == runtime defaults).

---

## D2 — Legacy engines are vendored into the package (revised 2026-11-14)

**Order (2.2):** pixel/control injection stays; they become `legacy-*` backends.
**What existed first:** `backends/resolve.js` resolved `dsh-click-matrix` and `dsh-x2`
from an explicit config path → `DSH_DEXTER_LEGACY_ROOT` → `local.config.json` →
package resolution next to the plugin, so installing dsh-dexter alone could not inject.
**Revised:** the two engines now ship inside `vendor/` (unmodified upstream code, MIT,
with their licenses and the `koffi` native module), and `resolve.js` falls back to that
copy. An explicit path still wins, so an existing installation keeps working.
**What this costs:** the package grows by ~5.5 MB (pixel 886 KB, uia + koffi 4.6 MB) and
carries third-party code that must be updated deliberately, not silently.
**What it buys:** a fresh machine can install the bundle and inject with **no
prerequisites** — the property this plugin lacked.
**Evidence:** `THIRD-PARTY-NOTICES.md` (vendored table with versions and licenses),
`test/09-vendor.test.mjs` (boots the whole plugin with `local.config.json` hidden and
asserts `backends came from vendor`), `tools/check-repo.mjs` (manifest + licenses).

---

## D3 — The stroke toy no longer depends on the unlicensed engine (resolved 2026-11-14)

**Order (4.4):** "不把 `stroke-helper.exe` 作为无源码二进制发布".
**Evidence found:** `dsh-stroke` `package.json` has **no `license` field** and the
package has **no `LICENSE` file** (pixel and control are MIT).
**Resolution:** the toy's capability is kept but its injection moved in-repo.
`backends/toy-draw.js` sends the bounded stroke through the same Win32 `SendInput`
path the UIA backend already uses (MIT, `dsh-x2` / `dsh-screen`; derived plumbing is
credited in `THIRD-PARTY-NOTICES.md`). `dsh-stroke` is **no longer a prerequisite**,
`legacyStrokePath` was removed from the config, and `check-repo.mjs` now reports
**0 WARN** on runtime prerequisites (pixel MIT, uia MIT).
**What is preserved from the order:** the capability still exists, still behind the
single gate, still one optional tool, still a point cap, still `mode:"toy"` rows.
**What changed:** the toy's ~120 lines of mouse plumbing are now ours, and a real
toy draw can no longer be blamed on a binary nobody can audit.

---

## D4 — Per-action authorization uses the platform approval service, with a human grant as fallback

**Order (4.1/4.5.3):** default per-action, no default latch, stop revokes.
**What exists:** `kernel/gate.js` asks `ctx.get('approval').request(...)` once per
write (the same seam the old pixel engine used in `mode: ask`); if the deployment
composes no approval service, a human-opened grant (`/dexter arm`, hotkey) is the
channel, and without either the call is **refused** (fail-closed). Latched requires
both bounds and is off by default.
**Note:** the kernel arms the legacy pixel gate per action (`openArm{clicks:1,
source:'dexter-gate'}`), so the engine never prompts a second time for the same
decision.

---

## D5 — A3 measured as "one top-level owner per capability"

**Order (A3):** click/drag/scroll/type/key/hotkey "各只属于 `hands_act`".
**What exists:** those six appear in `hands_act`'s top-level `action` enum and
nowhere else at that level. They also appear inside `hands_run.steps[].action`,
because `hands_run` is the batch form of the same entry point (it replaces
`mouse_batch`/`screen_sequence`). There is exactly one implementation of each
capability: `kernel/kernel.js#runOne`.
**Evidence:** `test/01-surface.test.mjs` checks the top-level ownership table.

---

## D6 — Human pause is polled, not hooked

**Order (4.1/A9):** human activity suspends every write backend; ≤2 s to suspend.
**What exists:** `kernel/human.js` polls `GetAsyncKeyState` for ctrl/alt/shift/esc and
the cursor position every 150 ms, and ignores activity while it is itself injecting.
Suspend and resume are audited. Measured detection: see
`baseline/local/live-smoke.json` (`suspendWithin2s`).
**Limitation:** a key tap shorter than one poll interval can be missed; a kernel
input hook (WH_KEYBOARD_LL) was rejected because it needs a message loop in the host
process and would be a new global hook with its own failure modes.

---

## D7 — `move` is authorized (partly superseded by D13)

> **Superseded in part by D13** (2026-11-14): a bare hover is now free — authorized by
> policy, still audited, still rate-capped, and refused while a mouse button is held.
> What D7 keeps: `move` is never *silent*; it always produces an audit row, and inside a
> batch it still spends a credit.

**Evidence:** dual-run scenario "write without any authorization": the old engine
moved the cursor with no authorization at all (`lib/access.js:584` `checkMove` only
checks mode/paused/suspended/rate-limit), while dsh-dexter refuses. This is the one
of 20 scenarios that differs (A11 = 19/20).
**Decision:** keep it. The order lists `move` as a write capability and requires
every write to pass one gate; "hovering is harmless" is not a property this kernel
wants to bet the authorization model on.
**Cost:** a caller that only needs to hover must obtain approval, or the human can
open a grant (`/dexter arm 60 5`).

---

## D8 — The legacy pixel runtime writes one `loaded` marker into its own trail

**Evidence:** `evidence/P3.md` (row counts before/after 20 actions).
**What happens:** `__createRuntime` appends a `loaded` row to
`<DSH_HOME>/click-matrix/audit.jsonl` *before* the adapter can replace the writer.
No action record ever lands there; the adapter forwards every later row into
`hands.jsonl`.
**Why not fixed:** removing it would mean forking the engine's constructor, which the
order forbids ("不重写 pixel/control 注入"). It is documented, counted, and separated
from the single action trail.

---

## D10 — Incident: a test left Shift stuck down (fixed, with a guard)

**Symptom (reported by the human, 2026-11-14 ~15:45):** the mouse wheel "did not
work" and some keyboard shortcuts stopped working.

**Cause:** `test/live-smoke.mjs` proved human-activity detection with a real key press:
a child process held `Shift` for 900 ms and sent its own key-up. The parent killed the
child as soon as the suspend row appeared (≈400 ms), i.e. **mid-hold**, so no key-up
was ever sent and Windows kept `Shift` logically down (`GetAsyncKeyState` reported
`Shift`+`LShift` as down). With Shift held, every shortcut silently becomes
`Shift+…` and Shift+wheel scrolls horizontally — exactly both reported symptoms.

**Fix:** the test now waits for the child to release the key itself (bounded 8 s) and
then sends an unconditional key-up for `Shift/LShift/RShift`; the same script asserts
`stuckModifiers` is empty at the end. The stuck key itself was released with
`keybd_event(KEYEVENTF_KEYUP)` and re-verified (`STUCK_KEYS=[]`).

**Not the cause:** no stray helper/process. Neither helper installs a low-level hook
(no `SetWindowsHookEx` in `helper.cs` / `stroke-helper.cs`), so neither can swallow
wheel or key events; the only helper running is the live plugin's, started 10:10
before this session's tests, and every helper spawned by the tests is gone.

**Rule added:** any test that injects a held key must own its release, and must wait
for the holder to finish rather than killing it.

## D9 — P0 reconciliation: 769 attempts in the order vs 863 across generations

**Order (1.2):** `decision:"attempt"` 769 times in `~/.dsh/click-matrix/audit.jsonl`.
**Measured 2026-11-14:** the live file holds 1,812 rows and 285 `attempt` rows; two
sealed generations hold 94 + 5 + 479. Sum across all generations = **863**.
**Verdict:** no conflict with the order's *conclusion* — pixel still carries the vast
majority of writes (863 vs 130 control `allow` vs 2 stroke rows ≈ 86.7%), which is
the number the conclusion rests on. The 769 figure was a different rotation window.
