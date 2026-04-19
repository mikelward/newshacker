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
  return sanitizeHtml(input, {
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
}
