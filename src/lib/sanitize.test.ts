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
});
