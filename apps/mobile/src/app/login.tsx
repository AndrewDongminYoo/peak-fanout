import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { AUTH_CALLBACK_URL, supabase } from '@/lib/supabase';

// design.md "Login": idle, sending, sent, error.
type Status =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; email: string }
  | { kind: 'error'; message: string };

export default function LoginScreen() {
  const theme = useTheme();
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  async function sendMagicLink() {
    const address = email.trim();
    if (!address) {
      setStatus({ kind: 'error', message: 'Enter your email address.' });
      return;
    }
    setStatus({ kind: 'sending' });
    const { error } = await supabase.auth.signInWithOtp({
      email: address,
      options: { emailRedirectTo: AUTH_CALLBACK_URL },
    });
    setStatus(error ? { kind: 'error', message: error.message } : { kind: 'sent', email: address });
  }

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.form}
        >
          <ThemedText type="subtitle">PeakCall</ThemedText>
          <ThemedText themeColor="textSecondary">
            Sign in with a magic link. No password.
          </ThemedText>

          {status.kind === 'sent' ? (
            <ThemedView type="backgroundElement" style={styles.card}>
              <ThemedText type="smallBold">Check your inbox</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                We sent a sign-in link to {status.email}. Open it on this device.
              </ThemedText>
              <Pressable onPress={() => setStatus({ kind: 'idle' })} accessibilityRole="button">
                <ThemedText type="linkPrimary">Use another email</ThemedText>
              </Pressable>
            </ThemedView>
          ) : (
            <ThemedView type="backgroundElement" style={styles.card}>
              <TextInput
                accessibilityLabel="Email address"
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect={false}
                editable={status.kind !== 'sending'}
                inputMode="email"
                keyboardType="email-address"
                onChangeText={setEmail}
                onSubmitEditing={sendMagicLink}
                placeholder="you@example.com"
                placeholderTextColor={theme.textSecondary}
                returnKeyType="send"
                style={[styles.input, { color: theme.text, backgroundColor: theme.background }]}
                value={email}
              />
              {status.kind === 'error' && (
                <ThemedText type="small" style={styles.error} accessibilityRole="alert">
                  {status.message}
                </ThemedText>
              )}
              <Button
                title="Send magic link"
                loading={status.kind === 'sending'}
                onPress={sendMagicLink}
              />
            </ThemedView>
          )}
        </KeyboardAvoidingView>
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
  },
  form: {
    flex: 1,
    justifyContent: 'center',
    gap: Spacing.three,
  },
  card: {
    gap: Spacing.three,
    padding: Spacing.four,
    borderRadius: Spacing.four,
  },
  input: {
    minHeight: 44,
    paddingHorizontal: Spacing.three,
    borderRadius: Spacing.two,
    fontSize: 16,
  },
  error: {
    color: '#d14343',
  },
});
