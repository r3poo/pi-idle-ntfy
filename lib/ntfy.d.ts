import type { NotificationConfig } from "./logic.js";

export function sendNotification(config: NotificationConfig, title: string, body: string, signal?: AbortSignal): Promise<void>;
