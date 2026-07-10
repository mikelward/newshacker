import { Fragment, type ReactElement } from 'react';

// Markdown renderer for AI summary strings. Gemini's article and comment
// summaries are *informally* markdown — they're plain text most of the time,
// but the model leaks `code` and **bold** spans even when the prompt asks it
// not to, and it sometimes emits **bullet lists**. Inline emphasis is
// tokenized within each line; a run of consecutive `-`/`*`/`+` bullet lines
// becomes a <ul>. Treating the strings as markdown is strictly a superset of
// treating them as plain text, so this component is safe to use anywhere a
// summary is rendered.
//
// Why not `dangerouslySetInnerHTML` + a markdown library: this tokenizer
// emits known JSX elements (<code>, <strong>) whose text content is a
// regex capture group dropped through React's normal `{…}` interpolation.
// React escapes that text by construction, so the worst-case output is
// "model included a literal `<script>` between backticks and the user
// sees the characters `<script>`" — never an injected tag.
//
// Asterisk italic (`*x*`) is handled too — Gemini leaks it the same way it
// leaks `**bold**`, and a stray literal `*` on either side of a phrase reads
// as noise. Three guards keep it from eating things that aren't emphasis:
//   - the content must begin and end with a "word" character (letter, digit,
//     or `_`), so a span can't open or close on whitespace (`3 * 4`) or on
//     path/glob punctuation (`src/*/*.ts`, `*.ts/*.tsx` — those start/end on
//     `/` or `.` and stay literal);
//   - each `*` must sit on a word boundary on the *outside* too (checked in
//     JS below), so compact formulas/identifiers like `2*3*4` or `foo*bar*baz`
//     stay literal instead of italicizing their middle term.
// The word classes use Unicode property escapes so accented / non-Latin
// emphasis (`*café*`, `*日本語*`) still italicizes. Underscore italic (`_x_`)
// is still out of scope — it collides with `snake_case` identifiers.
//
// Bullet lists ARE in scope (a run of `-`/`*`/`+ ` lines becomes a <ul>), but
// everything else block-level is not: headings, ordered lists, blockquotes,
// and code fences render as their literal text. Also out of scope by design:
// underscore italic (see above) and links (model-supplied URLs are a different
// trust story — see TODO.md "ask Gemini to return markdown" entry). The summary
// prompt asks for a single sentence, so bullets are rare in article summaries —
// but comment insights are arbitrary strings, and rendering a list when the
// model does emit one is strictly safer than showing raw `- ` markers.

// Every alternative is inline-only: the inner class explicitly excludes
// `\n`, so a stray `**` at the start of one paragraph can't bold every
// character through to a `**` several lines down. (Article summaries are
// single-sentence today, but comment insights are arbitrary strings; the
// constraint is cheap insurance.)
const CODE = /`([^`\n]+)`/.source;
const BOLD = /\*\*([^*\n][^\n]*?)\*\*/.source;
// A letter, digit, or underscore in any script — the "word" character the
// italic edges and the outer-boundary guard below both key off.
const WORD_CHAR = '[\\p{L}\\p{N}_]';
// Tried after BOLD, so `**x**` is consumed as bold before this can see it.
// Content begins and ends with WORD_CHAR (everything between is just "not a
// `*` or newline"). The outer-boundary check is done in JS below, NOT with a
// regex lookbehind: `(?<!…)` is a parse-time SyntaxError on Safari < 16.4, and
// this is a mobile-facing app with no transpile step that would rewrite it — a
// bad lookbehind doesn't fail one match, it stops the module from loading.
const ITALIC = `\\*(${WORD_CHAR}(?:[^*\\n]*${WORD_CHAR})?)\\*`;
const TOKEN_RE = new RegExp(`${CODE}|${BOLD}|${ITALIC}`, 'gu');

// A `*` is an emphasis delimiter only when its outer neighbor is a boundary
// (string edge, whitespace, or punctuation) rather than a word character.
const WORD = new RegExp(WORD_CHAR, 'u');

// A bullet-list line: optional indent, a `-`/`*`/`+` marker, then ≥1 space and
// the item text (captured). The required space after the marker is what keeps
// `**bold**` and `*italic*` (marker immediately followed by a non-space) from
// being mistaken for bullets.
const BULLET_RE = /^[ \t]*[-*+][ \t]+(.*)$/;

type Block =
  | { type: 'text'; text: string }
  | { type: 'list'; items: string[] };

// Group the raw string into text blocks and bullet-list blocks. Consecutive
// bullet lines collapse into one list; every other line (including blanks)
// accumulates into a text block whose lines are rejoined with `\n` — so a
// string with no bullets round-trips to a single text block byte-for-byte, and
// the inline tokenizer sees exactly what it always did.
function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let textLines: string[] = [];
  const flushText = () => {
    if (textLines.length > 0) {
      blocks.push({ type: 'text', text: textLines.join('\n') });
      textLines = [];
    }
  };
  for (const line of text.split('\n')) {
    const match = BULLET_RE.exec(line);
    if (!match) {
      textLines.push(line);
      continue;
    }
    flushText();
    const last = blocks[blocks.length - 1];
    if (last && last.type === 'list') last.items.push(match[1]);
    else blocks.push({ type: 'list', items: [match[1]] });
  }
  flushText();
  return blocks;
}

export function MarkdownText({ text }: { text: string }) {
  const blocks = splitBlocks(text);
  // No bullet lists → a single text block. Render exactly as the inline-only
  // tokenizer did before (no wrapper element), so plain/inline output stays
  // byte-identical.
  if (blocks.length === 1 && blocks[0].type === 'text') {
    return <>{tokenize(text)}</>;
  }
  return (
    <>
      {blocks.map((block, i) =>
        block.type === 'list' ? (
          <ul key={i} className="markdown-list">
            {block.items.map((item, j) => (
              <li key={j}>{tokenize(item)}</li>
            ))}
          </ul>
        ) : (
          <Fragment key={i}>{tokenize(block.text)}</Fragment>
        ),
      )}
    </>
  );
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
    } else if (m[3] !== undefined) {
      const before = start > 0 ? text[start - 1] : '';
      const after = text[start + m[0].length] ?? '';
      if (WORD.test(before) || WORD.test(after)) {
        // A `*` hugged by a word character on the outside is a literal
        // operator/identifier char (`2*3*4`), not an emphasis delimiter.
        out.push(m[0]);
      } else {
        out.push(<em key={key++}>{m[3]}</em>);
      }
    }
    cursor = start + m[0].length;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
