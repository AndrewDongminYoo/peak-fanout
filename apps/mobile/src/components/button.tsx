import { ActivityIndicator, Pressable, StyleSheet, type PressableProps } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type ButtonProps = Omit<PressableProps, 'style' | 'children'> & {
  title: string;
  loading?: boolean;
};

export function Button({ title, loading = false, disabled, ...props }: ButtonProps) {
  const theme = useTheme();
  const inactive = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      accessibilityLabel={title}
      disabled={inactive}
      {...props}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: theme.text },
        (pressed || inactive) && styles.dimmed,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={theme.background} />
      ) : (
        <ThemedText type="smallBold" style={{ color: theme.background }}>
          {title}
        </ThemedText>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.three,
  },
  dimmed: {
    opacity: 0.6,
  },
});
