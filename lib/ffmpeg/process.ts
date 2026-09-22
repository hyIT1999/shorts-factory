/**
 * Runs an external program (ffmpeg / ffprobe) safely: arguments are passed as
 * an array to `spawn` without a shell, so no user data is ever interpreted by
 * cmd.exe or sh. Both output pipes are always drained (a full pipe would block
 * the child), stdout is capped and only the tail of stderr is kept. A timeout
 * kills the process; the promise settles exactly once. Every running child is
 * tracked, so the worker can stop them all when it shuts down or when its job
 * is cancelled (killActiveProcesses): ffmpeg must never outlive its job.
 */
import { spawn, type ChildProcess } from 'node:child_process';

const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

export interface ProcessOptions {
  cwd?: string;
  timeoutMs: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface ProcessResult {
  /** null when the process was killed. */
  exitCode: number | null;
  stdout: string;
  /** The last `maxStderrBytes` bytes of stderr. */
  stderr: string;
  timedOut: boolean;
}

export type ProcessRunner = (command: string, args: readonly string[], options: ProcessOptions) => Promise<ProcessResult>;

/** The program could not be started (e.g. ENOENT: not installed / wrong path). */
export class ProcessStartError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProcessStartError';
  }
}

/** Children started by runProcess that have not closed yet. */
const active = new Set<ChildProcess>();

export function activeProcessCount(): number {
  return active.size;
}

/**
 * Kills every running child with SIGKILL (ffmpeg needs no graceful stop, and
 * a half-written video.tmp.mp4 is discarded anyway). Their runProcess promises
 * settle through the normal 'close' path with exitCode null. Returns how many
 * processes were signalled. Safe to call from a signal or 'exit' handler.
 */
export function killActiveProcesses(): number {
  let killed = 0;
  for (const child of active) {
    if (child.kill('SIGKILL')) {
      killed++;
    }
  }
  return killed;
}

export const runProcess: ProcessRunner = (command, args, options) =>
  new Promise<ProcessResult>((resolve, reject) => {
    const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
    const maxStderr = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;

    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      // Synchronous failures, e.g. EINVAL for .bat/.cmd files without a shell.
      const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      reject(new ProcessStartError(code, `Could not start ${command} (${code})`));
      return;
    }
    active.add(child);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes < maxStdout) {
        const part = chunk.subarray(0, maxStdout - stdoutBytes);
        stdout.push(part);
        stdoutBytes += part.length;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > maxStderr) {
        stderr = stderr.subarray(stderr.length - maxStderr);
      }
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      active.delete(child);
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const code = error.code ?? 'UNKNOWN';
      reject(new ProcessStartError(code, `Could not start ${command} (${code})`));
    });

    child.on('close', (exitCode) => {
      active.delete(child);
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: stderr.toString('utf8'),
        timedOut,
      });
    });
  });
