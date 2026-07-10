import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MarkdownText } from './MarkdownText';

describe('MarkdownText', () => {
  it('renders plain text without any tags', () => {
    const { container } = render(<MarkdownText text="Just a sentence." />);
    expect(container.innerHTML).toBe('Just a sentence.');
  });

  it('renders backtick code spans as <code>', () => {
    const { container } = render(
      <MarkdownText text="Set the `base_url` and the API key." />,
    );
    expect(container.innerHTML).toBe(
      'Set the <code>base_url</code> and the API key.',
    );
  });

  it('renders **bold** as <strong>', () => {
    const { container } = render(
      <MarkdownText text="This is **important** stuff." />,
    );
    expect(container.innerHTML).toBe(
      'This is <strong>important</strong> stuff.',
    );
  });

  it('renders *italic* as <em>', () => {
    const { container } = render(
      <MarkdownText text="This is *kind of* a big deal." />,
    );
    expect(container.innerHTML).toBe(
      'This is <em>kind of</em> a big deal.',
    );
  });

  it('renders a single-character italic span', () => {
    const { container } = render(<MarkdownText text="the variable *x* here" />);
    expect(container.innerHTML).toBe('the variable <em>x</em> here');
  });

  it('keeps **bold** as <strong> rather than treating the inner * as italic', () => {
    const { container } = render(
      <MarkdownText text="This is **important** stuff." />,
    );
    expect(container.innerHTML).toBe(
      'This is <strong>important</strong> stuff.',
    );
  });

  it('leaves spaced asterisks (arithmetic) alone', () => {
    const { container } = render(
      <MarkdownText text="The area is width * height in pixels." />,
    );
    expect(container.innerHTML).toBe(
      'The area is width * height in pixels.',
    );
  });

  it('leaves compact arithmetic like 2*3*4 literal', () => {
    const { container } = render(
      <MarkdownText text="The result of 2*3*4 is 24." />,
    );
    expect(container.innerHTML).toBe('The result of 2*3*4 is 24.');
  });

  it('leaves a compact identifier like foo*bar*baz literal', () => {
    const { container } = render(<MarkdownText text="the foo*bar*baz token" />);
    expect(container.innerHTML).toBe('the foo*bar*baz token');
  });

  it('leaves a word-flanked span literal even when it ends at a boundary', () => {
    // The closing `*` here sits at a word boundary (end of string), so only
    // the leading-side check keeps `foo*bar*` from italicizing to foo<em>bar</em>.
    const { container } = render(<MarkdownText text="see foo*bar*" />);
    expect(container.innerHTML).toBe('see foo*bar*');
  });

  it('leaves glob patterns literal (asterisks abut / or .)', () => {
    const { container } = render(
      <MarkdownText text="match src/*/*.ts and *.ts/*.tsx files" />,
    );
    expect(container.innerHTML).toBe(
      'match src/*/*.ts and *.ts/*.tsx files',
    );
  });

  it('italicizes accented and non-Latin emphasis', () => {
    const { container } = render(
      <MarkdownText text="a *café* and a *日本語* word" />,
    );
    expect(container.innerHTML).toBe(
      'a <em>café</em> and a <em>日本語</em> word',
    );
  });

  it('italicizes a span that ends at a sentence boundary', () => {
    const { container } = render(<MarkdownText text="read the *docs*." />);
    expect(container.innerHTML).toBe('read the <em>docs</em>.');
  });

  it('does not italicize across a newline', () => {
    const { container } = render(
      <MarkdownText text={'first *opens but does not close\nsecond closes* here'} />,
    );
    expect(container.innerHTML).toBe(
      'first *opens but does not close\nsecond closes* here',
    );
  });

  it('renders multiple spans of each kind in one string', () => {
    const { container } = render(
      <MarkdownText text="Use `foo` then `bar`, but **really** read the *docs*." />,
    );
    expect(container.innerHTML).toBe(
      'Use <code>foo</code> then <code>bar</code>, but <strong>really</strong> read the <em>docs</em>.',
    );
  });

  it('leaves an unmatched single backtick literal', () => {
    const { container } = render(
      <MarkdownText text="open the ` and never close it" />,
    );
    expect(container.innerHTML).toBe('open the ` and never close it');
  });

  it('leaves underscores alone so snake_case identifiers stay literal', () => {
    const { container } = render(
      <MarkdownText text="The base_url and api_key fields." />,
    );
    expect(container.innerHTML).toBe('The base_url and api_key fields.');
  });

  it('escapes HTML in user-supplied text — no tag injection', () => {
    const { container } = render(
      <MarkdownText text={'innocent <script>alert(1)</script> text'} />,
    );
    expect(container.innerHTML).toBe(
      'innocent &lt;script&gt;alert(1)&lt;/script&gt; text',
    );
    expect(container.querySelector('script')).toBeNull();
  });

  it('escapes HTML even inside a code span', () => {
    const { container } = render(
      <MarkdownText text={'use `<script>alert(1)</script>` here'} />,
    );
    expect(container.innerHTML).toBe(
      'use <code>&lt;script&gt;alert(1)&lt;/script&gt;</code> here',
    );
    expect(container.querySelector('script')).toBeNull();
  });

  it('does not let a bold span match across a newline', () => {
    const { container } = render(
      <MarkdownText
        text={'first paragraph **opens but does not close\nsecond paragraph closes** here'}
      />,
    );
    expect(container.innerHTML).toBe(
      'first paragraph **opens but does not close\nsecond paragraph closes** here',
    );
  });

  it('renders an empty string as nothing', () => {
    const { container } = render(<MarkdownText text="" />);
    expect(container.innerHTML).toBe('');
  });

  it('renders the full DeepSeek example end to end', () => {
    const { container } = render(
      <MarkdownText
        text="The DeepSeek API is compatible with OpenAI and Anthropic SDKs, allowing developers to make API calls by configuring the `base_url` and obtaining an API key."
      />,
    );
    expect(container.innerHTML).toBe(
      'The DeepSeek API is compatible with OpenAI and Anthropic SDKs, allowing developers to make API calls by configuring the <code>base_url</code> and obtaining an API key.',
    );
  });

  it('renders a run of "-" bullet lines as a <ul>', () => {
    const { container } = render(
      <MarkdownText text={'- First point\n- Second point\n- Third point'} />,
    );
    expect(container.innerHTML).toBe(
      '<ul class="markdown-list"><li>First point</li><li>Second point</li>' +
        '<li>Third point</li></ul>',
    );
  });

  it('renders "*" bullet lines as a <ul> without treating them as italic', () => {
    const { container } = render(<MarkdownText text={'* one\n* two'} />);
    expect(container.innerHTML).toBe(
      '<ul class="markdown-list"><li>one</li><li>two</li></ul>',
    );
  });

  it('applies inline formatting inside list items', () => {
    const { container } = render(
      <MarkdownText text={'- set the `base_url`\n- **enable** the *flag*'} />,
    );
    expect(container.innerHTML).toBe(
      '<ul class="markdown-list"><li>set the <code>base_url</code></li>' +
        '<li><strong>enable</strong> the <em>flag</em></li></ul>',
    );
  });

  it('renders a lead-in paragraph followed by a bullet list', () => {
    const { container } = render(
      <MarkdownText text={'Here are the highlights:\n- alpha\n- beta'} />,
    );
    expect(container.innerHTML).toBe(
      'Here are the highlights:<ul class="markdown-list">' +
        '<li>alpha</li><li>beta</li></ul>',
    );
  });

  it('does not treat a mid-sentence hyphen or asterisk as a bullet', () => {
    const { container } = render(
      <MarkdownText text="a well-known result and 2 * 3 math" />,
    );
    expect(container.innerHTML).toBe('a well-known result and 2 * 3 math');
  });

  it('leaves **bold** at the start of a line as bold, not a bullet', () => {
    const { container } = render(<MarkdownText text="**heads up** everyone" />);
    expect(container.innerHTML).toBe('<strong>heads up</strong> everyone');
  });
});
