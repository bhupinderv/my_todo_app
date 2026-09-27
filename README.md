# Next

A personal task app that answers one question: **what should I work on next?**

*The app recommends; you decide.*

Open it → see what needs attention → pick something → finish it.

- **Daily briefing**: overdue and due-today counts, plus an "Action required" box for overdue tasks. Overdue tasks are never moved to another day for you.
- **Top 3**: the recommended next tasks, each with a short "Why" line. You can override it: pin a task, drag it up your list, or snooze it with "Not now".
- **Still in progress**: unfinished work stays on screen even when something more urgent shows up.
- **Your list**: drag and drop sets your manual order, and the app never reorders it on its own. "Suggest order" re-sorts it by the app's suggestion, but only when you click it.
- **Snooze** ("Remind me later"): hides a task from the recommendations until the time you pick. Its due date doesn't change.
- **Quick capture**: type a title and press Enter, then get back to what you were doing. New tasks go where the app thinks they belong, and you can move them.

## Project layout

```
index.html              markup
css/styles.css          styles (light/dark, responsive)
js/app.js               UI: rendering, events, dialogs
js/prioritization.js    recommendation engine (pure functions, no DOM/DB)
js/dates.js             date-only helpers, snooze times
js/store.js             data access: Supabase, or localStorage in demo mode
js/dnd.js               drag-to-reorder (mouse, touch, keyboard)
js/config.js            Supabase URL + anon key
supabase/schema.sql     the tasks table + row-level security
tests/                  unit tests for the engine (node --test)
```

## Run locally

With `js/config.js` left empty, the app runs in **demo mode**. It stores sample tasks in your browser and needs no backend.

```bash
python3 -m http.server 8000
```

Open http://localhost:8000. ES modules don't load from `file://`, so opening the HTML file directly won't work.

Run the tests (Node 20 or later):

```bash
npm test
```

## Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor**, paste in [`supabase/schema.sql`](supabase/schema.sql), and run it.
3. Go to **Project Settings → API** and copy the **Project URL** and the **anon / publishable key** into [`js/config.js`](js/config.js).
4. Go to **Authentication → URL Configuration**:
   - Set **Site URL** to your GitHub Pages URL, e.g. `https://<you>.github.io/<repo>/`.
   - Add `http://localhost:8000/` under **Redirect URLs** for local testing.
5. Open the app, enter your email, and click the magic link. After your first sign-in, you can turn off **Authentication → Sign In / Providers → Allow new users to sign up** so nobody else can create an account. Row-level security already keeps other users out of your tasks.

> The anon key is meant to be public. The site stays safe because of row-level security: every row belongs to `auth.uid()`, and the `anon` role has no access to the table.

### 2. GitHub Pages

```bash
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

Then go to **Settings → Pages → Build and deployment**, choose *Deploy from a branch*, and select `main` / `/ (root)`. The site has no build step.

## How the recommendation works

Everything lives in [`js/prioritization.js`](js/prioritization.js). The weights are in `WEIGHTS` at the top of the file.

**Suggested priority** is based on urgency only:

| Suggested | When |
| --- | --- |
| HIGH | Overdue, due today, or due tomorrow |
| MEDIUM | Due within 7 days, in progress, or postponed 3+ times |
| LOW | Everything else |

If you set a priority yourself, it always wins. The app still saves its own suggestion in `suggested_priority`, so a later version can learn from the cases where you disagreed.

**Focus score** decides the Top 3. It adds up:

- Due date: overdue +50 to +70 (more the longer it's overdue), today +40, tomorrow +30, within 3 days +20, within a week +10, within 2 weeks +4
- Priority: HIGH +30, MEDIUM +15, LOW 0
- Already in progress: +25
- Postponed (snoozed, or due date pushed later): +4 each time, up to +12
- Effort: quick win (≤ 30 min) +4, or a big task (≥ 2 h) due within 3 days +6
- Your manual order: +15 for the top of the list, dropping to 0 at the bottom

Pinned tasks always come first. Done and currently snoozed tasks are left out.

To evolve it, keep the function signatures (`rankTasks`, `scoreTask`, `suggestPriority`) and change what's inside them. For example, you could learn `WEIGHTS` from a future `task_events` table.

## Data model

There is one table, `tasks`. See the comments in `schema.sql` for details.

| Column | Purpose |
| --- | --- |
| `title`, `category`, `notes` | What the task is |
| `due_date` | Date only |
| `effort_minutes` | Estimated effort |
| `status` | `TODO` / `IN_PROGRESS` / `DONE` |
| `user_priority` | Your priority; `null` means "Auto" |
| `suggested_priority` | The app's latest opinion |
| `position` | Manual order. It's fractional, so a drag updates only one row |
| `pinned` | You forced the task into the Top 3 |
| `snoozed_until`, `postpone_count` | Snooze info and the "repeatedly postponed" signal |
| `started_at`, `completed_at`, `created_at`, `updated_at` | Timestamps for future signals (e.g. completed late, typical duration) |

Tables to add later without changing `tasks`: `task_events` (status changes, moves, overrides), `user_preferences`, `recommendation_log`.

## Not in V1 (on purpose)

Machine learning, recurring tasks, time-of-day due times, calendar sync, sharing, analytics. The plan is to use the app for a while, then decide what to add.
