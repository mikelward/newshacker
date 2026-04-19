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

Every screen has its own URL, so you can bookmark a feed or share a
thread. The browser's back button works the way you'd expect: it
returns you to the previous screen **at the scroll position you left
it at**. Navigating forward (tapping a story, switching feeds) always
starts at the top.

## A story row

Each row in a feed has exactly three tap targets, left to right:

1. **Upvote arrow** (logged-in only).
2. **Title** — opens the article, or the thread for a self-post.
3. **"N comments"** — opens the thread.

There are no other tappable bits of metadata. Long-pressing a row
opens a small menu with Save and Ignore; swiping does the same thing
without the menu (left = save, right = ignore).

## Opened

A story is "opened" the moment you tap it. Newshacker tracks the two
halves of a story separately:

- If you tap the **title**, the title dims.
- If you tap **"N comments"**, the comments button dims.

So at a glance you can see "I read the article but haven't looked at
the discussion yet," or vice-versa. You don't have to do anything to
mark a story opened — it just happens when you tap.

Opened stories stay in the **Opened** library for **7 days** and then
quietly age out. The library lists them newest-first, so it doubles as
a short-term history of what you've been reading this week. A "Forget
all opened" button at the top clears it immediately if you'd rather
start fresh.

Opened is automatic memory. You never save to it, and you don't need
to prune it.

## Saved

Saved is the opposite: deliberate and permanent. You save a story when
you want to come back to it.

Two ways to save:

- **Swipe the row left.**
- **Long-press the row** and pick Save from the menu.

A toast appears at the bottom — "Saved" with an **Undo** button — in
case the swipe was an accident.

Saved stories get a ★ badge in their row so you can recognise them
wherever they appear. They live in the **Saved** library until you
remove them; there is no expiry. Unsaving works the same way — swipe,
or long-press → Unsave — and the toast offers Undo again.

## Ignored

The third library rounds out the set. Swipe a row right, or long-press
→ Ignore, and the story disappears from your feeds. It's also
auto-ignored if you scroll past it without tapping — the idea being
that if you've already skimmed over something, you don't need to see
it again tomorrow.

Ignored stories live in the **Ignored** library for **7 days**, in
case you want to go back and look at something you dismissed too
quickly.

## The mental model

Three buckets, each with a different lifespan and a different way in:

| Bucket | How it fills | How long it lasts |
|---|---|---|
| **Opened** | Automatically, when you tap a story | 7 days |
| **Saved** | Deliberately, by swipe or menu | Until you unsave |
| **Ignored** | Swipe / menu, or scrolling past | 7 days |

Every state change is a side-effect of a gesture you were already
making — tap to read, swipe to triage — so the libraries fill
themselves up without any extra bookkeeping on your part.
