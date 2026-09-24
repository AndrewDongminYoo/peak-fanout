# Issue 11 authenticated links

## Problem

The current magic-link callback accepts access and refresh tokens from an unverified custom URL scheme.
Another app can claim that scheme, and this app can accept a link that was not requested on this installation.
Issue #11 requires both the callback binding and verified HTTPS delivery in one change.

## Hosting decision

The dedicated static Vercel project `donminzzi-projects/peak-fanout-links` serves `https://peak-fanout-links.vercel.app` as the mobile redirect host, without changing an unrelated personal website.
Its production alias serves the association files and fallback page over HTTPS; the published responses were checked against their source files.
This project hosts only the callback fallback page and the two platform association files; it does not host the API or Supabase Auth.
The operator approved creating and deploying this separate hosted project.

## Scope

- Use Supabase PKCE for email sign-in and exchange a returned code with the verifier stored on the requesting installation.
- Accept only the configured HTTPS callback path, and reject legacy token-bearing custom-scheme callbacks.
- Preserve ordered sign-in attempts, local sign-out on a failed completion, and installation-scoped push-token clearing on account switches.
- Configure iOS Universal Links and Android App Links for the same callback host and exact route.
- Serve `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` over HTTPS with correct content types and no redirects.
- Set the Supabase redirect allow-list to the fixed HTTPS callback path with only the `sb_flow_id` query wildcard needed by concurrent PKCE attempts, and update the login and callback documentation.

## Non-goals

- Host the API, queue, database, or Supabase Auth.
- Change push delivery, reminder scheduling, or measured results.
- Add a new mobile authentication provider or a browser sign-in flow.
- Modify the operator's existing personal websites.

## Acceptance criteria

1. A callback without a code, from the wrong origin or path, or with legacy URL tokens cannot create a session.
2. A valid code from a sign-in initiated on this installation completes exactly once through its own `sb_flow_id` verifier slot; a code without that local verifier fails without creating an app user.
3. Fast successive links are processed in arrival order, and only the latest link controls navigation and error display.
4. Existing and switched-account push-token cleanup keeps its documented ordering and failure bounds.
5. The published AASA lists the existing iOS team and bundle ID, and the published asset links file lists the Android package and its verified signing fingerprint.
6. Both association endpoints return HTTP 200 and JSON over HTTPS without a redirect; the callback host is identical in the mobile config, Supabase allow-list, and association files.
7. An installed native app opens the verified HTTPS route on iOS, and an Android APK signed with the published EAS keystore does the same on a device or emulator; a local Supabase magic-link check demonstrates PKCE completion.
8. Focused tests, `bun run check`, and `trunk check --all --no-fix` pass.

## Material constraints

The repository had no hosted callback domain before the dedicated Vercel project was created.
The Android package is `kr.donminzzi.peakfanout`, and the association file uses the public SHA-256 fingerprint of its generated EAS production keystore.
The operator approved publishing the endpoint and creating the signing credentials.
The installed auth-js makes the PKCE flow ID redirect parameter opt-in, and an exact redirect allow-list entry would reject that appended query.
The existing custom scheme may remain registered for Expo development tooling, but authentication never accepts it after this migration.
