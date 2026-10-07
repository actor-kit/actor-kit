/**
 * A tests/e2e-studio wrangler dev server the restart test owns: it starts it,
 * kills it mid-session (every Durable Object and socket dies with it) and
 * starts it again on the same port and persisted state.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";

const STUDIO_WORKER_DIR = resolve(import.meta.dirname, "../../../e2e-studio");

export interface DevServer {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

async function waitUntilUp(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`wrangler dev on ${baseUrl} did not come up in ${timeoutMs}ms`);
}

async function assertPortFree(baseUrl: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/`);
  } catch {
    return;
  }
  throw new Error(`${baseUrl} already answers: another server holds the port`);
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((r) => child.once("exit", () => r()));
}

export async function startStudioWorker(port: number, persistTo: string): Promise<DevServer> {
  const baseUrl = `http://localhost:${port}`;
  await assertPortFree(baseUrl);
  const child = spawn(
    "pnpm",
    ["exec", "wrangler", "dev", "--persist-to", persistTo, "--port", String(port), "--inspector-port", "0"],
    {
      cwd: STUDIO_WORKER_DIR,
      detached: true, // own process group, so stop() takes workerd down with wrangler
      stdio: "ignore",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  const stop = async (): Promise<void> => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      return; // already gone
    }
    const killTimer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // gone
      }
    }, 5_000);
    await exited(child);
    clearTimeout(killTimer);
    // workerd may outlive the wrangler parent for a moment: wait for the port to close.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        await fetch(`${baseUrl}/`);
        await new Promise((r) => setTimeout(r, 200));
      } catch {
        return;
      }
    }
  };
  try {
    await waitUntilUp(baseUrl, 60_000);
  } catch (err) {
    await stop();
    throw err;
  }
  return { baseUrl, stop };
}
