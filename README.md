# Brave Origin Unlocker

Unlock Brave Origin's premium features on Windows and macOS — permanently and automatically.

The tool writes Brave's own persisted purchase state into the browser's `Local State` file, then a hidden, **event-driven watchdog** (no polling, 0% idle CPU) re-applies it whenever the browser exits or an update wipes it.

## How it works

Brave Origin gates its features behind two persisted keys in the `Local State` JSON file, plus a SKU credential string. This tool writes exactly what a real purchase would write:

- `brave.origin.purchase_validated` → `true`
- `brave.origin.policies_were_enforced` → `true`
- `skus.state["67"]` → a credential payload

The watchdog watches each channel's `User Data` directory using OS file-change notifications (`ReadDirectoryChangesW` on Windows, FSEvents on macOS). When Brave rewrites `Local State`, the OS wakes the watchdog instantly and it re-applies the unlock — zero polling, zero idle CPU.

## Features

- ✅ Unlocks every installed Brave Origin channel (Stable / Beta / Nightly)
- ✅ Survives browser exits and updates via the background watchdog
- ✅ Event-driven watchdog — no polling, **0% idle CPU**
- ✅ Windows and macOS auto-detection
- ✅ Atomic writes — never leaves a half-written file
- ✅ One-time backup of your pristine `Local State`
- ✅ Idempotent — safe to run repeatedly
- ✅ Single-instance lock — the watchdog never runs twice
- ✅ Self-diagnosis with `doctor`

## Requirements

- **Deno** — the only dependency (no Node, no packages)
- **Windows** or **macOS**
- **Brave Origin** installed

## Quick start

```bash
git clone https://github.com/bynguts/brave-origin-unlocker.git
cd brave-origin-unlocker
deno task install
```

`install` unlocks every installed channel, registers the watchdog at logon, and starts it in the background.

> Prefer not to install Deno? Grab a pre-built binary from the [latest release](https://github.com/bynguts/brave-origin-unlocker/releases/latest).

## Commands

| Command | What it does |
|---|---|
| `deno task install` | Unlock + autostart + start watchdog (**recommended**) |
| `deno task unlock` | One-shot unlock of all installed channels |
| `deno task watch` | Run the watchdog in the foreground |
| `deno task status` | Show unlock, watchdog and autostart status |
| `deno task doctor` | Diagnose and repair any part of the setup |
| `deno task uninstall` | Stop watchdog, remove autostart, revert unlock keys |

Compiled binaries support the same commands, e.g. `unlock-win.exe install`.

### Example output

```text
$ deno task status
Brave Origin Unlocker v1.0.0

Channels:
  ✔ Brave-Origin: UNLOCKED
  — Brave-Origin-Beta: not installed
  — Brave-Origin-Nightly: not installed

Watchdog:
  ✔ process: running
✔ autostart: enabled
```

## Safety

- **Atomic writes** — `Local State` is written via temp-file + rename, never half-written
- **One-time backups** — the pristine file is kept as `Local State.unlocker-backup`
- **Idempotent** — safe to run any command repeatedly; already-unlocked files are never touched
- **Single-instance lock** — the watchdog never runs twice
- **Self-diagnosis** — `doctor` re-applies, re-registers, and restarts anything broken
- **Clean uninstall** — `uninstall` reverts the unlock keys, stops the watchdog, and removes autostart

## Compile / cross-compile

Standalone binaries for Windows and macOS:

```bash
deno task compile-win       # Windows x64          → dist/unlock-win.exe
deno task compile-mac-arm   # macOS Apple Silicon  → dist/unlock-mac-arm
deno task compile-mac-x64   # macOS Intel          → dist/unlock-mac-x64
```

## Repository layout

| Path | Purpose |
|---|---|
| `unlock.ts` | The entire CLI — single file, zero dependencies |
| `deno.json` | Deno tasks (run + compile) |

## FAQ

**Will it survive Brave Origin updates?**
Yes. The watchdog re-applies the unlock whenever the browser or an updater rewrites `Local State`.

**Does the watchdog drain battery or CPU?**
No. It blocks on OS file notifications — measured at **0% idle CPU** and ~12–30 MB RAM.

**Is it safe?**
It only edits Brave Origin's `Local State` (with a one-time backup) and only writes files it created. No network access is requested.

**How do I undo it?**
`deno task uninstall` — or restore your `Local State.unlocker-backup`.

## Disclaimer

This tool modifies local browser state. Use it on your own machines and at your own risk. It is not affiliated with Brave Software.
