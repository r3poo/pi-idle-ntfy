export const DEFAULTS = Object.freeze({
  server: "https://ntfy.sh",
  delayMinutes: 15,
  mode: "idle",
});

export function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("configuration must be a JSON object");
  }
  if (typeof value.topic !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.topic)) {
    throw new Error('"topic" must be a 1–64 character ntfy topic using only letters, numbers, _ or -.');
  }

  const server = value.server ?? DEFAULTS.server;
  let parsedServer;
  try {
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

  for (const key of ["token", "username", "password"]) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key] === "")) {
      throw new Error(`"${key}" must be a non-empty string when provided.`);
    }
  }
  if ((value.username === undefined) !== (value.password === undefined)) {
    throw new Error('"username" and "password" must be provided together.');
  }

  return {
    topic: value.topic,
    server: parsedServer.toString().replace(/\/$/, ""),
    delayMinutes,
    mode,
    ...(value.token === undefined ? {} : { token: value.token }),
    ...(value.username === undefined ? {} : { username: value.username, password: value.password }),
  };
}

export function getLatestAssistantResponse(entries) {
  if (!Array.isArray(entries)) return undefined;
  let latestUserIndex = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message?.role === "user") {
      latestUserIndex = i;
      break;
    }
  }
  for (let i = entries.length - 1; i > latestUserIndex; i--) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message?.role === "assistant") return entry.message;
  }
  return undefined;
}

export function isAwaitingUserInput(message) {
  if (!message || message.role !== "assistant" || message.stopReason !== "stop" || !Array.isArray(message.content)) {
    return false;
  }
  // Tool handoffs are not user-facing completions; Pi may still need to run the tool and continue.
  return !message.content.some((block) => block && typeof block === "object" && block.type === "toolCall");
}

export function createAwaitingInputState() {
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
