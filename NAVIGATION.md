# Navigation, Opened & Pinned

How newshacker feels to use — moving between screens, and what happens
to a story after you've tapped it.

## Getting around

newshacker opens on the **Top** feed. The "n" logo in the header always
takes you back there.

The menu button (top-left) slides out a drawer with two groups:

- **Feeds** — Top, New, Best, Ask, Show, Jobs.
- **Library** — Favorites, Pinned, Opened, Ignored.

Tap any entry and the drawer closes behind you. Swipe, tap outside, or
press Escape to dismiss it without going anywhere.

On any feed page the header picks up two more controls on the right:

- **Undo** (arrow icon) — bring back the stories you most recently
  dismissed, whether you swiped them away one at a time or swept them
  all at once. Disabled when there's nothing to undo.
- **Sweep** (broom icon) — dismiss every unpinned story currently on
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
3. **Pin** — a small button on the right that toggles pinned state.

The thread page itself carries a prominent **Read article** button
for URL stories, so the article is always one tap away — just via the
thread instead of the row.

There's no separate "N comments" button any more; the comment count
is plain text inside the meta line. Long-pressing a row still opens a
small menu with Pin/Unpin, Ignore and Share; swiping does the same
triage without the menu (left = pin, right = ignore).

## A comment row

Comments on the thread page follow the same "one tap zone" rule. Each
comment starts collapsed, showing the author, age, reply count, and
the first three lines of the body. Tapping anywhere on the row
expands it: the full body appears, and its immediate replies show up
below — each itself a three-line preview that you can tap to drill
in. Tapping again collapses back.

Tapping the author name still goes to their profile, and an expanded
comment picks up a muted **Reply on HN ↗** link at the bottom that
hands you off to Hacker News itself — newshacker doesn't submit
comments. Deleted and empty comments are hidden from the thread
entirely.

## Opened

A story is "opened" the moment you tap it. newshacker tracks the two
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

Opened is automatic memory. You never pin to it, and you don't need
to prune it.

## Pinned

Pinned is the opposite of Opened: deliberate and durable. You pin a
story when you want to come back to it — your active reading list.

Three ways to pin:

- **Tap the 📌 pin** on the right of the row. Tap again to unpin.
- **Swipe the row left.**
- **Long-press the row** and pick Pin from the menu.

The pin button is the state indicator — filled when pinned, outlined
when not — so there's no toast; the row reflects the new state
immediately.

Pinned stories are also **exempt from the sweep broom**, so you can
pin the handful of things you actually want to read, then sweep the
rest of the feed without losing your picks.

Pinned stories live in the **Pinned** library until you remove them;
there is no expiry. The verb pair "Pin / Unpin" is the whole
interaction — explicit in, explicit out. Anything you want to keep
forever (vs. just on your reading list) goes in **Favorites** instead.

## Favorites

Favorites is the "keep forever" bucket. Pin is for "I'll read this
later", Favorite is for "I loved this and want to remember it" — they
are deliberately separate so the active reading list can stay tidy
without losing the keepers.

You favorite from the **article comments view** — there's a Favorite
button on the story page, next to Pin. There is no row-level heart,
because that would add a fourth tap target to a row and undo the
"fewer, larger zones" rule we care about.

Favorites live in the **Favorites** library forever (until you tap
Unfavorite). They are never swept, never expired, and never filtered
out of feeds.

## Ignored

The third library rounds out the set. Three ways to dismiss a story
from your feeds:

- **Swipe the row right.**
- **Long-press the row** and pick Ignore.
- **Tap the 🧹 sweep** button in the top bar to dismiss every
  unpinned story currently visible in one action.

Scrolling past is *not* a dismissal — dismissing is always deliberate.

If you dismissed too much, hit the **undo** arrow in the top bar to
bring back the batch you most recently swiped or swept. For anything
older, open the **Ignored** library and tap **Un-ignore** on the row
— the "rescue the ones I actually wanted" flow.

Ignored stories live in the **Ignored** library for **7 days**, so
you can go back and rescue something you dismissed too quickly there
instead.

## The mental model

Three buckets, each with a different lifespan and a different way in:

| Bucket | How it fills | How long it lasts |
|---|---|---|
| **Opened** | Automatically, when you tap a row or Read article | 7 days |
| **Pinned** | Deliberately, by pin / swipe-left / menu | Until you unpin |
| **Favorites** | Deliberately, by the Favorite button on the thread page | Forever (until you unfavorite) |
| **Ignored** | Swipe-right / menu Ignore / top-bar sweep | 7 days |

Every state change is a side-effect of a gesture you were already
making — tap to read, swipe or pin to triage, sweep to clear — so
the libraries fill themselves up without any extra bookkeeping on
your part.
