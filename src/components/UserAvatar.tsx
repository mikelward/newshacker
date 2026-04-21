import { useEffect, useState } from 'react';
import { avatarColorForUsername } from '../lib/avatarColor';
import './UserAvatar.css';

interface Props {
  username?: string | null;
  size?: number;
  // Optional remote picture. Rendered on top of the letter circle; if
  // it 404s or fails to load, we hide it and the letter remains
  // visible underneath with no layout shift.
  imageUrl?: string | null;
}

// Material Symbols Outlined — Apache 2.0, Google. viewBox 0 -960 960 960.
const PERSON_PATH =
  'M480-480q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 66-47 113t-113 47ZM160-160v-112q0-34 17.5-62.5T224-378q62-31 126-46.5T480-440q66 0 130 15.5T736-378q29 15 46.5 43.5T800-272v112H160Z';

export function UserAvatar({ username, size = 32, imageUrl }: Props) {
  const initial = username ? username.slice(0, 1).toUpperCase() : '';
  const [imgFailed, setImgFailed] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);

  useEffect(() => {
    setImgFailed(false);
    setImgLoaded(false);
  }, [imageUrl]);

  const style = {
    width: size,
    height: size,
    background: username
      ? avatarColorForUsername(username)
      : 'var(--hn-meta)',
  };
  if (!username) {
    return (
      <span
        className="user-avatar user-avatar--anon"
        style={style}
        data-testid="user-avatar-anon"
        aria-hidden="true"
      >
        <svg
          className="user-avatar__icon"
          viewBox="0 -960 960 960"
          width={Math.round(size * 0.625)}
          height={Math.round(size * 0.625)}
          fill="currentColor"
          aria-hidden="true"
          focusable="false"
        >
          <path d={PERSON_PATH} />
        </svg>
      </span>
    );
  }
  const showImage = Boolean(imageUrl) && !imgFailed;
  return (
    <span
      className="user-avatar"
      style={style}
      data-testid="user-avatar"
      data-username={username}
      aria-hidden="true"
    >
      <span className="user-avatar__initial">{initial}</span>
      {showImage ? (
        <img
          className="user-avatar__img"
          src={imageUrl ?? undefined}
          alt=""
          aria-hidden="true"
          data-testid="user-avatar-img"
          data-loaded={imgLoaded ? 'true' : 'false'}
          onLoad={() => setImgLoaded(true)}
          onError={() => setImgFailed(true)}
        />
      ) : null}
    </span>
  );
}
