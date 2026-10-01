import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

export interface RotatingFileOptions {
  dir: string;
  /** Base name; rotated files become `<name>.1`, `<name>.2`, … (oldest has the highest number). */
  name?: string;
  maxBytes?: number;
  /** Rotated files kept besides the active one. */
  keep?: number;
}

/**
 * Size-based rotating log file. Synchronous on purpose: log volume is low, and sync writes mean the
 * last lines before a crash reach disk. pino's worker-thread transports don't survive bundling.
 */
export class RotatingFile {
  readonly path: string;
  private fd: number;
  private size: number;
  private readonly maxBytes: number;
  private readonly keep: number;

  constructor({
    dir,
    name = 'orchestrator.log',
    maxBytes = 5 * 1024 * 1024,
    keep = 3,
  }: RotatingFileOptions) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, name);
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.fd = openSync(this.path, 'a');
    this.size = statSync(this.path).size;
  }

  write(line: string): void {
    const bytes = Buffer.byteLength(line);
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
    writeSync(this.fd, line);
    this.size += bytes;
  }

  close(): void {
    closeSync(this.fd);
  }

  private rotate(): void {
    closeSync(this.fd);
    rmSync(`${this.path}.${this.keep}`, { force: true });
    for (let i = this.keep - 1; i >= 1; i--) {
      if (existsSync(`${this.path}.${i}`)) renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
    }
    if (this.keep > 0) renameSync(this.path, `${this.path}.1`);
    else rmSync(this.path, { force: true });
    this.fd = openSync(this.path, 'a');
    this.size = 0;
  }
}
