
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

export function validateConfig(value: unknown): NotificationConfig;
export function getLatestAssistantResponse(entries: unknown): unknown;
export function isAwaitingUserInput(message: unknown): boolean;
export function createAwaitingInputState(): {
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
};
export const DEFAULTS: Readonly<{
 server: "https://ntfy.sh";
 delayMinutes: 15;
 mode: "idle";
}>
