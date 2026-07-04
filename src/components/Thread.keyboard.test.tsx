import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Thread } from './Thread';
import { FeedBarProvider } from './FeedBarContext';
import { LoginDialogProvider } from './LoginDialog';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';

// Surfaces the current path so navigation-out shortcuts (u / b) can be
// asserted on. Mirrors the LocationProbe in Thread.test.tsx.
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location-pathname">{loc.pathname}</div>;
}

// Renders <Thread> inside a multi-entry MemoryRouter so u / b have a
// history (and a parent) to navigate to. initialIndex lands on the last
// entry (the /item/:id route the reader is "on").
function renderThreadWithHistory({
  id,
  entries,
}: {
  id: number;
  entries: string[];
}) {
  // MemoryRouter keeps its own history and never touches window.history, but
  // closeArticleView reads window.history.length to decide back-vs-close-vs-root.
  // Mirror the intended session-history depth so multi-entry cases exercise the
  // pop path and single-entry cases exercise the close/root fallback. Cleaned up
  // in afterEach.
  Object.defineProperty(window.history, 'length', {
    configurable: true,
    value: entries.length,
  });
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        staleTime: 0,
        networkMode: 'offlineFirst',
      },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <LoginDialogProvider>
          <FeedBarProvider>
            <LocationProbe />
            <Thread id={id} />
          </FeedBarProvider>
        </LoginDialogProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// jsdom doesn't lay out, so getBoundingClientRect returns zeros for
// every element. Stub it to return a real-ish layout (header at
// y=0..48, each comment at sequential y positions) so jumpComment's
// "first comment below the trigger line" math has something to chew
// on. Same trick for scrollTo: capture calls so the assertions can
// see which target the hook scrolled to.
function stubLayout(commentYPositions: number[]) {
  let scrollY = 0;
  Object.defineProperty(window, 'scrollY', {
    configurable: true,
    get: () => scrollY,
  });
  const scrollCalls: number[] = [];
  vi.spyOn(window, 'scrollTo').mockImplementation((arg: unknown) => {
    let top = 0;
    if (typeof arg === 'object' && arg !== null && 'top' in arg) {
      top = (arg as { top?: number }).top ?? 0;
    } else if (typeof arg === 'number') {
      // Second arg form: scrollTo(x, y) — not exercised by the hook.
      top = arg;
    }
    scrollY = top;
    scrollCalls.push(top);
  });

  const origGetRect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: Element) {
      if (this.classList.contains('app-header')) {
        return new DOMRect(0, 0, 800, 48);
      }
      if (this.classList.contains('comment')) {
        // Match the hook's own visible-comments selector so the
        // indexes line up with `commentYPositions` (including nested
        // replies once they appear after expansion).
        const visible = Array.from(
          document.querySelectorAll<HTMLElement>(
            '.thread__comments .comment:not(.comment--loading)',
          ),
        );
        const idx = visible.indexOf(this as HTMLElement);
        if (idx >= 0 && idx < commentYPositions.length) {
          const top = commentYPositions[idx] - scrollY;
          return new DOMRect(0, top, 800, 60);
        }
      }
      return origGetRect.call(this);
    },
  );
  return { scrollCalls, getScrollY: () => scrollY };
}

function makeHeader() {
  const header = document.createElement('div');
  header.className = 'app-header';
  document.body.appendChild(header);
  return header;
}

describe('<Thread> keyboard shortcuts', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // Restore window.history.length to its prototype getter (see
    // renderThreadWithHistory).
    delete (window.history as unknown as { length?: number }).length;
    document.body.querySelectorAll('.app-header').forEach((el) => el.remove());
  });

  it('j scrolls to the next top-level comment', async () => {
    installHNFetchMock({
      items: {
        500: makeStory(500, {
          title: 'KB story',
          url: 'https://example.com/500',
          kids: [501, 502],
          descendants: 2,
        }),
        501: { id: 501, type: 'comment', by: 'a', text: 'first', time: 1 },
        502: { id: 502, type: 'comment', by: 'b', text: 'second', time: 2 },
      },
    });
    makeHeader();
    // header is 48px tall, comments start below at y=200, y=400.
    const layout = stubLayout([200, 400]);

    renderWithProviders(<Thread id={500} />);
    await waitFor(() => {
      expect(screen.getByText('first')).toBeInTheDocument();
      expect(screen.getByText('second')).toBeInTheDocument();
    });

    await userEvent.keyboard('j');
    // The first j press jumps to the first comment (y=200), placing
    // its top just below the 48px header (200 - 48 - 4 = 148).
    expect(layout.scrollCalls.at(-1)).toBe(148);
    await userEvent.keyboard('j');
    // Second j: the second comment at y=400 lands at 400 - 48 - 4 = 348.
    expect(layout.scrollCalls.at(-1)).toBe(348);
  });

  it('j walks real comments and never parks on a reserved placeholder', async () => {
    // 22 kids with the default 20-comment first page leaves 2 height-
    // reserving placeholders below the sentinel. They carry the .comment
    // class, so this guards that keyboard nav still excludes them.
    const kidIds = Array.from({ length: 22 }, (_, i) => 600 + i);
    const items: Record<number, ReturnType<typeof makeStory> | unknown> = {
      590: makeStory(590, { kids: kidIds, descendants: kidIds.length }),
    };
    for (const kid of kidIds) {
      items[kid] = {
        id: kid,
        type: 'comment',
        by: `u${kid}`,
        text: `comment ${kid}`,
        time: 1,
      };
    }
    installHNFetchMock({ items: items as Record<number, never> });
    makeHeader();
    stubLayout(kidIds.slice(0, 20).map((_, i) => 200 + i * 100));

    renderWithProviders(<Thread id={590} />);
    await waitFor(() => {
      expect(screen.getByText('comment 600')).toBeInTheDocument();
    });
    // Placeholders exist for the 2 unloaded kids.
    expect(
      document.querySelectorAll('.comment--placeholder').length,
    ).toBeGreaterThan(0);

    // Walk well past the last real comment; the focus marker must always
    // land on a readable comment, never on a placeholder skeleton.
    for (let i = 0; i < 22; i++) {
      await userEvent.keyboard('j');
      expect(
        document.querySelector('.comment--placeholder[data-keyboard-focused]'),
      ).toBeNull();
    }
    const focused = document.querySelector('.comment[data-keyboard-focused]');
    expect(focused).not.toBeNull();
    expect(focused).not.toHaveClass('comment--placeholder');
  });

  it('j at the bottom of the thread is a no-op', async () => {
    installHNFetchMock({
      items: {
        510: makeStory(510, { kids: [511], descendants: 1 }),
        511: { id: 511, type: 'comment', by: 'a', text: 'only', time: 1 },
      },
    });
    makeHeader();
    const layout = stubLayout([200]);

    renderWithProviders(<Thread id={510} />);
    await waitFor(() => {
      expect(screen.getByText('only')).toBeInTheDocument();
    });

    await userEvent.keyboard('j');
    expect(layout.scrollCalls.at(-1)).toBe(148);
    const beforeBottomJ = layout.scrollCalls.length;
    await userEvent.keyboard('j');
    // Already at the only comment, so j shouldn't push us further.
    expect(layout.scrollCalls.length).toBe(beforeBottomJ);
  });

  it('k from the top of the thread scrolls back to the page top', async () => {
    installHNFetchMock({
      items: {
        520: makeStory(520, { kids: [521], descendants: 1 }),
        521: { id: 521, type: 'comment', by: 'a', text: 'one', time: 1 },
      },
    });
    makeHeader();
    const layout = stubLayout([200]);

    renderWithProviders(<Thread id={520} />);
    await waitFor(() => {
      expect(screen.getByText('one')).toBeInTheDocument();
    });

    await userEvent.keyboard('j');
    expect(layout.getScrollY()).toBe(148);
    await userEvent.keyboard('k');
    expect(layout.scrollCalls.at(-1)).toBe(0);
  });

  it('o opens the article in a new tab and records the open', async () => {
    installHNFetchMock({
      items: {
        530: makeStory(530, {
          url: 'https://example.com/530',
          kids: [],
        }),
      },
    });
    const open = vi.fn();
    vi.stubGlobal('open', open);

    renderWithProviders(<Thread id={530} />);
    await waitFor(() => {
      expect(
        screen.getByRole('link', { name: /read article/i }),
      ).toBeInTheDocument();
    });

    await userEvent.keyboard('o');
    expect(open).toHaveBeenCalledWith(
      'https://example.com/530',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('o is a no-op on self-posts (no URL)', async () => {
    installHNFetchMock({
      items: {
        540: makeStory(540, { url: undefined, text: 'self post body' }),
      },
    });
    const open = vi.fn();
    vi.stubGlobal('open', open);

    renderWithProviders(<Thread id={540} />);
    await waitFor(() => {
      expect(screen.getByText('self post body')).toBeInTheDocument();
    });

    await userEvent.keyboard('o');
    expect(open).not.toHaveBeenCalled();
  });

  it('p toggles the pinned state for the story', async () => {
    installHNFetchMock({
      items: {
        550: makeStory(550, { url: 'https://example.com/550' }),
      },
    });

    renderWithProviders(<Thread id={550} />);
    await waitFor(() => {
      expect(screen.getByTestId('thread-pin')).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });

    await userEvent.keyboard('p');
    await waitFor(() => {
      expect(screen.getByTestId('thread-pin')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
    expect(window.localStorage.getItem('newshacker:pinnedStoryIds')).toContain(
      '550',
    );

    await userEvent.keyboard('p');
    await waitFor(() => {
      expect(screen.getByTestId('thread-pin')).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });
  });

  it('does not fire shortcuts while typing in an input', async () => {
    installHNFetchMock({
      items: {
        560: makeStory(560, { url: 'https://example.com/560' }),
      },
    });
    const open = vi.fn();
    vi.stubGlobal('open', open);

    renderWithProviders(<Thread id={560} />);
    await waitFor(() => {
      expect(
        screen.getByRole('link', { name: /read article/i }),
      ).toBeInTheDocument();
    });

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    await userEvent.keyboard('opd');
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByTestId('thread-pin')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    input.remove();
  });

  it('j walks into a nested reply once its parent has been expanded', async () => {
    installHNFetchMock({
      items: {
        580: makeStory(580, {
          title: 'tree',
          kids: [581, 583],
          descendants: 3,
        }),
        581: {
          id: 581,
          type: 'comment',
          by: 'a',
          text: 'top one',
          kids: [582],
          time: 1,
        },
        582: {
          id: 582,
          type: 'comment',
          by: 'b',
          text: 'nested reply',
          time: 2,
        },
        583: { id: 583, type: 'comment', by: 'c', text: 'top two', time: 3 },
      },
    });
    makeHeader();
    // Three rendered cards once the first is expanded:
    // top-one at y=200, nested at y=350, top-two at y=600. j should
    // visit them in DOM order, not skip past the nested reply.
    const layout = stubLayout([200, 350, 600]);

    renderWithProviders(<Thread id={580} />);
    await waitFor(() => {
      expect(screen.getByText('top one')).toBeInTheDocument();
      expect(screen.getByText('top two')).toBeInTheDocument();
    });

    // Before expansion the nested reply isn't rendered, so j walks
    // straight from the first top-level to the second.
    expect(screen.queryByText('nested reply')).toBeNull();
    await userEvent.keyboard('j');
    expect(layout.scrollCalls.at(-1)).toBe(148); // top-one (200 - 48 - 4)

    await userEvent.click(
      screen.getAllByRole('button', { name: /expand comment/i })[0],
    );
    await waitFor(() => {
      expect(screen.getByText('nested reply')).toBeInTheDocument();
    });

    // Now the nested reply is in the DOM and becomes the next j-stop
    // (350 - 48 - 4 = 298), then the next press lands on top-two
    // (600 - 48 - 4 = 548).
    await userEvent.keyboard('j');
    expect(layout.scrollCalls.at(-1)).toBe(298);
    await userEvent.keyboard('j');
    expect(layout.scrollCalls.at(-1)).toBe(548);
  });

  it('Enter toggles the active top-level comment', async () => {
    installHNFetchMock({
      items: {
        590: makeStory(590, {
          kids: [591],
          descendants: 2,
        }),
        591: {
          id: 591,
          type: 'comment',
          by: 'a',
          text: 'parent',
          kids: [592],
          time: 1,
        },
        592: {
          id: 592,
          type: 'comment',
          by: 'b',
          text: 'kid body',
          time: 2,
        },
      },
    });
    makeHeader();
    stubLayout([60]); // first comment already sits at the trigger line

    renderWithProviders(<Thread id={590} />);
    await waitFor(() => {
      expect(screen.getByText('parent')).toBeInTheDocument();
    });
    expect(screen.queryByText('kid body')).toBeNull();

    // Move focus off any interactive element so Enter falls into our
    // handler (jsdom's initial activeElement is the body — fine).
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByText('kid body')).toBeInTheDocument();
    });

    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.queryByText('kid body')).toBeNull();
    });
  });

  it('Enter is a no-op when focus is on a button (native click wins)', async () => {
    installHNFetchMock({
      items: {
        600: makeStory(600, {
          url: 'https://example.com/600',
          kids: [601],
          descendants: 2,
        }),
        601: {
          id: 601,
          type: 'comment',
          by: 'a',
          text: 'comment body',
          kids: [602],
          time: 1,
        },
        602: { id: 602, type: 'comment', by: 'b', text: 'reply body', time: 2 },
      },
    });
    makeHeader();
    stubLayout([60]);

    renderWithProviders(<Thread id={600} />);
    await waitFor(() => {
      expect(screen.getByText('comment body')).toBeInTheDocument();
    });

    // Focus the Pin button — Enter on it should click it (toggling
    // pin), NOT expand the comment.
    screen.getByTestId('thread-pin').focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByTestId('thread-pin')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
    // Comment kids must not have been revealed.
    expect(screen.queryByText('reply body')).toBeNull();
  });

  it('paints the keyboard-focus indicator on the active comment after j and moves it on the next press', async () => {
    installHNFetchMock({
      items: {
        700: makeStory(700, { kids: [701, 702], descendants: 2 }),
        701: { id: 701, type: 'comment', by: 'a', text: 'first', time: 1 },
        702: { id: 702, type: 'comment', by: 'b', text: 'second', time: 2 },
      },
    });
    makeHeader();
    stubLayout([200, 400]);

    renderWithProviders(<Thread id={700} />);
    await waitFor(() => {
      expect(screen.getByText('first')).toBeInTheDocument();
      expect(screen.getByText('second')).toBeInTheDocument();
    });

    const cards = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '.thread__comments .comment:not(.comment--loading)',
        ),
      );

    // Nothing focused before the first press.
    expect(
      document.querySelector('.thread__comments [data-keyboard-focused]'),
    ).toBeNull();

    await userEvent.keyboard('j');
    expect(cards()[0].hasAttribute('data-keyboard-focused')).toBe(true);
    expect(cards()[1].hasAttribute('data-keyboard-focused')).toBe(false);

    await userEvent.keyboard('j');
    expect(cards()[0].hasAttribute('data-keyboard-focused')).toBe(false);
    expect(cards()[1].hasAttribute('data-keyboard-focused')).toBe(true);
  });

  it('moves the focus indicator back with k, and clears it at the top of the thread', async () => {
    installHNFetchMock({
      items: {
        710: makeStory(710, { kids: [711, 712], descendants: 2 }),
        711: { id: 711, type: 'comment', by: 'a', text: 'one', time: 1 },
        712: { id: 712, type: 'comment', by: 'b', text: 'two', time: 2 },
      },
    });
    makeHeader();
    stubLayout([200, 400]);

    renderWithProviders(<Thread id={710} />);
    await waitFor(() => {
      expect(screen.getByText('one')).toBeInTheDocument();
      expect(screen.getByText('two')).toBeInTheDocument();
    });

    const cards = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '.thread__comments .comment:not(.comment--loading)',
        ),
      );

    await userEvent.keyboard('jj');
    expect(cards()[1].hasAttribute('data-keyboard-focused')).toBe(true);

    await userEvent.keyboard('k');
    expect(cards()[0].hasAttribute('data-keyboard-focused')).toBe(true);
    expect(cards()[1].hasAttribute('data-keyboard-focused')).toBe(false);

    // k from the first comment scrolls back to the page top, which
    // should clear the indicator (no comment is "active" up in the
    // story header).
    await userEvent.keyboard('k');
    expect(
      document.querySelector('.thread__comments [data-keyboard-focused]'),
    ).toBeNull();
  });

  it('Enter paints the focus indicator even with no prior j/k press', async () => {
    installHNFetchMock({
      items: {
        720: makeStory(720, { kids: [721], descendants: 2 }),
        721: {
          id: 721,
          type: 'comment',
          by: 'a',
          text: 'parent body',
          kids: [722],
          time: 1,
        },
        722: { id: 722, type: 'comment', by: 'b', text: 'reply body', time: 2 },
      },
    });
    makeHeader();
    stubLayout([60]);

    renderWithProviders(<Thread id={720} />);
    await waitFor(() => {
      expect(screen.getByText('parent body')).toBeInTheDocument();
    });

    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    expect(
      document.querySelector('.thread__comments [data-keyboard-focused]'),
    ).toBeNull();

    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByText('reply body')).toBeInTheDocument();
    });

    const first = document.querySelector<HTMLElement>(
      '.thread__comments .comment:not(.comment--loading)',
    );
    expect(first?.hasAttribute('data-keyboard-focused')).toBe(true);
  });

  it('does not fire o/p/d on the focused-comment view', async () => {
    installHNFetchMock({
      items: {
        570: makeStory(570, {
          url: 'https://example.com/570',
          kids: [571],
        }),
        571: {
          id: 571,
          type: 'comment',
          by: 'a',
          text: 'focused comment body',
          time: 1,
        },
      },
    });
    const open = vi.fn();
    vi.stubGlobal('open', open);

    renderWithProviders(<Thread id={571} />, { route: '/item/571' });
    await waitFor(() => {
      expect(screen.getByText('focused comment body')).toBeInTheDocument();
    });

    await userEvent.keyboard('opd');
    expect(open).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('newshacker:pinnedStoryIds')).toBeNull();
  });

  it('b pops back to the previous page', async () => {
    installHNFetchMock({
      items: { 810: makeStory(810, { title: 'Backable' }) },
    });

    renderThreadWithHistory({ id: 810, entries: ['/top', '/item/810'] });
    await screen.findByText('Backable');

    await userEvent.keyboard('b');
    await waitFor(() => {
      expect(screen.getByTestId('location-pathname')).toHaveTextContent('/top');
    });
  });

  it('b with no back entry closes the tab, then falls back to the home feed', async () => {
    installHNFetchMock({
      items: { 811: makeStory(811, { title: 'Deeplinked' }) },
    });

    // Single-entry history → location.key === 'default', no back entry: `b`
    // tries to close the tab and falls back to '/' when the browser won't.
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    renderThreadWithHistory({ id: 811, entries: ['/item/811'] });
    await screen.findByText('Deeplinked');

    await userEvent.keyboard('b');
    expect(close).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByTestId('location-pathname')).toHaveTextContent('/');
    });
  });

  it('u on a focused-comment view goes up to the parent', async () => {
    installHNFetchMock({
      items: {
        820: makeStory(820, { title: 'Root story', kids: [821] }),
        821: {
          id: 821,
          type: 'comment',
          by: 'a',
          text: 'focused comment',
          parent: 820,
          time: 1,
        },
      },
    });

    renderThreadWithHistory({ id: 821, entries: ['/item/821'] });
    await screen.findByText('focused comment');

    await userEvent.keyboard('u');
    await waitFor(() => {
      expect(screen.getByTestId('location-pathname')).toHaveTextContent(
        '/item/820',
      );
    });
  });

  it('u on a story view falls back to going back', async () => {
    installHNFetchMock({
      items: { 830: makeStory(830, { title: 'Top story' }) },
    });

    renderThreadWithHistory({ id: 830, entries: ['/top', '/item/830'] });
    await screen.findByText('Top story');

    // A story has nothing above it, so u behaves like b.
    await userEvent.keyboard('u');
    await waitFor(() => {
      expect(screen.getByTestId('location-pathname')).toHaveTextContent('/top');
    });
  });
});
