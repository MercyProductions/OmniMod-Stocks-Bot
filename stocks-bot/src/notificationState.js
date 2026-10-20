const DEFAULT_RETRY_MS = 5 * 60_000;

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

export function notificationRetryReady(state, name, nowMs = Date.now(), retryMs = DEFAULT_RETRY_MS) {
  if (state?.[`${name}PostedAt`]) return false;
  const attemptedAt = timestamp(state?.[`${name}AttemptedAt`]);
  return attemptedAt === null || (nowMs >= attemptedAt && nowMs - attemptedAt >= retryMs);
}

export function markNotificationAttempt(state, name, now = new Date()) {
  return { ...(state || {}), [`${name}AttemptedAt`]: now.toISOString() };
}

export function markNotificationPosted(state, name, message, now = new Date()) {
  if (!message) return { ...(state || {}) };
  return { ...(state || {}), [`${name}PostedAt`]: now.toISOString(), [`${name}MessageId`]: message.id || '' };
}
