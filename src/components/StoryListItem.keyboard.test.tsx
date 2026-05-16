import { useState } from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StoryListItem } from './StoryListItem';
import { renderWithProviders } from '../test/renderUtils';
import type { HNItem } from '../lib/hn';

const baseStory: HNItem = {
  id: 1,
  type: 'story',
  title: 'A story title',
  url: 'https://example.com/post',
  by: 'alice',
  score: 42,
  descendants: 7,
  time: Math.floor(Date.now() / 1000) - 3600,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StoryListItem keyboard shortcuts', () => {
  it('Space on a focused row opens the actions menu', async () => {
    renderWithProviders(
      <StoryListItem story={baseStory} onPin={vi.fn()} onShare={vi.fn()} />,
    );
    const link = screen.getByTestId('story-title');
    act(() => link.focus());
    expect(screen.queryByTestId('story-row-menu')).toBeNull();
    await userEvent.keyboard(' ');
    expect(screen.getByTestId('story-row-menu')).toBeInTheDocument();
  });

  it('Space does nothing when no menu items are available', async () => {
    // A read-only row (no handlers) has zero menu items; Space is a no-op.
    renderWithProviders(<StoryListItem story={baseStory} />);
    const link = screen.getByTestId('story-title');
    act(() => link.focus());
    await userEvent.keyboard(' ');
    expect(screen.queryByTestId('story-row-menu')).toBeNull();
  });

  it('`o` opens the article URL in a new tab', async () => {
    const openSpy = vi
      .spyOn(window, 'open')
      .mockImplementation(() => null);
    renderWithProviders(<StoryListItem story={baseStory} />);
    const link = screen.getByTestId('story-title');
    act(() => link.focus());
    await userEvent.keyboard('o');
    expect(openSpy).toHaveBeenCalledWith(
      'https://example.com/post',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('`o` is a no-op on self-posts (no url)', async () => {
    const openSpy = vi
      .spyOn(window, 'open')
      .mockImplementation(() => null);
    const selfPost: HNItem = { ...baseStory, url: undefined };
    renderWithProviders(<StoryListItem story={selfPost} />);
    const link = screen.getByTestId('story-title');
    act(() => link.focus());
    await userEvent.keyboard('o');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('`o` refuses to open unsafe URL schemes (javascript:, data:, …)', async () => {
    // Mirrors the isSafeHttpUrl guard on the thread "Read article"
    // link — an HN URL with a non-http(s) scheme must never reach
    // window.open via the keyboard path either.
    const openSpy = vi
      .spyOn(window, 'open')
      .mockImplementation(() => null);
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
    ]) {
      const unsafe: HNItem = { ...baseStory, url };
      const { unmount } = renderWithProviders(
        <StoryListItem story={unsafe} />,
      );
      const link = screen.getByTestId('story-title');
      act(() => link.focus());
      await userEvent.keyboard('o');
      unmount();
    }
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('`o` records the article-open so the row joins /opened (mirrors the thread Read link)', async () => {
    vi.spyOn(window, 'open').mockImplementation(() => null);
    window.localStorage.clear();
    renderWithProviders(<StoryListItem story={baseStory} />);
    const link = screen.getByTestId('story-title');
    act(() => link.focus());
    await userEvent.keyboard('o');
    // openedStories writes a raw localStorage entry keyed on the id;
    // any non-null value for our id means the open was recorded.
    const stored = window.localStorage.getItem(
      'newshacker:openedStoryIds',
    );
    expect(stored).not.toBeNull();
    expect(stored ?? '').toContain('"id":1');
    window.localStorage.clear();
  });

  it('`p` calls onPin on an unpinned row', async () => {
    const onPin = vi.fn();
    renderWithProviders(<StoryListItem story={baseStory} onPin={onPin} />);
    const link = screen.getByTestId('story-title');
    act(() => link.focus());
    await userEvent.keyboard('p');
    expect(onPin).toHaveBeenCalledWith(1);
  });

  it('`p` calls onUnpin on a pinned row', async () => {
    const onUnpin = vi.fn();
    renderWithProviders(
      <StoryListItem story={baseStory} pinned onUnpin={onUnpin} />,
    );
    const link = screen.getByTestId('story-title');
    act(() => link.focus());
    await userEvent.keyboard('p');
    expect(onUnpin).toHaveBeenCalledWith(1);
  });

  it('`d` calls onHide on an unpinned row', async () => {
    const onHide = vi.fn();
    renderWithProviders(<StoryListItem story={baseStory} onHide={onHide} />);
    const link = screen.getByTestId('story-title');
    act(() => link.focus());
    await userEvent.keyboard('d');
    expect(onHide).toHaveBeenCalledWith(1);
  });

  it('`d` is a no-op on pinned rows (pinned shields hide)', async () => {
    const onHide = vi.fn();
    renderWithProviders(
      <StoryListItem story={baseStory} pinned onHide={onHide} />,
    );
    const link = screen.getByTestId('story-title');
    act(() => link.focus());
    await userEvent.keyboard('d');
    expect(onHide).not.toHaveBeenCalled();
  });

  it('does not act on modifier-key combinations (Cmd-o keeps Cmd-click hooks)', async () => {
    const openSpy = vi
      .spyOn(window, 'open')
      .mockImplementation(() => null);
    renderWithProviders(<StoryListItem story={baseStory} />);
    const link = screen.getByTestId('story-title');
    act(() => link.focus());
    // fireEvent so we can pass metaKey directly; userEvent rebinds the
    // modifier for the whole sequence which is closer to a real key combo
    // but harder to assert atomically here.
    fireEvent.keyDown(link, { key: 'o', metaKey: true });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('Enter activates the native <Link> (no JS override needed)', () => {
    renderWithProviders(<StoryListItem story={baseStory} />);
    const link = screen.getByTestId('story-title');
    // The <Link> renders an <a href="/item/1">. We just assert the
    // href is correct — the browser handles Enter on a focused link
    // natively, and React Router intercepts the resulting click. No
    // onKeyDown override should fight that.
    expect(link).toHaveAttribute('href', '/item/1');
  });

  it('after `d` hides the row, focus survives onto the next row', async () => {
    // Render two sibling rows and wire a hide handler that removes the
    // first one from the DOM. Confirm focus jumps to the second row.
    function Pair() {
      const [hidden, setHidden] = useState(false);
      return (
        <ol>
          {hidden ? null : (
            <li data-story-id={1}>
              <StoryListItem
                story={{ ...baseStory, id: 1, title: 'Row one' }}
                onHide={() => setHidden(true)}
              />
            </li>
          )}
          <li data-story-id={2}>
            <StoryListItem
              story={{ ...baseStory, id: 2, title: 'Row two' }}
            />
          </li>
        </ol>
      );
    }
    renderWithProviders(<Pair />);
    const first = screen.getAllByTestId('story-title')[0];
    act(() => first.focus());
    expect(document.activeElement).toBe(first);
    await userEvent.keyboard('d');
    await waitFor(() => {
      const remaining = screen.getAllByTestId('story-title');
      expect(remaining).toHaveLength(1);
      expect(document.activeElement).toBe(remaining[0]);
    });
  });
});
