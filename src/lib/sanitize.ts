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
  return stripLeadingQuoteParagraphs(normalizeParagraphs(clean));
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

// A comment that opens by re-quoting its parent ("> ...") wastes the reader's
// first line on text they already see directly above. Drop leading paragraphs
// whose visible text starts with "> " (encoded as &gt; in HN's HTML) so the
// reply's own content shows first. If the comment is nothing but quote
// paragraphs, leave it alone rather than render an empty body.
function stripLeadingQuoteParagraphs(html: string): string {
  const paragraphs = html.match(/<p>[\s\S]*?<\/p>/g);
  if (!paragraphs) return html;

  let firstNonQuote = 0;
  while (firstNonQuote < paragraphs.length) {
    const inner = paragraphs[firstNonQuote].slice(3, -4);
    const text = inner.replace(/<[^>]+>/g, '').trim();
    if (/^(?:&gt;|>)\s/.test(text)) {
      firstNonQuote++;
    } else {
      break;
    }
  }

  if (firstNonQuote === 0) return html;
  if (firstNonQuote === paragraphs.length) return html;
  return paragraphs.slice(firstNonQuote).join('');
}
