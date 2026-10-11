import { spawn } from 'node:child_process';
import type { CommandResult } from './types.js';
import { tail } from './util.js';

/** Run a shell command and capture its outcome. Never throws; failures are reported in the result. */
export function runCommand(command: string, cwd: string, timeoutMs = 10 * 60_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(command, { cwd, shell: true, detached: true, env: { ...process.env, CI: '1' } });
    let out = '';
    let timedOut = false;
    const collect = (d: Buffer) => {
      out += d.toString();
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ command, exitCode: null, timedOut, durationMs: Date.now() - start, outputTail: String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ command, exitCode: code, timedOut, durationMs: Date.now() - start, outputTail: tail(out, 4000) });
    });
  });
}
