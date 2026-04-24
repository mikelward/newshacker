import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { UserAvatar } from './UserAvatar';
import { avatarColorForUsername } from '../lib/avatarColor';

describe('avatarColorForUsername', () => {
  it('returns the same color for the same input', () => {
    expect(avatarColorForUsername('alice')).toBe(avatarColorForUsername('alice'));
  });

  it('returns a color from the non-orange palette', () => {
    // Palette entries are explicitly chosen to not clash with the
    // brand mark's orange. We don't assert the exact hex per username
    // (that would couple the test to the hash) but we do assert the
    // color is never a brand-orange hue.
    const color = avatarColorForUsername('bob');
    // Brand orange and its darker hover shade — none of the palette
    // entries should match these.
    expect(color.toLowerCase()).not.toMatch(/^#e651[0-9a-f]{2}$/);
    expect(color.toLowerCase()).not.toMatch(/^#bf360c$/);
  });

  it('falls back deterministically for an empty username', () => {
    expect(avatarColorForUsername('')).toBeDefined();
  });
});

describe('<UserAvatar>', () => {
  it('renders an anonymous silhouette when no username is given', () => {
    const { container } = render(<UserAvatar />);
    expect(screen.getByTestId('user-avatar-anon')).toBeInTheDocument();
    // SVG person icon is present.
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('renders the uppercase initial when a username is given', () => {
    render(<UserAvatar username="alice" />);
    expect(screen.getByTestId('user-avatar')).toHaveTextContent('A');
  });

  it('does not leak a tappable child — the avatar itself is aria-hidden', () => {
    render(<UserAvatar username="alice" />);
    // The wrapping button supplies the accessible name; the visual
    // avatar must not also be exposed to assistive tech or it's
    // announced twice.
    expect(screen.getByTestId('user-avatar')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  it('respects a custom size prop', () => {
    render(<UserAvatar username="alice" size={48} />);
    const el = screen.getByTestId('user-avatar');
    expect(el.getAttribute('style')).toMatch(/width:\s*48px/);
    expect(el.getAttribute('style')).toMatch(/height:\s*48px/);
  });

  it('renders the remote image over the initial when imageUrl is given', () => {
    render(
      <UserAvatar
        username="alice"
        imageUrl="https://github.com/alice.png?size=64"
      />,
    );
    const img = screen.getByTestId('user-avatar-img');
    expect(img).toHaveAttribute(
      'src',
      'https://github.com/alice.png?size=64',
    );
    // Initial is still in the DOM underneath so the fallback is invisible
    // when the image errors later.
    expect(screen.getByTestId('user-avatar')).toHaveTextContent('A');
  });

  it('hides the image and keeps the initial when the image errors', () => {
    render(
      <UserAvatar
        username="alice"
        imageUrl="https://github.com/does-not-exist-xyzzy.png"
      />,
    );
    const img = screen.getByTestId('user-avatar-img');
    fireEvent.error(img);
    expect(screen.queryByTestId('user-avatar-img')).not.toBeInTheDocument();
    expect(screen.getByTestId('user-avatar')).toHaveTextContent('A');
  });

  it('marks the image as loaded on load so CSS can fade it in', () => {
    render(
      <UserAvatar
        username="alice"
        imageUrl="https://github.com/alice.png"
      />,
    );
    const img = screen.getByTestId('user-avatar-img');
    expect(img).toHaveAttribute('data-loaded', 'false');
    fireEvent.load(img);
    expect(img).toHaveAttribute('data-loaded', 'true');
  });

  it('resets the failed state when imageUrl changes', () => {
    const { rerender } = render(
      <UserAvatar
        username="alice"
        imageUrl="https://github.com/does-not-exist-xyzzy.png"
      />,
    );
    fireEvent.error(screen.getByTestId('user-avatar-img'));
    expect(screen.queryByTestId('user-avatar-img')).not.toBeInTheDocument();
    rerender(
      <UserAvatar
        username="alice"
        imageUrl="https://gravatar.com/avatar/abc"
      />,
    );
    expect(screen.getByTestId('user-avatar-img')).toHaveAttribute(
      'src',
      'https://gravatar.com/avatar/abc',
    );
  });

  it('does not render an image for the anon silhouette', () => {
    render(<UserAvatar imageUrl="https://example.com/nope.png" />);
    expect(screen.queryByTestId('user-avatar-img')).not.toBeInTheDocument();
  });
});
