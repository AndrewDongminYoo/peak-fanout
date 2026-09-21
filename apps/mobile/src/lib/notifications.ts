import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';

import { shouldRequestNotificationPermission } from '@/lib/push-token';

// The `expo-notifications` and `expo-constants` calls behind push-token
// registration (design.md "Me"), kept out of `push-token.ts` so the Bun test
// imports no native module, and out of the screens so the web bundle does
// not carry `expo-notifications` at all: importing it on web registers a
// module-scope push-token listener that only logs a warning. The
// `notifications.web.ts` twin is the web side.

/**
 * A push that arrives while the app is open is still shown as a banner and in
 * the notification list, without sound or badge, so the one-message device
 * check is visible in the foreground too. On Android `shouldPlaySound: false`
 * also suppresses the drop-down alert (installed `NotificationBehavior` doc),
 * so there the foreground push lands in the list only.
 */
export function setForegroundNotificationHandler() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

/** `Constants.expoConfig.extra.eas.projectId`; `extra` is untyped, so the id is checked before it is trusted. */
export function getEasProjectId(): string | undefined {
  const projectId: unknown = Constants.expoConfig?.extra?.eas?.projectId;
  return typeof projectId === 'string' ? projectId : undefined;
}

/**
 * Ask while the system still lets the app ask (`canAskAgain`, not the
 * status: a fresh Android 13+ install already reports `denied`); a final
 * denial is left to Settings.
 */
export async function getNotificationPermission() {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!shouldRequestNotificationPermission(current)) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

export async function getExpoPushToken(projectId: string) {
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}
