import type { ReactElement } from 'react';

// Inline-only markdown renderer for AI summary strings. Gemini's article
// and comment summaries are *informally* markdown — they're plain text
// most of the time, but the model leaks `code` and **bold** spans even
// when the prompt asks it not to. Treating the strings as markdown is
// strictly a superset of treating them as plain text, so this component
// is safe to use anywhere a summary is rendered.
//
// Why not `dangerouslySetInnerHTML` + a markdown library: this tokenizer
// emits known JSX elements (<code>, <strong>) whose text content is a
// regex capture group dropped through React's normal `{…}` interpolation.
// React escapes that text by construction, so the worst-case output is
// "model included a literal `<script>` between backticks and the user
// sees the characters `<script>`" — never an injected tag.
//
// Out of scope by design: italic (`_x_` / `*x*` are too easy to confuse
// with `snake_case` identifiers and arithmetic), links (model-supplied
// URLs are a different trust story — see TODO.md "ask Gemini to return
// markdown" entry), and any block-level construct.

// Both alternatives are inline-only: the inner class explicitly excludes
// `\n`, so a stray `**` at the start of one paragraph can't bold every
// character through to a `**` several lines down. (Article summaries are
// single-sentence today, but comment insights are arbitrary strings; the
// constraint is cheap insurance.)
const CODE = /`([^`\n]+)`/.source;
const BOLD = /\*\*([^*\n][^\n]*?)\*\*/.source;
const TOKEN_RE = new RegExp(`${CODE}|${BOLD}`, 'g');

export function MarkdownText({ text }: { text: string }) {
  return <>{tokenize(text)}</>;
}

function tokenize(text: string): (string | ReactElement)[] {
  const out: (string | ReactElement)[] = [];
  let cursor = 0;
  let key = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    if (start > cursor) out.push(text.slice(cursor, start));
    if (m[1] !== undefined) {
      out.push(<code key={key++}>{m[1]}</code>);
    } else if (m[2] !== undefined) {
      out.push(<strong key={key++}>{m[2]}</strong>);
    }
    cursor = start + m[0].length;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
