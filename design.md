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

`POST /auth/session` and `GET /me` additionally refuse a row the load seed owns, whatever the token says.
A verified token for an address carrying `users.seeded` gets 409 `{ "error": "conflict", "reason": "reserved_identity" }` from `POST /auth/session`, and `GET /me` reports it as absent.
Handing such a row back would give the caller reminders it never created and an account the next `bun run db:seed` deletes, so a seeded row is a load-test fixture and never an identity.
In a deployment with no seeded rows the flag is always `false` and neither branch is reachable.

### `POST /auth/session`

No request body.
Upserts `users` by the token's `email` (unique) and returns the row, unless that row carries `users.seeded`; see "Authentication" above.
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
users        id, email, timezone, reminder_time (time), expo_push_token?, seeded, load_pool, created_at
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

### The seed owns its rows by a recorded flag, not by their address

`users.seeded` is `false` for every row the application creates and `true` only for a row the load seed wrote.
The seed deletes exactly the rows where it is `true`, materializes reminders for exactly those rows, and the verification query counts exactly those rows.
The materializer's population is therefore not a parameter: there is one population, and it is the marked rows.

The column exists because ownership cannot be read off an address, and four review rounds were spent proving it one predicate at a time.
`LIKE 'load-%@example.test'` also claimed `load-alice@example.test`.
Narrowing to `^load-[0-9]+@example\.test$` still claimed `load-50000@example.test` and `load-000@example.test`, which the seed never writes.
Enumerating the 50,000 generated addresses removed those edges but still could not tell a seed-written row from a magic-link login that had taken one of the same addresses — and on the local stack that is reachable, because the mail catcher accepts any domain.
Every one of those predicates asks what a row looks like. Only the flag records who wrote it, which is the actual question.

So the guarantee is now unconditional and does not depend on what a user's address looks like: a row the application created has `seeded = false`, and no seed run reads it, writes to it, counts it, or deletes it.

The flag closes the reverse ordering too, which the seed cannot defend against alone.
If the seed runs first and a magic link then arrives for an address it generated, the upsert in `POST /auth/session` would find the marked row and hand it back, so the caller would inherit a reminder it never created and an account the next seed run deletes.
The API therefore refuses a marked row rather than adopting it, and `GET /me` reports it as absent — see "Authentication".
In the other ordering, a login first and the seed second, the seed refuses instead: the unmarked row holds the address, the insert stops on the unique index, and the run reports which address collided and changes nothing.
Nothing in M1 materializes for unmarked rows, and the materializer offers no way to ask for them.

### The load harness owns its API pool the same way

The measured run needs a handful of ordinary users to send `GET /me` as, and it creates them.
`users.load_pool` records that it did: `true` only for a row the harness wrote, `false` for every row the application creates, exactly as `seeded` works and for the same reason.
The harness's sweep before a run and its delete after one both read the flag, so neither asks what an address looks like.
The addresses it uses, `apiload-<n>@example.test`, are a convention for a reader and carry no meaning for any query.

The harness writes those rows itself rather than letting `POST /auth/session` create them, because ownership has to be recorded in the same statement that creates the row.
A row the API created is returned to the harness as a 200 whether the API found it or inserted it, which is indistinguishable, and a flag set afterwards would claim a row that was already there.
One insert of the whole pool closes that: the unique index on `email` stops it if any of those addresses is already taken, and the run refuses and names the address, changing nothing — the same closure the seed relies on for a login that arrived first.
`POST /auth/session` is still called once per address, and what it proves is identity rather than a status code: the route returns the `id` of the row it served, the pool insert returned the `id` the database generated for each row, and the two are equal only when the API found this run's row in this database.
A 200 alone would prove nothing about which database, because the route upserts: an API on another database with the same signing secret creates the row there and answers 200 just the same, and the run would then measure `GET /me` against one database and the counters, the connections and the fan-out against another, with every verdict check still met.
Before any of those calls, one `GET /me` on the first pool row, which writes nothing: a 404 means the API's database holds no row at an address this run just inserted, so the run refuses before asking that API to upsert anything, and no refusal in this step creates a row in any database.
This is a precondition of a measured run and not a verdict check, for the reason "Metric definitions and their sources" gives: a written run log could never disagree with it.

The two fixture flags differ in exactly one way, and it is deliberate.
A `seeded` row is never an identity, so both authenticated routes refuse it.
A `load_pool` row is the opposite: the run exists to have the API serve it, so `POST /auth/session` and `GET /me` treat it as the ordinary user it is, and the API never reads the flag at all.
What the flag protects is not the API's behavior but the harness's delete.

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

### The push sink

One interface with one operation, in `apps/api/src/push/sink.ts`: `send(token, message)` returns once the send has completed and throws when it failed.
`apps/api/src/push/simulated.ts` is the only implementation M1 ships, and the only one any measured number is produced against.

The simulated latency is the experiment, not a placeholder.
An instant sink finishes 8,000 sequential sends in about two seconds, M2's queue would have nothing to beat, and the measurement table would compare nothing.
So three properties are fixed:

- Every send waits a delay drawn uniformly from `[PUSH_SIM_LATENCY_MIN_MS, PUSH_SIM_LATENCY_MAX_MS]`, defaulting to 50 ms and 150 ms, which is the order of one real push call to a provider.
  `PUSH_SIM_FAILURE_RATE`, default 0, is the fraction of sends that throw instead, so the `failed` state and the `deliveries.error` column are exercised rather than dead.
  `send` returns what the wait actually cost — the elapsed time on a monotonic clock around the sleep, not the delay it drew — and a failure carries the same figure on the thrown error, so the caller writes `latency_ms` without timing the clock a second time.
  The draw is an input to the sink; `latency_ms` is its output, and the two differ by whatever the timer overshoots, which is small while M1 sends one at a time and grows once M2's workers contend for the same event loop.
  A sink that returned its draw would record the same cost under both, and the M2 row would then understate what its sends really paid.
- The module is shared with M2, whose workers import this same sink.
  M2 changes how sends are scheduled and must not change what one send costs.
  Changing the distribution invalidates every committed comparison, so a run log has to make a changed distribution visible — which it does by measuring the sends rather than by repeating the settings.
  The three parameters are read by the process that sends, and in M1 that is the scheduler, not the harness that writes the log.
  A log that copied `PUSH_SIM_*` out of the harness's own environment would therefore state parameters no send was made with: a scheduler started with a wider delay would inflate the fan-out while the log still read 50 and 150.
  So the log records the module's pinned defaults, which are constants and not anyone's environment, beside the per-send cost the fan-out actually paid, taken from the `deliveries` rows the sender wrote.
- A real `expo-server-sdk` sink is out of scope until M5, which owns the one real-device send.
  Adding the dependency now would ship a package nothing exercises.

The seeded population carries no `expo_push_token`, because the seed writes none.
`send` therefore takes the column's value as it is, `null` included, and the simulated implementation ignores it — one more reason the only sink in M1 is a simulated one.

### The scheduler

`apps/api/src/scheduler/` runs as its own process (`bun run dev:scheduler`), never inside the API server process: the measurement is about what a fan-out does to an API that is serving requests at the same time, which is not observable when both share one process.

One tick:

1. selects `reminders` that are due and `pending` — `scheduled_at <= now` — ordered by `scheduled_at`, joined to `users` and restricted to rows carrying `users.seeded`;
2. sends each one through the push sink, one at a time;
3. writes one `deliveries` row per attempt and moves that reminder to `sent` or `failed`, in one transaction per attempt.

The seeded restriction is there for the reason `load/verify-peak.sql` has it: the scheduler in this milestone is a measurement instrument, and an application user's reminder is not part of a load experiment.
It is the same ownership fact and not a second predicate over addresses.

One transaction per attempt is not only the naive shape.
`deliveries.created_at` defaults to `now()`, which in Postgres is the **transaction** timestamp, so recording several attempts in one transaction would stamp them all identically and collapse the fan-out duration defined below to nothing.

The tick is a function over injected dependencies — the reminder repository operations and the sink — the same shape `createApp({ users, jwt })` uses, so its tests run without Postgres, a timer or the network.
The runner wires Drizzle and the simulated sink, ticks once immediately and then every `SCHEDULER_INTERVAL_MS` (default 60,000), and logs one line per tick: how many were due, how many sent, how many failed, and elapsed time.
A tick still in flight blocks the next, as "What M1 deliberately does not do" says: the runner skips the tick it cannot start rather than overlapping it, and logs that it skipped.

`SCHEDULER_NOW` is a measurement affordance and not a clock: it fixes the instant every tick treats as the current time.
The value must be a complete ISO 8601 instant carrying a time and an explicit UTC offset; the runner refuses a bare date or a time without an offset, because either would make the tick's `<= now` select a different set of reminders than the one meant.
It exists because the seed's target date is a fixed future date, so on the day a measurement runs nothing is due by the wall clock.
Unset — which is what any deployment leaves it — the tick reads the wall clock.

Graceful shutdown is M2's deliverable and M1 does not have it.
The measurement table's "jobs lost across worker restart" column measures exactly that difference, so adding it here would erase the comparison.

### What one measured run assumes

The measured window is one minute's worth of reminders.
A scheduler in a deployment would have been running all day, so by the time the peak instant arrives every earlier reminder of that date is already `sent`.
A run establishes that state rather than reproducing it: the harness marks the still-`pending` reminders scheduled before the peak instant as `sent`, in one statement over the seeded population, and records how many rows it touched.
Sending them would add some 36,000 simulated sends — about an hour — to every run and measure nothing that the peak minute does not already show.
Those reminders carry no `deliveries` row, which is how a row the experiment never sent is told apart from one it did.
No verification number moves, because `load/verify-peak.sql` reads `reminders.state` nowhere.

The run then asserts, in one query, that the reminders due and `pending` at the target instant are exactly `PEAK_USER_COUNT` and that all of them sit on that instant.
That single count is what proves the measured window is the peak alone; it refuses to run otherwise, so a database that has already been measured is re-seeded (`bun run db:seed`) rather than measured twice.

Three more refusals, all before anything is written:

- a `DATABASE_URL` or an API URL that is not on this machine, through the same loopback check the seed uses (`requireLoopbackDatabaseUrl`, and its host predicate for the API URL);
- a missing signing secret, which the harness needs because the API traffic has to be authenticated;
- another `bun run load:m1` still holding the same database.
  The harness takes a session-level advisory lock (`pg_try_advisory_lock`) on a connection reserved for it alone, before its first read, and keeps it until its pool is deleted, so a second run refuses instead of sharing the fan-out.
  The due-and-pending count above is not that guard: it stays at `PEAK_USER_COUNT` until the scheduler's first delivery, which is exactly the stretch in which a second run would otherwise pass every check, sweep the first run's pool and double its request rate.
  The lock goes with the connection, so a run that is killed outright leaves nothing to clear by hand.

The API traffic cannot use seeded addresses: `POST /auth/session` answers 409 and `GET /me` answers 404 for a row carrying `users.seeded` (see "Authentication").
So the harness creates its own small pool of ordinary users, marked `users.load_pool` and reached with locally minted tokens, as "The load harness owns its API pool the same way" describes.
The seed will not clean them up, because they are not its rows.

The pool is deleted however the run ends, not only when it succeeds: the delete sits in a `finally`, so a refusal in the middle of a measured window takes its rows with it.
A run that is killed outright still leaves them, which is what the sweep before the pool is created is for — those rows carry the flag, so the next run removes them and says how many it found.
A cleanup that fails is reported and does not replace the error that reached the `finally`, because the refusal is the more useful of the two.

### What the M1 measurements cover

Every M1 number comes from one run on one machine: Postgres in docker compose, the API, the scheduler and the load generator all on the same Mac, against the simulated sink.
A number here is a comparison point for M2 and M3 measured the same way, and nothing else.

Not measured, and not to be read out of these numbers: a real push provider's latency, rate limits and partial failures; network latency or loss between separate hosts; a database on its own hardware; more than one API process; cold start; and anything about a deployed environment.
The API side is deliberately small too — the load generator holds a fixed, low request rate against a 200-user pool — because the question is what the fan-out does to the API's latency, not how many clients the API can hold.

### Metric definitions and their sources

`bun run load:m1` (`apps/api/src/load/`) drives one measured run end to end and writes one `load/results/<ISO instant>-m1-naive.json`.
Every cell of `README.md`'s measurement table is copied from a field of such a file, which is AGENTS.md gate rule 4.

- **Fan-out duration** — wall time from the first send of the target minute to the last.
  The scheduler is the measurer: the figure is `max(created_at) - min(created_at - latency_ms)` over the `deliveries` rows for the target instant whose reminder belongs to a seeded user — the same `users.seeded` restriction the scheduler selects by — all of which the scheduler wrote.
  The harness copies those two timestamps and does not re-time the fan-out from outside.
- **API p95** — the harness's own `GET /me` responses, over the samples whose request started inside the fan-out window.
  The window used for that slice is the one the harness observed — from the poll that first saw a delivery for the target instant to the poll that saw the last seeded reminder leave `pending` (the same `users.seeded` restriction the scheduler selects by, so a reminder it would never send cannot hold the window open) — and not the `deliveries` timestamps above, because the request timestamps are the harness's clock and the `deliveries` timestamps are the database's.
  Both boundaries are in the run log, and so are p50, p99, the in-window sample count, the total sample count and the error count.
- **Primary transactions per second** — `xact_commit + xact_rollback` from `pg_stat_database` for the application database, sampled once when the fan-out is first observed and once when it ends, divided by the seconds between those two samples.
  Both raw samples and their timestamps go into the run log.
  Stock Postgres 16 counts transactions and not statements, and `pg_stat_statements` is deliberately not installed, which is why the table's column is transactions per second: a column named for a number this repository cannot measure would have to be filled with an invented one.
- **Peak connection usage** — the highest `pg_stat_activity` row count for the application database seen while polling the window, against `max_connections`.
  The harness's own connections are in that count, because the figure is the whole local stack's usage.
- **What one send cost** — the smallest, largest and mean `deliveries.latency_ms` over the target instant's rows, which the sink itself measured and the scheduler wrote down.
  This is the sink's distribution as the run actually paid it, and it is in the log beside the module's pinned parameters because the harness cannot read the environment of the process that sent (see "The push sink").

The run log also carries a verdict: the targets the run was checked against, what it actually measured, and whether each held.
The harness exits non-zero when one does not, so a run log is a gate and not only a record.
M1's targets are that every peak reminder reached a terminal state, that one `deliveries` row exists per peak reminder, that no API request failed during the window, that the mean send cost the pinned distribution's mean, that the smallest and largest send costs landed at the pinned bounds, and that no send failed.
There is deliberately no target on the fan-out duration: M1's slowness is the result.

Two targets grade the send cost, because neither alone can tell the pinned distribution from every other one.

The mean is graded within 5 ms of the pinned midpoint.
The mean is the figure the fan-out duration scales with, and a change to one bound moves it: uniform over 50..150 ms has a standard deviation of about 28.9 ms, so over the peak's 8,000 sends the mean's own standard error is about 0.32 ms, and a 5 ms tolerance is some fifteen of those.
The tolerance also has to hold the timer's overshoot, because the sink measures the wait rather than reporting the draw: every send costs its draw plus however late the timer fires, which is a bias in one direction and not noise, on the order of a millisecond or two per send while M1 sends sequentially.
A measured mean that sits above 100 ms by that much is the expected shape of a passing run, not a drifted sink.

The mean cannot see a change to both bounds at once: 0..200 and 60..140 share the 100 ms midpoint with 50..150 and are different experiments, one of them the direction that would flatter M1 against M2.
So the smallest and largest measured send costs are graded too, and asymmetrically, because they fail asymmetrically.
A timer never fires early, so the smallest cost never sits below the pinned minimum, and over 8,000 draws it sits within a hundredth of a millisecond above it plus timer overhead; it is graded within 2 ms above the minimum, which is room for the machine and none for a different distribution.
The largest cost sits above the pinned maximum by however late the timer fired, which depends on load, so it is graded on one side only: it must reach the pinned maximum.
A wider or shifted distribution fails on the minimum, a narrower one fails on the maximum as well, and the committed run's 51..153 ms passes both.

A target is a gate only if a written run log can disagree with it, and that decides where each condition lives.
Both fan-out targets are reachable through one outcome: a fan-out that stops making progress is measured to where it got, written down with the reminders that never left `pending` and the attempts never recorded for them, and reported as a missed run rather than thrown away.
Two other conditions are refused earlier instead, before any log exists, because they are preconditions of a measured run and not results of one — nothing delivered for the target instant at all, which means the scheduler was never started, and no API request inside the window, because a p95 over no samples is not a measurement.
So the third check grades the error count alone, and reports the in-window request count beside it.
The two send-cost checks are reachable by a run that completes normally: a scheduler started with other `PUSH_SIM_*` values, or with a failure rate above 0, delivers every reminder and still writes a log the checks read false off — which is the only way the log can say that a completed run measured a different experiment.

Provenance is `base_commit` and `worktree_dirty`, deliberately not "the commit that produced this run".
A measured run has to happen before the commit that carries its log, which is what keeping the run and its `load/results/*.json` in one pull request requires, so at the moment of measurement no commit contains the code being measured.
Those two fields state exactly that much; the harness's own stdout, pasted into the pull request body, is what ties the numbers to the diff.
The harness reads both when the run starts, at the same instant as `started_at` and before the window, so a commit or a hook's restage made during the quarter-hour fan-out cannot change what they name.
