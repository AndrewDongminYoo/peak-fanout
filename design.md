# design.md

Single source of truth for screens, API, and data contracts.
Change this file first, then change code.
`README.md` links here instead of repeating these tables.
Give this file to any agent before it touches a route, a table, or a screen.

## Screens (`apps/mobile`)

Routes are expo-router paths under `apps/mobile/src/app/`.
The root layout (`src/app/_layout.tsx`) is a `Stack` with two `Stack.Protected` guards on the Supabase session: signed in shows the `(tabs)` group, signed out shows `/login`, and `/auth/callback` is reachable in both states.
The app scheme is `peakfanout` (`app.json` → `scheme`), so the magic-link deep link is `peakfanout://auth/callback`.
Supabase Auth only redirects to URLs on its allow-list; the local stack allows the pattern `peakfanout://**` in `supabase/config.toml` (`[auth] additional_redirect_urls`), because an exact entry stops matching once Supabase appends the token fragment.

### Login — `/login` (`src/app/login.tsx`)

| State   | Shows                                                       | Action                                                                                               |
| ------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| idle    | email input, "Send magic link" button                       | `supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: 'peakfanout://auth/callback' } })` |
| sending | button disabled, spinner                                    | none                                                                                                 |
| sent    | "Check your inbox" with the email, "Use another email" link | back to idle                                                                                         |
| error   | the Supabase error message under the input, button enabled  | retry                                                                                                |

API calls: none to `apps/api`.
The screen talks only to Supabase Auth (`POST /auth/v1/otp` through supabase-js).

### Auth callback — `/auth/callback` (`src/app/auth/callback.tsx`)

The magic link points at Supabase Auth's `/auth/v1/verify`, which redirects to `peakfanout://auth/callback#access_token=…&refresh_token=…&type=magiclink` (implicit flow: the tokens travel in the URL fragment).
On failure Supabase redirects to the same path with `#error=…&error_description=…`.
The screen reads the incoming URL with `useLinkingURL()` from `expo-linking`, then:

1. `supabase.auth.setSession({ access_token, refresh_token })` — persists the session in the secure store.
2. `POST /auth/session` on `apps/api` with that access token — creates the `users` row on first login.
3. `router.replace('/')` — lands on the Me screen.

If step 1 or 2 fails, `supabase.auth.signOut({ scope: 'local' })` drops whatever the store holds before the error is shown (`src/lib/auth-callback.ts`).
A session can still be persisted without its `users` row when the app is killed between the two steps; the next launch restores it, and the Me screen's first `GET /me` repairs it (see below).
Links opened in quick succession run one at a time in arrival order, each through steps 1–2 before the next starts; the last link to complete leaves its session, and the screen renders only the outcome of the most recently opened link.

| State      | Shows                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| completing | spinner, "Signing you in"                                                                                                                                           |
| error      | the failure (`error_description` from the fragment, a `setSession` error, a link without tokens, or a non-200 from `POST /auth/session`) and a "Back to login" link |

### Me — `/` (`src/app/(tabs)/index.tsx`, the Home tab)

Calls `GET /me` through the Eden treaty client with TanStack Query (query key `['me']`).
On a 404 (a persisted session whose `users` row was never created) it calls `POST /auth/session` once and retries `GET /me` once (`fetchMeWithRecovery` in `src/lib/auth-callback.ts`); any other failure, or a second 404, is the error state below. The query never retries a 404 on its own (`shouldRetryMe`), so a TanStack Query retry cannot rerun that repair.

| State      | Shows                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------- |
| loading    | spinner                                                                                         |
| loaded     | `timezone`, `reminder_time`, `push_token` (`null` renders as "not registered"), sign-out button |
| error      | the `GET /me` status and message, retry button, sign-out button                                 |
| signed out | not rendered: the root `Stack.Protected` guard replaces the tabs with `/login`                  |

Sign out calls `supabase.auth.signOut()` and clears the query cache; the guard then routes to `/login`.
The Explore tab (`/explore`, `src/app/(tabs)/explore.tsx`) keeps the template content.

## API surface (`apps/api`)

```plaintext
GET  /health              liveness probe -> { ok: true }
POST /auth/session        Supabase JWT -> internal user upsert
GET  /me                  timezone, reminder_time, push_token
PUT  /me/reminder         { reminder_time, timezone }
PUT  /me/push-token       { token }
GET  /cards/today         three expression cards (cached)
GET  /deliveries?limit=   recent delivery log (read replica)
GET  /admin/queue         waiting / running / failed counts for the demo dashboard
```

The app imports `type App` from `@peak-fanout/api` (`apps/api/src/app.ts`) and calls these routes through Eden treaty.
A route change that breaks the app is a compile error, not a runtime error.

### Authentication

Every route except `GET /health` requires `Authorization: Bearer <Supabase access token>`.
The API verifies the signature, requires an `exp` claim and rejects it once it has passed, and requires an `email` claim.
Two signatures are accepted, chosen by the token's `alg` header: `HS256` with the shared `SUPABASE_JWT_SECRET` (legacy projects), and `ES256` against the project's signing keys at `SUPABASE_URL/auth/v1/.well-known/jwks.json`, which is what the local Supabase CLI issues.
The JWKS is fetched lazily by jose and cached: it is re-fetched when the cache is older than ten minutes or when an unknown `kid` arrives more than 30 seconds after the last fetch (jose `createRemoteJWKSet` defaults). No other request reaches Supabase from the API.

| Case                                                           | Status | Body                                                     |
| -------------------------------------------------------------- | ------ | -------------------------------------------------------- |
| no `Authorization` header, or not of the form `Bearer <token>` | 401    | `{ "error": "unauthorized", "reason": "missing_token" }` |
| malformed token, bad signature, no `exp`, or no `email` claim  | 401    | `{ "error": "unauthorized", "reason": "invalid_token" }` |
| `exp` in the past                                              | 401    | `{ "error": "unauthorized", "reason": "expired_token" }` |

### `POST /auth/session`

No request body.
Upserts `users` by the token's `email` (unique) and returns the row.
`reminder_time` is the Postgres `time` value as text, `push_token` is the `expo_push_token` column, `created_at` is ISO 8601.

```json
{
  "id": "5f0c…",
  "email": "user@example.com",
  "timezone": "UTC",
  "reminder_time": "21:00:00",
  "push_token": null,
  "created_at": "2026-09-12T00:00:00.000Z"
}
```

### `GET /me`

No request body.

```json
{ "timezone": "UTC", "reminder_time": "21:00:00", "push_token": null }
```

404 `{ "error": "not_found" }` when no `users` row exists for the token's email yet; the app calls `POST /auth/session` from the auth callback before its first `GET /me`, and the Me screen answers a 404 with the same call and one retry.

## Data model (`packages/db`)

```plaintext
users        id, email, timezone, reminder_time (time), expo_push_token?, created_at
expressions  id, lang, text, translation, level
reminders    id, user_id, scheduled_at (timestamptz, UTC), state, created_at
jobs         id, kind, payload jsonb, run_at, locked_at, locked_by, attempts, done_at
deliveries   id, reminder_id, status, latency_ms, error?, created_at
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

## Reminders and delivery (M1)

States, constraints and semantics for the M1 fan-out.
The `## Data model` block above owns the column lists and this section does not repeat them.

### The peak instant

The target is `21:00` local in `Asia/Seoul`, which is `12:00Z`.
This section defines it, and `packages/db/src/seed-plan.ts` is the only place the code states the value, as `TARGET_TIMEZONE` and `TARGET_LOCAL_TIME` next to the calendar date the seed materializes.
The seed, the materializer and `load/verify-peak.sql` all take the instant from those constants — the SQL receives it as a parameter — rather than writing it down a second time.

### Timezone distribution

48,000 of the 50,000 seeded users are in `Asia/Seoul`.
The remaining 2,000 are spread over `UTC`, `America/New_York` and `Europe/London`, so the conversion path is exercised for more than one offset and for an offset that daylight saving moves.
The 8,000-user peak is drawn only from the `Asia/Seoul` population, which makes the peak minute deterministic: `Asia/Seoul` has no daylight saving, so `21:00` there is `12:00Z` on every date of the year.
A single-timezone peak is a deliberate simplification — a realistic multi-timezone product would have one smaller peak per zone, and measuring one large peak is the point of the exercise.

### No accidental peak contributions

Off-peak users must not land on the peak instant, because a seed that spread `reminder_time = '21:00'` across timezones would produce one reminder per timezone minute and no peak at all, while every unit test still passed.
The seed's assignment function therefore drops, per timezone, the one local reminder time that converts to the peak instant on the target date, and the peak group is the only group whose local time converts to it.

Two artifacts prove that, and they prove different halves:

- the tests in `packages/db/src/seed-plan.test.ts` walk all 50,000 indices through the assignment function and the TypeScript conversion, and assert exactly 8,000 hits on the peak instant with zero off-peak collisions. They need no Postgres, which is why they can run in CI.
- `load/verify-peak.sql`, run against a real database, counts the materialized rows at the peak instant and lists the five busiest minutes. Postgres `AT TIME ZONE` is what actually writes `scheduled_at`, so this is the only check that proves the database agrees with the assignment function, and a flattened peak is visible in it at a glance rather than inferred.

### `reminders` materialization

`reminders` rows are not created by the scheduler.
A materializer turns one date plus a population of `users` into one `reminders` row per user in it, at that user's local `reminder_time` converted to UTC for that date: `(date + reminder_time) AT TIME ZONE timezone`.
The date names the user's own local calendar day, so a user far enough east or west lands on an adjacent UTC date — `21:00` on that date in `America/New_York` is the next UTC day.
M1 runs the materializer once, for the target date, as part of the seed.
Nothing in M1 runs it on a schedule.

The materializer takes its population as an explicit set of `users.email` values, and the seed passes the set it generates, so a seed run never writes a reminder it cannot delete.
The boundary is the generated set and not a pattern over addresses, because ownership is not a property of an address's shape.
A shape predicate always claims something outside the set: `load-%@example.test` claims `load-alice@example.test`, and `^load-[0-9]+@example\.test$` still claims `load-50000@example.test` and `load-000@example.test`, none of which the seed writes.
The set has no such edge, so a user created by a magic-link login gains no row from a seed run and loses none to it, whatever their address looks like.
Nothing in M1 materializes for the whole table, so the materializer offers no way to ask for it.

### `reminders.state`

`pending` on insert, then `sent` or `failed`.
No other values in M1.
One row per user per scheduled instant, enforced by a unique constraint on `(user_id, scheduled_at)`; with one materialization run per date, that is one row per user per date.
The scheduler's only query is due and pending ordered by `scheduled_at`, served by a partial index on `(scheduled_at) WHERE state = 'pending'` — the same shape as the `jobs` index above.

### `deliveries`

One row per send attempt: the `reminders` row it belongs to, a status of `sent` or `failed`, `latency_ms` measured at the push sink, and `error`, which is null unless the status is `failed`.
No constraint enforces that last clause in M1, because the push sink is the only writer.

### `state` and `status` are Postgres enums

Both are `pgEnum` types (`reminder_state`, `delivery_status`) rather than a text column with a check constraint.
Drizzle infers a TypeScript union from a `pgEnum`, so an invalid state is a compile error in `apps/api` rather than a runtime constraint violation, and `drizzle-kit` diffs the type itself instead of diffing the text of a constraint.
They are two types and not one shared type: `delivery_status` must not accept `pending`, because a `deliveries` row exists only after an attempt has finished.

### What M1 deliberately does not do

The naive send is single-process, unbatched and sequential, and it claims nothing: no `SKIP LOCKED`, no retry, no backoff, no dead-letter.
A tick that is still sending blocks the next tick rather than running concurrently with it, so the fan-out spills past one minute and the reminders it has not reached stay `pending` until it reaches them.
This is a decision, not an omission: it is the measured baseline that M2's queue replaces, and the numbers only mean something if the baseline is the naive shape a first implementation would actually have.
