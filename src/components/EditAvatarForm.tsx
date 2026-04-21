import { useCallback, useId, useState, type FormEvent } from 'react';
import {
  GITHUB_USERNAME_MAX,
  GRAVATAR_EMAIL_MAX,
  type AvatarPrefs,
  type AvatarSource,
  gravatarHashFromEmail,
  isValidGithubUsername,
  isValidGravatarEmail,
} from '../lib/avatarPrefs';
import './EditAvatarForm.css';

interface Props {
  hnUsername: string;
  initialPrefs: AvatarPrefs;
  onSave: (prefs: AvatarPrefs) => void;
  onCancel: () => void;
}

export function EditAvatarForm({
  hnUsername,
  initialPrefs,
  onSave,
  onCancel,
}: Props) {
  const ghId = useId();
  const emailId = useId();

  const [source, setSource] = useState<AvatarSource>(initialPrefs.source);
  const [githubUsername, setGithubUsername] = useState<string>(
    initialPrefs.githubUsername ?? hnUsername,
  );
  const [gravatarEmail, setGravatarEmail] = useState<string>(
    initialPrefs.gravatarEmail ?? '',
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError(null);
      if (source === 'none') {
        onSave({ source: 'none' });
        return;
      }
      if (source === 'github') {
        const trimmed = githubUsername.trim();
        if (!isValidGithubUsername(trimmed)) {
          setError(
            'Not a valid GitHub username (letters, numbers, single hyphens; up to 39 chars).',
          );
          return;
        }
        const next: AvatarPrefs = { source: 'github' };
        // Only persist the override when it differs from the HN
        // username, so the default tracks the logged-in account.
        if (trimmed !== hnUsername) next.githubUsername = trimmed;
        onSave(next);
        return;
      }
      // gravatar
      const trimmed = gravatarEmail.trim();
      if (!isValidGravatarEmail(trimmed)) {
        setError('Enter a valid email address.');
        return;
      }
      setSaving(true);
      try {
        const hash = await gravatarHashFromEmail(trimmed);
        onSave({
          source: 'gravatar',
          gravatarEmail: trimmed,
          gravatarHash: hash,
        });
      } finally {
        setSaving(false);
      }
    },
    [source, githubUsername, gravatarEmail, hnUsername, onSave],
  );

  return (
    <form
      className="edit-avatar-form"
      onSubmit={handleSubmit}
      noValidate
      data-testid="edit-avatar-form"
    >
      <fieldset className="edit-avatar-form__fieldset">
        <legend className="edit-avatar-form__legend">Profile picture</legend>
        <label className="edit-avatar-form__choice">
          <input
            type="radio"
            name="avatar-source"
            value="github"
            checked={source === 'github'}
            onChange={() => setSource('github')}
            data-testid="edit-avatar-source-github"
          />
          <span>GitHub</span>
        </label>
        <label className="edit-avatar-form__choice">
          <input
            type="radio"
            name="avatar-source"
            value="gravatar"
            checked={source === 'gravatar'}
            onChange={() => setSource('gravatar')}
            data-testid="edit-avatar-source-gravatar"
          />
          <span>Gravatar</span>
        </label>
        <label className="edit-avatar-form__choice">
          <input
            type="radio"
            name="avatar-source"
            value="none"
            checked={source === 'none'}
            onChange={() => setSource('none')}
            data-testid="edit-avatar-source-none"
          />
          <span>Letter only</span>
        </label>
      </fieldset>

      {source === 'github' ? (
        <label className="edit-avatar-form__field" htmlFor={ghId}>
          <span className="edit-avatar-form__label">GitHub username</span>
          <input
            id={ghId}
            className="edit-avatar-form__input"
            type="text"
            value={githubUsername}
            maxLength={GITHUB_USERNAME_MAX}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setGithubUsername(e.currentTarget.value)}
            data-testid="edit-avatar-github-input"
          />
        </label>
      ) : null}

      {source === 'gravatar' ? (
        <label className="edit-avatar-form__field" htmlFor={emailId}>
          <span className="edit-avatar-form__label">Gravatar email</span>
          <input
            id={emailId}
            className="edit-avatar-form__input"
            type="email"
            value={gravatarEmail}
            maxLength={GRAVATAR_EMAIL_MAX}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setGravatarEmail(e.currentTarget.value)}
            data-testid="edit-avatar-email-input"
          />
          <span className="edit-avatar-form__hint">
            Hashed in your browser before the request.
          </span>
        </label>
      ) : null}

      {error ? (
        <p className="edit-avatar-form__error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="edit-avatar-form__actions">
        <button
          type="button"
          className="edit-avatar-form__btn edit-avatar-form__btn--secondary"
          onClick={onCancel}
          disabled={saving}
          data-testid="edit-avatar-cancel"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="edit-avatar-form__btn edit-avatar-form__btn--primary"
          disabled={saving}
          data-testid="edit-avatar-save"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
