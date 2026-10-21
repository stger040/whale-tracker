'use client';

import { useState, useTransition } from 'react';
import { disconnectTelegram, startTelegramLink } from './actions';

export function TelegramConnect({ linked }: { linked: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (linked) {
    return (
      <div className="flex items-center justify-between gap-4">
        <span>Telegram: <span className="text-[var(--yes)]">connected ✓</span></span>
        <button disabled={pending} onClick={() => start(() => disconnectTelegram())}
          className="text-sm text-[var(--muted)] hover:text-[var(--no)]">
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <span>Get your alerts in Telegram from <b>@splashspybot</b>.</span>
      {url ? (
        <>
          <a href={url} target="_blank" rel="noopener noreferrer"
            className="w-fit rounded-lg bg-[var(--accent)] px-4 py-2 font-semibold text-[#0b1220] hover:opacity-90">
            Open Telegram and tap Start
          </a>
          <span className="text-xs text-[var(--muted)]">
            The link works once and expires in 15 minutes. Refresh this page after tapping Start.
          </span>
        </>
      ) : (
        <button disabled={pending}
          onClick={() => start(async () => {
            const r = await startTelegramLink();
            if (r.url) { setUrl(r.url); window.open(r.url, '_blank', 'noopener'); } else setError(r.error ?? 'Something went wrong.');
          })}
          className="w-fit rounded-lg bg-[var(--accent)] px-4 py-2 font-semibold text-[#0b1220] hover:opacity-90 disabled:opacity-60">
          {pending ? 'Creating link…' : 'Connect Telegram'}
        </button>
      )}
      {error && <span className="text-sm text-[var(--no)]">{error}</span>}
    </div>
  );
}
