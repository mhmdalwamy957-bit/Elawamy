import { createHmac } from 'node:crypto';

export function createPublicRateLimitKey(name, clientIp, secret) {
  const normalizedName = String(name || '').trim();
  const normalizedIp = String(clientIp || '').trim();
  const normalizedSecret = String(secret || '').trim();
  if (!normalizedName || !normalizedIp || !normalizedSecret) throw new Error('PUBLIC_RATE_LIMIT_KEY_INVALID');
  return createHmac('sha256', normalizedSecret).update(`${normalizedName}\0${normalizedIp}`).digest('hex');
}

export function getPublicRateLimitWindow(stored = {}, nowMs = Date.now(), windowMs = 60_000, maxRequests = 60) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(windowMs) || windowMs <= 0 || !Number.isInteger(maxRequests) || maxRequests < 1) {
    throw new Error('PUBLIC_RATE_LIMIT_CONFIG_INVALID');
  }

  const storedStart = Number(stored?.windowStartMs);
  const storedCount = Number(stored?.count);
  const isCurrentWindow = Number.isFinite(storedStart)
    && Number.isFinite(storedCount)
    && storedStart <= nowMs
    && nowMs - storedStart < windowMs;
  const windowStartMs = isCurrentWindow ? storedStart : nowMs;
  const count = isCurrentWindow ? Math.max(0, Math.floor(storedCount)) : 0;

  if (count >= maxRequests) {
    return {
      allowed: false,
      windowStartMs,
      count,
      retryAfter: Math.max(1, Math.ceil((windowStartMs + windowMs - nowMs) / 1000)),
      expiresAtMs: windowStartMs + windowMs * 2
    };
  }

  return {
    allowed: true,
    windowStartMs,
    count: count + 1,
    retryAfter: 0,
    expiresAtMs: windowStartMs + windowMs * 2
  };
}
