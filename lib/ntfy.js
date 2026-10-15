const NOTIFY_TIMEOUT_MS = 5_000;

export async function sendNotification(config, title, body, signal) {
  const headers = new Headers({
    Title: title,
    Tags: "robot,eyes",
    "Content-Type": "text/plain; charset=utf-8",
  });
  if (config.token) headers.set("Authorization", `Bearer ${config.token}`);
  else if (config.username && config.password) {
    headers.set("Authorization", `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`);
  }

  const timeoutController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, NOTIFY_TIMEOUT_MS);
  try {
    const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
    const response = await fetch(`${config.server}/${encodeURIComponent(config.topic)}`, {
      method: "POST",
      headers,
      body,
      signal: requestSignal,
    });
    if (!response.ok) throw new Error(`ntfy returned HTTP ${response.status} ${response.statusText}`);
  } catch (error) {
    if (timedOut) throw new Error(`ntfy request timed out after ${NOTIFY_TIMEOUT_MS / 1000} seconds.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
