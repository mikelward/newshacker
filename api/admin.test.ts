// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractHnLoggedInUsername,
  handleAdminRequest,
  parseCookieHeader,
  usernameFromSessionValue,
  type AdminResponse,
  type HnVerifyResult,
} from './admin';

// A helper so every "logged-in mikelward" test uses the same stub.
// Tests that want to exercise failure paths override inline.
const verifyMikelward = async (): Promise<HnVerifyResult> => ({
  ok: true,
  username: 'mikelward',
});

function requestWithCookie(cookie: string | null): Request {
  const headers = new Headers();
  if (cookie !== null) headers.set('cookie', cookie);
  return new Request('https://newshacker.app/api/admin', {
    method: 'GET',
    headers,
  });
}

async function readBody(res: Response): Promise<AdminResponse> {
  return (await res.json()) as AdminResponse;
}

describe('parseCookieHeader / usernameFromSessionValue (admin copies)', () => {
  it('parses session cookies and extracts the username', () => {
    expect(
      usernameFromSessionValue(
        parseCookieHeader('hn_session=mikelward%26hash').hn_session,
      ),
    ).toBe('mikelward');
  });
});

describe('handleAdminRequest', () => {
  const envSnapshot: Record<string, string | undefined> = {};
  const envKeys = [
    'ADMIN_USERNAME',
    'SESSION_COOKIE_NAME',
    'GOOGLE_API_KEY',
    'JINA_API_KEY',
    'KV_REST_API_URL',
    'KV_REST_API_TOKEN',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'VERCEL_REGION',
    'VERCEL_GIT_COMMIT_SHA',
  ];

  beforeEach(() => {
    for (const k of envKeys) {
      envSnapshot[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of envKeys) {
      if (envSnapshot[k] === undefined) delete process.env[k];
      else process.env[k] = envSnapshot[k];
    }
  });

  it('rejects non-GET with 405', async () => {
    const res = await handleAdminRequest(
      new Request('https://newshacker.app/api/admin', { method: 'POST' }),
    );
    expect(res.status).toBe(405);
  });

  it('returns 401 when no session cookie is present', async () => {
    const res = await handleAdminRequest(requestWithCookie(null));
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
  });

  it('returns 401 when the session cookie value is malformed', async () => {
    const res = await handleAdminRequest(requestWithCookie('hn_session=a'));
    expect(res.status).toBe(401);
  });

  it('returns 403 when a non-admin is logged in (with diagnostic reason + signedInAs)', async () => {
    const res = await handleAdminRequest(
      requestWithCookie('hn_session=alice%26hash'),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      reason?: string;
      signedInAs?: string;
    };
    // The operator UI renders `reason` and `signedInAs` so the user
    // can see which HN identity was rejected.
    expect(body.reason).toBe('admin_user_mismatch');
    expect(body.signedInAs).toBe('alice');
  });

  it('surfaces HN-verified username on the 403 when HN disagrees with the prefix', async () => {
    // The claim matches ADMIN_USERNAME (prefix check passes and the
    // HN round-trip runs), but HN reports a different identity — e.g.
    // the cookie is valid but for a different user.
    const res = await handleAdminRequest(
      requestWithCookie('hn_session=mikelward%26hash'),
      {
        pingRedis: async () => ({ ok: false }),
        verifyHn: async () => ({ ok: true, username: 'someoneelse' }),
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      reason?: string;
      signedInAs?: string;
    };
    expect(body.reason).toBe('admin_user_mismatch');
    expect(body.signedInAs).toBe('someoneelse');
  });

  it('defaults the admin username to "mikelward"', async () => {
    const res = await handleAdminRequest(
      requestWithCookie('hn_session=mikelward%26hash'),
      {
        pingRedis: async () => ({ ok: false }),
        verifyHn: verifyMikelward,
      },
    );
    expect(res.status).toBe(200);
    const body = await readBody(res);
    expect(body.username).toBe('mikelward');
  });

  it('honors ADMIN_USERNAME env override', async () => {
    process.env.ADMIN_USERNAME = 'otheradmin';
    // mikelward should now be rejected — the override is authoritative.
    const rejected = await handleAdminRequest(
      requestWithCookie('hn_session=mikelward%26hash'),
      {
        pingRedis: async () => ({ ok: false }),
        verifyHn: verifyMikelward,
      },
    );
    expect(rejected.status).toBe(403);

    const accepted = await handleAdminRequest(
      requestWithCookie('hn_session=otheradmin%26hash'),
      {
        pingRedis: async () => ({ ok: false }),
        verifyHn: async () => ({ ok: true, username: 'otheradmin' }),
      },
    );
    expect(accepted.status).toBe(200);
  });

  it('reports gemini as configured when GOOGLE_API_KEY is set', async () => {
    process.env.GOOGLE_API_KEY = 'x';
    const res = await handleAdminRequest(
      requestWithCookie('hn_session=mikelward%26hash'),
      {
        pingRedis: async () => ({ ok: false }),
        verifyHn: verifyMikelward,
      },
    );
    const body = await readBody(res);
    expect(body.services.gemini.configured).toBe(true);
  });

  it('reports jina as configured when the API key is set', async () => {
    // Link-only: the /admin page renders a dashboard link next to
    // this, so we only need the env-var presence. A live balance
    // probe will come in a follow-up against Jina's dashboard
    // backend endpoint.
    process.env.JINA_API_KEY = 'jk';
    const res = await handleAdminRequest(
      requestWithCookie('hn_session=mikelward%26hash'),
      { pingRedis: async () => ({ ok: false }), verifyHn: verifyMikelward },
    );
    const body = await readBody(res);
    expect(body.services.jina).toEqual({ configured: true });
  });

  it('reports jina as not configured when the API key is absent', async () => {
    const res = await handleAdminRequest(
      requestWithCookie('hn_session=mikelward%26hash'),
      { pingRedis: async () => ({ ok: false }), verifyHn: verifyMikelward },
    );
    const body = await readBody(res);
    expect(body.services.jina).toEqual({ configured: false });
  });

  it('reports Redis reachability and latency', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'tok';
    const pingRedis = vi.fn(async () => ({ ok: true as const, latencyMs: 6 }));
    const res = await handleAdminRequest(
      requestWithCookie('hn_session=mikelward%26hash'),
      { pingRedis, verifyHn: verifyMikelward },
    );
    const body = await readBody(res);
    expect(body.services.redis).toEqual({
      configured: true,
      reachable: true,
      latencyMs: 6,
    });
    expect(pingRedis).toHaveBeenCalledTimes(1);
  });

  it('tolerates a ping implementation that throws', async () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'tok';
    const pingRedis = vi.fn(async () => {
      throw new Error('boom');
    });
    const res = await handleAdminRequest(
      requestWithCookie('hn_session=mikelward%26hash'),
      { pingRedis, verifyHn: verifyMikelward },
    );
    expect(res.status).toBe(200);
    const body = await readBody(res);
    expect(body.services.redis.reachable).toBe(false);
  });

  it('reports region and build SHA when present', async () => {
    process.env.VERCEL_REGION = 'iad1';
    process.env.VERCEL_GIT_COMMIT_SHA = 'abc1234';
    const res = await handleAdminRequest(
      requestWithCookie('hn_session=mikelward%26hash'),
      {
        pingRedis: async () => ({ ok: false }),
        verifyHn: verifyMikelward,
      },
    );
    const body = await readBody(res);
    expect(body.region).toBe('iad1');
    expect(body.build).toBe('abc1234');
  });

  it('sets no-store cache control on success', async () => {
    const res = await handleAdminRequest(
      requestWithCookie('hn_session=mikelward%26hash'),
      {
        pingRedis: async () => ({ ok: false }),
        verifyHn: verifyMikelward,
      },
    );
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  // Security-critical path. Tests in this block cover the scenario a
  // reviewer flagged on PR #164: "a visitor sets hn_session=mikelward&X
  // in devtools". The cookie prefix regex alone used to let that
  // through.
  describe('HN cookie verification (defence against forged hn_session)', () => {
    it('returns 403 when HN says the session is not logged in (forged cookie)', async () => {
      const verifyHn = vi.fn(async () => ({
        ok: false as const,
        reason: 'not_logged_in',
      }));
      const res = await handleAdminRequest(
        requestWithCookie('hn_session=mikelward%26forged'),
        {
          pingRedis: async () => ({ ok: false }),
          verifyHn,
        },
      );
      expect(res.status).toBe(403);
      expect(verifyHn).toHaveBeenCalledTimes(1);
      expect(verifyHn).toHaveBeenCalledWith('mikelward&forged');
    });

    it('returns 403 when HN confirms a different user than the claim', async () => {
      // Someone handed their own valid cookie to our site under the
      // name "mikelward" — HN still reports it as whoever actually
      // owns that session.
      const res = await handleAdminRequest(
        requestWithCookie('hn_session=mikelward%26hash'),
        {
          pingRedis: async () => ({ ok: false }),
          verifyHn: async () => ({ ok: true, username: 'someoneelse' }),
        },
      );
      expect(res.status).toBe(403);
    });

    it('returns 503 when HN is unreachable (fail-closed)', async () => {
      const res = await handleAdminRequest(
        requestWithCookie('hn_session=mikelward%26hash'),
        {
          pingRedis: async () => ({ ok: false }),
          verifyHn: async () => ({ ok: false, reason: 'unreachable' }),
        },
      );
      // Fail-closed: if we can't ask HN, we don't show admin data.
      expect(res.status).toBe(503);
    });

    it('does not round-trip to HN when the cookie prefix is obviously non-admin', async () => {
      // A non-admin cookie is safe to reject without burning an HN
      // call — the only thing HN could say is "yes, you're alice", but
      // alice is not ADMIN_USERNAME either way.
      const verifyHn = vi.fn(async () => ({
        ok: true as const,
        username: 'alice',
      }));
      const res = await handleAdminRequest(
        requestWithCookie('hn_session=alice%26hash'),
        {
          pingRedis: async () => ({ ok: false }),
          verifyHn,
        },
      );
      expect(res.status).toBe(403);
      expect(verifyHn).not.toHaveBeenCalled();
    });

    it('exposes the HN-verified username, not the cookie-claimed one', async () => {
      // Belt-and-braces: after verification we present HN's answer as
      // the caller's identity. Mismatches between the claim and the
      // verified name are already rejected above; this asserts the
      // right value ends up in the response body.
      const res = await handleAdminRequest(
        requestWithCookie('hn_session=mikelward%26hash'),
        {
          pingRedis: async () => ({ ok: false }),
          verifyHn: async () => ({ ok: true, username: 'mikelward' }),
        },
      );
      const body = await readBody(res);
      expect(body.username).toBe('mikelward');
    });
  });
});

describe('extractHnLoggedInUsername', () => {
  // HN marks the logged-in viewer's own profile link with id="me"
  // in the pagetop; we key off that single attribute. Fixtures here
  // mirror the shipped HN surface (mixed double/single quotes, id
  // attributes on sibling links, `&nbsp;` separators, wrapper
  // elements) so regressions can't sneak in through HTML drift.
  const loggedIn = (name: string) =>
    `<td style="line-height:12pt"><span class="pagetop"><b class="hnname"><a href="news">Hacker News</a></b>
            <a href="newest">new</a> | <a href="front">past</a></span></td><td style="text-align:right"><span class="pagetop">
                    <a id="me" href="user?id=${name}">${name}</a>&nbsp;(<span id="karma">1234</span>)&nbsp;|
                <a id='logout' rel='nofollow' href='logout?auth=abcdef&amp;goto=news'>logout</a>                        </span></td>`;

  it('returns the username from a logged-in HN page', () => {
    expect(extractHnLoggedInUsername(loggedIn('mikelward'))).toBe('mikelward');
  });

  it('handles the compact whitespace variant', () => {
    const compact =
      `<span class="pagetop"><a id="me" href="user?id=mikelward">mikelward</a>&nbsp;` +
      `(<span id="karma">1234</span>)&nbsp;|&nbsp;` +
      `<a id='logout' rel='nofollow' href='logout?auth=x&amp;goto=news'>logout</a></span>`;
    expect(extractHnLoggedInUsername(compact)).toBe('mikelward');
  });

  it('handles mixed quote styles (id="me" double-quoted, logout single-quoted)', () => {
    // Observed on live HN: the `id="me"` username link uses double
    // quotes while the `id='logout'` link uses single quotes.
    const mixed =
      `<a id="me" href="user?id=mikelward">mikelward</a> | ` +
      `<a id='logout' rel='nofollow' href='logout?auth=xyz&amp;goto=news'>logout</a>`;
    expect(extractHnLoggedInUsername(mixed)).toBe('mikelward');
  });

  it('returns null for a signed-out page (no id="me" element)', () => {
    const signedOut =
      '<td><span class="pagetop"><a href="login?goto=news">login</a></span></td>';
    expect(extractHnLoggedInUsername(signedOut)).toBeNull();
  });

  it('returns null when id="me" links somewhere other than user?id=', () => {
    // Defensive: if HN ever repurposes id="me" for a different
    // link target, don't blindly treat its href as a username.
    const repurposed = '<a id="me" href="submit">submit</a>';
    expect(extractHnLoggedInUsername(repurposed)).toBeNull();
  });

  it('returns null when the href query string carries a disallowed username', () => {
    // Usernames must match the HN username charset. A href with
    // injected content (path traversal, querystring tricks) should
    // not be accepted as an identity.
    const bogus = '<a id="me" href="user?id=bad.name!">bad</a>';
    expect(extractHnLoggedInUsername(bogus)).toBeNull();
  });
});
