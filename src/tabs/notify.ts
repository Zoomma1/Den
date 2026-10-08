import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { TabLifecycleState } from "./lifecycle";

export interface SystemNotification {
  title: string;
  body: string;
}

/** Pur : une notification par transition qui demande l'attention de l'utilisateur, sinon `null`. */
export function notificationFor(
  prev: TabLifecycleState | undefined,
  next: TabLifecycleState,
  projectName: string,
): SystemNotification | null {
  if (next === "waiting" && prev !== "waiting") {
    return { title: projectName, body: "Needs your input" };
  }
  if (next === "idle" && (prev === "running" || prev === "waiting")) {
    return { title: projectName, body: "Finished" };
  }
  return null;
}

/** Ne throw jamais : une notif perdue ne doit pas casser le flux de session. */
export async function sendSystemNotification(note: SystemNotification): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) return;
    sendNotification(note);
  } catch (err) {
    console.warn("den: notification système indisponible.", err);
  }
}
