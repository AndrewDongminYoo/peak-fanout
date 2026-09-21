import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
import { getEasProjectId, getExpoPushToken, getNotificationPermission } from '@/lib/notifications';
import {
  describePushTokenFailure,
  registerPushToken,
  visiblePushTokenStatus,
  type PushTokenAttempt,
  type PushTokenStatus,
  type SessionSnapshot,
} from '@/lib/push-token';
import { createUser } from '@/lib/sign-in';
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
// whoever a magic link signed in since.
async function putPushToken(token: string, accessToken: string) {
  const { data, error } = await api.me['push-token'].put(
    { token },
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (error) throw toApiError(error);
  return data;
}

async function getSession(): Promise<SessionSnapshot | undefined> {
  const { data } = await supabase.auth.getSession();
  if (!data.session) return undefined;
  return { userId: data.session.user.id, accessToken: data.session.access_token };
}

// design.md "Me": the mechanism, with the real modules (`@/lib/notifications`,
// a native/web twin) behind `registerPushToken`. `userId` is the user who
// pressed the button; the flow stores the token only while the session is
// still theirs.
const registerDevicePushToken = (userId: string | undefined) =>
  registerPushToken({
    projectId: getEasProjectId(),
    userId,
    getSession,
    getPermission: getNotificationPermission,
    getExpoPushToken,
    putPushToken,
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
  const [signOutStatus, setSignOutStatus] = useState<SignOutStatus>({ kind: 'idle' });

  // On success the returned body is the GET /me shape, so the card shows the
  // token without a refetch. A session that switched to another account
  // mid-flow (a magic link) drops the result: the screen is already showing
  // that account's query, and nothing about this attempt applies to it.
  // `registerPushToken` reports every failure it knows as a result; the catch
  // is for anything else, so the button never stays disabled in `registering`.
  async function registerPush() {
    const attemptUserId = userId;
    const setStatus = (status: PushTokenStatus) =>
      setPushTokenAttempt({ userId: attemptUserId, status });
    setStatus({ kind: 'registering' });
    try {
      const result = await registerDevicePushToken(attemptUserId);
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

  // SessionProvider clears the query cache when the user changes, sign-out included.
  async function signOut() {
    setSignOutStatus({ kind: 'signing-out' });
    const message = await signOutWithFeedback({ signOut: () => supabase.auth.signOut() });
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
            <Field label="push_token" value={me.data.push_token ?? 'not registered'} />
            {pushTokenStatus.kind === 'error' && (
              <ThemedText type="small" themeColor="error" accessibilityRole="alert">
                {pushTokenStatus.message}
              </ThemedText>
            )}
            {/* iOS only (design.md "Me"): web gets no Expo push token, and
                Android has no FCM configuration yet, so its token call would
                fail and be misnamed as the device/project-id line. */}
            {Platform.OS === 'ios' && me.data.push_token === null && (
              <Button
                title="Register push notifications"
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
