// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { json } from './http';

describe('json', () => {
  it('serializes the body as JSON with the default status 200', async () => {
    const res = json({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    );
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('honors the supplied status', async () => {
    const res = json({ error: 'nope' }, 418);
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: 'nope' });
  });

  it('merges extra headers (e.g. set-cookie)', () => {
    const res = json({ ok: true }, 200, { 'set-cookie': 'a=1' });
    expect(res.headers.get('set-cookie')).toBe('a=1');
    expect(res.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    );
  });

  it('does not let extraHeaders override content-type or cache-control', () => {
    const res = json({ ok: true }, 200, {
      'content-type': 'text/plain',
      'cache-control': 'public, max-age=3600',
    });
    expect(res.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    );
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});
