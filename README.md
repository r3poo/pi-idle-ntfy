# pi-idle-notification

Send [ntfy](https://ntfy.sh) push notifications when Pi needs your attention. Choose a persistent idle mode, which waits for a configurable delay after a response, or immediate mode, which alerts as soon as a response settles or an extension-owned UI prompt opens.

## Install

From the package directory:

```sh
pi install .
```

Or directly from git:
```sh
pi install git:https://github.com/r3poo/pi-idle-ntfy
```


Review extension code before installing: Pi extensions run inside the Pi process.

## Configure

Run `/idle-ntfy setup` in Pi to enter your ntfy topic, server, alert delay, notification mode, and optional authentication. The command saves the configuration to `~/.pi/agent/idle-notification.json` with owner-only file permissions. It asks before replacing an existing configuration. After setup, the settings take effect immediately; no restart is needed. Run `/idle-ntfy mode` to switch between idle and immediate mode; the selected mode is saved across restarts.

The topic is required. Choose a long, unguessable topic if using the public `ntfy.sh` server; anyone who knows the topic name can subscribe or publish. By default, alerts go to `https://ntfy.sh` and are sent after 15 minutes. Run `/idle-ntfy` to show the current status, or `/idle-ntfy test` to send an immediate test notification to the configured topic.

You can also create `~/.pi/agent/idle-notification.json` manually:

```json
{
  "topic": "replace-with-a-private-topic",
  "delayMinutes": 15
}
```

Optional settings:

- `server`: ntfy server URL, for example `https://ntfy.example.com`.
- `delayMinutes`: delay from Pi settling while awaiting input, or from an extension UI prompt opening, in `idle` mode; number from `0` to `10080` (7 days). Zero sends immediately for responses; UI prompt alerts retain a 100 ms grace period to avoid stale alerts for quickly resolved prompts.
- `mode`: `idle` (default) waits `delayMinutes` after Pi settles awaiting your input; `immediate` sends as soon as Pi settles awaiting your input and when an extension-owned UI prompt opens. Mode changes made with `/idle-ntfy mode` persist in the configuration file.
- `token`: ntfy bearer token. Alternatively, supply both `username` and `password` for basic authentication. Do not commit credentials to a project repository.

Example with an authenticated self-hosted server:

```json
{
  "topic": "replace-with-a-private-topic",
  "server": "https://ntfy.example.com",
  "delayMinutes": 10,
  "token": "tk_replace_me"
}
```

After manually creating or changing the configuration, restart Pi or use `/reload`. Run `/idle-ntfy` to check whether the extension loaded its configuration and which mode is selected.

## Behavior and limitations

- Both modes check Pi's last assistant message when the agent settles. A completed text response (`stopReason: "stop"`) without a tool call counts as awaiting your input; tool handoffs, errors, and aborted runs do not trigger this response alert.
- In `idle` mode, the extension waits the configured delay before sending an alert for either a completed response or an extension-owned UI prompt that remains open. If a prompt opens while a response alert is already pending, the existing timer is kept. In `immediate` mode, response alerts are sent without waiting and prompt alerts are deferred by 100 milliseconds so a quickly resolved prompt does not send a stale notification. A prompt that closes before an idle alert is due cancels that alert unless Pi is still waiting for a completed response.
- Any terminal input while Pi is waiting cancels the pending alert, including non-message keys such as arrows and control-key combinations. The alert stays disarmed while Pi is waiting and is re-armed only after the agent runs and settles again waiting for input. A new user message, a new agent run, session replacement, reload, or shutdown also cancels a pending alert. Keyboard activity detection is available in interactive TUI mode only; a modifier key pressed by itself may not produce terminal input.
- Alerts do not include prompt or response contents. Idle alerts include the working-directory path and elapsed delay; immediate alerts use a generic attention title and may identify the type of UI prompt.
- Pi's public extension API does not identify whether an extension-owned UI prompt is specifically a permission approval; immediate mode therefore alerts for all such prompts without labeling them as approvals. Built-in or third-party permission prompts that do not use Pi's extension UI prompt events may not be detected. Model-generated questions and prose requests for permission are not a structured signal, so any final assistant response awaiting a user turn is treated as potentially actionable.
- The timer is session-local; it is not persisted across Pi process shutdown or restart.
- Notifications require network access to the configured server. A failed request is logged in Pi's console and shown in the UI when available.

## Development

```sh
npm test
```
