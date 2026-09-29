import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../log.ts';
import { createMessageRouter } from './router.ts';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
}

describe('createMessageRouter', () => {
  it('dispatches a valid message to its handler', async () => {
    const log = fakeLogger();
    const router = createMessageRouter('panel', log);
    const ready = vi.fn();
    router.on('ready', ready);
    expect(await router.handle({ type: 'ready', view: 'panel' })).toBe(true);
    expect(ready).toHaveBeenCalledWith({ type: 'ready', view: 'panel' });
  });

  it.each([
    ['not an object', 'ready'],
    ['null', null],
    ['unknown type', { type: 'exec', command: 'rm -rf /' }],
    ['missing field', { type: 'ready' }],
    ['extra field', { type: 'ready', view: 'panel', html: '<script>' }],
    ['bad enum', { type: 'ready', view: 'terminal' }],
    ['non-allow-listed command', { type: 'command', command: 'workbench.action.terminal.new' }],
    ['oversized log', { type: 'log', level: 'info', message: 'x'.repeat(2001) }],
  ])('rejects and logs a malformed message (%s) without throwing', async (_case, raw) => {
    const log = fakeLogger();
    const router = createMessageRouter('panel', log);
    const handler = vi.fn();
    router.on('ready', handler);
    router.on('command', handler);
    router.on('log', handler);
    await expect(router.handle(raw)).resolves.toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn.mock.calls[0]?.[0]).toMatch(/^Rejected malformed message from panel webview/);
  });

  it('does not echo the payload into the log', async () => {
    const log = fakeLogger();
    await createMessageRouter('panel', log).handle({
      type: 'log',
      level: 'info',
      message: 7,
      secret: 'sk-123',
    });
    expect(log.warn.mock.calls[0]?.[0]).not.toContain('sk-123');
  });

  it('logs handler failures instead of throwing', async () => {
    const log = fakeLogger();
    const router = createMessageRouter('decisions', log);
    router.on('ready', () => {
      throw new Error('boom');
    });
    await expect(router.handle({ type: 'ready', view: 'decisions' })).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('logs async handler rejections', async () => {
    const log = fakeLogger();
    const router = createMessageRouter('panel', log);
    router.on('command', () => Promise.reject(new Error('no such command')));
    await router.handle({ type: 'command', command: 'mutt.showLog' });
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('no such command'));
  });

  it('ignores valid messages without a handler at debug level', async () => {
    const log = fakeLogger();
    await createMessageRouter('panel', log).handle({ type: 'ready', view: 'panel' });
    expect(log.debug).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
