import { ExtensionInputComponent, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sendNotification } from "../lib/ntfy.ts";
import { createAwaitingInputState, DEFAULTS, getLatestAssistantResponse, isAwaitingUserInput, validateConfig } from "../lib/logic.ts";
import type { NotificationConfig } from "../lib/logic.ts";

const CONFIG_PATH = join(getAgentDir(), "pi-idle-ntfy.json");
const UI_PROMPT_GRACE_MS = 100;

async function promptInput(
  ctx: ExtensionContext,
  title: string,
  initialValue: string,
  placeholder?: string,
): Promise<string | undefined> {
  if (ctx.mode === "tui") {
    return ctx.ui.custom<string | undefined>((_tui, _theme, _keybindings, done) =>
      new ExtensionInputComponent(title, placeholder, done, () => done(undefined), { initialValue }),
    );
  }
  if (initialValue) return ctx.ui.editor(title, initialValue);
  return ctx.ui.input(title, placeholder);
}

function formatRemainingTime(delayMs: number): string {
  const totalSeconds = Math.ceil(Math.max(0, delayMs) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`;
}

async function readConfig(): Promise<NotificationConfig> {
  try {
    return validateConfig(JSON.parse(await readFile(CONFIG_PATH, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Missing ${CONFIG_PATH}. Run /idle-ntfy setup to configure notifications.`);
    }
    throw new Error(`Cannot read ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeConfig(config: NotificationConfig): Promise<void> {
  await mkdir(getAgentDir(), { recursive: true, mode: 0o700 });
  const temporaryPath = `${CONFIG_PATH}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, CONFIG_PATH);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export default function (pi: ExtensionAPI) {
  let config: NotificationConfig | undefined;
  let configError: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let countdownInterval: ReturnType<typeof setInterval> | undefined;
  let requestController: AbortController | undefined;
  let stopped = true;
  let pending = false;
  let generation = 0;
  let suppressUiPromptNotifications = false;
  let uiPromptNotificationGeneration: number | undefined;
  let unsubscribeTerminalInput: (() => void) | undefined;
  let context: ExtensionContext | undefined;
  const awaitingInputState = createAwaitingInputState();

  const cancel = () => {
    generation++;
    pending = false;
    uiPromptNotificationGeneration = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = undefined;
    requestController?.abort();
    requestController = undefined;
    context?.ui.setStatus("idle-notification", undefined);
  };

  const postAlert = async (
    ownGeneration: number,
    title = "Pi is waiting for your input",
    body?: string,
  ) => {
    const currentContext = context;
    const currentConfig = config;
    if (!currentConfig || !currentContext || stopped || generation !== ownGeneration || !pending) return;

    const controller = new AbortController();
    requestController = controller;
    try {
      await sendNotification(
        currentConfig,
        title,
        body ?? `A Pi agent in ${currentContext.cwd} has been waiting for your input for ${currentConfig.delayMinutes} minute${currentConfig.delayMinutes === 1 ? "" : "s"}.`,
        controller.signal,
      );
      if (generation === ownGeneration && pending) {
        pending = false;
        uiPromptNotificationGeneration = undefined;
        context?.ui.setStatus("idle-notification", undefined);
        const message = `${new Date().toLocaleString()} — Sent ntfy alert: ${title}.`;
        console.info(`[idle-notification] ${message}`);
        if (currentContext.hasUI) currentContext.ui.notify(message, "info");
      }
    } catch (error) {
      if (generation === ownGeneration && pending) {
        pending = false;
        uiPromptNotificationGeneration = undefined;
        context?.ui.setStatus("idle-notification", undefined);
        console.error(`[idle-notification] ${error instanceof Error ? error.message : String(error)}`);
        if (currentContext.hasUI) currentContext.ui.notify("Could not send ntfy alert; see the Pi console for details.", "warning");
      }
    } finally {
      if (requestController === controller) requestController = undefined;
    }
  };

  const schedule = (
    ctx: ExtensionContext,
    mode: "idle" | "immediate" = config?.mode ?? "idle",
    immediateBody?: string,
    delayMsOverride?: number,
  ): number | undefined => {
    if (stopped || !config) return;
    cancel();
    pending = true;
    context = ctx;
    const ownGeneration = generation;
    const delayMs = delayMsOverride ?? (mode === "immediate" ? 0 : config.delayMinutes * 60_000);
    if (mode === "immediate" || delayMs <= 0) {
      context.ui.setStatus("idle-notification", "ntfy alert now");
    } else {
      const deadline = Date.now() + delayMs;
      const updateCountdown = () => {
        context?.ui.setStatus("idle-notification", `ntfy alert in ${formatRemainingTime(deadline - Date.now())}`);
      };
      updateCountdown();
      countdownInterval = setInterval(updateCountdown, 1000);
      countdownInterval.unref?.();
    }
    timer = setTimeout(() => {
      if (countdownInterval) clearInterval(countdownInterval);
      countdownInterval = undefined;
      context?.ui.setStatus("idle-notification", "ntfy alert sending…");
      const body = mode === "immediate" ? immediateBody ?? `A Pi agent in ${ctx.cwd} has finished a response and is waiting for your input.` : undefined;
      void postAlert(ownGeneration, mode === "immediate" ? "Pi needs your attention" : undefined, body);
    }, delayMs);
    timer.unref?.();
    return ownGeneration;
  };

  const loadConfig = async (ctx: ExtensionContext) => {
    try {
      config = await readConfig();
      configError = undefined;
      ctx.ui.setStatus("idle-notification", `ntfy ready · ${config.mode === "immediate" ? "immediate" : `${config.delayMinutes}m delay`}`);
    } catch (error) {
      config = undefined;
      configError = error instanceof Error ? error.message : String(error);
      console.error(`[idle-notification] ${configError}`);
      ctx.ui.setStatus("idle-notification", "ntfy not configured");
      if (ctx.hasUI) ctx.ui.notify(`Idle notification: ${configError}`, "warning");
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    unsubscribeTerminalInput?.();
    unsubscribeTerminalInput = undefined;
    stopped = false;
    context = ctx;
    cancel();
    awaitingInputState.reset();
    if (ctx.mode === "tui") {
      unsubscribeTerminalInput = ctx.ui.onTerminalInput(() => {
        if (awaitingInputState.shouldNotify()) awaitingInputState.dismiss();
        if (pending) cancel();
        return undefined;
      });
    }
    await loadConfig(ctx);
  });

  pi.on("session_shutdown", () => {
    stopped = true;
    unsubscribeTerminalInput?.();
    unsubscribeTerminalInput = undefined;
    cancel();
    awaitingInputState.reset();
    context = undefined;
  });

  pi.on("message_start", (event, ctx) => {
    context = ctx;
    if ((event.message as { role?: string }).role === "user") {
      awaitingInputState.dismiss();
      cancel();
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    context = ctx;
    awaitingInputState.beginAgentRun();
    cancel();
  });

  pi.on("agent_settled", (event, ctx) => {
    context = ctx;
    if (stopped || event.aborted || !config) return;
    const responseWaiting = isAwaitingUserInput(getLatestAssistantResponse(ctx.sessionManager.getBranch()));
    awaitingInputState.settle(responseWaiting);
    if (!awaitingInputState.shouldNotify()) {
      if (pending) cancel();
      return;
    }

    if (config.mode === "immediate" && responseWaiting) {
      const promptGeneration = uiPromptNotificationGeneration;
      if (promptGeneration !== undefined && pending && generation === promptGeneration) cancel();
      uiPromptNotificationGeneration = undefined;
      schedule(ctx, "immediate");
      return;
    }

    // Keep an existing timer: it may have started for the prompt before the response settled.
    if (!pending) {
      const promptWaiting = !responseWaiting && awaitingInputState.isWaiting();
      const delayMs = promptWaiting
        ? config.mode === "idle"
          ? Math.max(UI_PROMPT_GRACE_MS, config.delayMinutes * 60_000)
          : UI_PROMPT_GRACE_MS
        : undefined;
      const promptBody = promptWaiting && config.mode === "immediate"
        ? "Pi is waiting for your response to an interactive prompt."
        : undefined;
      if (promptWaiting) {
        uiPromptNotificationGeneration = schedule(ctx, config.mode, promptBody, delayMs);
      } else {
        schedule(ctx, config.mode);
      }
    }
  });

  pi.on("ui_prompt_start", (event, ctx) => {
    context = ctx;
    if (stopped || !config || suppressUiPromptNotifications) return;
    awaitingInputState.beginUiPrompt();
    if (!awaitingInputState.shouldNotify() || pending) return;

    const promptDescription = `an interactive ${event.kind} prompt`;
    // Defer immediate prompts so quickly resolved dialogs do not send stale alerts.
    // Idle mode keeps the configured delay, with 100 ms as a minimum when it is zero.
    if (config.mode === "immediate") {
      uiPromptNotificationGeneration = schedule(
        ctx,
        "immediate",
        `Pi is waiting for your response to ${promptDescription}.`,
        UI_PROMPT_GRACE_MS,
      );
    } else {
      uiPromptNotificationGeneration = schedule(
        ctx,
        "idle",
        undefined,
        Math.max(UI_PROMPT_GRACE_MS, config.delayMinutes * 60_000),
      );
    }
  });

  pi.on("ui_prompt_end", () => {
    awaitingInputState.endUiPrompt();
    const promptGeneration = uiPromptNotificationGeneration;
    uiPromptNotificationGeneration = undefined;
    if (promptGeneration !== undefined && pending && generation === promptGeneration && !awaitingInputState.isWaiting()) {
      cancel();
    }
  });

  const showStatus = (ctx: ExtensionContext) => {
    if (configError) {
      ctx.ui.notify(`Idle notification is not configured: ${configError}`, "warning");
      return;
    }
    ctx.ui.notify(
      config
        ? `${config.mode === "immediate" ? "Immediate" : "Idle"} ntfy notifications are ready. ${config.mode === "immediate" ? "Pi sends alerts when a response settles awaiting your input and when an extension UI prompt opens." : `Alerts are sent after ${config.delayMinutes} minutes when Pi settles awaiting your input or an extension UI prompt remains open.`} Terminal input cancels an alert while Pi is waiting; alerts re-arm after the agent runs and settles again.`
        : "Idle ntfy notifications are not ready yet.",
      config ? "info" : "warning",
    );
  };

  pi.registerCommand("idle-ntfy", {
    description: "Configure ntfy alerts or show their status",
    getArgumentCompletions: (prefix) =>
      ["setup", "test", "mode"].filter((action) => action.startsWith(prefix)).map((action) => ({ value: action, label: action })),
    handler: async (args, ctx) => {
      const action = args.trim();
      if (!action) {
        showStatus(ctx);
        return;
      }
      if (action === "mode") {
        if (!ctx.hasUI) {
          ctx.ui.notify("Run /idle-ntfy mode in an interactive Pi session.", "warning");
          return;
        }
        if (!config) {
          ctx.ui.notify(`Cannot change notification mode: ${configError ?? "ntfy is not configured."}`, "warning");
          return;
        }
        suppressUiPromptNotifications = true;
        try {
          const nextMode = await ctx.ui.select("ntfy notification mode", ["Idle: wait before alerting", "Immediate: alert when attention is needed"]);
          if (nextMode === undefined) return;
          const mode = nextMode.startsWith("Immediate:") ? "immediate" : nextMode.startsWith("Idle:") ? "idle" : undefined;
          if (!mode) return;
          const nextConfig = validateConfig({ ...config, mode });
          await writeConfig(nextConfig);
          config = nextConfig;
          cancel();
          ctx.ui.setStatus("idle-notification", `ntfy ready · ${mode === "immediate" ? "immediate" : `${config.delayMinutes}m delay`}`);
          ctx.ui.notify(`ntfy notification mode set to ${mode} and saved.`, "info");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Could not change ntfy notification mode: ${message}`, "error");
        } finally {
          suppressUiPromptNotifications = false;
        }
        return;
      }
      if (action === "test") {
        if (!config) {
          ctx.ui.notify(`Cannot send a test notification: ${configError ?? "ntfy is not configured."}`, "warning");
          return;
        }
        try {
          await sendNotification(
            config,
            "Pi idle notification test",
            "This is a test notification from the Pi idle notification extension.",
          );
          ctx.ui.notify("Test ntfy notification sent successfully.", "info");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[idle-notification] Test notification failed: ${message}`);
          ctx.ui.notify(`Could not send test ntfy notification: ${message}`, "error");
        }
        return;
      }
      if (action !== "setup") {
        ctx.ui.notify("Usage: /idle-ntfy setup | /idle-ntfy mode | /idle-ntfy test", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("Run /idle-ntfy setup in an interactive Pi session.", "warning");
        return;
      }

      suppressUiPromptNotifications = true;
      try {
        try {
          await access(CONFIG_PATH);
          const replace = await ctx.ui.confirm(
            "Replace ntfy configuration?",
            `This will overwrite ${CONFIG_PATH}.`,
          );
          if (!replace) return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }

        const topic = await promptInput(
          ctx,
          "ntfy topic (required)",
          config?.topic ?? "",
          "Choose a private, unguessable topic",
        );
        if (topic === undefined) return;
        const serverInput = await promptInput(ctx, "ntfy server", config?.server ?? "", DEFAULTS.server);
        if (serverInput === undefined) return;
        const delayInput = await promptInput(
          ctx,
          "Alert delay in minutes",
          config?.delayMinutes === undefined ? "" : String(config.delayMinutes),
          String(DEFAULTS.delayMinutes),
        );
        if (delayInput === undefined) return;
        const authMethods = ["None", "Bearer token", "Username and password"];
        const currentAuthMethod = config?.token !== undefined
          ? "Bearer token"
          : config?.username !== undefined
            ? "Username and password"
            : "None";
        const authOptions = [currentAuthMethod, ...authMethods.filter((method) => method !== currentAuthMethod)];
        const authMethod = await ctx.ui.select("ntfy authentication", authOptions);
        if (authMethod === undefined) return;

        let token: string | undefined;
        let username: string | undefined;
        let password: string | undefined;
        if (authMethod === "Bearer token") {
          const value = await promptInput(ctx, "ntfy bearer token", config?.token ?? "");
          if (value === undefined) return;
          token = value.trim();
        } else if (authMethod === "Username and password") {
          const userValue = await promptInput(ctx, "ntfy username", config?.username ?? "");
          if (userValue === undefined) return;
          const passwordValue = await promptInput(ctx, "ntfy password", config?.password ?? "");
          if (passwordValue === undefined) return;
          username = userValue.trim();
          password = passwordValue;
        } else if (authMethod !== "None") {
          return;
        }

        const delayText = delayInput.trim();
        const modeOptions = config?.mode === "immediate"
          ? ["Immediate: alert when attention is needed", "Idle: wait before alerting"]
          : ["Idle: wait before alerting", "Immediate: alert when attention is needed"];
        const selectedMode = await ctx.ui.select("ntfy notification mode", modeOptions);
        if (selectedMode === undefined) return;
        const mode = selectedMode.startsWith("Immediate:") ? "immediate" : selectedMode.startsWith("Idle:") ? "idle" : undefined;
        if (!mode) return;
        const nextConfig = validateConfig({
          topic: topic.trim(),
          server: serverInput.trim() || DEFAULTS.server,
          delayMinutes: delayText ? Number(delayText) : DEFAULTS.delayMinutes,
          mode,
          ...(token === undefined ? {} : { token }),
          ...(username === undefined ? {} : { username, password }),
        });
        await writeConfig(nextConfig);

        context = ctx;
        cancel();
        config = nextConfig;
        configError = undefined;
        ctx.ui.setStatus("idle-notification", `ntfy ready · ${config.mode === "immediate" ? "immediate" : `${config.delayMinutes}m delay`}`);
        ctx.ui.notify(`ntfy configuration saved to ${CONFIG_PATH} with ${config.mode} mode.`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not configure ntfy: ${message}`, "error");
      } finally {
        suppressUiPromptNotifications = false;
      }
    },
  });
}
