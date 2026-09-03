/**
 * notify.ts — completion notification for long (10+ min) runs: terminal bell
 * always, macOS notification center best-effort. Never crashes a run, no
 * dependencies.
 */
import { spawn } from "node:child_process";

export function notifyDone(title: string, message: string): void {
  process.stdout.write("\a"); // terminal bell
  if (process.platform !== "darwin") return;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    spawn(
      "osascript",
      ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`],
      { stdio: "ignore", detached: true }
    ).unref();
  } catch {
    // bell already rang — the notification is a bonus
  }
}
