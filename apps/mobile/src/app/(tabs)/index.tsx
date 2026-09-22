import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { WebBadge } from '@/components/web-badge';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useSession } from '@/hooks/use-session';
import { useTheme } from '@/hooks/use-theme';
import { api, ApiError, toApiError } from '@/lib/api';
import { fetchMeWithRecovery, shouldRetryMe, signOutWithFeedback } from '@/lib/auth-callback';
import {
  getEasProjectId,
  getExpoPushToken,
  getNotificationPermission,
  hasNotificationPermission,
} from '@/lib/notifications';
import {
  describePushTokenFailure,
  isThisDeviceRegistered,
  reconcileIsDue,
  reconcileRememberedPushToken,
  registerPushToken,
  visiblePushTokenStatus,
  type PushTokenAttempt,
  type PushTokenStatus,
} from '@/lib/push-token';
import {
  clearPushToken,
  createUser,
  getSession,
  readRememberedPushToken,
  rememberPushToken,
  sessionLane,
} from '@/lib/sign-in';
import { supabase } from '@/lib/supabase';

async function getMe() {
  const { data, error } = await api.me.get();
  if (error) throw toApiError(error);
  return data;
}

// design.md "Me": GET /me through Eden treaty, three fields, sign out. A 404
// on a restored session means the users row was never created; the helper
// upserts it and retries once before the error reaches the screen; the query
// itself must not retry a 404, or that one-shot repair reruns on every retry.
const fetchMe = () => fetchMeWithRecovery({ getMe, createUser });

// design.md "Me": the sign-out action. A failure keeps the session (see
// `signOutWithFeedback`), so it is shown and the button retries.
type SignOutStatus =
  { kind: 'idle' } | { kind: 'signing-out' } | { kind: 'error'; message: string };

// The per-call header replaces the one `api`'s `headers()` reads from the
// session at send time (Eden spreads request headers over the client's), so
// the PUT is signed as the user `registerPushToken` just compared, not as
// whoever a magic link signed in since. `signal` reaches `fetch` the same way,
// so the flow's bound aborts a stalled request.
async function putPushToken(token: string, accessToken: string, signal: AbortSignal) {
  const { data, error } = await api.me['push-token'].put(
    { token },
    { headers: { authorization: `Bearer ${accessToken}` }, fetch: { signal } },
  );
  if (error) throw toApiError(error);
  return data;
}

// design.md "Me": the mechanism, with the real modules (`@/lib/notifications`,
// a native/web twin) behind `registerPushToken`. `userId` is the user who
// pressed the button; the flow stores the token only while the session is
// still theirs, and its PUT takes its turn in the lane sign-out and the auth
// callback share, and once that PUT has answered the installation remembers
// the token (AsyncStorage, `sign-in.ts`) so its later clears can name it and
// the card can show this device as registered; `onRemembered` is the screen's
// copy of that write.
const registerDevicePushToken = (
  userId: string | undefined,
  onRemembered: (token: string) => void,
) =>
  registerPushToken({
    projectId: getEasProjectId(),
    userId,
    getSession,
    getPermission: getNotificationPermission,
    getExpoPushToken,
    putPushToken,
    async rememberPushToken(token) {
      onRemembered(token);
      await rememberPushToken(token);
    },
    runExclusive: sessionLane,
  });

export default function MeScreen() {
  const theme = useTheme();
  const { session } = useSession();
  // Keyed by user so an account switch while this screen stays mounted swaps
  // to the new user's query instead of leaving the previous profile on screen;
  // `queryClient.clear()` alone does not notify a mounted observer.
  const userId = session?.user.id;
  const me = useQuery({
    queryKey: ['me', userId],
    queryFn: fetchMe,
    enabled: userId !== undefined,
    retry: shouldRetryMe,
  });

  const queryClient = useQueryClient();
  // design.md "Me": push registration. The attempt is tagged with the user
  // who pressed the button and rendered only while the session is still
  // theirs, like the query key above: the card stays mounted across an
  // account switch, and an attempt that ends after it (or is still in flight)
  // must not put its error line or spinner on the other account's card.
  const [pushTokenAttempt, setPushTokenAttempt] = useState<PushTokenAttempt>({
    userId,
    status: { kind: 'idle' },
  });
  const pushTokenStatus = visiblePushTokenStatus(pushTokenAttempt, userId);
  // The one state slot above holds only the latest attempt. An earlier
  // attempt still in flight across a magic-link switch would otherwise write
  // its own ending over the new user's `registering` (re-enabling the button
  // mid-request) or over their error line, so every write checks that its
  // attempt is still the latest and is dropped otherwise.
  const pushTokenAttemptSeq = useRef(0);
  const [signOutStatus, setSignOutStatus] = useState<SignOutStatus>({ kind: 'idle' });

  // design.md "Me": the token this installation registered, read from
  // AsyncStorage once the card has loaded and, when nothing is remembered on
  // an iOS build whose permission is already granted, reconciled against the
  // loaded `push_tokens` (no prompt, no server call, at most once per
  // signed-in account per mount: the card stays mounted across a magic-link
  // switch, and the account signed in after it gets its own run, so
  // `reconciledFor` holds the user the last run was for). It tells this
  // device's row from the others on the card and is what the sign-out clear
  // names; a registration below sets it as soon as its PUT answered.
  // `undefined` until the read has answered. The effect has no cleanup on
  // purpose: the promise also carries the plain stored-token answer, and a
  // cleanup that dropped it when `push_tokens` changed identity mid-read (a
  // refetch while the token read was pending) would leave this account
  // without a remembered token for the rest of the mount, because
  // `reconcileIsDue` refuses a second run for it. The updater keeps a
  // registration that landed first, and a resolve after unmount is a no-op
  // setState. The reconcile's storage write takes its turn in `sessionLane`,
  // as registration's does, so it never overwrites a newer registration.
  const [rememberedToken, setRememberedToken] = useState<string | null | undefined>(undefined);
  const reconciledFor = useRef<string | undefined>(undefined);
  const loadedPushTokens = me.data?.push_tokens;
  useEffect(() => {
    if (loadedPushTokens === undefined || !reconcileIsDue(reconciledFor.current, userId)) return;
    reconciledFor.current = userId;
    void reconcileRememberedPushToken({
      isIos: Platform.OS === 'ios',
      projectId: getEasProjectId(),
      pushTokens: loadedPushTokens,
      readRememberedPushToken,
      hasPermission: hasNotificationPermission,
      getExpoPushToken,
      rememberPushToken,
      runExclusive: sessionLane,
    }).then((token) => {
      setRememberedToken((current) => current ?? token);
    });
  }, [userId, loadedPushTokens]);

  // On success the returned body is the GET /me shape, so the card shows the
  // token without a refetch. A session that switched to another account
  // mid-flow (a magic link) drops the result: the screen is already showing
  // that account's query, and nothing about this attempt applies to it.
  // `registerPushToken` reports every failure it knows as a result; the catch
  // is for anything else, so the button never stays disabled in `registering`.
  async function registerPush() {
    const attemptUserId = userId;
    const attemptId = ++pushTokenAttemptSeq.current;
    const setStatus = (status: PushTokenStatus) => {
      if (pushTokenAttemptSeq.current !== attemptId) return;
      setPushTokenAttempt({ userId: attemptUserId, status });
    };
    setStatus({ kind: 'registering' });
    try {
      const result = await registerDevicePushToken(attemptUserId, setRememberedToken);
      if (result.ok) {
        queryClient.setQueryData(['me', attemptUserId], result.me);
        setStatus({ kind: 'idle' });
      } else if (result.reason === 'session_changed') {
        setStatus({ kind: 'idle' });
      } else {
        setStatus({ kind: 'error', message: describePushTokenFailure(result) });
      }
    } catch (cause) {
      setStatus({
        kind: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  // SessionProvider clears the query cache when the user changes, sign-out
  // included. The push token is cleared first, best effort (design.md "Me"),
  // after any registration step ahead of it in the lane has finished. One session
  // snapshot signs the clear (a per-call header, as in `putPushToken`) and
  // keys the cache write, so both name the same user: whoever holds the
  // session here is who `signOut()` is about to sign out. No session, nothing
  // to clear; a failed read is swallowed by `signOutWithFeedback`. The clear
  // names the token this installation remembered (`clearPushToken`; nothing
  // remembered deletes nothing), so the returned body is the row set as the
  // server now holds it, and it goes into that user's query as after a
  // `PUT`: a sign-out that then fails keeps the session and the card, which
  // must show neither this device as registered after its row went nor a
  // count the server no longer holds. An answer that arrives after the bound
  // is dropped: sign-out has moved on and the cache is about to be cleared.
  async function signOut() {
    setSignOutStatus({ kind: 'signing-out' });
    const message = await signOutWithFeedback({
      async clearPushToken(signal) {
        const current = await getSession();
        if (!current) return;
        const me = await clearPushToken(current.accessToken, signal);
        if (signal.aborted) return;
        queryClient.setQueryData(['me', current.userId], me);
      },
      signOut: () => supabase.auth.signOut(),
      runExclusive: sessionLane,
    });
    setSignOutStatus(message === null ? { kind: 'idle' } : { kind: 'error', message });
  }

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedText type="subtitle">Me</ThemedText>

        {me.isPending ? (
          <ActivityIndicator color={theme.text} style={styles.spinner} />
        ) : me.isError ? (
          <ThemedView type="backgroundElement" style={styles.card}>
            <ThemedText type="smallBold">Could not load your profile</ThemedText>
            <ThemedText type="small" themeColor="textSecondary" accessibilityRole="alert">
              {me.error instanceof ApiError ? `GET /me returned ${me.error.status}: ` : ''}
              {me.error.message}
            </ThemedText>
            <Button title="Retry" loading={me.isFetching} onPress={() => me.refetch()} />
          </ThemedView>
        ) : (
          <ThemedView type="backgroundElement" style={styles.card}>
            <Field label="timezone" value={me.data.timezone} />
            <Field label="reminder_time" value={me.data.reminder_time} />
            <Field label="Registered devices" value={String(me.data.push_tokens.length)} />
            <Field
              label="This device"
              value={
                isThisDeviceRegistered(me.data.push_tokens, rememberedToken)
                  ? 'registered'
                  : 'not registered'
              }
            />
            {pushTokenStatus.kind === 'error' && (
              <ThemedText type="small" themeColor="error" accessibilityRole="alert">
                {pushTokenStatus.message}
              </ThemedText>
            )}
            {/* iOS only (design.md "Me"): web gets no Expo push token, and
                Android has no FCM configuration yet, so its token call would
                fail and be misnamed as the device/project-id line. The button
                stays once this device is registered: Expo can rotate its token
                while GET /me keeps the old row, and a second run registers
                the new one. */}
            {Platform.OS === 'ios' && (
              <Button
                title={
                  isThisDeviceRegistered(me.data.push_tokens, rememberedToken)
                    ? 'Refresh push token'
                    : 'Register push notifications'
                }
                loading={pushTokenStatus.kind === 'registering'}
                onPress={registerPush}
              />
            )}
          </ThemedView>
        )}

        {signOutStatus.kind === 'error' && (
          <ThemedText type="small" themeColor="error" accessibilityRole="alert">
            Could not sign out: {signOutStatus.message}
          </ThemedText>
        )}
        <Button title="Sign out" loading={signOutStatus.kind === 'signing-out'} onPress={signOut} />

        {Platform.OS === 'web' && <WebBadge />}
      </SafeAreaView>
    </ThemedView>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <ThemedText type="code" themeColor="textSecondary">
        {label}
      </ThemedText>
      <ThemedText selectable>{value}</ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
  },
  safeArea: {
    flex: 1,
    maxWidth: MaxContentWidth,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.four,
    paddingBottom: BottomTabInset + Spacing.three,
    gap: Spacing.four,
  },
  spinner: {
    marginVertical: Spacing.five,
  },
  card: {
    gap: Spacing.three,
    padding: Spacing.four,
    borderRadius: Spacing.four,
  },
  field: {
    gap: Spacing.half,
  },
});
