import { useState } from 'react';
import { TooltipButton } from './TooltipButton';
import { useAuth } from '../hooks/useAuth';
import { useConnectTokens } from '../hooks/useConnectTokens';
import type { CreatedToken } from '../lib/connectTokens';
import './ConnectedApps.css';

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString();
}

/**
 * Settings section for issuing app tokens to a companion app (Readmo), so
 * dismissing a Hacker News story there mirrors back to your Done list here.
 * Only rendered for a signed-in user — the tokens act as that HN identity. The
 * raw token is shown once at creation and never again; the list thereafter
 * carries only redacted metadata. See SPEC § "Connecting a companion app".
 */
export function ConnectedApps() {
  const { user } = useAuth();
  const { tokens, create, revoke } = useConnectTokens(user?.username ?? null);
  const [justCreated, setJustCreated] = useState<CreatedToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A token is the signed-in HN identity — nothing to offer a logged-out visitor.
  if (!user) return null;

  const onGenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await create('Readmo');
      setJustCreated(created);
      setCopied(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create a token.');
    } finally {
      setBusy(false);
    }
  };

  const onCopy = async () => {
    if (!justCreated) return;
    try {
      await navigator.clipboard.writeText(justCreated.token);
      setCopied(true);
    } catch {
      // Clipboard unavailable (older browser / denied permission); the token is
      // still visible for a manual copy, so this is non-fatal.
    }
  };

  const onRevoke = async (id: string) => {
    setError(null);
    try {
      await revoke(id);
      if (justCreated?.id === id) setJustCreated(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not revoke the token.');
    }
  };

  return (
    <section className="settings-page__section">
      <h2 className="settings-page__heading">Connected apps</h2>
      <button
        type="button"
        className="connected-apps__generate"
        onClick={onGenerate}
        disabled={busy}
      >
        {busy ? 'Generating…' : 'Generate token'}
      </button>

      {error && (
        <p className="connected-apps__error" role="alert">
          {error}
        </p>
      )}

      {justCreated && (
        <div className="connected-apps__new">
          <code className="connected-apps__token">{justCreated.token}</code>
          <button
            type="button"
            className="connected-apps__copy"
            onClick={onCopy}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <p className="connected-apps__once">
            Copy it now — you won&rsquo;t see it again.
          </p>
        </div>
      )}

      {tokens.length > 0 && (
        <ul className="connected-apps__list">
          {tokens.map((t) => (
            <li key={t.id} className="connected-apps__item">
              <span className="connected-apps__meta">
                {t.label} · ••••{t.last4} · {formatDate(t.createdAt)}
              </span>
              <TooltipButton
                type="button"
                tooltip="Revoke"
                aria-label={`Revoke ${t.label}`}
                className="connected-apps__revoke"
                onClick={() => onRevoke(t.id)}
              >
                Revoke
              </TooltipButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
