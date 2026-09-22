// Web twin of `notifications.ts`: `expo-notifications` does not deliver Expo
// push tokens on web, and importing it there only registers a module-scope
// listener that logs a warning, so the web bundle carries none of it. The Me
// screen shows the register button on iOS only (design.md "Me"); if this twin
// were called anyway, the missing project id makes `registerPushToken` answer
// `unsupported` before any other call.

export function setForegroundNotificationHandler() {}

export function getEasProjectId(): string | undefined {
  return undefined;
}

export async function getNotificationPermission() {
  return false;
}

/** Web never holds a token, so there is nothing for the reconcile to learn. */
export async function hasNotificationPermission() {
  return false;
}

export async function getExpoPushToken(_projectId: string): Promise<string> {
  throw new Error('Expo push tokens are not delivered on web');
}
