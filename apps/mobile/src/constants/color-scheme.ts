import type { ColorSchemeName } from 'react-native';

/**
 * Narrows a color scheme reading to a `Colors` key.
 *
 * React Native's TypeScript declaration types `useColorScheme()` as
 * `'light' | 'dark' | 'unspecified'`, but the Flow source is nullable and
 * `Appearance.getColorScheme()` returns `null` when the native Appearance
 * module is absent, so `null` and `undefined` must resolve without a cast.
 * Anything other than `'dark'` is the light scheme.
 *
 * This module stays free of React Native runtime imports so a Bun test can
 * import it; `ColorSchemeName` is a type-only import.
 */
export function resolveColorScheme(
  scheme: ColorSchemeName | 'unspecified' | null | undefined,
): 'light' | 'dark' {
  return scheme === 'dark' ? 'dark' : 'light';
}
