import { Writable } from 'node:stream';
import { format } from 'node:util';

/**
 * stdout is the JSON-RPC transport, so a single stray byte corrupts the stream. This takes stdout
 * for the transport and sends every other writer (console.*, process.stdout.write from any
 * dependency) to stderr instead. Call it before anything else runs.
 */
export function claimStdout(
  stdout: NodeJS.WriteStream = process.stdout,
  stderr: NodeJS.WriteStream = process.stderr,
): Writable {
  const rawWrite = stdout.write.bind(stdout);
  const transport = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      rawWrite(chunk, (err) => callback(err ?? null));
    },
  });

  stdout.write = stderr.write.bind(stderr) as typeof stdout.write;
  const toStderr = (...args: unknown[]): void => {
    stderr.write(`${format(...args)}\n`);
  };
  for (const method of ['log', 'info', 'debug', 'warn', 'error', 'trace'] as const) {
    console[method] = toStderr;
  }
  return transport;
}
