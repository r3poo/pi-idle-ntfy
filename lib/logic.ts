export type NotificationMode = "idle" | "immediate";

export interface NotificationConfig {
  topic: string;
  server: string;
  delayMinutes: number;
  mode: NotificationMode;
  token?: string;
  username?: string;
  password?: string;
}

export const DEFAULTS = Object.freeze({
  server: "https://ntfy.sh",
  delayMinutes: 15,
  mode: "idle" as const,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalCredential(value: Record<string, unknown>, key: "token" | "username" | "password"): string | undefined {
  const credential = value[key];
  if (credential === undefined) return undefined;
  if (typeof credential !== "string" || credential === "") {
    throw new Error(`"${key}" must be a non-empty string when provided.`);
  }
  return credential;
}

export function validateConfig(value: unknown): NotificationConfig {
  if (!isRecord(value)) {
    throw new Error("configuration must be a JSON object");
  }
  if (typeof value.topic !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.topic)) {
    throw new Error('"topic" must be a 1–64 character ntfy topic using only letters, numbers, _ or -.');
  }

  const server = value.server ?? DEFAULTS.server;
  let parsedServer: URL;
  try {
    if (typeof server !== "string") throw new TypeError("server must be a string");
    parsedServer = new URL(server);
  } catch {
    throw new Error('"server" must be an absolute HTTP or HTTPS URL.');
  }
  if (parsedServer.protocol !== "https:" && parsedServer.protocol !== "http:") {
    throw new Error('"server" must use HTTP or HTTPS.');
  }

  const delayMinutes = value.delayMinutes ?? DEFAULTS.delayMinutes;
  if (typeof delayMinutes !== "number" || !Number.isFinite(delayMinutes) || delayMinutes < 0 || delayMinutes > 10080) {
    throw new Error('"delayMinutes" must be a number from 0 to 10080.');
  }

  const mode = value.mode ?? DEFAULTS.mode;
  if (mode !== "idle" && mode !== "immediate") {
    throw new Error('"mode" must be either "idle" or "immediate".');
  }

  const token = optionalCredential(value, "token");
  const username = optionalCredential(value, "username");
  const password = optionalCredential(value, "password");
  if ((username === undefined) !== (password === undefined)) {
    throw new Error('"username" and "password" must be provided together.');
  }

  return {
    topic: value.topic,
    server: parsedServer.toString().replace(/\/$/, ""),
    delayMinutes,
    mode,
    ...(token === undefined ? {} : { token }),
    ...(username === undefined || password === undefined ? {} : { username, password }),
  };
}

export type AssistantMessage = Record<string, unknown> & { role: "assistant" };

export function getLatestAssistantResponse(entries: unknown): AssistantMessage | undefined {
  if (!Array.isArray(entries)) return undefined;
  let latestUserIndex = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry: unknown = entries[i];
    if (isRecord(entry) && entry.type === "message" && isRecord(entry.message) && entry.message.role === "user") {
      latestUserIndex = i;
      break;
    }
  }
  for (let i = entries.length - 1; i > latestUserIndex; i--) {
    const entry: unknown = entries[i];
    if (isRecord(entry) && entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant") {
      return entry.message as AssistantMessage;
    }
  }
  return undefined;
}

export function isAwaitingUserInput(message: unknown): boolean {
  if (!isRecord(message) || message.role !== "assistant" || message.stopReason !== "stop" || !Array.isArray(message.content)) {
    return false;
  }
  // Tool handoffs are not user-facing completions; Pi may still need to run the tool and continue.
  return !message.content.some((block: unknown) => isRecord(block) && block.type === "toolCall");
}

export interface AwaitingInputState {
  reset(): void;
  beginAgentRun(): void;
  settle(isAwaitingInput: boolean): void;
  beginUiPrompt(): void;
  endUiPrompt(): void;
  dismiss(): void;
  isWaiting(): boolean;
  isAgentWaiting(): boolean;
  isUiPromptWaiting(): boolean;
  isDismissed(): boolean;
  shouldNotify(): boolean;
}

export function createAwaitingInputState(): AwaitingInputState {
  let agentWaiting = false;
  let uiPromptWaiting = false;
  let dismissed = false;
  const isWaiting = () => agentWaiting || uiPromptWaiting;
  return {
    reset() {
      agentWaiting = false;
      uiPromptWaiting = false;
      dismissed = false;
    },
    beginAgentRun() {
      agentWaiting = false;
      if (!uiPromptWaiting) dismissed = false;
    },
    settle(isAwaitingInput) {
      agentWaiting = isAwaitingInput;
      if (!isWaiting()) dismissed = false;
    },
    beginUiPrompt() {
      uiPromptWaiting = true;
    },
    endUiPrompt() {
      uiPromptWaiting = false;
      if (!agentWaiting) dismissed = false;
    },
    dismiss() {
      if (isWaiting()) dismissed = true;
    },
    isWaiting,
    isAgentWaiting() {
      return agentWaiting;
    },
    isUiPromptWaiting() {
      return uiPromptWaiting;
    },
    isDismissed() {
      return dismissed;
    },
    shouldNotify() {
      return isWaiting() && !dismissed;
    },
  };
}
