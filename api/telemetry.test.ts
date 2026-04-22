// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDefaultStoreForTests,
  fieldFor,
  handleTelemetryRequest,
  isAllowedReferer,
  validatePayload,
  type TelemetryPayload,
  type TelemetryStore,
} from './telemetry';

function makeReq(
  init: {
    method?: string;
    referer?: string | null;
    body?: unknown;
    bodyRaw?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (init.referer !== null) {
    headers.set('referer', init.referer ?? 'https://newshacker.app/item/1');
  }
  const body =
    init.bodyRaw !== undefined
      ? init.bodyRaw
      : init.body !== undefined
        ? JSON.stringify(init.body)
        : undefined;
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request('https://newshacker.app/api/telemetry', {
    method: init.method ?? 'POST',
    headers,
    body,
  });
}

const validArticlePayload: TelemetryPayload = {
  kind: 'article',
  card_w: 400,
  summary_chars: 220,
  reserved_h: 120,
  rendered_h: 140,
  delta_h: 20,
};

const validCommentsPayload: TelemetryPayload = {
  kind: 'comments',
  card_w: 400,
  summary_chars: 320,
  reserved_h: 200,
  rendered_h: 180,
  delta_h: -20,
  insight_count: 5,
};

function makeStore(): TelemetryStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async incr(field) {
      calls.push(field);
    },
  };
}

describe('isAllowedReferer', () => {
  it('accepts newshacker.app and subdomains', () => {
    expect(isAllowedReferer('https://newshacker.app/')).toBe(true);
    expect(isAllowedReferer('https://www.newshacker.app/')).toBe(true);
    expect(isAllowedReferer('https://hnews.app/')).toBe(true);
  });
  it('accepts localhost, 127.0.0.1, and *.vercel.app', () => {
    expect(isAllowedReferer('http://localhost:5173/')).toBe(true);
    expect(isAllowedReferer('http://127.0.0.1:5173/')).toBe(true);
    expect(isAllowedReferer('https://newshacker-git-foo.vercel.app/')).toBe(
      true,
    );
  });
  it('rejects everything else and malformed input', () => {
    expect(isAllowedReferer(null)).toBe(false);
    expect(isAllowedReferer('https://evil.example/')).toBe(false);
    expect(isAllowedReferer('not a url')).toBe(false);
  });
});

describe('validatePayload', () => {
  it('accepts a valid article payload', () => {
    expect(validatePayload(validArticlePayload)).toEqual(validArticlePayload);
  });
  it('accepts a valid comments payload including insight_count', () => {
    expect(validatePayload(validCommentsPayload)).toEqual(validCommentsPayload);
  });
  it('rejects unknown kinds', () => {
    expect(
      validatePayload({ ...validArticlePayload, kind: 'other' }),
    ).toBeNull();
  });
  it('rejects non-numeric or non-finite fields', () => {
    expect(
      validatePayload({ ...validArticlePayload, card_w: '400' }),
    ).toBeNull();
    expect(
      validatePayload({ ...validArticlePayload, delta_h: Number.NaN }),
    ).toBeNull();
    expect(
      validatePayload({ ...validArticlePayload, rendered_h: Infinity }),
    ).toBeNull();
  });
  it('rejects absurd magnitudes to cap hash cardinality', () => {
    expect(
      validatePayload({ ...validArticlePayload, card_w: 1_000_000 }),
    ).toBeNull();
    expect(
      validatePayload({ ...validArticlePayload, delta_h: -1_000_000 }),
    ).toBeNull();
  });
  it('rejects implausible insight_count values', () => {
    expect(
      validatePayload({ ...validCommentsPayload, insight_count: -1 }),
    ).toBeNull();
    expect(
      validatePayload({ ...validCommentsPayload, insight_count: 999 }),
    ).toBeNull();
    expect(
      validatePayload({ ...validCommentsPayload, insight_count: 3.5 }),
    ).toBeNull();
  });
  it('rejects negative measurements (only delta_h may be negative)', () => {
    for (const f of [
      'card_w',
      'summary_chars',
      'reserved_h',
      'rendered_h',
    ] as const) {
      expect(validatePayload({ ...validArticlePayload, [f]: -1 })).toBeNull();
    }
    // delta_h stays legal when negative.
    expect(
      validatePayload({ ...validArticlePayload, delta_h: -40 }),
    ).toMatchObject({ delta_h: -40 });
  });
  it('re-buckets fractional / off-grid numeric fields server-side', () => {
    // A non-browser client skipping bucket20() can't grow the hash beyond
    // the bucket grid — the handler rounds every numeric field to the
    // nearest 20 before fieldFor() turns it into a hash key.
    const bucketed = validatePayload({
      kind: 'article',
      card_w: 391,
      summary_chars: 214.7,
      reserved_h: 124,
      rendered_h: 144,
      delta_h: 19.4,
    });
    expect(bucketed).toEqual({
      kind: 'article',
      card_w: 400,
      summary_chars: 220,
      reserved_h: 120,
      rendered_h: 140,
      delta_h: 20,
    });
  });
  it('ignores unexpected extra properties rather than rejecting', () => {
    const extra = { ...validArticlePayload, rogue: 'x' };
    expect(validatePayload(extra)).toEqual(validArticlePayload);
  });
  it('rejects non-object input', () => {
    expect(validatePayload(null)).toBeNull();
    expect(validatePayload('string')).toBeNull();
    expect(validatePayload(42)).toBeNull();
  });
});

describe('fieldFor', () => {
  it('encodes article (no insight_count) with a trailing empty slot', () => {
    expect(fieldFor(validArticlePayload)).toBe('article|400|220|120|140|20|');
  });
  it('encodes comments with insight_count', () => {
    expect(fieldFor(validCommentsPayload)).toBe(
      'comments|400|320|200|180|-20|5',
    );
  });
});

describe('handleTelemetryRequest', () => {
  beforeEach(() => {
    _resetDefaultStoreForTests();
  });
  afterEach(() => {
    _resetDefaultStoreForTests();
  });

  it('rejects non-POST methods with 405', async () => {
    const res = await handleTelemetryRequest(makeReq({ method: 'GET' }));
    expect(res.status).toBe(405);
  });

  it('rejects a missing or disallowed referer with 403', async () => {
    const noRef = await handleTelemetryRequest(makeReq({ referer: null }));
    expect(noRef.status).toBe(403);
    const badRef = await handleTelemetryRequest(
      makeReq({ referer: 'https://evil.example/' }),
    );
    expect(badRef.status).toBe(403);
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await handleTelemetryRequest(makeReq({ bodyRaw: 'not-json' }));
    expect(res.status).toBe(400);
  });

  it('rejects an invalid payload with 400 and does not increment the counter', async () => {
    const store = makeStore();
    const res = await handleTelemetryRequest(
      makeReq({ body: { kind: 'wat' } }),
      { store },
    );
    expect(res.status).toBe(400);
    expect(store.calls).toEqual([]);
  });

  it('accepts a valid article payload, increments once, returns 204', async () => {
    const store = makeStore();
    const res = await handleTelemetryRequest(
      makeReq({ body: validArticlePayload }),
      { store },
    );
    expect(res.status).toBe(204);
    expect(store.calls).toEqual(['article|400|220|120|140|20|']);
  });

  it('accepts a valid comments payload with insight_count', async () => {
    const store = makeStore();
    await handleTelemetryRequest(makeReq({ body: validCommentsPayload }), {
      store,
    });
    expect(store.calls).toEqual(['comments|400|320|200|180|-20|5']);
  });

  it('skips the store cleanly when no credentials are configured (store=null)', async () => {
    const res = await handleTelemetryRequest(
      makeReq({ body: validArticlePayload }),
      { store: null },
    );
    expect(res.status).toBe(204);
  });

  it('still returns 204 when the store.incr throws (fail-open)', async () => {
    const store: TelemetryStore = {
      incr: vi.fn(async () => {
        throw new Error('upstash down');
      }),
    };
    const res = await handleTelemetryRequest(
      makeReq({ body: validArticlePayload }),
      { store },
    );
    expect(res.status).toBe(204);
    expect(store.incr).toHaveBeenCalledTimes(1);
  });
});
