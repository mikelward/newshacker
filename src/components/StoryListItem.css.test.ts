// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  new URL('./StoryListItem.css', import.meta.url),
  'utf8',
);

/** The declarations inside one rule, by selector. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

/** The vertical component of a `padding` shorthand, in px. Comments are
 * stripped first — these rules carry long ones between declarations. */
function verticalPadding(decls: string): number {
  const bare = decls.replace(/\/\*[\s\S]*?\*\//g, '');
  const value = bare.match(/(?:^|;)\s*padding:\s*([^;]+)/)?.[1].trim();
  if (value === undefined) throw new Error('no padding declaration found');
  return Number(value.split(/\s+/)[0].replace('px', ''));
}

describe('story row density', () => {
  it('leaves nothing stacked on top of the row’s 48px child constraint', () => {
    // The one that got away first time. `.pin-btn` is a flex child of the row
    // with `min-height: var(--tap-min)`, so it forces the row's *content box*
    // to 48px on its own — and any vertical padding on `.story-row` then adds
    // to that, which is what pinned every row to 60px however small the text
    // got. Asserting the row's own min-height is not enough: it was already
    // 48px and the rows still did not shrink. This is the invariant that
    // actually decides it.
    expect(rule('.pin-btn')).toMatch(/min-height:\s*var\(--tap-min\)/);
    expect(verticalPadding(rule('.story-row'))).toBe(0);
    expect(rule('.story-row')).toMatch(/min-height:\s*var\(--tap-min\)/);
  });

  it('keeps the breathing room, inside the floor rather than on top of it', () => {
    // Moving the padding is only correct if it still exists somewhere: the
    // optical inset above the title and below the meta, and the room the
    // pressed/hover highlight needs so it doesn't hug the glyphs.
    expect(verticalPadding(rule('.story-row__body'))).toBeGreaterThan(0);
    expect(rule('.story-row__body')).not.toMatch(/min-height/);
  });

  it('keeps the pin button’s own 48×48 hit area', () => {
    // SPEC *Story row layout*: the right-side icon button has its own 48×48px
    // hit area. Tightening the row must not be paid for out of that.
    expect(rule('.pin-btn')).toMatch(/min-width:\s*var\(--tap-min\)/);
    expect(rule('.pin-btn')).toMatch(/align-self:\s*stretch/);
  });

  it('makes the row the link’s hit area, which is what justifies the floor', () => {
    expect(rule('.story-row__body--stretched::after')).toMatch(/inset:\s*0/);
  });
});
