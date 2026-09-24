import { useLinkingURL } from 'expo-linking';
import { Link, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { completeSignIn } from '@/lib/sign-in';

// design.md "Auth callback": the magic link lands here as
// https://peak-fanout-links.vercel.app/auth/callback?sb_flow_id=…&code=…; exchange the code, upsert the
// user through POST /auth/session, then replace the route with the Me screen.
export default function AuthCallbackScreen() {
  const theme = useTheme();
  const router = useRouter();
  const url = useLinkingURL();
  // Keyed by URL, not by mount: expo-router reuses this screen for a second
  // magic link, so a per-instance flag would ignore the new link and leave
  // the user on the error card from the expired one. completeSignIn runs the
  // links one at a time and settles each on its own; the screen shows only
  // the outcome of the most recently opened link, so an older link that
  // settles later neither navigates nor replaces the newer link's error.
  const handledUrl = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!url || handledUrl.current === url) return;
    handledUrl.current = url;
    setError(null);
    const isLatest = () => handledUrl.current === url;
    completeSignIn(url).then(
      () => {
        if (isLatest()) router.replace('/');
      },
      (cause: unknown) => {
        if (isLatest()) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, [url, router]);

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        {error === null ? (
          <>
            <ActivityIndicator color={theme.text} />
            <ThemedText themeColor="textSecondary">Signing you in</ThemedText>
          </>
        ) : (
          <ThemedView type="backgroundElement" style={styles.card}>
            <ThemedText type="smallBold">Sign-in failed</ThemedText>
            <ThemedText type="small" themeColor="textSecondary" accessibilityRole="alert">
              {error}
            </ThemedText>
            <Link href="/" replace>
              <ThemedText type="linkPrimary">Continue</ThemedText>
            </Link>
          </ThemedView>
        )}
      </SafeAreaView>
    </ThemedView>
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
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  card: {
    alignSelf: 'stretch',
    gap: Spacing.three,
    padding: Spacing.four,
    borderRadius: Spacing.four,
  },
});
