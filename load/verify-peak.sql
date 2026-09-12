-- Proves that the seeded population really produces one peak minute.
-- design.md "Reminders and delivery (M1)" owns what these numbers mean and why the peak is one timezone.
--
-- Parameters, passed by packages/db/src/verify-peak.ts:
--   $1  the target local date, 'YYYY-MM-DD'
--   $2  the peak instant, ISO 8601
--   $3  the addresses the seed generates, as a text array
--
-- Run with `bun run db:verify-peak`; `bun run db:seed` prints the same rows when it finishes.
-- Every count is scoped to the seeded population, which is also the only population the seed
-- materializes for, so these are exactly the rows a seed run wrote and a magic-link user's own
-- rows never enter the peak report.
WITH seeded_user AS (
  SELECT id, timezone, reminder_time FROM users WHERE email = ANY($3::text[])
),
seeded_reminder AS (
  -- Selected by the materializer's own expression, which is what makes $1 the date these rows are
  -- for. A UTC-day window on scheduled_at would be wrong rather than merely narrower: $1 names each
  -- user's local calendar day, so an early Seoul slot lands on the UTC day before it and a
  -- New York evening slot on the UTC day after it.
  SELECT r.scheduled_at
  FROM reminders AS r
  JOIN seeded_user AS u ON u.id = r.user_id
  WHERE r.scheduled_at = ($1::date + u.reminder_time) AT TIME ZONE u.timezone
),
busiest AS (
  SELECT
    scheduled_at,
    count(*) AS reminders,
    row_number() OVER (ORDER BY count(*) DESC, scheduled_at) AS place
  FROM seeded_reminder
  GROUP BY scheduled_at
  ORDER BY reminders DESC, scheduled_at
  LIMIT 5
)
SELECT 1 AS ord, 'seeded_users' AS key, 'seeded users' AS metric, count(*)::text AS value
FROM seeded_user
UNION ALL
SELECT 2, 'distinct_timezones', 'distinct timezones seeded', count(DISTINCT timezone)::text
FROM seeded_user
UNION ALL
SELECT 3, 'reminders_total', format('seeded reminders for %s', $1::text), count(*)::text
FROM seeded_reminder
UNION ALL
SELECT
  4,
  'reminders_at_peak',
  format(
    'reminders at the peak instant %sZ',
    to_char($2::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI')
  ),
  count(*)::text
FROM seeded_reminder
WHERE scheduled_at = $2::timestamptz
UNION ALL
SELECT
  4 + place::int,
  format('busiest_%s', place),
  format(
    'busiest minute %s: %sZ',
    place,
    to_char(scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI')
  ),
  reminders::text
FROM busiest
ORDER BY ord;
