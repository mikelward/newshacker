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

  it('renders multiple spans of each kind in one string', () => {
    const { container } = render(
      <MarkdownText text="Use `foo` then `bar`, but **really** read the docs." />,
    );
    expect(container.innerHTML).toBe(
      'Use <code>foo</code> then <code>bar</code>, but <strong>really</strong> read the docs.',
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
});
