import sanitizeHtml from 'sanitize-html';

const HN_HOSTS = new Set(['news.ycombinator.com', 'www.news.ycombinator.com']);

export function rewriteHnHref(href: string | undefined): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!HN_HOSTS.has(url.hostname)) return null;
  const pathname = url.pathname.replace(/\/+$/, '');
  const id = url.searchParams.get('id');
  if (!id) return null;
  if (pathname === '/item' && /^\d+$/.test(id)) {
    return `/item/${id}${url.hash}`;
  }
  if (pathname === '/user' && /^[A-Za-z0-9_-]+$/.test(id)) {
    return `/user/${id}${url.hash}`;
  }
  return null;
}

export function sanitizeCommentHtml(input: string): string {
  const clean = sanitizeHtml(input, {
    allowedTags: ['a', 'p', 'i', 'em', 'b', 'strong', 'pre', 'code', 'br'],
    allowedAttributes: {
      a: ['href', 'rel', 'target'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: (tagName, attribs) => {
        const internal = rewriteHnHref(attribs.href);
        if (internal) {
          return {
            tagName,
            attribs: { href: internal },
          };
        }
        return {
          tagName,
          attribs: {
            ...attribs,
            href: attribs.href ?? '',
            rel: 'noopener noreferrer nofollow',
            target: '_blank',
          },
        };
      },
    },
  });
  return normalizeParagraphs(clean);
}

// HN stores multi-paragraph comments as raw text for the first paragraph and
// <p> as a *separator* before each subsequent one. Rendered literally, the
// first paragraph has no container (and no margin) so it sits flush against
// the next, while empty <p><p> sequences leave huge gaps. Normalize so every
// block is its own non-empty <p>.
function normalizeParagraphs(html: string): string {
  let out = html.replace(/<p>\s*<\/p>/g, '');
  const firstP = out.indexOf('<p>');
  if (firstP === -1) {
    return out.trim() ? `<p>${out}</p>` : out;
  }
  if (firstP > 0) {
    const leading = out.slice(0, firstP);
    if (leading.trim()) {
      out = `<p>${leading}</p>${out.slice(firstP)}`;
    } else {
      out = out.slice(firstP);
    }
  }
  return out;
}
