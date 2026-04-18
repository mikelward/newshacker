import { describe, expect, it, vi } from 'vitest';
import { buildSharePayload, shareOrCopy } from './share';
import type { HNItem } from './hn';

const story: HNItem = {
  id: 42,
  type: 'story',
  title: 'A story',
  url: 'https://example.com/post',
  by: 'alice',
  score: 1,
  descendants: 0,
  time: 0,
};

describe('buildSharePayload', () => {
  it('uses the article url when present', () => {
    const p = buildSharePayload(story, 'https://newshacker.app/');
    expect(p.url).toBe('https://example.com/post');
    expect(p.title).toBe('A story');
  });

  it('falls back to the thread url for self-posts', () => {
    const p = buildSharePayload(
      { ...story, url: undefined },
      'https://newshacker.app',
    );
    expect(p.url).toBe('https://newshacker.app/item/42');
  });
});

describe('shareOrCopy', () => {
  const payload = { title: 't', text: 't', url: 'https://x' };

  it('uses navigator.share when available', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const copy = vi.fn();
    const result = await shareOrCopy(payload, { share, copy });
    expect(result).toBe('shared');
    expect(share).toHaveBeenCalledWith(payload);
    expect(copy).not.toHaveBeenCalled();
  });

  it('treats AbortError from share as cancelled and does not fall back', async () => {
    const abort = new Error('cancelled');
    abort.name = 'AbortError';
    const share = vi.fn().mockRejectedValue(abort);
    const copy = vi.fn();
    const result = await shareOrCopy(payload, { share, copy });
    expect(result).toBe('cancelled');
    expect(copy).not.toHaveBeenCalled();
  });

  it('falls back to copy when share throws a non-abort error', async () => {
    const share = vi.fn().mockRejectedValue(new Error('boom'));
    const copy = vi.fn().mockResolvedValue(undefined);
    const result = await shareOrCopy(payload, { share, copy });
    expect(result).toBe('copied');
    expect(copy).toHaveBeenCalledWith('https://x');
  });

  it('uses copy when share is unavailable', async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    const result = await shareOrCopy(payload, { copy });
    expect(result).toBe('copied');
  });

  it('returns "unavailable" when neither is available', async () => {
    const result = await shareOrCopy(payload, {});
    expect(result).toBe('unavailable');
  });

  it('returns "unavailable" when copy also fails', async () => {
    const copy = vi.fn().mockRejectedValue(new Error('no clipboard'));
    const result = await shareOrCopy(payload, { copy });
    expect(result).toBe('unavailable');
  });
});
