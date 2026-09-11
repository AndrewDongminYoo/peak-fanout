# design.md

Single source of truth for screens, API, and data contracts.
Change this file first, then change code.
`README.md` links here instead of repeating these tables.
Give this file to any agent before it touches a route, a table, or a screen.

## Screens (`apps/mobile`)

Not designed yet.
M0 needs two screens: a magic-link login and a "me" screen that shows timezone, reminder time, and push token from `GET /me`.
Add each screen here with its route path, the API calls it makes, and its empty and error states before building it.

## API surface (`apps/api`)

```plaintext
POST /auth/session        Supabase JWT -> internal user upsert
GET  /me                  timezone, reminder_time, push_token
PUT  /me/reminder         { reminder_time, timezone }
PUT  /me/push-token       { token }
GET  /cards/today         three expression cards (cached)
GET  /deliveries?limit=   recent delivery log (read replica)
GET  /admin/queue         waiting / running / failed counts for the demo dashboard
```

The app imports `type App` from `apps/api/src/index.ts` and calls these routes through Eden treaty.
A route change that breaks the app is a compile error, not a runtime error.

## Data model (`packages/db`)

```plaintext
users        id, email, timezone, reminder_time (time), expo_push_token?, created_at
expressions  id, lang, text, translation, level
reminders    id, user_id, scheduled_at (timestamptz, UTC), state
jobs         id, kind, payload jsonb, run_at, locked_at, locked_by, attempts, done_at
deliveries   id, reminder_id, status, latency_ms, error?
```

- `jobs` has a partial index on `(run_at) WHERE done_at IS NULL`.
- Workers claim a batch with one statement:

  ```sql
  UPDATE jobs SET locked_at = now(), locked_by = $worker
  WHERE id IN (
    SELECT id FROM jobs
    WHERE run_at <= now() AND done_at IS NULL AND locked_at IS NULL
    ORDER BY run_at LIMIT $n
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
  ```

- Reads of expression cards and delivery logs go to `db.read`. Everything else goes to `db.write`.
- Users store a timezone. The scheduler runs in UTC and converts each user's local reminder time.
