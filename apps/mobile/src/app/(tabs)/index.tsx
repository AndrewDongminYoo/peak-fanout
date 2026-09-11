import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { WebBadge } from '@/components/web-badge';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { api, ApiError, toApiError } from '@/lib/api';
import { fetchMeWithRecovery } from '@/lib/auth-callback';
import { createUser } from '@/lib/sign-in';
import { supabase } from '@/lib/supabase';

async function getMe() {
  const { data, error } = await api.me.get();
  if (error) throw toApiError(error);
  return data;
}

// design.md "Me": GET /me through Eden treaty, three fields, sign out. A 404
// on a restored session means the users row was never created; the helper
// upserts it and retries once before the error reaches the screen.
const fetchMe = () => fetchMeWithRecovery({ getMe, createUser });

export default function MeScreen() {
  const theme = useTheme();
  const me = useQuery({ queryKey: ['me'], queryFn: fetchMe });

  // SessionProvider clears the query cache when the user changes, sign-out included.
  async function signOut() {
    await supabase.auth.signOut();
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
          </ThemedView>
        )}

        <Button title="Sign out" onPress={signOut} />

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
