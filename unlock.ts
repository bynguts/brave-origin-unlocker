// Brave Origin Unlocker — professional CLI.
// Subcommands: unlock | watch | status | install | uninstall | doctor
const VERSION = "1.0.0";
const WATCHDOG_IMAGE = "unlock-win.exe";

const os = Deno.build.os;

let localStatePathPattern: (version: string) => string;
let autostartScriptPath: string | null = null;

if (os === "windows") {
  const localAppData = Deno.env.get("LOCALAPPDATA");
  const appData = Deno.env.get("APPDATA");
  if (!localAppData || !appData) {
    console.error("Error: LOCALAPPDATA/APPDATA environment variable not found.");
    Deno.exit(1);
  }
  localStatePathPattern = (version) =>
    `${localAppData}\\BraveSoftware\\${version}\\User Data\\Local State`;
  autostartScriptPath =
    `${appData}\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\BraveOriginUnlockWatchdog.vbs`;
} else if (os === "darwin") {
  const homeDir = Deno.env.get("HOME");
  if (!homeDir) {
    console.error("Error: HOME environment variable not found.");
    Deno.exit(1);
  }
  localStatePathPattern = (version) =>
    `${homeDir}/Library/Application Support/BraveSoftware/${version}/Local State`;
  autostartScriptPath =
    `${homeDir}/Library/LaunchAgents/com.brave-origin-unlocker.plist`;
} else {
  console.error(`Error: Unsupported operating system: ${os}`);
  Deno.exit(1);
}

const channels = ["Brave-Origin", "Brave-Origin-Beta", "Brave-Origin-Nightly"];

const C = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

// Lockstep output helpers (shared by every command — consistent UX contract).
function ok(msg: string): void {
  console.log(`${C.green}✔${C.reset} ${msg}`);
}
function warn(msg: string): void {
  console.log(`${C.yellow}⚠${C.reset} ${msg}`);
}
function fail(msg: string): void {
  console.log(`${C.red}✖${C.reset} ${msg}`);
}
function info(msg: string): void {
  console.log(`${C.cyan}ℹ${C.reset} ${msg}`);
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Resolve the watchdog executable: the compiled exe when run as one,
 *  otherwise dist/unlock-win.exe when invoked via `deno task`. */
function resolveWatchdogExe(): string {
  const exec = Deno.execPath();
  const execName = exec.split(/[\\/]/).pop() ?? "";
  if (!/^deno(\.exe)?$/i.test(execName)) {
    return exec;
  }
  const candidate = `${Deno.cwd()}${os === "windows" ? "\\" : "/"}dist${os === "windows" ? "\\" : "/"}${WATCHDOG_IMAGE}`;
  if (Deno.statSync(candidate).isFile) {
    return candidate;
  }
  fail(
    `Watchdog exe not found. Run ${C.bold}deno task compile-win${C.reset} first, or run this command from the compiled binary.`,
  );
  Deno.exit(1);
}

/** True while any process with the given image name is running (Windows only). */
async function isProcessRunning(imageName: string): Promise<boolean> {
  const check = new Deno.Command("tasklist", {
    args: ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"],
    stdout: "piped",
    stderr: "null",
  });
  const { stdout } = await check.output();
  const text = new TextDecoder().decode(stdout);
  return text.toLowerCase().includes(imageName.toLowerCase()) &&
    !text.includes("INFO:");
}

/** True while a Brave-Origin-specific process (not regular Brave) is running. */
async function isOriginRunning(): Promise<boolean> {
  if (os === "windows") {
    const check = new Deno.Command("powershell", {
      args: [
        "-NoProfile",
        "-Command",
        "(Get-CimInstance Win32_Process -Filter \"Name='brave.exe'\" | Where-Object { $_.ExecutablePath -like '*Brave-Origin*' } | Measure-Object).Count -gt 0",
      ],
      stdout: "piped",
      stderr: "null",
    });
    const { stdout } = await check.output();
    return new TextDecoder().decode(stdout).trim().toLowerCase() === "true";
  }
  const check = new Deno.Command("pgrep", {
    args: ["-f", "Brave Origin.app"],
    stdout: "null",
    stderr: "null",
  });
  const { code } = await check.output();
  return code === 0;
}

type UnlockResult = "unlocked" | "already" | "missing";

/** Atomic file replacement: write a temp file, then swap it into place.
 *  Never leaves a half-written Local State behind. */
async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.unlocker-tmp`;
  await Deno.writeTextFile(tmp, data);
  try {
    await Deno.rename(tmp, path);
  } catch {
    // Windows rename can refuse to overwrite — remove target and retry.
    await Deno.remove(path);
    await Deno.rename(tmp, path);
  }
}

/** Read and parse a Local State file, or null when the channel is not installed. */
async function readLocalState(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }
}

/** Apply the unlock to one channel, idempotently and atomically.
 *  Keeps a one-time backup of the pristine Local State before first write. */
async function unlockOne(version: string): Promise<UnlockResult> {
  const localStatePath = localStatePathPattern(version);
  const localState = await readLocalState(localStatePath);
  if (localState === null) {
    return "missing";
  }

  const brave = localState.brave as
    | {
      origin?: {
        purchase_validated?: boolean;
        policies_were_enforced?: boolean;
      };
    }
    | undefined;
  const skus = localState.skus as { state?: { "67"?: string } } | undefined;
  const alreadyUnlocked =
    brave?.origin?.purchase_validated === true &&
    brave?.origin?.policies_were_enforced === true &&
    typeof skus?.state?.["67"] === "string" &&
    skus.state["67"].includes("credentials");
  if (alreadyUnlocked) {
    return "already";
  }

  // One-time backup of the pristine file (kept for uninstall/repair).
  const backupPath = `${localStatePath}.unlocker-backup`;
  try {
    await Deno.copyFile(localStatePath, backupPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) {
      try {
        await Deno.stat(backupPath);
      } catch {
        throw error;
      }
    }
  }

  const braveState = (localState.brave ?? {}) as Record<string, unknown>;
  const originState = (braveState.origin ?? {}) as Record<string, unknown>;
  originState.purchase_validated = true;
  originState.policies_were_enforced = true;
  braveState.origin = originState;
  localState.brave = braveState;

  // Merge into any existing skus object so unrelated SKU/feature state that
  // Brave updates later is preserved, not clobbered.
  const skusState = (localState.skus ?? {}) as Record<string, unknown>;
  const state = (skusState.state ?? {}) as Record<string, unknown>;
  state["67"] = JSON.stringify({
    credentials: {
      items: { "6": "7" },
    },
  });
  skusState.state = state;
  localState.skus = skusState;

  await writeAtomic(localStatePath, JSON.stringify(localState));
  return "unlocked";
}

/** Remove the unlock keys from one channel (clean uninstall). */
async function lockOne(version: string): Promise<boolean> {
  const localStatePath = localStatePathPattern(version);
  const localState = await readLocalState(localStatePath);
  if (localState === null) {
    return false;
  }

  const braveState = localState.brave as Record<string, unknown> | undefined;
  const skusState = localState.skus as { state?: Record<string, string> } |
    undefined;
  let changed = false;
  if (braveState?.origin !== undefined) {
    const origin = braveState.origin as Record<string, unknown>;
    delete origin.purchase_validated;
    delete origin.policies_were_enforced;
    changed = true;
  }
  if (skusState?.state?.["67"] !== undefined) {
    delete skusState.state["67"];
    changed = true;
  }
  if (changed) {
    await writeAtomic(localStatePath, JSON.stringify(localState));
  }
  return changed;
}

/** Unlock every installed channel. Quiet mode logs only real changes. */
async function unlockAll(quiet: boolean): Promise<boolean> {
  let foundAny = false;
  for (const version of channels) {
    const result = await unlockOne(version);
    if (result === "missing") {
      continue;
    }
    foundAny = true;
    if (result === "unlocked") {
      ok(`${version.replace(/-/g, " ")} unlocked successfully!`);
    } else if (!quiet) {
      info(`${version.replace(/-/g, " ")} already unlocked — skipping.`);
    }
  }
  if (!foundAny && !quiet) {
    warn("Brave Origin not found.");
  }
  return foundAny;
}

/** Single-instance guard for watch mode via a pid lock file. */
async function acquireWatchLock(): Promise<void> {
  const tmpDir = Deno.env.get("TEMP") ?? Deno.env.get("TMP") ?? "/tmp";
  const lockPath = `${tmpDir}${os === "windows" ? "\\" : "/"}brave-origin-unlocker.watch.lock`;
  try {
    const pid = parseInt((await Deno.readTextFile(lockPath)).trim(), 10);
    const alive = new Deno.Command("tasklist", {
      args: ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      stdout: "piped",
      stderr: "null",
    });
    const { stdout } = await alive.output();
    const running = new TextDecoder().decode(stdout).includes(`"${pid}"`);
    if (running && pid !== Deno.pid) {
      fail(`Watchdog already running (pid ${pid}). Exiting this instance.`);
      Deno.exit(1);
    }
  } catch {
    // No lock file (or unreadable pid) — safe to take over.
  }
  await Deno.writeTextFile(lockPath, String(Deno.pid));
}

/** Ensure the hidden autostart launcher exists (Startup .vbs on Windows). */
async function ensureAutostart(): Promise<void> {
  if (os !== "windows" || autostartScriptPath === null) {
    // macOS autostart (LaunchAgent) is created on demand for darwin builds.
    if (os === "darwin" && autostartScriptPath !== null) {
      const exe = resolveWatchdogExe();
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.brave-origin-unlocker</string>
  <key>ProgramArguments</key><array><string>${exe}</string><string>--watch</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
`;
      await Deno.writeTextFile(autostartScriptPath, plist);
    }
    return;
  }
  const exe = resolveWatchdogExe().replaceAll("\\", "\\\\");
  const vbs = `' Brave Origin unlock watchdog - re-applies unlock after the browser closes.
' Managed by brave-origin-unlocker; remove via "unlock-win.exe uninstall".
Set shell = CreateObject("WScript.Shell")
shell.Run """${exe}"" --watch", 0, False
`;
  await Deno.writeTextFile(autostartScriptPath, vbs);
}

/** Remove the autostart launcher. */
async function removeAutostart(): Promise<void> {
  if (autostartScriptPath === null) {
    return;
  }
  try {
    await Deno.remove(autostartScriptPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
}

/** Launch a detached, hidden watchdog instance (Windows). */
async function launchWatchdogHidden(): Promise<void> {
  const exe = resolveWatchdogExe();
  if (os === "windows") {
    const launch = new Deno.Command("powershell", {
      args: [
        "-NoProfile",
        "-Command",
        `Start-Process -WindowStyle Hidden -FilePath '${exe}' -Argument '--watch'`,
      ],
      stdout: "null",
      stderr: "null",
    });
    await launch.output();
  } else {
    const launch = new Deno.Command(exe, {
      args: ["--watch"],
      stdout: "null",
      stderr: "null",
    });
    launch.spawn();
  }
}

/** Stop any running watchdog instances except ourselves (Windows).
 *  taskkill /IM would match our own image name too, so filter by PID instead. */
async function stopWatchdog(): Promise<void> {
  if (os !== "windows") {
    return;
  }
  const list = new Deno.Command("tasklist", {
    args: ["/FI", `IMAGENAME eq ${WATCHDOG_IMAGE}`, "/FO", "CSV", "/NH"],
    stdout: "piped",
    stderr: "null",
  });
  const { stdout } = await list.output();
  const text = new TextDecoder().decode(stdout);
  for (const line of text.split("\n")) {
    if (!line.toLowerCase().includes(WATCHDOG_IMAGE.toLowerCase())) continue;
    // CSV row: "unlock-win.exe","1234","Console",...
    const pid = parseInt(line.split("\",\"")[1] ?? "", 10);
    if (!Number.isFinite(pid) || pid === Deno.pid) continue;
    const kill = new Deno.Command("taskkill", {
      args: ["/PID", String(pid), "/F"],
      stdout: "null",
      stderr: "null",
    });
    await kill.output();
  }
}

// --- Commands ---------------------------------------------------------------

async function cmdUnlock(): Promise<void> {
  console.log(`${C.bold}Brave Origin Unlocker${C.reset} ${C.dim}v${VERSION}${C.reset}`);
  if (await isOriginRunning()) {
    warn(
      "Brave Origin is currently running. Close it first, otherwise it may overwrite the unlock when it exits.",
    );
  }
  await unlockAll(false);
}

async function cmdStatus(): Promise<void> {
  console.log(`${C.bold}Brave Origin Unlocker${C.reset} ${C.dim}v${VERSION}${C.reset}\n`);

  console.log(`${C.bold}Channels:${C.reset}`);
  for (const version of channels) {
    const path = localStatePathPattern(version);
    const localState = await readLocalState(path);
    if (localState === null) {
      console.log(`  ${C.dim}— ${version}: not installed${C.reset}`);
      continue;
    }
    const brave = localState.brave as
      | {
        origin?: {
          purchase_validated?: boolean;
          policies_were_enforced?: boolean;
        };
      }
      | undefined;
    const skus = localState.skus as { state?: { "67"?: string } } | undefined;
    const unlocked =
      brave?.origin?.purchase_validated === true &&
      brave?.origin?.policies_were_enforced === true &&
      typeof skus?.state?.["67"] === "string" &&
      skus.state["67"].includes("credentials");
    const state = unlocked
      ? `${C.green}UNLOCKED${C.reset}`
      : `${C.red}locked${C.reset}`;
    console.log(`  ${unlocked ? "✔" : "✖"} ${version}: ${state}`);
  }

  console.log(`\n${C.bold}Watchdog:${C.reset}`);
  if (os === "windows") {
    const running = await isProcessRunning(WATCHDOG_IMAGE);
    console.log(
      `  ${running ? "✔" : "✖"} process: ${
        running ? `${C.green}running${C.reset}` : `${C.red}not running${C.reset}`
      }`,
    );
  }
  if (autostartPathExists) {
    ok(`autostart: enabled (${autostartScriptPath})`);
  } else {
    fail(`autostart: disabled`);
  }

  if (await isOriginRunning()) {
    warn("Brave Origin is currently running — unlock state may change on exit.");
  } else {
    info("Brave Origin is not running — safe state for any operation.");
  }
}

let autostartPathExists = false;
try {
  if (autostartScriptPath !== null) {
    autostartPathExists = Deno.statSync(autostartScriptPath).isFile;
  }
} catch {
  autostartPathExists = false;
}

async function cmdInstall(): Promise<void> {
  console.log(`${C.bold}Brave Origin Unlocker${C.reset} ${C.dim}v${VERSION}${C.reset}\n`);
  info("Installing: unlock + autostart + watchdog...\n");

  await unlockAll(false);
  await ensureAutostart();
  ok(`Autostart launcher written: ${autostartScriptPath}`);

  // Restart the watchdog cleanly so the newest build is what keeps running.
  await stopWatchdog();
  await sleep(1000);
  await launchWatchdogHidden();
  await sleep(3000);
  if (os === "windows" && (await isProcessRunning(WATCHDOG_IMAGE))) {
    ok("Watchdog started (hidden, background).");
  } else {
    warn("Watchdog may not have started — run the doctor command to diagnose.");
  }

  console.log(
    `\n${C.green}Done!${C.reset} The unlock now re-applies itself after every Brave Origin exit, and the watchdog starts automatically at every logon.`,
  );
}

async function cmdUninstall(): Promise<void> {
  console.log(`${C.bold}Brave Origin Unlocker${C.reset} ${C.dim}v${VERSION}${C.reset}\n`);
  info("Uninstalling: stopping watchdog, removing autostart, reverting unlock...\n");

  await stopWatchdog();
  ok("Watchdog stopped.");

  await removeAutostart();
  ok("Autostart launcher removed.");

  let reverted = 0;
  for (const version of channels) {
    if (await lockOne(version)) {
      ok(`${version.replace(/-/g, " ")} unlock keys removed.`);
      reverted++;
    }
  }
  if (reverted === 0) {
    info("No unlock keys found to remove.");
  }

  console.log(
    `\n${C.green}Uninstalled.${C.reset} Backups of your original Local State files were kept as ${C.dim}*.unlocker-backup${C.reset} if you ever need them.`,
  );
}

async function cmdDoctor(): Promise<void> {
  console.log(`${C.bold}Brave Origin Unlocker — Doctor${C.reset} ${C.dim}v${VERSION}${C.reset}\n`);

  let healthy = true;

  // 1. Unlock state.
  let anyUnlocked = false;
  let anyInstalled = false;
  for (const version of channels) {
    const result = await unlockOne(version);
    if (result === "unlocked") {
      ok(`${version.replace(/-/g, " ")}: unlock re-applied (was missing).`);
      anyUnlocked = true;
      anyInstalled = true;
    } else if (result === "already") {
      anyUnlocked = true;
      anyInstalled = true;
    }
  }
  if (!anyInstalled) {
    fail("No Brave Origin installation detected.");
    healthy = false;
  } else if (!anyUnlocked) {
    healthy = false;
  } else {
    ok("Unlock state: healthy.");
  }

  // 2. Autostart.
  await ensureAutostart();
  ok(`Autostart: healthy (${autostartScriptPath}).`);

  // 3. Watchdog process.
  if (os === "windows") {
    if (!(await isProcessRunning(WATCHDOG_IMAGE))) {
      warn("Watchdog not running — restarting it now.");
      await launchWatchdogHidden();
      await sleep(3000);
      if (await isProcessRunning(WATCHDOG_IMAGE)) {
        ok("Watchdog restarted.");
      } else {
        fail("Watchdog failed to start.");
        healthy = false;
      }
    } else {
      ok("Watchdog: running.");
    }
  }

  console.log(
    healthy
      ? `\n${C.green}All checks passed.${C.reset} Your Brave Origin unlock is protected.`
      : `\n${C.red}Problems found.${C.reset} See the messages above.`,
  );
  if (!healthy) {
    Deno.exit(1);
  }
}

// --- Event-driven watcher (no polling) ---------------------------------------
// The watchdog subscribes to OS file-change notifications (ReadDirectoryChangesW
// on Windows, FSEvents on macOS) on each channel's "User Data" directory plus
// the BraveSoftware parent directory. A Brave update or browser exit that
// rewrites Local State wakes the watchdog instantly; otherwise it uses zero CPU.
// A rare long-interval safety sweep catches anything the OS notifications miss.

const PATH_SEP = os === "windows" ? "\\" : "/";
const QUIET_MS = 1500; // debounce: wait for a burst of file events to stop
const SAFETY_MS = 120_000; // rare fallback sweep when no events occur at all

function dirname(path: string): string {
  const i = path.lastIndexOf(PATH_SEP);
  return i < 0 ? "." : path.slice(0, i);
}
function basename(path: string): string {
  const i = path.lastIndexOf(PATH_SEP);
  return i < 0 ? path : path.slice(i + 1);
}

interface WatchEntry {
  role: "channel" | "parent";
  dir: string;
  watcher: Deno.FsWatcher;
  iter: AsyncIterator<Deno.FsEvent>;
  /** Relevant if a changed path matches. An event with no paths (Windows
   *  buffer overflow) is always relevant. */
  match: (path: string) => boolean;
  /** One outstanding next() per watcher; re-armed only when it wins a race. */
  pending: Promise<EventResult> | null;
}

type EventResult =
  | { entry: WatchEntry; done: true }
  | { entry: WatchEntry; done: false; value: Deno.FsEvent };

function arm(entry: WatchEntry): Promise<EventResult> {
  return entry.iter.next().then(
    (res) =>
      res.done
        ? ({ entry, done: true }) as EventResult
        : ({ entry, done: false, value: res.value }) as EventResult,
    () => ({ entry, done: true }) as EventResult,
  );
}

function addWatcher(
  entries: WatchEntry[],
  role: WatchEntry["role"],
  dir: string,
  match: WatchEntry["match"],
  label: string,
): void {
  if (entries.some((e) => e.dir === dir)) return;
  const watcher = Deno.watchFs(dir, { recursive: false });
  const entry: WatchEntry = {
    role,
    dir,
    watcher,
    iter: watcher[Symbol.asyncIterator](),
    match,
    pending: null,
  };
  entry.pending = arm(entry);
  entries.push(entry);
  info(`Watching ${label}`);
}

function closeEntry(entries: WatchEntry[], entry: WatchEntry): void {
  const i = entries.indexOf(entry);
  if (i === -1) return;
  try {
    entry.watcher.close();
  } catch {
    // already closed
  }
  entries.splice(i, 1);
}

function closeRole(entries: WatchEntry[], role: WatchEntry["role"]): void {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].role === role) closeEntry(entries, entries[i]);
  }
}

const channelDir = (version: string) => dirname(localStatePathPattern(version));

/** Watch one channel's "User Data" directory for Local State rewrites. */
function addChannelWatcher(entries: WatchEntry[], version: string): void {
  const dir = channelDir(version);
  addWatcher(entries, "channel", dir, (p) => {
    return basename(p).startsWith("Local State");
  }, `${dir} (${version})`);
}

/** Watch the BraveSoftware directory so newly installed/uninstalled channels
 *  are picked up without any timer. */
function ensureParentWatcher(entries: WatchEntry[]): void {
  if (entries.some((e) => e.role === "parent")) return;
  // Local State path: ...\BraveSoftware\<Channel>\User Data\Local State
  const braveSoftware = dirname(dirname(channelDir(channels[0])));
  // If BraveSoftware itself is missing, watch the nearest existing ancestor.
  let dir = braveSoftware;
  while (true) {
    try {
      Deno.statSync(dir);
      break;
    } catch {
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  addWatcher(entries, "parent", dir, (p) => {
    return basename(p).startsWith("Brave-Origin");
  }, `${dir} (BraveSoftware parent)`);
}

/** Add channel watchers for every installed channel we are not watching yet. */
async function rescanChannels(entries: WatchEntry[]): Promise<void> {
  for (const version of channels) {
    if (entries.some((e) => e.role === "channel" && e.dir === channelDir(version))) {
      continue;
    }
    if ((await readLocalState(localStatePathPattern(version))) === null) {
      continue;
    }
    addChannelWatcher(entries, version);
  }
}

/** Wait for the next relevant event from any watcher. Irrelevant events are
 *  filtered out; each watcher keeps exactly one outstanding next() pending. */
async function nextEvent(entries: WatchEntry[]): Promise<EventResult> {
  while (true) {
    const racers = entries.filter((e) => e.pending).map((e) =>
      e.pending!.then((r) => ({ entry: e, r }))
    );
    if (racers.length === 0) {
      await sleep(5000); // no watchers; caller re-adds the parent watcher
      continue;
    }
    const { entry, r } = await Promise.race(racers);
    if (r.done) return r;
    entry.pending = arm(entry);
    // Deno yields a `rescan` kind on some platforms when events overflow, but
    // not in its typings; an event with no paths is always relevant.
    const paths = r.value.paths ?? [];
    if (paths.length === 0 || paths.some((p) => entry.match(p))) {
      return r;
    }
  }
}

type SettleResult = { quiet: true } | { quiet: false };

/** Debounce: wait until `ms` of silence on channel events. Returns early if a
 *  parent-watcher event arrives meanwhile, so it is never lost. */
async function settle(entries: WatchEntry[], ms: number): Promise<SettleResult> {
  while (true) {
    const winner = await Promise.race([
      nextEvent(entries).then((r) => ({ kind: "event", r }) as const),
      sleep(ms).then(() => ({ kind: "timeout" }) as const),
    ]);
    if (winner.kind === "timeout") return { quiet: true };
    const r = winner.r;
    if (r.done) {
      closeEntry(entries, r.entry);
      ensureParentWatcher(entries);
      continue;
    }
    if (r.entry.role === "parent") return { quiet: false };
    // Channel event during the quiet window — keep draining until silence.
  }
}

/** Re-apply the unlock after the browser closed or an update wiped it.
 *  Never writes while Brave Origin is running (it would overwrite on exit). */
async function healIfSafe(): Promise<void> {
  if (await isOriginRunning()) return;
  await sleep(500); // let any tmp+rename settle after the last event
  await unlockAll(true);
}

async function cmdWatch(): Promise<void> {
  await acquireWatchLock();
  info(
    "Brave Origin unlock watchdog started — watching Local State files (event-driven, no polling).",
  );
  await unlockAll(false);

  const entries: WatchEntry[] = [];
  ensureParentWatcher(entries);
  await rescanChannels(entries);

  while (true) {
    if (entries.length === 0) ensureParentWatcher(entries);
    const winner = await Promise.race([
      nextEvent(entries).then((r) => ({ kind: "event", r }) as const),
      sleep(SAFETY_MS).then(() => ({ kind: "safety" }) as const),
    ]);

    if (winner.kind === "safety") {
      await healIfSafe();
      continue;
    }

    const r = winner.r;
    if (r.done) {
      // A watched directory disappeared (channel uninstalled) — drop it.
      closeEntry(entries, r.entry);
      ensureParentWatcher(entries);
      continue;
    }

    if (r.entry.role === "parent") {
      // A channel appeared/disappeared under BraveSoftware — rebuild watchers.
      closeRole(entries, "parent");
      ensureParentWatcher(entries);
      await rescanChannels(entries);
      await healIfSafe();
      continue;
    }

    // A Local State file changed (browser exit, update, or corruption).
    const settled = await settle(entries, QUIET_MS);
    if (!settled.quiet) {
      // A parent event arrived during debounce — process it the same way.
      closeRole(entries, "parent");
      ensureParentWatcher(entries);
      await rescanChannels(entries);
      await healIfSafe();
      continue;
    }
    await healIfSafe();
  }
}

function cmdHelp(): void {
  console.log(`${C.bold}Brave Origin Unlocker${C.reset} ${C.dim}v${VERSION}${C.reset}

Keeps Brave Origin premium features unlocked — permanently and automatically.

${C.bold}Usage:${C.reset} unlock-win.exe <command>

${C.bold}Commands:${C.reset}
  ${C.cyan}install${C.reset}     Unlock now + enable autostart + start watchdog (recommended)
  ${C.cyan}status${C.reset}      Show unlock, watchdog and autostart status
  ${C.cyan}unlock${C.reset}      One-shot unlock of all installed channels
  ${C.cyan}watch${C.reset}       Run the watchdog in the foreground
  ${C.cyan}doctor${C.reset}      Diagnose and repair any part of the setup
  ${C.cyan}uninstall${C.reset}   Stop watchdog, remove autostart, revert unlock keys
  ${C.cyan}help${C.reset}        Show this help

${C.bold}How it works:${C.reset}
  Writes purchase-validation state into Brave Origin's Local State file,
  then a hidden watchdog re-applies it whenever the browser exits or an
  update wipes it. Atomic writes + one-time backups keep your profile safe.`);
}

// --- Entry point -------------------------------------------------------------

const rawCommand = Deno.args.find((a) => !a.startsWith("--")) ??
  Deno.args[0] ??
  "unlock";
// Autostart/LaunchAgent/powershell pass `--watch`; strip leading dashes so
// those invocations reach the watch loop instead of defaulting to `unlock`.
const command = rawCommand.replace(/^--/, "");
switch (command) {
  case "unlock":
    await cmdUnlock();
    break;
  case "watch":
    await cmdWatch();
    break;
  case "status":
    await cmdStatus();
    break;
  case "install":
    await cmdInstall();
    break;
  case "uninstall":
    await cmdUninstall();
    break;
  case "doctor":
    await cmdDoctor();
    break;
  case "help":
  case "--help":
  case "-h":
    cmdHelp();
    break;
  case "version":
  case "--version":
    console.log(VERSION);
    break;
  default:
    fail(`Unknown command: ${command}`);
    cmdHelp();
    Deno.exit(1);
}
