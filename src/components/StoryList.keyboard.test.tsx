import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StoryList } from './StoryList';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';

describe('<StoryList> keyboard navigation', () => {
  beforeEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  async function renderList(count = 5) {
    const ids = Array.from({ length: count }, (_, i) => i + 1);
    const items = Object.fromEntries(ids.map((id) => [id, makeStory(id)]));
    installHNFetchMock({ feeds: { topstories: ids }, items });
    renderWithProviders(<StoryList feed="top" />);
    await waitFor(() => {
      expect(screen.getAllByTestId('story-row')).toHaveLength(count);
    });
    return screen.getAllByTestId('story-title') as HTMLAnchorElement[];
  }

  it('first j press focuses the first row when nothing was focused', async () => {
    const titles = await renderList();
    expect(document.activeElement).not.toBe(titles[0]);
    await userEvent.keyboard('j');
    expect(document.activeElement).toBe(titles[0]);
  });

  it('first ArrowDown press also focuses the first row', async () => {
    const titles = await renderList();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(titles[0]);
  });

  it('j walks focus to the next row; k walks it back', async () => {
    const titles = await renderList();
    await userEvent.keyboard('jjj');
    // First j: first row. Second j: second row. Third j: third row.
    expect(document.activeElement).toBe(titles[2]);
    await userEvent.keyboard('k');
    expect(document.activeElement).toBe(titles[1]);
  });

  it('ArrowDown / ArrowUp behave like j / k', async () => {
    const titles = await renderList();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(titles[1]);
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(titles[0]);
  });

  it('j on the last row stays on the last row (no wrap)', async () => {
    const titles = await renderList(3);
    await userEvent.keyboard('jjjjj');
    expect(document.activeElement).toBe(titles[2]);
  });

  it('k on the first row stays on the first row (no wrap)', async () => {
    const titles = await renderList(3);
    await userEvent.keyboard('j');
    expect(document.activeElement).toBe(titles[0]);
    await userEvent.keyboard('kkk');
    expect(document.activeElement).toBe(titles[0]);
  });

  it('does not navigate while typing in an input', async () => {
    const titles = await renderList(3);
    // Mount an external input and focus it. Keystrokes there must not
    // hijack list nav.
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    await userEvent.keyboard('jjj');
    expect(document.activeElement).toBe(input);
    expect(document.activeElement).not.toBe(titles[0]);
    input.remove();
  });

  it('ignores modifier-key combinations (Cmd+j stays a browser shortcut)', async () => {
    const titles = await renderList(3);
    fireEvent.keyDown(document, { key: 'j', metaKey: true });
    expect(document.activeElement).not.toBe(titles[0]);
  });

  it('focuses the visible-position next row after the active row is hidden', async () => {
    const titles = await renderList(4);
    // Focus row 0, then dismiss it with `d`.
    act(() => titles[0].focus());
    await userEvent.keyboard('d');
    await waitFor(() => {
      // After hide, only 3 rows remain; the previously-second row is
      // now at index 0 and should hold focus.
      const remaining = screen.getAllByTestId('story-title');
      expect(remaining).toHaveLength(3);
      expect(document.activeElement).toBe(remaining[0]);
    });
  });
});
