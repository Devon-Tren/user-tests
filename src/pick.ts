/**
 * pick.ts — a real, native folder dialog.
 *
 * docs/HANDOFF.md framed the constraint as "a browser cannot hand a server a
 * folder path", and concluded a server-side folder browser was the only
 * option. That is true of the browser — but `usertests serve` runs on the
 * SAME machine as the person using it, so the *server* can open the OS's own
 * picker and read the path straight off it. The browser never sees a file.
 *
 * This is strictly better UX than the in-page browser, so it is the default,
 * with the in-page browser kept as the fallback for headless boxes, SSH
 * sessions, and platforms where no dialog binary exists.
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";

/** The user closed the dialog without choosing — not an error worth shouting about. */
export class PickCancelled extends Error {
  constructor() {
    super("folder selection cancelled");
  }
}

const TIMEOUT_MS = 120_000; // a dialog nobody answers must not pin a connection open

interface Dialog {
  cmd: string;
  args: (prompt: string) => string[];
  /** stderr/exit signatures that mean "cancelled", not "broken". */
  cancelled: (code: number | null, stderr: string) => boolean;
}

function dialogFor(platform: string): Dialog | null {
  if (platform === "darwin") {
    return {
      cmd: "osascript",
      args: (prompt) => [
        // Without an explicit activate the panel can open behind the browser.
        "-e", 'tell application "System Events" to activate',
        "-e", `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`,
      ],
      cancelled: (_c, err) => /User canceled|-128/i.test(err),
    };
  }
  if (platform === "win32") {
    return {
      cmd: "powershell",
      args: (prompt) => [
        "-NoProfile", "-STA", "-Command",
        `Add-Type -AssemblyName System.Windows.Forms;` +
        `$d = New-Object System.Windows.Forms.FolderBrowserDialog;` +
        `$d.Description = ${JSON.stringify(prompt)};` +
        `if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath } else { exit 1 }`,
      ],
      cancelled: (code) => code === 1,
    };
  }
  // Linux/BSD: zenity is the most commonly present of the GTK/KDE helpers.
  return {
    cmd: "zenity",
    args: (prompt) => ["--file-selection", "--directory", `--title=${prompt}`],
    cancelled: (code) => code === 1,
  };
}

/** True when a native dialog is even worth offering on this machine. */
export function nativePickerAvailable(platform = process.platform, env = process.env): boolean {
  if (platform === "darwin" || platform === "win32") return true;
  // A Linux box with no display has no dialog to show.
  return Boolean(env["DISPLAY"] || env["WAYLAND_DISPLAY"]);
}

/**
 * Open the OS folder picker and resolve to the chosen absolute path.
 * Throws PickCancelled when the user backs out.
 */
export function pickFolder(prompt = "Choose the project to test"): Promise<string> {
  const dialog = dialogFor(process.platform);
  if (!dialog) throw new Error("no native folder dialog on this platform");

  return new Promise((resolve, reject) => {
    execFile(
      dialog.cmd,
      dialog.args(prompt),
      { timeout: TIMEOUT_MS, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        const code = (err as NodeJS.ErrnoException & { code?: number })?.code;
        if (err && dialog.cancelled(typeof code === "number" ? code : null, String(stderr))) {
          return reject(new PickCancelled());
        }
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return reject(new Error(`${dialog.cmd} is not installed — use the in-page browser instead`));
        }
        if (err) return reject(new Error(String(stderr).trim() || err.message));

        const picked = stdout.trim().replace(/\/+$/, "");
        if (!picked) return reject(new PickCancelled());
        if (!existsSync(picked) || !statSync(picked).isDirectory()) {
          return reject(new Error(`not a folder: ${picked}`));
        }
        resolve(picked);
      }
    );
  });
}
