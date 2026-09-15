# M5 Expo push sink

## Problem

M5 can store an Expo push token, but the repository has no provider implementation that can send to that token.
The existing simulated sink must remain unchanged because it defines every committed fan-out measurement.
The queue currently materializes only seeded reminders, and those rows have no push token, so a provider sink wired only to the worker would not provide a safe one-device acceptance path.

## Scope

- Add `expo-server-sdk` to `@peak-fanout/api`.
- Add an Expo implementation of the existing `PushSink` contract.
- Let a worker select that implementation only with `PUSH_SINK=expo`.
- Keep the worker default and the naive scheduler on the simulated sink.
- Make every load-harness worker command set `PUSH_SINK=simulated`.
- Add `bun run push:expo` as an explicit one-message path for a later real-device check.
- Record the selected worker sink in `deliveries.sender` without recording credentials.

## Non-goals

- Do not send a real notification in this pull request.
- Do not request notification permission or obtain a token from the mobile app.
- Do not add scheduled reminder materialization for ordinary users.
- Do not poll Expo push receipts or claim that an accepted ticket proves device delivery.
- Do not implement `GET /admin/queue`, the architecture diagram, or another M5 item.
- Do not change the simulated latency distribution, load result schema, or committed measurements.

## Contract

`PUSH_SINK` accepts `simulated` and `expo`.
An absent or empty value selects `simulated`.
Any other value stops the worker before it opens a database connection.

The Expo client receives `EXPO_ACCESS_TOKEN` only when it is non-empty.
The sender record stores `access_token_configured` as a boolean and never stores the credential.
The one-message command requires `EXPO_PUSH_TOKEN` and never prints either token.

The Expo sink refuses a null or malformed push token before it calls the client.
That refusal is a `PushSendError` with zero latency.
For a valid token, the sink sends one message through `sendPushNotificationsAsync` and rounds the elapsed monotonic time to whole milliseconds.
A single success ticket returns that latency.
A client exception, a response with other than one ticket, or an error ticket throws `PushSendError` with the same elapsed latency.

An accepted ticket proves only that the Expo service accepted the request.
The later device check must inspect the device or a push receipt before it claims delivery.

## Acceptance criteria

1. The worker defaults to the byte-identical simulated sink behavior and rejects an unknown `PUSH_SINK` value before database setup.
2. The Expo sink sends the exact token, title, and body to the client for a valid token.
3. Invalid tokens cause no client call and produce a zero-latency `PushSendError`.
4. Client exceptions, malformed ticket counts, and Expo error tickets preserve measured latency in `PushSendError`.
5. An Expo worker delivery record identifies the sink and whether push security was configured without storing a credential.
6. Load-harness worker commands explicitly select the simulated sink.
7. The one-message command refuses a missing token before client construction and never logs a secret.
8. Focused tests, `bun run check`, and `trunk check --all --no-fix` pass without a real network request.

## External acceptance

The real-device send is a later external action.
It requires a device-produced `EXPO_PUSH_TOKEN` and separate operator approval to run `bun run push:expo`.
