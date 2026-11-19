# Security policy — dsh-dexter

## Three layers, in order

1. **Target policy (permanent, not configurable).** System and security targets are
   refused outright: registry editor, task manager, services/group-policy/event-viewer
   tools, security software panels, credential managers, system settings, and any
   elevated window. Private/payment targets (chat, mail, banking, password-looking
   titles) always take one question per write. Lists: `kernel/targets.js`; tested in
   `test/02-auth-invariants.test.mjs`.
2. **Session authorization.** A human opens a bounded session (`/dexter arm`,
   `Ctrl+Alt+F12`) with minutes, an action budget and a rate cap; while it is open,
   writes do not ask. Without a session, each write asks once. A bare **cursor move is
   free**: it is audited (`hover(free)`), counted against the rate cap, and refused
   while any mouse button is held — because a move with a button down is a drag. The
   model can only revoke; it can never grant.
3. **Emergency stop.** Esc, `Ctrl+Alt+F11`, `/dexter stop` or a `stop.signal` file
   revoke the session immediately; the next write is refused.

## Five statements this build stands behind

1. **Local execution only** — it drives the desktop of the machine it runs on.
2. **Zero outbound traffic** — no socket, no telemetry, no upload of pixels, titles,
   text or audit rows.
3. **Per-action authorization** — the default is one human decision per write; a
   bounded grant or a latched grant must be opened by a human, and every use is
   still an audited approval.
4. **The audit is not a security boundary** — key-less hash chain in a plain file.
5. **Vulnerability disclosure** — see "Reporting a vulnerability" below.

## What this plugin is

A Windows-only desktop automation plugin for DeepSeek Harness. It lets a model look
at the local screen and, after a human decision, inject real mouse and keyboard
input into the local desktop. It is a local RPA / personal-automation tool.

## What this is not

Stated plainly, because the distinction matters for anyone who finds this repository:

- **Not a research or red-team tool.** It is not published as a vehicle for security
  research, and it is not intended to demonstrate or discover weaknesses in other
  software.
- **Not a way around another product's terms or anti-abuse controls.** Working around
  a CAPTCHA, an anti-cheat, a rate limit, a paywall or a licensing check is not a
  supported use, and the target policy refuses the obvious cases outright.
- **Not for unattended use on someone else's machine.** Every write needs a human
  decision (or a human-opened, bounded, expiring grant), and injection suspends while
  the human is using the machine.
- **Not a distribution channel for arbitrary code.** There is no npm package, no
  prebuilt helper binary in a release, and no auto-start: the vendored engines are
  MIT-licensed source in `vendor/`, compiled or loaded locally.

## Threat model (what the guarantees are and are not)

**In scope (design intent):**

- no network: the plugin opens no socket, sends no telemetry, uploads no
  screenshots, filenames, window titles or clipboard text;
- every write passes one authorization gate: per-action human approval through the
  host approval service, or a human-opened bounded grant;
- an emergency stop revokes authorization, and the next write is refused;
- one append-only audit trail per data root, hash-chained to its predecessor;
- input is only injected while the human is *not* using the machine; human activity
  suspends injection and resumes after an idle period;
- no elevation: the plugin never asks to run as administrator and never requests
  UAC; it operates with the integrity level of the DSH process.

**Explicitly out of scope (stated so nobody over-trusts it):**

- **Reads are not gated.** `hands_view` (screenshots, UIA trees, window lists, text,
  clipboard reads go through `hands_act`) does not ask before reading: a screenshot of a
  password manager window is allowed, and its pixels may contain secrets. The permanent
  system-target list applies to writes only.
- **`focus` changes the foreground window** without a write authorization. It is a read-side
  action by classification, but it visibly changes the desktop; the audit records it.
- **A deliberately injected key that matches a human hotkey is refused**, and the plugin's
  own keystrokes are ignored by the stop poller only for the exact combo injected — but
  another program may still synthesize input that looks like the human.

- **The audit is not a security boundary.** It is a key-less hash chain: it detects
  silent edits and insertions in a local file, not an attacker who rewrites the
  whole file. Records are ordinary files that the same user can delete.
- **Approval is not a sandbox.** A human "yes" authorizes one action; what that
  action does to the target application is outside this plugin's control.
- **Some content is untrusted input.** Screenshot text, window titles, UIA element
  names and clipboard content can contain instructions aimed at the model. The
  plugin treats them as data; the model must too.
- **Cross-integrity injection (UIPI)** is not attempted. Windows refuses
  `SendInput` into elevated windows; that refusal is a feature, not a bug.
- **Anti-cheat / EDR reactions** to synthetic input are outside our control.
- **Screen content is not scrubbed.** Screenshots can contain secrets (tokens,
  messages, personal data). They stay local and are only attached to the model's
  context when the caller asked for an image; the audit never stores pixels.
- **The stroke toy** is a demonstration, not a productivity capability.

## Rules this project holds itself to

1. No password fields, payment pages, OTP/CAPTCHA prompts, or banking UI: not a
   supported target, regardless of who asks.
2. No process that is not the human's explicit target; the pixel backend keeps a
   window deny list for security software, credential managers and system
   configuration tools.
3. No silent execution: a dry run and a refusal are always visible in the result
   text and in the audit.
4. No self-authorization: the model can revoke (`hands_act action=stop`) but never
   grant. `/dexter arm` and the hotkeys are human-only.

## Reporting a vulnerability

Open a private security advisory on the repository (GitHub → **Security** → *Report a
vulnerability*). Please include: the DSH version, the plugin version, the tool call, the
audit rows involved (redact any personal text), and what you expected. Do not include
screenshots of personal data.

The project is feature-frozen at 0.10.0; security fixes are still accepted and shipped.

## Data locations

| What | Where |
|---|---|
| audit trail | `<DSH_HOME>/dexter/audit/hands.jsonl` (env override `DSH_DEXTER_DATA_DIR`) |
| screenshots (only when requested) | `<data>/shots`, pruned by the returning engine |
| legacy engine state | its own data directory, e.g. `<DSH_HOME>/click-matrix` |
