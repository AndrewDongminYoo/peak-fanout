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
On a 404 (a persisted session whose `users` row was never created) it calls `POST /auth/session` once and retries `GET /me` once (`fetchMeWithRecovery` in `src/lib/auth-callback.ts`); any other failure, or a second 404, is the error state below.

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
