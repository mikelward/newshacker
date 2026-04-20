import { describe, it, expect } from 'vitest';
import { sanitizeCommentHtml } from './sanitize';

describe('sanitizeCommentHtml', () => {
  it('strips script tags', () => {
    const result = sanitizeCommentHtml('Hi<script>alert(1)</script>');
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('alert');
  });

  it('preserves allowed formatting tags', () => {
    const html = '<p>Hello <i>world</i> <b>bold</b> <pre><code>x</code></pre></p>';
    const result = sanitizeCommentHtml(html);
    expect(result).toContain('<p>');
    expect(result).toContain('<i>');
    expect(result).toContain('<b>');
    expect(result).toContain('<pre>');
    expect(result).toContain('<code>');
  });

  it('preserves links with safe schemes and adds rel/target', () => {
    const result = sanitizeCommentHtml('<a href="https://example.com">go</a>');
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain('rel="noopener noreferrer nofollow"');
    expect(result).toContain('target="_blank"');
  });

  it('drops javascript: urls', () => {
    const result = sanitizeCommentHtml('<a href="javascript:alert(1)">x</a>');
    expect(result).not.toContain('javascript:');
  });

  it('drops disallowed attributes like onclick', () => {
    const result = sanitizeCommentHtml('<a href="https://x.com" onclick="evil()">x</a>');
    expect(result).not.toContain('onclick');
  });

  it('rewrites HN item links to relative app paths', () => {
    const result = sanitizeCommentHtml(
      '<a href="https://news.ycombinator.com/item?id=47824463">see</a>',
    );
    expect(result).toContain('href="/item/47824463"');
    expect(result).not.toContain('news.ycombinator.com');
    expect(result).not.toContain('target="_blank"');
    expect(result).not.toContain('nofollow');
  });

  it('rewrites HN user links to relative app paths', () => {
    const result = sanitizeCommentHtml(
      '<a href="https://news.ycombinator.com/user?id=pg">pg</a>',
    );
    expect(result).toContain('href="/user/pg"');
    expect(result).not.toContain('target="_blank"');
  });

  it('preserves the fragment on rewritten HN item links', () => {
    const result = sanitizeCommentHtml(
      '<a href="https://news.ycombinator.com/item?id=123#456">c</a>',
    );
    expect(result).toContain('href="/item/123#456"');
  });

  it('rewrites www.news.ycombinator.com and http scheme too', () => {
    const result = sanitizeCommentHtml(
      '<a href="http://www.news.ycombinator.com/item?id=1">x</a>',
    );
    expect(result).toContain('href="/item/1"');
  });

  it('leaves non-item/non-user HN links alone', () => {
    const result = sanitizeCommentHtml(
      '<a href="https://news.ycombinator.com/newest">x</a>',
    );
    expect(result).toContain('href="https://news.ycombinator.com/newest"');
    expect(result).toContain('target="_blank"');
  });

  it('leaves non-HN links alone and marks them external', () => {
    const result = sanitizeCommentHtml(
      '<a href="https://example.com/item?id=1">x</a>',
    );
    expect(result).toContain('href="https://example.com/item?id=1"');
    expect(result).toContain('target="_blank"');
    expect(result).toContain('nofollow');
  });

  it('ignores HN item links with non-numeric ids', () => {
    const result = sanitizeCommentHtml(
      '<a href="https://news.ycombinator.com/item?id=abc">x</a>',
    );
    expect(result).toContain('href="https://news.ycombinator.com/item?id=abc"');
  });

  it('wraps leading raw text in a <p> so HN comments render as uniform paragraphs', () => {
    // HN stores the first paragraph as bare text and uses <p> as a separator
    // before each subsequent paragraph. Without normalization the first block
    // has no margin and ends up flush against the second block.
    const result = sanitizeCommentHtml('First para.<p>Second para.<p>Third para.');
    expect(result).toBe('<p>First para.</p><p>Second para.</p><p>Third para.</p>');
  });

  it('wraps a comment with no <p> separators at all in a single <p>', () => {
    const result = sanitizeCommentHtml('Just one paragraph.');
    expect(result).toBe('<p>Just one paragraph.</p>');
  });

  it('strips empty <p> elements so double separators don\'t leave gaps', () => {
    // HN sometimes produces <p><p> (an empty paragraph) when users hit enter
    // extra times. Render as a single paragraph break, not a blank line.
    const result = sanitizeCommentHtml('A<p><p>B');
    expect(result).toBe('<p>A</p><p>B</p>');
  });

  it('leaves content alone when it already starts with <p>', () => {
    const result = sanitizeCommentHtml('<p>One<p>Two');
    expect(result).toBe('<p>One</p><p>Two</p>');
  });

  it('drops a single leading quoted paragraph so the reply shows first', () => {
    // HN encodes "> quoted" as a paragraph starting with "&gt; ". Showing it
    // in the preview is noise — the parent comment is right above.
    const result = sanitizeCommentHtml('&gt; quoted parent<p>my actual reply');
    expect(result).toBe('<p>my actual reply</p>');
  });

  it('drops multiple consecutive leading quote paragraphs', () => {
    const result = sanitizeCommentHtml(
      '&gt; line one<p>&gt; line two<p>the reply',
    );
    expect(result).toBe('<p>the reply</p>');
  });

  it('stops stripping at the first non-quote paragraph', () => {
    const result = sanitizeCommentHtml(
      '&gt; quoted<p>reply text<p>&gt; later quote<p>more reply',
    );
    expect(result).toBe(
      '<p>reply text</p><p>&gt; later quote</p><p>more reply</p>',
    );
  });

  it('leaves the comment alone when every paragraph is a quote', () => {
    // Pathological case: don't render an empty body.
    const result = sanitizeCommentHtml('&gt; only<p>&gt; quotes');
    expect(result).toBe('<p>&gt; only</p><p>&gt; quotes</p>');
  });

  it('does not strip paragraphs that merely contain ">" mid-text', () => {
    const result = sanitizeCommentHtml('a > b is true<p>next');
    expect(result).toBe('<p>a &gt; b is true</p><p>next</p>');
  });

  it('strips a leading quote paragraph that contains inline formatting', () => {
    const result = sanitizeCommentHtml(
      '&gt; <i>quoted</i> bit<p>the reply',
    );
    expect(result).toBe('<p>the reply</p>');
  });
});
