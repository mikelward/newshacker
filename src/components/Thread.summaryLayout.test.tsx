import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { Thread } from './Thread';
import { renderWithProviders } from '../test/renderUtils';
import { installHNFetchMock, makeStory } from '../test/mockFetch';

const trackLayoutSpy = vi.fn();
vi.mock('../lib/analytics', () => ({
  trackSummaryLayout: (event: unknown) => trackLayoutSpy(event),
}));

// useContentWidth reads clientWidth; jsdom defaults to 0 which suppresses
// the telemetry guard. Override with a phone-width value and a fixed
// offsetHeight so the event fires with predictable, asserted numbers.
function stubLayoutMetrics(clientWidth: number, offsetHeight: number) {
  const prevClientWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'clientWidth',
  );
  const prevOffsetHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetHeight',
  );
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return clientWidth;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return offsetHeight;
    },
  });
  return () => {
    if (prevClientWidth) {
      Object.defineProperty(
        HTMLElement.prototype,
        'clientWidth',
        prevClientWidth,
      );
    } else {
      delete (HTMLElement.prototype as unknown as { clientWidth?: unknown })
        .clientWidth;
    }
    if (prevOffsetHeight) {
      Object.defineProperty(
        HTMLElement.prototype,
        'offsetHeight',
        prevOffsetHeight,
      );
    } else {
      delete (HTMLElement.prototype as unknown as { offsetHeight?: unknown })
        .offsetHeight;
    }
  };
}

describe('<Thread> summary_layout telemetry', () => {
  let restoreMetrics: (() => void) | undefined;

  beforeEach(() => {
    window.localStorage.clear();
    trackLayoutSpy.mockClear();
    restoreMetrics = stubLayoutMetrics(390, 120);
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    restoreMetrics?.();
  });

  it('fires once for the article summary when data arrives', async () => {
    installHNFetchMock({
      items: {
        900: makeStory(900, {
          title: 'Layout',
          url: 'https://example.com/900',
        }),
      },
      summaries: {
        900: { summary: 'A single-sentence summary for layout telemetry.' },
      },
    });

    renderWithProviders(<Thread id={900} />, { route: '/item/900' });

    await waitFor(() => {
      expect(
        trackLayoutSpy.mock.calls.some(
          ([evt]) => (evt as { kind: string }).kind === 'article',
        ),
      ).toBe(true);
    });

    const articleCall = trackLayoutSpy.mock.calls.find(
      ([evt]) => (evt as { kind: string }).kind === 'article',
    );
    expect(articleCall?.[0]).toMatchObject({
      kind: 'article',
      cardWidthPx: 390,
      summaryChars: 'A single-sentence summary for layout telemetry.'.length,
      renderedContentHeightPx: 120,
    });
  });

  it('fires for the comments summary with insight_count', async () => {
    installHNFetchMock({
      items: {
        910: makeStory(910, {
          title: 'Thread',
          url: 'https://example.com/910',
          kids: [911, 912],
          descendants: 2,
        }),
        911: {
          id: 911,
          type: 'comment',
          by: 'a',
          text: 'one',
          time: 1,
        },
        912: {
          id: 912,
          type: 'comment',
          by: 'b',
          text: 'two',
          time: 2,
        },
      },
      commentsSummaries: {
        910: {
          insights: [
            'Insight alpha.',
            'Insight beta.',
            'Insight gamma.',
          ],
        },
      },
    });

    renderWithProviders(<Thread id={910} />, { route: '/item/910' });

    await waitFor(() => {
      expect(
        trackLayoutSpy.mock.calls.some(
          ([evt]) => (evt as { kind: string }).kind === 'comments',
        ),
      ).toBe(true);
    });

    const commentsCall = trackLayoutSpy.mock.calls.find(
      ([evt]) => (evt as { kind: string }).kind === 'comments',
    );
    expect(commentsCall?.[0]).toMatchObject({
      kind: 'comments',
      cardWidthPx: 390,
      insightCount: 3,
      renderedContentHeightPx: 120,
    });
  });
});
