# Navigation, Opened & Saved

How Newshacker feels to use — moving between screens, and what happens
to a story after you've tapped it.

## Getting around

Newshacker opens on the **Top** feed. The "N" logo in the header always
takes you back there.

The menu button (top-left) slides out a drawer with two groups:

- **Feeds** — Top, New, Best, Ask, Show, Jobs.
- **Library** — Saved, Opened, Ignored.

Tap any entry and the drawer closes behind you. Swipe, tap outside, or
press Escape to dismiss it without going anywhere.

On any feed page the header picks up two more controls on the right:

- **Show-dismissed** (eye icon) — toggle. See [Ignored](#ignored).
- **Sweep** (broom icon) — dismiss every unstarred story currently on
  screen in one tap. Disabled when there's nothing to sweep.

Both are hidden on non-feed pages (threads, libraries, Help, About) so
the bar stays clean where they don't apply.

Every screen has its own URL, so you can bookmark a feed or share a
thread. The browser's back button works the way you'd expect: it
returns you to the previous screen **at the scroll position you left
it at**. Navigating forward (tapping a story, switching feeds) always
starts at the top.

## A story row

Each row in a feed has at most three tap targets, left to right:

1. **Upvote arrow** (logged-in only).
2. **Row body** — title and metadata share a single stretched link;
   tapping anywhere on the row opens the thread at `/item/:id`.
3. **Star** — a small button on the right that toggles saved state.

The thread page itself carries a prominent **Read article** button
for URL stories, so the article is always one tap away — just via the
thread instead of the row.

There's no separate "N comments" button any more; the comment count
is plain text inside the meta line. Long-pressing a row still opens a
small menu with Save/Unsave, Ignore and Share; swiping does the same
triage without the menu (left = save, right = ignore).

## Opened

A story is "opened" the moment you tap it. Newshacker tracks the two
halves of a story separately:

- Tapping the **row** opens the thread — the row dims.
- Tapping **Read article** on the thread page — the row also dims.

Either action counts as "read this one" from the feed's perspective,
so the row gets the same muted treatment whichever half you explored.
The two timestamps are recorded under the hood (for future use), but
visually the row is one state: opened or not.

Opened stories stay in the **Opened** library for **7 days** and then
quietly age out. The library lists them newest-first, so it doubles as
a short-term history of what you've been reading this week. A "Forget
all opened" button at the top clears it immediately if you'd rather
start fresh.

Opened is automatic memory. You never save to it, and you don't need
to prune it.

## Saved (starred)

Saved is the opposite: deliberate and permanent. You save a story when
you want to come back to it.

Three ways to save:

- **Tap the ★ star** on the right of the row. Tap again to unsave.
- **Swipe the row left.**
- **Long-press the row** and pick Save from the menu.

The star button is the state indicator — filled orange when saved,
outlined when not — so there's no toast; the row just reflects the
new state immediately.

Starred stories also become a to-read list: they're **exempt from the
sweep broom**, so you can star the handful of things you actually want
to read, then sweep the rest of the feed without losing your picks.

Saved stories live in the **Saved** library until you remove them;
there is no expiry.

## Ignored

The third library rounds out the set. Three ways to dismiss a story
from your feeds:

- **Swipe the row right.**
- **Long-press the row** and pick Ignore.
- **Tap the 🧹 sweep** button in the top bar to dismiss every
  unstarred story currently visible in one action.

Scrolling past is *not* a dismissal — dismissing is always deliberate.

If you dismissed too much, flip the **eye** toggle in the top bar.
Dismissed stories reappear in the feed, visibly muted, and tapping
one opens the thread **and un-dismisses it** in the same gesture —
the "peek at what I swept, rescue the ones I actually wanted" flow.

Ignored stories live in the **Ignored** library for **7 days**, in
case you want to go back and look at something you dismissed too
quickly there instead.

## The mental model

Three buckets, each with a different lifespan and a different way in:

| Bucket | How it fills | How long it lasts |
|---|---|---|
| **Opened** | Automatically, when you tap a row or Read article | 7 days |
| **Saved** | Deliberately, by star / swipe-left / menu | Until you unsave |
| **Ignored** | Swipe-right / menu Ignore / top-bar sweep | 7 days |

Every state change is a side-effect of a gesture you were already
making — tap to read, swipe or star to triage, sweep to clear — so
the libraries fill themselves up without any extra bookkeeping on
your part.
