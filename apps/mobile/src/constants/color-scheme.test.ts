import { describe, expect, it } from 'bun:test';

import { resolveColorScheme } from './color-scheme';

describe('resolveColorScheme', () => {
  it('keeps dark', () => {
    expect(resolveColorScheme('dark')).toBe('dark');
  });

  it('keeps light', () => {
    expect(resolveColorScheme('light')).toBe('light');
  });

  // `useColorScheme()` is typed to return this on platforms without a scheme.
  it('maps unspecified to light', () => {
    expect(resolveColorScheme('unspecified')).toBe('light');
  });

  // `Appearance.getColorScheme()` returns null when the native module is absent.
  it('maps null and undefined to light', () => {
    expect(resolveColorScheme(null)).toBe('light');
    expect(resolveColorScheme(undefined)).toBe('light');
  });
});
