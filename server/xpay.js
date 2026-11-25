import crypto from 'crypto';

const XPAY_API_BASE = String(process.env.XPAY_API_BASE || 'https://api.xpay.app').replace(/\/$/, '');

export class XPayApiError extends Error {
  constructor(message, { status = 500, code = 'xpay_error', requestId = '' } = {}) {
    super(message);
    this.name = 'XPayApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

function requiredSecret() {
  const secret = String(process.env.XPAY_SECRET_KEY || '').trim();
  if (!secret) {
    throw new XPayApiError('XPAY_NOT_CONFIGURED', { status: 503, code: 'XPAY_NOT_CONFIGURED' });
  }
  return secret;
}

export function getXPayConfig() {
  const secretKey = String(process.env.XPAY_SECRET_KEY || '').trim();
  const webhookSecret = String(process.env.XPAY_WEBHOOK_SECRET || '').trim();
  const modeFromKey = secretKey.startsWith('sk_live_') ? 'live' : secretKey.startsWith('sk_test_') ? 'test' : 'unknown';
  const configured = Boolean(secretKey && webhookSecret && modeFromKey !== 'unknown');

  return {
    configured,
    mode: modeFromKey,
    apiBase: XPAY_API_BASE
  };
}

function asJsonSafe(value) {
  if (value == null) return {};
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return { raw: String(value) };
  }
}

async function xpayRequest(path, { method = 'GET', body = undefined, idempotencyKey = undefined } = {}) {
  const secret = requiredSecret();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const headers = {
      Authorization: `Bearer ${secret}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    };

    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    const response = await fetch(`${XPAY_API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });

    const raw = await response.text();
    const data = asJsonSafe(raw);
    const requestId = response.headers.get('x-request-id') || data?.request_id || '';

    if (!response.ok) {
      const error = data?.error || {};
      throw new XPayApiError(
        error.message || `XPay request failed (${response.status})`,
        {
          status: response.status,
          code: error.code || error.type || 'xpay_http_error',
          requestId
        }
      );
    }

    return data;
  } catch (error) {
    if (error instanceof XPayApiError) throw error;
    if (error?.name === 'AbortError') {
      throw new XPayApiError('XPAY_TIMEOUT', { status: 504, code: 'XPAY_TIMEOUT' });
    }
    throw new XPayApiError(error?.message || 'XPAY_NETWORK_ERROR', {
      status: 502,
      code: 'XPAY_NETWORK_ERROR'
    });
  } finally {
    clearTimeout(timeout);
  }
}

function minorUnits(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new XPayApiError('INVALID_ORDER_TOTAL', { status: 409, code: 'INVALID_ORDER_TOTAL' });
  const minor = Math.round(n * 100);
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new XPayApiError('INVALID_ORDER_TOTAL', { status: 409, code: 'INVALID_ORDER_TOTAL' });
  }
  return minor;
}

export async function createXPayCheckoutSession({
  orderId,
  serviceName,
  totalPrice,
  returnUrl,
  cancelUrl,
  idempotencyKey,
  bookingId = null
}) {
  const amount = minorUnits(totalPrice);
  const payload = {
    mode: 'payment',
    uiMode: 'hosted',
    locale: 'ar',
    currency: 'EGP',
    lineItems: [
      {
        priceData: {
          currency: 'EGP',
          unitAmount: amount,
          productData: {
            name: String(serviceName || 'طلب ElaWamy').slice(0, 200),
            description: `طلب ElaWamy رقم ${String(orderId).slice(0, 40)}`
          }
        },
        quantity: 1
      }
    ],
    afterCompletion: {
      type: 'redirect',
      redirect: { url: String(returnUrl) }
    },
    cancelUrl: String(cancelUrl),
    metadata: bookingId
      ? { orderId: String(orderId), bookingId: String(bookingId), context: 'barber_booking', platform: 'elawamy' }
      : { orderId: String(orderId), platform: 'elawamy' }
  };

  return xpayRequest('/checkout/sessions', {
    method: 'POST',
    body: payload,
    idempotencyKey
  });
}

export async function getXPayCheckoutSession(sessionId) {
  const safeId = encodeURIComponent(String(sessionId));
  return xpayRequest(`/checkout/sessions/${safeId}`);
}

export async function createXPayRefund({ paymentIntentId, orderId, reason = 'requested_by_customer' }) {
  const pi = String(paymentIntentId || '').trim();
  if (!pi) {
    throw new XPayApiError('XPAY_PAYMENT_INTENT_MISSING', { status: 409, code: 'XPAY_PAYMENT_INTENT_MISSING' });
  }

  return xpayRequest('/refunds', {
    method: 'POST',
    body: {
      paymentIntentId: pi,
      reason,
      metadata: {
        orderId: String(orderId),
        platform: 'elawamy'
      }
    },
    idempotencyKey: `elawamy-refund-${String(orderId)}`
  });
}

export function verifyXPaySignature(rawBody, header, secret = process.env.XPAY_WEBHOOK_SECRET) {
  const webhookSecret = String(secret || '').trim();
  if (!webhookSecret || !rawBody || !header) return { valid: false };

  const parts = Object.fromEntries(
    String(header).split(',').map(part => {
      const [key, ...rest] = part.split('=');
      return [key, rest.join('=')];
    })
  );

  const timestamp = Number.parseInt(parts.t || '', 10);
  const received = String(parts.v1 || '');
  if (!Number.isFinite(timestamp) || !received) return { valid: false };

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) return { valid: false };

  const bodyText = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const computed = crypto
    .createHmac('sha256', webhookSecret)
    .update(`${timestamp}.${bodyText}`)
    .digest('hex');

  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length) return { valid: false };
  if (!crypto.timingSafeEqual(a, b)) return { valid: false };

  try {
    return { valid: true, event: JSON.parse(bodyText) };
  } catch {
    return { valid: false };
  }
}
