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
jobs         id, kind, payload jsonb, run_at, locked_at?, locked_by?, attempts, last_error?, dead_at?, done_at?
deliveries   id, reminder_id, status, latency_ms, error?, sender jsonb?, created_at
```

- `deliveries.sender` is the record of who sent the row and with what: `{"kind": "naive" | "worker", "sink": {"kind": "simulated", "min_latency_ms": …, "max_latency_ms": …, "failure_rate": …}}`, written by the naive scheduler and by the worker on every row either inserts, from the `SimulatedSinkConfig` that process read at start.
  It is a column on the row and not a table of sender runs, because the run log's verdict reads it over exactly the rows every other fan-out figure is read from — the peak instant, `users.seeded`, `created_at` inside the window — and a separate table would have to be matched to deliveries by time overlap, which is a predicate over values ("The seed owns its rows by a recorded flag, not by their address"); such rows would also sit outside every cascade the seed relies on to delete only its own rows.
  It is nullable so that its migration applies to a database already holding `deliveries` rows from an earlier run, and it has no default because a default is a value no sender wrote: a `NULL` is a send whose sender recorded nothing, and the verdict reads it as not the pinned experiment ("Metric definitions and their sources").
  The TypeScript shape lives beside the code that writes it (`apps/api/src/push/sender.ts`), not in the schema, as `jobs.payload`'s does.
- `jobs` has a partial index on `(run_at) WHERE done_at IS NULL`.
- `run_at` is the instant a job may next be attempted, not the reminder's `scheduled_at`: the enqueue tick sets it to the enqueue instant, `now()`, and a retry sets it to `now()` plus its backoff ("Retry, backoff, dead-letter" below).
  A worker therefore compares `run_at` to the wall clock and needs no `SCHEDULER_NOW`, even though a measured run's reminders sit on a future `scheduled_at`.
- `attempts` counts failed sends, starts at 0, and `last_error` keeps the most recent failure's text.
  `dead_at` is set when the ceiling is reached; a dead-lettered job is a done job with `dead_at` set, and that one column tells the two apart.
- Every `jobs` timestamp is written by the database's `now()` and compared to it, so N workers on N clocks agree on what is due.
- Workers claim a batch with one statement, which also reclaims a row whose lock is older than the lease ("Graceful shutdown and the lease" below):

  ```sql
  WITH claimed AS MATERIALIZED (
    SELECT id FROM jobs
    WHERE run_at <= now() AND done_at IS NULL
      AND (locked_at IS NULL OR locked_at < now() - $lease)
    ORDER BY run_at, id LIMIT $n
    FOR UPDATE SKIP LOCKED
  )
  UPDATE jobs SET locked_at = now(), locked_by = $worker
  FROM claimed WHERE jobs.id = claimed.id AND jobs.done_at IS NULL
  RETURNING jobs.*;
  ```

  The selection is a `MATERIALIZED` common table expression and not a `WHERE id IN (SELECT … LIMIT $n …)` subquery, because the subquery form does not honour its `LIMIT` on this table.
  PostgreSQL 16 plans `IN (subquery)` as a nested-loop semi-join that re-runs the subquery for every candidate row, and the enqueue tick gives every job of one peak the same `run_at`, so each re-run breaks the `ORDER BY` tie differently and, run by run, offers every row: measured on the compose Postgres, `LIMIT 2` over five tied rows updated all five, which in a measured run is one worker claiming the whole peak.
  The CTE is evaluated once, so the batch is `$n` rows, and `id` is the tiebreaker so two claims on tied rows see one order.
  PostgreSQL already refuses to inline a `FOR UPDATE` CTE; `MATERIALIZED` states that rather than relying on it.

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

`pending` on insert, `queued` once its job exists, then `sent` or `failed`.
`queued` arrived with M2: the enqueue tick moves a reminder `pending → queued` in the statement that inserts its job, and a worker moves it `queued → sent | failed` when it records the outcome ("Queue and workers (M2)" below).
The naive send never writes `queued`: it moves a reminder from `pending` straight to a terminal state, and `SCHEDULER_MODE=naive` still does.
One row per user per scheduled instant, enforced by a unique constraint on `(user_id, scheduled_at)`; with one materialization run per date, that is one row per user per date.
The scheduler's only query is due and pending ordered by `scheduled_at`, served by a partial index on `(scheduled_at) WHERE state = 'pending'` — the same shape as the `jobs` index above.
The index's predicate stays `pending` in M2, because a `queued` reminder is one the scheduler must never select again; the state machine is visible in the table, and the selection needs no second predicate to skip what has been enqueued.

### `deliveries`

One row per send attempt: the `reminders` row it belongs to, a status of `sent` or `failed`, `latency_ms` measured at the push sink, and `error`, which is null unless the status is `failed`.
No constraint enforces that last clause.
It had one writer in M1, the naive send, and has two since M2 — the worker writes a row for every attempt it makes, retries and dead-letters included — and both write `error` only on a `failed` row.
One reminder can carry more than one row: a retried send leaves a `failed` row per attempt, and a lease reclaim can leave two `sent` rows ("Graceful shutdown and the lease").

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
  Changing the distribution invalidates every committed comparison, so a run log has to make a changed distribution visible — which it does by measuring the sends rather than by repeating the settings, and, since M2, by reading the settings the sender itself recorded beside them.
  The three parameters are read by the process that sends — the scheduler under `SCHEDULER_MODE=naive`, the workers otherwise — and never by the harness that writes the log.
  A log that copied `PUSH_SIM_*` out of the harness's own environment would therefore state parameters no send was made with: a scheduler started with a wider delay would inflate the fan-out while the log still read 50 and 150.
  So the log records the module's pinned defaults, which are constants and not anyone's environment, beside the per-send cost the fan-out actually paid, taken from the `deliveries` rows the sender wrote.
  Measurement alone cannot close the class, though ([#25](https://github.com/AndrewDongminYoo/peak-fanout/issues/25)): the tolerance on the smallest send cost has to be at least the timer's overshoot or every honest run fails, and any tolerance that large admits a sender shifted by less than it — 51..149 lands inside every bound 50..150 is graded on, and no third tolerance on measured extrema would tell the two apart.
  A record can.
  The sender writes the settings it read into `deliveries.sender` on every row it inserts ("Data model"), and the verdict grades that record against the module's pinned constants beside the measured costs, which stay: a modified sink module started at its defaults writes a record that matches and is caught only by the measurement, and a shifted `PUSH_SIM_*` environment pays a cost the tolerances admit and is caught only by the record.
  The harness's own environment is still never the source; the record is the sender's, written in the transaction that records that send's outcome, sent or failed.
- A real `expo-server-sdk` sink is out of scope until M5, which owns the one real-device send.
  Adding the dependency now would ship a package nothing exercises.

The seeded population carries no `expo_push_token`, because the seed writes none.
`send` therefore takes the column's value as it is, `null` included, and the simulated implementation ignores it — one more reason the only sink in M1 is a simulated one.

### The scheduler

`apps/api/src/scheduler/` runs as its own process (`bun run dev:scheduler`), never inside the API server process: the measurement is about what a fan-out does to an API that is serving requests at the same time, which is not observable when both share one process.

`SCHEDULER_MODE` picks what a tick does.
`enqueue`, the default since M2, runs the enqueue tick described under "Queue and workers (M2)": it inserts one `jobs` row per due reminder and sends nothing.
`naive` runs the tick described in the rest of this section, unchanged from M1.
It is kept as a measurement affordance and not as a fallback: the M1 row has to stay reproducible under later schema versions, and it can only be reproduced by the code that produced it.
Any other value is refused at start, the way an invalid `SCHEDULER_NOW` is.
`SCHEDULER_INTERVAL_MS`, `SCHEDULER_NOW`, the non-overlap guard and the one-line-per-tick log apply to both modes; the process logs its mode once at start.

One naive tick:

1. selects `reminders` that are due and `pending` — `scheduled_at <= now` — ordered by `scheduled_at`, joined to `users` and restricted to rows carrying `users.seeded`;
2. sends each one through the push sink, one at a time;
3. writes one `deliveries` row per attempt, carrying `sender` with `kind = 'naive'` and the sink settings this process read ("Data model"), and moves that reminder to `sent` or `failed`, in one transaction per attempt.

The seeded restriction is there for the reason `load/verify-peak.sql` has it: the scheduler in this milestone is a measurement instrument, and an application user's reminder is not part of a load experiment.
It is the same ownership fact and not a second predicate over addresses.

One transaction per attempt is not only the naive shape.
`deliveries.created_at` defaults to `now()`, which in Postgres is the **transaction** timestamp, so recording several attempts in one transaction would stamp them all identically and collapse the fan-out duration defined below to nothing.

The tick is a function over injected dependencies — the reminder repository operations and the sink — the same shape `createApp({ users, jwt })` uses, so its tests run without Postgres, a timer or the network.
The runner wires Drizzle and the simulated sink, ticks once immediately and then every `SCHEDULER_INTERVAL_MS` (default 60,000), and logs one line per tick: how many were due, how many sent, how many failed, and elapsed time.
A tick still in flight blocks the next, as "What M1 deliberately does not do" says: the runner skips the tick it cannot start rather than overlapping it, and logs that it skipped.

`SCHEDULER_NOW` is a measurement affordance and not a clock: it fixes the instant every tick treats as the current time.
The value must be a complete ISO 8601 instant carrying a time and an explicit UTC offset; the runner refuses a bare date or a time without an offset, because either would make the tick's `<= now` select a different set of reminders than the one meant.
It also refuses a value whose calendar components do not name a real instant — a 30 February, a 24th hour — because the runtime's `Date` normalizes such a value to the following day rather than rejecting it, and the tick would then select against an instant nobody wrote.
It exists because the seed's target date is a fixed future date, so on the day a measurement runs nothing is due by the wall clock.
Unset — which is what any deployment leaves it — the tick reads the wall clock.

Graceful shutdown is the worker's deliverable and the naive send does not have it, in M2 either.
The measurement table's "jobs lost across worker restart" column measures exactly that difference, so adding it to the naive send would erase the comparison.
The enqueue tick needs none: it is one statement, so a tick killed mid-flight rolls back and the next tick enqueues the same reminders.

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
- another harness run, in either mode, still holding the same database.
  The harness takes a session-level advisory lock (`pg_try_advisory_lock`) on a connection reserved for it alone, before its first read, and keeps it until its pool is deleted, so a second run refuses instead of sharing the fan-out.
  The due-and-pending count above is not that guard: it stays at `PEAK_USER_COUNT` until the scheduler's first delivery, which is exactly the stretch in which a second run would otherwise pass every check, sweep the first run's pool and double its request rate.
  The lock goes with the connection, so a run that is killed outright leaves nothing to clear by hand.
  Every sweep of the pool is one statement on the reserved connection whose delete predicate is the lock question itself (`pg_locks` for `pg_backend_pid()`), so a backend that does not hold the lock deletes nothing.
  Neither half is enough alone: asking whether the connection still answers is not asking whether the lock is held, because the driver reconnects a dropped connection object to serve ordinary queries and the reserved handle then answers from a backend that never took the lock; and asking first and deleting second leaves a gap between the two in which the connection can drop, another run take the lock and create its pool, and the delete sweep it.

The API traffic cannot use seeded addresses: `POST /auth/session` answers 409 and `GET /me` answers 404 for a row carrying `users.seeded` (see "Authentication").
So the harness creates its own small pool of ordinary users, marked `users.load_pool` and reached with locally minted tokens, as "The load harness owns its API pool the same way" describes.
The seed will not clean them up, because they are not its rows.

The pool is deleted however the run ends, not only when it succeeds: the delete sits in a `finally`, so a refusal in the middle of a measured window takes its rows with it.
A run that is killed outright still leaves them, which is what the sweep before the pool is created is for — those rows carry the flag, so the next run removes them and says how many it found.
A cleanup that fails is reported and does not replace the error that reached the `finally`, because the refusal is the more useful of the two.
When nothing else failed, the cleanup failure is the run's error: the log has already been written and stands, but the harness exits non-zero, because a run that reports success while its rows are still in the database being measured is not the outcome it documents.

### What the M1 measurements cover

Every M1 number comes from one run on one machine: Postgres in docker compose, the API, the scheduler and the load generator all on the same Mac, against the simulated sink.
A number here is a comparison point for M2 and M3 measured the same way, and nothing else.

Not measured, and not to be read out of these numbers: a real push provider's latency, rate limits and partial failures; network latency or loss between separate hosts; a database on its own hardware; more than one API process; cold start; and anything about a deployed environment.
The API side is deliberately small too — the load generator holds a fixed, low request rate against a 200-user pool — because the question is what the fan-out does to the API's latency, not how many clients the API can hold.

### Metric definitions and their sources

`apps/api/src/load/m1.ts` drives one measured run end to end and writes one run log.
The file keeps the name of the milestone that introduced it and runs both milestones: `LOAD_MODE=naive` measures the M1 sender — the scheduler under `SCHEDULER_MODE=naive` — and `LOAD_MODE=queue` measures the enqueue tick plus N workers; `bun run load:m1`, `bun run load:m2` and `bun run load:m2:restart` set the mode, and the third also sets `LOAD_WORKER_RESTART=1`, which turns a queue run into the restart run defined below and is refused in naive mode.
The harness prints the scheduler line with the matching `SCHEDULER_MODE` and, in queue mode, the worker line before it, because workers start first so the enqueue tick's jobs meet a fleet.
The log records `mode`, and its file is `load/results/<ISO instant>-m1-naive.json`, `-m2-queue.json` or `-m2-queue-restart.json`.
Every cell of `README.md`'s measurement table is copied from a field of such a file, which is AGENTS.md gate rule 4.

- **Fan-out duration** — wall time from the first send of the target minute to the last.
  The sender is the measurer: the figure is `max(created_at) - min(created_at - latency_ms)` over the `deliveries` rows for the target instant whose reminder belongs to a seeded user — the same `users.seeded` restriction the scheduler selects by — all of which the sender wrote, the naive scheduler in one mode and the workers in the other.
  The harness copies those two timestamps and does not re-time the fan-out from outside.
  The window it observes ends when every peak reminder is in a terminal state, `sent` or `failed`; `pending` holds it open, and so does `queued`, which in queue mode is a reminder whose job exists and has not been finished — a reminder handed to the queue is not a reminder delivered.
- **API p95** — the harness's own `GET /me` responses, over the samples whose request started inside the fan-out window.
  The window used for that slice is the one the harness observed — from the poll that first saw a delivery for the target instant to the poll that saw the last seeded reminder leave `pending` and `queued` (the same `users.seeded` restriction the scheduler selects by, so a reminder it would never send cannot hold the window open) — and not the `deliveries` timestamps above, because the request timestamps are the harness's clock and the `deliveries` timestamps are the database's.
  Both boundaries are in the run log, and so are p50, p99, the in-window sample count, the total sample count and the error count.
  The two milestone rows are the same instrument at different sample sizes: the generator holds the same fixed rate in both, so M2's window of some twenty seconds yields a few hundred in-window samples where M1's 866 s yielded sixteen thousand.
  Both counts are in the log beside the percentile, and a reader comparing the cells reads them together.
- **Primary transactions per second** — `xact_commit + xact_rollback` from `pg_stat_database` for the application database, sampled once when the fan-out is first observed and once when it ends, divided by the seconds between those two samples.
  Both raw samples and their timestamps go into the run log.
  Stock Postgres 16 counts transactions and not statements, and `pg_stat_statements` is deliberately not installed, which is why the table's column is transactions per second: a column named for a number this repository cannot measure would have to be filled with an invented one.
- **Peak connection usage** — the highest `pg_stat_activity` row count for the application database seen while polling the window, against `max_connections`.
  The poll that first observes a delivery is the window's opening reading and counts; the peak is never lower than a value the harness read inside the window.
  The harness's own connections are in that count, because the figure is the whole local stack's usage.
- **What one send cost** — the smallest, largest and mean `deliveries.latency_ms` over the target instant's rows, which the sink itself measured and the sender wrote down.
  This is the sink's distribution as the run actually paid it, and it is in the log beside the module's pinned parameters because the harness cannot read the environment of the process that sent (see "The push sink").
- **Offered rate** ([#26](https://github.com/AndrewDongminYoo/peak-fanout/issues/26)) — the in-window request count against what the generator was set to offer over the observed window: `requests_in_window` against `requests_per_second_target × window seconds`, where the window is the observed one above, on the harness's clock.
  The generator offers less than its setting in two ways, and neither is a verdict miss on its own: it skips a beat rather than piling up once fifty requests are in flight, which it counts as `requests_skipped_for_backpressure`, and its interval timer fires late on a loaded machine and does not replay the beats it missed, which no counter sees.
  The count is graded and not the skip counter, because the count is what the API actually received and covers both.
  The tolerance is 5% of the target over the observed window, one form for every window length: the check holds when `requests_in_window >= 0.95 × requests_per_second_target × window seconds`.
  The M1 baseline was 3% short at a load average near 15, and on a quiet machine the timer's lag is smaller; the generator starts before the window opens, so there is no ramp inside it, and the window's bounds are poll instants against a 50 ms request interval, so the boundary error is at most one request each side.
  The arithmetic for both windows: 866.8 s at 20 a second is 17,336 expected, and the 16,777 of the 2026-09-12 schema-4 M1 log the tolerance was calibrated on is 96.8% of it, which holds; an M2 window of 15–20 s is 300–400 expected, where 5% is 15–20 requests of room, more than the boundary error and less than a generator that backed off.
  An absolute floor was rejected as a second rule for a case that does not arise at these window lengths.
- **The sender record** ([#25](https://github.com/AndrewDongminYoo/peak-fanout/issues/25)) — the distinct `deliveries.sender` values over the same rows every other fan-out figure is read from: the peak instant, `users.seeded`, `created_at` inside the window.
  The verdict grades that set against exactly one expected record, built from the sink module's pinned constants and the mode's sender kind: `{"kind": "naive", "sink": {"kind": "simulated", "min_latency_ms": 50, "max_latency_ms": 150, "failure_rate": 0}}` in naive mode and the same record with `"kind": "worker"` in queue mode.
  The check holds when every peak delivery carries a record and the set of distinct records is that one record.
  A `NULL` is a miss, because it is a send whose sender recorded nothing; a second distinct record is a miss, because two senders with different settings sent one fan-out; the other mode's kind is a miss, because the row was then produced by the sender the mode does not measure.
  The case this closes is the issue's own: `PUSH_SIM_LATENCY_MIN_MS=51 PUSH_SIM_LATENCY_MAX_MS=149` pays a cost inside every tolerance the measured extrema are graded on and writes a record of 51 and 149, which is not the pinned one.
  The comparison is structural — the record is read back from `jsonb`, whose text orders keys its own way — and the expected side is never taken from the harness's environment, for the reason "The push sink" gives.
- **Workers observed** and **largest claim observed** — queue mode only, both read at window close, both recorded as observed and never declared to the harness.
  Workers observed is the count of distinct `jobs.locked_by` values over the peak's jobs, recorded beside the list of ids; the peak's jobs are found through `(payload->>'reminder_id')::uuid` joined to the seeded reminders on the peak instant, because the payload value is text and `reminders.id` is uuid.
  The largest claim observed is the most jobs sharing one `(locked_by, locked_at)` pair over those rows, which is one claim statement's transaction timestamp and so one batch; it is how the log states the batch size a run actually ran at.
  A killed worker's id can vanish from `locked_by`, because every row it held is re-stamped by the reclaim, so the restart block below records the killed id itself.
- **Duplicate attempts** — `count(*) − count(DISTINCT reminder_id)` over the window's peak deliveries, recorded in queue mode beside the attempts check.
  The check itself is per mode: the naive sender records exactly one attempt per reminder, as M1's contract says, so in naive mode the check is `attempts = reminders`; the queue is at-least-once, a lease reclaim may send a reminder twice and both rows are true ("Graceful shutdown and the lease"), so in queue mode the check is `attempts >= reminders` and the duplicate count says how far above.
  The failed-sends check stays at 0 failed in both modes: `SIGKILL` is a send that was never recorded, not a send that failed.
- **Jobs lost across worker restart** — the fourth column, measured by a restart run and defined as the peak reminders that reached no terminal state by window close, plus the jobs the killed worker held at the kill that were still open at window close.
  A job reclaimed by lease and finished by another worker is delayed, not lost, and is counted by neither term.
  The second term is contained in the first — a job of a peak reminder that is open at close is a reminder still `queued`, because a job is finished in the transaction that moves its reminder — so the number is the first count, and the restart block reports the second beside it so a reader can see whether what was lost was the killed worker's batch.
  Its condition therefore coincides with the terminal-state check's, and it is a separate check all the same: it is the fourth column's own name, it is absent from a timing run, and it carries what the first does not — how many jobs the killed worker held and the three fates they met.
  The procedure: in a restart run the harness waits for the first poll at or past one quarter of the peak's reminders attempted, then, polling at 50 ms for at most five seconds, picks the worker holding the most open claims at that instant — a kill between batches would strand nothing and measure nothing, which is why a reading with no open claim is waited out rather than acted on — and requires two things of it before it sends anything: that its `locked_by` host is this machine's hostname, and that the process at that pid is a worker, which `ps -p <pid> -o command=` shows as a `bun` command line whose script is `src/worker/index.ts` or whose `run` target is the `worker` script — the executable and its argument, never a substring of the line, because an editor open on that file names it too and is not a worker.
  Either failing refuses the run rather than killing anything else, because a pid read from a table can have been reused by an unrelated process on a machine where other work runs in parallel.
  Then it reads the claims once more, because the process read spawned `ps` and waited for it, and a batch at 50–150 ms per send can finish inside that wait: the record is that last reading, taken with nothing but the signal left between it and the kill, and a chosen worker that holds nothing any more is a between-batches instant like any other, waited out.
  Then it sends `SIGKILL` to that pid and records the worker's id, the harness-clock instant, the attempts at that instant, and how many jobs it held; their ids stay in memory for the close read and are not logged.
  `SIGKILL` and not `SIGTERM`, because the drain makes "0 lost" true by construction and the gate could then catch only a broken drain; the lease is the harder property ("nothing was ever only in the worker's memory"), and only a kill without a drain exercises it.
  At window close the harness reads those jobs' fate: finished by another worker, which is the reclaim, and the instant of the earliest re-stamp is `first_reclaim_at`; finished by the killed worker, which it recorded between the pick and the kill; or still open.
  Two outcomes are refused rather than logged, because a log named `-restart` would fill the fourth cell with a run that never exercised the lease: a run that killed nothing, because the fan-out ended before a quarter of the peak was attempted, and a run whose kill stranded nothing — every held job finished by the killed worker itself, none reclaimed and none still open — because the batch finished in the gap that remained before the signal, and its 0 lost would then be true by construction, which is the `SIGTERM` outcome by another route.
  A held job still open at close is stranded, so that run is logged and its ninth check misses, which is what the check is for.
  Nobody starts a replacement: from the queue's side a restart is a process that is gone with its batch while the fleet goes on, and a replacement would change the fleet's size and nothing the column measures.
  The restart run's own duration includes one lease wait and is not a headline cell, which is why the M2 row is filled from two runs (below).
  The harness's `LOAD_STALL_TIMEOUT_MS` (default 120,000) has to exceed `WORKER_LEASE_MS` (default 30,000), or the reclaim looks like a stall; the harness refuses a restart run whose stall timeout does not exceed the pinned default lease, and the workers are run at that default.

The run log also carries a verdict: the targets the run was checked against, what it actually measured, and whether each held.
The harness exits non-zero when one does not, so a run log is a gate and not only a record.
At schema 5 a timing run is graded on eight checks: every peak reminder reached a terminal state (`pending + queued = 0`); the attempts check per mode, above; no API request failed during the window; the mean send cost the pinned distribution's mean; the smallest and largest send costs landed at the pinned bounds; no send failed; the generator offered its rate; and every peak delivery carries the one expected sender record.
A restart run is graded on a ninth: jobs lost across the restart is 0.
There is deliberately no target on the fan-out duration: M1's slowness is the result, and M2's speed is the comparison.

Two targets grade the send cost, because neither alone can tell the pinned distribution from every other one, and the sender record is the third because measurement alone cannot close the class.

The mean is graded within 5 ms of the pinned midpoint.
The mean is the figure the fan-out duration scales with, and a change to one bound moves it: uniform over 50..150 ms has a standard deviation of about 28.9 ms, so over the peak's 8,000 sends the mean's own standard error is about 0.32 ms, and a 5 ms tolerance is some fifteen of those.
The tolerance also has to hold the timer's overshoot, because the sink measures the wait rather than reporting the draw: every send costs its draw plus however late the timer fires, which is a bias in one direction and not noise, on the order of a millisecond or two per send while M1 sends sequentially.
A measured mean that sits above 100 ms by that much is the expected shape of a passing run, not a drifted sink.
The tolerances are shared between the modes on measured evidence rather than split per mode: probed on this machine before M2's measurement (load average 2.6, `createSimulatedPushSink()` at its defaults, no database), 25 concurrent sends × 120 batches gave min 51 / mean 100.77 / p99 149 / max 151 ms over 3,000 sends, and 100 concurrent × 40 batches gave min 51 / mean 100.5 / max 150 over 4,000, both inside the tolerances with the same margin M1 had, so a worker's concurrent timers do not break what "while M1 sends sequentially" derived.

The mean cannot see a change to both bounds at once: 0..200 and 60..140 share the 100 ms midpoint with 50..150 and are different experiments, one of them the direction that would flatter M1 against M2.
So the smallest and largest measured send costs are graded too, and asymmetrically, because they fail asymmetrically.
A timer never fires early, so the smallest cost never sits below the pinned minimum, and over 8,000 draws it sits within a hundredth of a millisecond above it plus timer overhead; it is graded within 2 ms above the minimum, which is room for the machine and none for a different distribution.
The largest cost sits above the pinned maximum by however late the timer fired, which depends on load, so it is graded on one side only: it must reach the pinned maximum.
A wider or shifted distribution fails on the minimum, a narrower one fails on the maximum as well, and the 51..153 ms of the 2026-09-12 schema-4 M1 log these bounds were calibrated on passes both.

A target is a gate only if a written run log can disagree with it, and that decides where each condition lives.
Both fan-out targets are reachable through one outcome: a fan-out that stops making progress is measured to where it got, written down with the reminders that never left `pending` or `queued` and the attempts never recorded for them, and reported as a missed run rather than thrown away.
Two other conditions are refused earlier instead, before any log exists, because they are preconditions of a measured run and not results of one — nothing delivered for the target instant at all, which means the sender was never started, and no API request inside the window, because a p95 over no samples is not a measurement.
So the third check grades the error count alone, and reports the in-window request count beside it.
The two send-cost checks are reachable by a run that completes normally: a sender started with other `PUSH_SIM_*` values, or with a failure rate above 0, delivers every reminder and still writes a log the checks read false off — which is the only way the log can say that a completed run measured a different experiment.
The offered-rate check is reachable by a run on a loaded machine, whose timer lag or backpressure leaves the count short while every other check holds.
The sender check is reachable by a scheduler or a worker started with other `PUSH_SIM_*` values, whose record then differs from the pinned one however small the shift, and by the wrong `SCHEDULER_MODE` — a naive scheduler under a queue run writes `naive` records, delivers everything, and the log says which sender it measured.
The restart check is reachable by a window that closes on jobs still locked: the harness refuses a stall timeout at or below the pinned default lease, but the workers read `WORKER_LEASE_MS` in their own processes, where the harness cannot see it, so a fleet started with a lease longer than the stall timeout — or one whose remaining workers die with the killed one — closes the window while the killed worker's jobs are still locked, and the log records them as still open.

One log per experiment.
A milestone row cites the logs it is filled from, and the M2 row cites two: a timing run — N workers, nothing killed — fills its first three cells, and a restart run — the same setup, plus the kill above — fills the fourth.
The reason is arithmetic: a batch of 25 concurrent sends over 50–150 ms settles in about 150–160 ms, 8,000 reminders are 320 batches, four workers take about 80 each, so the whole M2 fan-out is roughly 13–20 seconds, while `WORKER_LEASE_MS` defaults to 30,000; a killed worker's batch stays locked for the full lease, and in a single run that wait would be most of the first cell, which would then measure the lease and not the queue.
A log superseded by a re-measurement under a newer schema is not kept: the committed log is what the current writer wrote, unedited, or the row is not reproducible from it.

Provenance is `base_commit` and `worktree_dirty`, deliberately not "the commit that produced this run".
A measured run has to happen before the commit that carries its log, which is what keeping the run and its `load/results/*.json` in one pull request requires, so at the moment of measurement no commit contains the code being measured.
Those two fields state exactly that much; the harness's own stdout, pasted into the pull request body, is what ties the numbers to the diff.
The harness reads both when the run starts, at the same instant as `started_at` and before the window, so a commit or a hook's restage made during the quarter-hour fan-out cannot change what they name.

## Queue and workers (M2)

The queue is Postgres alone: one `jobs` table, one claim statement with `FOR UPDATE SKIP LOCKED`, and no library — explaining a queue with nothing but the database is the point of the milestone, and `README.md`'s "Next" names pg-boss as the documented replacement rather than a dependency.
The `## Data model` block above owns the columns, the index and the claim statement; this section owns what the two processes do with them.
The push sink is imported unchanged from `apps/api/src/push/simulated.ts`: M2 changes how sends are scheduled and not what one send costs, or the M1 and M2 rows stop being comparable ("The push sink").

### The enqueue tick

`SCHEDULER_MODE=enqueue`, the default.
One tick selects the reminders that are due and `pending` — the same query the naive tick runs: `scheduled_at <= now` ordered by `scheduled_at`, joined to `users` and restricted to rows carrying `users.seeded`, for the reason "The scheduler" gives — and hands their ids to one statement.
That statement moves those reminders `pending → queued` and inserts one `jobs` row per reminder it moved: `kind = 'send_reminder'`, `payload = { "reminder_id": … }`, `run_at = now()`, `attempts = 0`.
The insert reads the update's `RETURNING` rows rather than evaluating the predicate a second time, so the two halves cannot disagree about which rows they touched, and one statement is one transaction, so a reminder is `queued` exactly when its job exists.
The update carries `state = 'pending'`, which is what makes "nothing is enqueued twice" a property of the statement and not of the process around it: a reminder another writer moved between the select and the statement is skipped, and the tick reports how many were due beside how many it enqueued.
A tick that finds nothing due writes nothing.
The tick sends nothing, so the peak minute enqueues in well under a second and the non-overlap guard, which still wraps it, rarely fires.

`queued` is also why there is no unique index on the job.
A unique index on `payload->>'reminder_id'` would ask the database to reject a second job after it was attempted; the state records, on the reminder itself, that a job exists, and the selection `WHERE state = 'pending'` never offers that reminder again.
The fact is recorded on the row where it is decided, which is the rule `users.seeded` follows.

`jobs` names its reminder in `payload` and not in a foreign key, so a reminder's deletion does not remove its jobs.
The seed is the only thing that deletes reminders, and it removes every job of the reminders it removes — done and dead-lettered ones included, not only the open ones — in the same transaction; the rows it owns include the jobs its reminders produced, and a finished job whose reminder is gone is orphan history rather than anything worth keeping.
The order inside that transaction is what makes "every job" hold against an enqueue tick running at the same time: the seed deletes its users first, whose cascade removes its reminders, and then, in a second statement, every job that names a reminder which no longer exists.
A job only ever names a seeded reminder, because the enqueue tick selects rows carrying `users.seeded` and nothing else writes `jobs`, and only the seed deletes seeded rows, so after the cascade that set is exactly the jobs of the reminders the seed removed, and the predicate reads the seed's own deletion rather than a value's shape.
The cascade is also the serialization, because a job is inserted in the statement that moves its reminder to `queued`, and that statement and the cascade lock the same reminder rows.
An enqueue that committed before the cascade leaves a job the sweep sees; one in flight when the cascade reaches its rows holds their locks, so the cascade waits for it to commit and the sweep then sees its job; one that reaches a reminder the cascade has already taken waits for the seed to commit and finds nothing left to move, so it inserts nothing.
The reverse order — jobs first, then users — would leave a job committed between the two statements with no reminder, invisible to the first statement's snapshot and outside the cascade, and nothing would ever remove it: a worker would claim it, send, and fail to record the outcome against a reminder that does not exist.
A re-seed is still not meant to run beside a ticking scheduler or a running worker (`README.md` says to stop both first), and the seed does not enforce that: it is a fixture tool run by hand, and a check before its transaction would leave the same window it meant to close.
Against the scheduler, the cascade and the enqueue statement can lock overlapping reminders in opposite orders.
Against a worker, the cycle is exact: a completion holds its job row and waits for its reminder through the `deliveries` foreign key, while the seed holds that reminder in the cascade and then waits for the job row in the sweep.
In either case Postgres aborts one of the two.
A seed aborted that way rolls back and changes nothing, because its whole replacement is one transaction; a worker aborted that way exits non-zero as "Graceful shutdown and the lease" says a worker that cannot record an outcome does, and the seed then removes the batch's jobs with the reminders they named.

### The worker

`apps/api/src/worker/` runs as its own process, `bun run dev:worker`, N of them in N terminals; nothing coordinates them but the claim statement.
Each identifies itself as `hostname:pid` in `locked_by`.
A worker claims a batch of `WORKER_BATCH_SIZE` (default 25) with the one statement in `## Data model`, reads the claimed reminders' `expo_push_token` in one select, and sends the batch **concurrently** through the push sink.
The worker carries no `users.seeded` predicate: a job exists only because the enqueue tick selected a seeded reminder, so the job's existence already records the ownership the naive tick has to ask for, and a second predicate over it would be the mistake "The seed owns its rows by a recorded flag, not by their address" describes.
Each outcome is recorded in its own transaction.
A successful send writes one `deliveries` row, moves the reminder `queued → sent`, and sets the job's `done_at`.
One transaction per attempt is still required, for the reason "The scheduler" gives: `deliveries.created_at` is the transaction timestamp, and the fan-out duration is measured from it.
An empty claim sleeps `WORKER_POLL_MS` (default 250) and claims again; a shutdown request cuts that sleep short.
The worker logs one line per batch — claimed, sent, failed, dead-lettered, duplicate, elapsed — where duplicate counts a send recorded after another worker had already finished the job: a successful one whose reminder was no longer `queued`, or a failed one whose job was already done ("Graceful shutdown and the lease").
Failed counts the failed sends that moved their job, to a retry or to the dead-letter, so a line can tell N jobs that will be retried from N that were already done.

The loop is a function over injected dependencies — the job repository's three operations, the sink, a clock, a sleep that is handed the shutdown signal, and the signal itself — the same shape `runTick` has, so its tests run without Postgres, a timer that really waits, or the network.
The SQL is not unit-tested; it is validated against the compose Postgres before a pull request opens, and the pull request body carries that output.

### Retry, backoff, dead-letter

A failed send increments `attempts` and records the error in `last_error`.
The count it increments is the row's, read under `FOR UPDATE` inside the failure's transaction, and not the count the claim returned: two workers that fail the same reclaimed job serialize on the row, the second one sees the first one's increment and decides from it, and a job is never left open with `attempts` at the ceiling.
A failure whose job is no longer open — another worker completed or dead-lettered it after a lease reclaim — writes its `deliveries` row and moves nothing, and the worker counts it as a duplicate ("The worker").
If the incremented `attempts` is still below `WORKER_MAX_ATTEMPTS` (default 3), the job is rescheduled: `run_at = now() + WORKER_BACKOFF_BASE_MS × 2^(attempts − 1)`, with `attempts` the value after the increment and `WORKER_BACKOFF_BASE_MS` defaulting to 1,000 ms, and `locked_at` is set back to `NULL` so any worker may take the retry.
If it has reached the ceiling, the job is dead-lettered instead: `dead_at` and `done_at` are set in the same statement, `last_error` keeps the final error, and the reminder moves `queued → failed`.
A dead-lettered job is a done job with `dead_at` set.
There is no status column, because one would have to be kept in step with `done_at` and `dead_at` and could disagree with them.
At the defaults:

| Failure | `attempts` after it | Below the ceiling of 3? | Outcome                                                         |
| ------- | ------------------- | ----------------------- | --------------------------------------------------------------- |
| first   | 1                   | yes                     | `run_at = now() + 1,000 ms × 2^0` = 1 s later, `locked_at` NULL |
| second  | 2                   | yes                     | `run_at = now() + 1,000 ms × 2^1` = 2 s later, `locked_at` NULL |
| third   | 3                   | no                      | `dead_at` and `done_at` set, reminder `failed`                  |

`apps/api/src/worker/loop.test.ts` asserts this table, so the arithmetic is checked in one place and read in another.
Every failed attempt writes a `deliveries` row with `status = 'failed'`, in the same transaction as the retry or the dead-letter, so `deliveries` keeps being one row per send attempt ("`deliveries`") and the attempts a job cost are readable from it and not only from the counter.
Only a failed send increments `attempts`.
A lease reclaim does not, so the ceiling counts send failures and not worker deaths: a job whose worker keeps dying is reclaimed as often as it takes rather than dead-lettered for a fault that was never the send's.

### Graceful shutdown and the lease

On `SIGTERM` or `SIGINT` the worker stops claiming, finishes sending and recording the batch in flight, prints what it drained, and exits 0.
The first signal of either kind removes the handlers for both, so a second signal of either kind — an operator who does not want to wait for a stuck batch — falls through to the runtime's default and kills the process, as the worker's log line at the first signal says it will.
An idle worker exits as promptly as a busy one: the request cuts the poll sleep short and releases its timer, because a timer left armed holds the process open for the rest of `WORKER_POLL_MS` after the loop has returned and the database client has closed.
A worker killed outright — `SIGKILL`, a crash, a pulled plug — leaves its batch with `locked_at` set and `done_at` null.
The claim statement takes such a row once `locked_at` is older than `WORKER_LEASE_MS` (default 30,000): a batch of 25 sends at 50–150 ms each settles well under a second, so the lease is room for a stalled machine and not for a slow batch, and it is long because a lease shorter than a batch would hand out rows that are still being sent.
Nothing is lost across a worker restart, because nothing was ever only in the worker's memory: the claim is the only state, and it expires.

The consequence is that delivery is **at-least-once**, and this is a property of the design rather than a defect in it.
A worker that sent a job's push and was killed before recording it leaves a job another worker will claim and send again, so one reminder can carry two `deliveries` rows, both of them true.
The completion statements are written so that the second recording is harmless.
Every reminder update carries `WHERE state = 'queued'`, so the first completion to commit moves the reminder and the second changes nothing; the worker reports that outcome as a duplicate and does not throw.
The job's `done_at` is written only `WHERE done_at IS NULL`, so the first stamp stands.
A retry or a dead-letter also carries `WHERE done_at IS NULL`, so a stale worker's failure cannot reopen a job another worker has finished.
Every transaction that touches both a job and its reminder takes the job row first and the reminder row second, so two workers recording the same reclaimed job can wait on each other but never in a cycle, and Postgres never has to abort one of them as a deadlock.
The first statement of the completion and of the failure path is therefore a `SELECT … FOR UPDATE` on the job row and nothing else, because the `deliveries` insert that follows touches the reminder too: its foreign key takes a key-share lock on the referenced row.
That lock does not conflict with the `FOR NO KEY UPDATE` the later `state` update takes (measured: two completions of one reclaimed job interleaved with the insert first did not deadlock), so the order is not what keeps the two apart; it is what makes this sentence true of the statements as written, which is the property a reader checks.
The enqueue statement stands outside that order: it updates `pending` reminders and inserts new job rows, and a worker holds neither.
Whichever completion commits first decides the reminder's terminal state; the `deliveries` rows record every send that happened, which is what the fan-out is measured from.
Exactly-once would need the push provider to take an idempotency key, which the simulated sink does not model; M5's real send is where that question belongs.

A worker that cannot record an outcome — the database is gone mid-batch — lets the rest of its batch settle, then exits non-zero with the error.
Its batch stays locked and the lease reclaims it, which at-least-once already permits; hiding the error behind a retry of the worker's own would make a database outage look like slow sends.

### What a measured M2 run does

The headline setup is four workers at the default batch of 25, and the log records both as it observed them — the distinct `locked_by` ids over the peak's jobs and the largest claim among them — rather than as anything the harness was told; a run with a different fleet writes a different log, and the README cell it fills says which.
Four and not eight because of connection headroom: every `postgres(url)` client here defaults to a pool of ten, so four workers, the API, the scheduler and the harness with its reserved lock connection can hold about seventy of `max_connections` 100, and `peak_connections` is a number the M2 paragraph reports for its own sake.
The M2 row is filled from two runs on one seed each, re-seeded between them with the scheduler and every worker stopped.
The timing run (`bun run load:m2`) starts four workers, then the enqueue scheduler with `SCHEDULER_NOW` on the peak instant, kills nothing, and fills the row's first three cells.
The restart run (`bun run load:m2:restart`) is the same setup with the harness killing one worker mid-fan-out and reading what became of its batch; it fills the fourth cell, and its own duration carries one lease wait and fills nothing else.
Every definition, tolerance and check the two runs are graded on — the terminal-state condition with `queued`, the per-mode attempts check and its duplicate count, the offered rate, the sender record, workers and largest claim as observed, the restart procedure and what "lost" means — lives in "Metric definitions and their sources" and is not repeated here.
The sink is the same module M1 measured, byte for byte, and the workers read its parameters as the naive scheduler did; what changed between the two rows is how sends are scheduled, which is the comparison the table exists for.
