import { isSafeHttpUrl } from './format';
import { createPersistentValue } from './persistentValue';

// Read-later "save" links. Each supported service exposes a public
// "save this page" URL — a plain deep link that opens the service's own
// save/confirmation page in a new tab (prompting login if the reader isn't
// signed in). No Web Share API (which desktop browsers mostly lack), no API
// call, no stored credentials, no cost: it's the same deep-link shape as
// "Open on Hacker News". Pocket is deliberately absent: Mozilla shut it down
// in July 2025.
//
// Which service (if any) appears in the thread overflow menu is a per-device
// setting: the reader picks at most one from a dropdown on the Settings page,
// defaulting to 'none' (no read-later entry). See `readLaterStore` below.

export type ReadLaterService = 'instapaper' | 'readwise' | 'raindrop';

// The chosen read-later target, or 'none' (the default) to hide the entry.
export type ReadLaterPref = ReadLaterService | 'none';

interface ReadLaterServiceDef {
  service: ReadLaterService;
  /** Thread-menu label, e.g. "Save to Instapaper". */
  label: string;
  /** Settings-dropdown label (the bare service name), e.g. "Instapaper". */
  optionLabel: string;
  build: (url: string, title: string) => string;
}

const SERVICES: readonly ReadLaterServiceDef[] = [
  {
    service: 'instapaper',
    label: 'Save to Instapaper',
    optionLabel: 'Instapaper',
    // Instapaper's publisher "Save to Instapaper" link: it shows a confirmation
    // page and offers login/signup when the reader isn't signed in. `title` is
    // optional but recommended.
    build: (url, title) =>
      `https://www.instapaper.com/hello2?url=${encodeURIComponent(url)}` +
      (title ? `&title=${encodeURIComponent(title)}` : ''),
  },
  {
    service: 'readwise',
    label: 'Save to Readwise Reader',
    optionLabel: 'Readwise Reader',
    // Readwise Reader's documented save-by-URL endpoint: saves the article to
    // the Reader inbox (login if needed). It doesn't take a title.
    build: (url) =>
      `https://wise.readwise.io/save?url=${encodeURIComponent(url)}`,
  },
  {
    service: 'raindrop',
    label: 'Save to Raindrop',
    optionLabel: 'Raindrop',
    // Raindrop's documented "add without the extension" save URL — prefills the
    // save dialog (login if needed) and queues the link. NB it's `app.raindrop
    // .io/add?link=` (not `raindrop.io/collection/0?url=`, which only opens the
    // collection viewer and saves nothing). Title is optional but accepted.
    // https://help.raindrop.io/install-extension#faq
    build: (url, title) =>
      `https://app.raindrop.io/add?link=${encodeURIComponent(url)}` +
      (title ? `&title=${encodeURIComponent(title)}` : ''),
  },
];

export const DEFAULT_READ_LATER: ReadLaterPref = 'none';

// Settings dropdown options: None first, then each service (bare name).
export const READ_LATER_OPTIONS: Array<{
  value: ReadLaterPref;
  label: string;
}> = [
  { value: 'none', label: 'None' },
  ...SERVICES.map((s) => ({ value: s.service, label: s.optionLabel })),
];

export const READ_LATER_STORAGE_KEY = 'newshacker:readLaterService';
export const READ_LATER_CHANGE_EVENT = 'newshacker:readLaterServiceChanged';

function isReadLaterPref(raw: unknown): raw is ReadLaterPref {
  return raw === 'none' || SERVICES.some((s) => s.service === raw);
}

export const readLaterStore = createPersistentValue<ReadLaterPref>({
  storageKey: READ_LATER_STORAGE_KEY,
  changeEvent: READ_LATER_CHANGE_EVENT,
  defaultValue: DEFAULT_READ_LATER,
  parse: (raw) => (isReadLaterPref(raw) ? raw : undefined),
  detailKey: 'service',
});

export interface ReadLaterTarget {
  service: ReadLaterService;
  label: string;
  href: string;
}

/** The single read-later menu target for the chosen service, or null when the
 *  pref is 'none' or the article has no safe http(s) URL to save (a self-post,
 *  or a non-http item like a `mailto:`/relative URL — nothing to save). `title`
 *  is the article's headline, used only by services that accept a title param
 *  (e.g. Instapaper). */
export function readLaterTarget(
  pref: ReadLaterPref,
  articleUrl: string | null | undefined,
  title?: string | null,
): ReadLaterTarget | null {
  if (pref === 'none') return null;
  if (!isSafeHttpUrl(articleUrl)) return null;
  const def = SERVICES.find((s) => s.service === pref);
  if (!def) return null;
  return {
    service: def.service,
    label: def.label,
    href: def.build(articleUrl, title?.trim() ?? ''),
  };
}
