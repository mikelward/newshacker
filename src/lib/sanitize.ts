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

// Sanitization is an allowlist COPY, not an in-place scrub: the input is
// parsed with the browser's own parser into an inert document (DOMParser
// never runs scripts or loads subresources), and a brand-new tree is built
// holding only allowlisted elements created fresh, text nodes, and the three
// anchor attributes we construct ourselves. Nothing from the input tree is
// ever re-attached, so there is no scrubbed-but-forgotten attribute or node
// to leak — anything not rebuilt simply doesn't exist in the output. Parsing
// with the same engine that will later parse our output (React sets it via
// innerHTML) is also what closes the parser-differential (mXSS) gap that a
// regex- or foreign-parser-based sanitizer has to fight.
//
// This replaced the sanitize-html dependency, which dragged htmlparser2 +
// postcss into the client bundle — ~150 KB minified (a fifth of the whole
// entry chunk) for what this allowlist needs. DOMPurify was tried as the
// replacement first but is unusable under happy-dom (the test DOM): its
// node-iterator pass silently keeps <script> and drops anchors there.

const ALLOWED_TAGS = new Set([
  'a',
  'p',
  'i',
  'em',
  'b',
  'strong',
  'pre',
  'code',
  'br',
]);

// Disallowed elements whose TEXT must also be dropped, not flattened into the
// surrounding paragraph: raw-text containers (a script's source code is not
// comment prose) and embedded-content/foreign roots whose subtrees have no
// meaning outside their namespace. Every other disallowed element (span, div,
// u, …) keeps its text content, matching sanitize-html's discard mode.
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'textarea',
  'title',
  'option',
  'iframe',
  'frame',
  'object',
  'embed',
  'svg',
  'math',
]);

const ALLOWED_HREF_SCHEMES = new Set(['http', 'https', 'mailto']);
// Characters browsers strip during URL parsing (C0 controls, space, and
// Unicode whitespace). A scheme check has to run on the post-strip form, or
// "jav\tascript:…" sails past a naive /^javascript:/ while the browser's URL
// parser collapses it right back into an executable javascript: URL.
// eslint-disable-next-line no-control-regex -- matching control chars is the point: they are what the URL parser strips
const URL_STRIPPED_CHARS = /[\u0000-\u0020\u00a0\u1680\u180e\u2000-\u2029\u205f\u3000]/g;

function isSafeHref(href: string): boolean {
  const cleaned = href.replace(URL_STRIPPED_CHARS, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned)?.[1];
  // No scheme = relative URL; allowed, matching the old sanitize-html config.
  if (!scheme) return true;
  return ALLOWED_HREF_SCHEMES.has(scheme.toLowerCase());
}

const ELEMENT_NODE = 1; // Node.ELEMENT_NODE, without touching the global
const TEXT_NODE = 3; // Node.TEXT_NODE

function copySanitized(from: Node, into: Element, doc: Document): void {
  for (const child of Array.from(from.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      // A fresh text node serializes with & < > escaped; it cannot re-open
      // markup when the output is parsed again.
      into.appendChild(doc.createTextNode(child.nodeValue ?? ''));
      continue;
    }
    // Comments, doctypes, processing instructions: dropped.
    if (child.nodeType !== ELEMENT_NODE) continue;
    const tag = (child as Element).tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) continue;
    if (!ALLOWED_TAGS.has(tag)) {
      // Disallowed wrapper (div, span, u, …): flatten — keep the children,
      // lose the element.
      copySanitized(child, into, doc);
      continue;
    }
    const fresh = doc.createElement(tag);
    if (tag === 'a') {
      const href = (child as Element).getAttribute('href');
      const internal = rewriteHnHref(href ?? undefined);
      if (internal) {
        // In-app destination: SPA navigation, no new tab, no rel.
        fresh.setAttribute('href', internal);
      } else {
        if (href !== null && isSafeHref(href)) {
          fresh.setAttribute('href', href);
        }
        fresh.setAttribute('rel', 'noopener noreferrer nofollow');
        fresh.setAttribute('target', '_blank');
      }
    }
    into.appendChild(fresh);
    copySanitized(child, fresh, doc);
  }
}

export function sanitizeCommentHtml(input: string): string {
  const doc = new DOMParser().parseFromString(input, 'text/html');
  const out = doc.createElement('div');
  copySanitized(doc.body, out, doc);
  return stripLeadingQuoteParagraphs(normalizeParagraphs(out.innerHTML));
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
  // Peel quote paragraphs off the *front* of the string only — never
  // rebuild the comment from <p> matches. Code blocks (<pre><code>) are
  // top-level siblings of the paragraphs (the parser auto-closes <p>
  // before <pre>), so a rebuild-from-<p>s would silently delete them.
  const LEADING_P_RE = /^\s*<p>([\s\S]*?)<\/p>/;
  let rest = html;
  let stripped = false;
  for (;;) {
    const m = LEADING_P_RE.exec(rest);
    if (!m) break;
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    if (!/^(?:&gt;|>)\s/.test(text)) break;
    rest = rest.slice(m[0].length);
    stripped = true;
  }

  if (!stripped) return html;
  // If the comment is nothing but quote paragraphs, leave it alone
  // rather than render an empty body.
  if (!rest.trim()) return html;
  return rest;
}
