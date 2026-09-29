import { beforeEach, describe, expect, it, vi } from 'vitest';

const postMessage = vi.fn();
vi.stubGlobal('acquireVsCodeApi', () => ({
  postMessage,
  getState: () => undefined,
  setState: vi.fn(),
}));

const { receive } = await import('./bridge.ts');

describe('receive', () => {
  beforeEach(() => postMessage.mockClear());

  it('accepts a valid extension message', () => {
    const m = { type: 'init', view: 'panel', devMode: true, showcase: false };
    expect(receive(m)).toEqual(m);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('tolerates extra fields on extension messages', () => {
    expect(receive({ type: 'showcase', enabled: true, future: 1 })).toEqual({
      type: 'showcase',
      enabled: true,
    });
  });

  it.each([null, 'init', { type: 'init' }, { type: 'mystery' }])(
    'drops malformed %j and reports it to the extension log',
    (raw) => {
      expect(receive(raw)).toBeUndefined();
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'log', level: 'warn' }),
      );
    },
  );
});
