import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { SessionProvider, useSession } from '@/hooks/use-session';
import { setForegroundNotificationHandler } from '@/lib/notifications';

SplashScreen.preventAutoHideAsync();

// design.md "Me": a push that arrives while the app is open is still shown,
// so the one-message device check is visible in the foreground too. The web
// twin of `@/lib/notifications` is a no-op, which keeps `expo-notifications`
// out of the web bundle.
setForegroundNotificationHandler();

const queryClient = new QueryClient();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
          <AnimatedSplashOverlay />
          <RootStack />
        </ThemeProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}

// design.md "Screens": the tabs exist only with a session, the login screen
// only without one, and the magic-link callback is reachable in both states.
function RootStack() {
  const { session, loading } = useSession();
  if (loading) return null;
  const signedIn = session !== null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="login" />
      </Stack.Protected>
      <Stack.Screen name="auth/callback" />
    </Stack>
  );
}
