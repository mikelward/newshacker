import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditAvatarForm } from './EditAvatarForm';

describe('<EditAvatarForm>', () => {
  it('defaults to GitHub with the HN username prefilled', () => {
    render(
      <EditAvatarForm
        hnUsername="alice"
        initialPrefs={{ source: 'github' }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId('edit-avatar-source-github')).toBeChecked();
    expect(screen.getByTestId('edit-avatar-github-input')).toHaveValue('alice');
  });

  it('prefills an existing GitHub override', () => {
    render(
      <EditAvatarForm
        hnUsername="alice"
        initialPrefs={{ source: 'github', githubUsername: 'alice-real' }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId('edit-avatar-github-input')).toHaveValue(
      'alice-real',
    );
  });

  it('saves GitHub with no override when the field matches the HN username', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <EditAvatarForm
        hnUsername="alice"
        initialPrefs={{ source: 'github' }}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    await user.click(screen.getByTestId('edit-avatar-save'));
    expect(onSave).toHaveBeenCalledWith({ source: 'github' });
  });

  it('saves GitHub with the override when the field differs from the HN username', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <EditAvatarForm
        hnUsername="alice"
        initialPrefs={{ source: 'github' }}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByTestId('edit-avatar-github-input');
    await user.clear(input);
    await user.type(input, 'alice-real');
    await user.click(screen.getByTestId('edit-avatar-save'));
    expect(onSave).toHaveBeenCalledWith({
      source: 'github',
      githubUsername: 'alice-real',
    });
  });

  it('rejects an invalid GitHub username with an inline error', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <EditAvatarForm
        hnUsername="alice"
        initialPrefs={{ source: 'github' }}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByTestId('edit-avatar-github-input');
    await user.clear(input);
    await user.type(input, 'has_underscore');
    await user.click(screen.getByTestId('edit-avatar-save'));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/not a valid github/i);
  });

  it('hashes the email and saves gravatar prefs', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <EditAvatarForm
        hnUsername="alice"
        initialPrefs={{ source: 'github' }}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    await user.click(screen.getByTestId('edit-avatar-source-gravatar'));
    const email = screen.getByTestId('edit-avatar-email-input');
    await user.type(email, '  Alice@Example.com ');
    await user.click(screen.getByTestId('edit-avatar-save'));
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0];
    expect(saved.source).toBe('gravatar');
    expect(saved.gravatarEmail).toBe('Alice@Example.com');
    expect(saved.gravatarHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a malformed email', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <EditAvatarForm
        hnUsername="alice"
        initialPrefs={{ source: 'github' }}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    await user.click(screen.getByTestId('edit-avatar-source-gravatar'));
    await user.type(screen.getByTestId('edit-avatar-email-input'), 'nope');
    await user.click(screen.getByTestId('edit-avatar-save'));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/valid email/i);
  });

  it('saves source = none without validating anything', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <EditAvatarForm
        hnUsername="alice"
        initialPrefs={{ source: 'github' }}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    await user.click(screen.getByTestId('edit-avatar-source-none'));
    await user.click(screen.getByTestId('edit-avatar-save'));
    expect(onSave).toHaveBeenCalledWith({ source: 'none' });
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <EditAvatarForm
        hnUsername="alice"
        initialPrefs={{ source: 'github' }}
        onSave={() => {}}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByTestId('edit-avatar-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('caps the GitHub input at 39 characters', () => {
    render(
      <EditAvatarForm
        hnUsername="alice"
        initialPrefs={{ source: 'github' }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId('edit-avatar-github-input')).toHaveAttribute(
      'maxlength',
      '39',
    );
  });

  it('caps the email input at 254 characters', async () => {
    const user = userEvent.setup();
    render(
      <EditAvatarForm
        hnUsername="alice"
        initialPrefs={{ source: 'github' }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    await user.click(screen.getByTestId('edit-avatar-source-gravatar'));
    expect(screen.getByTestId('edit-avatar-email-input')).toHaveAttribute(
      'maxlength',
      '254',
    );
  });
});
