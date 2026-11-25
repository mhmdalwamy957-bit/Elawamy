import crypto from 'crypto';
import dotenv from "dotenv";
dotenv.config({ path: process.env.HOME + "/elawamy-secrets/.env" });
import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';
import { createOrder } from './order-service.js';
import { normalizeBarberClosedDates, getBarberClosureReason } from './barber-schedule-rules.js';
import { createPublicRateLimitKey, getPublicRateLimitWindow } from './public-rate-limit-rules.js';
import {
  confirmDemoPayment,
  confirmXPayPayment,
  markXPayPaymentFailed,
  recordXPayRefund,
  beginXPayRefund,
  completeOrderAndRelease,
  cancelOrder,
  requestWithdrawal,
  processWithdrawal,
  getFinanceConfig,
  getSellerLevel,
  getSellerDirectPaymentProfile,
  saveSellerDirectPaymentProfile,
  startDirectPayment,
  submitDirectPayment,
  confirmDirectPayment,
  rejectDirectPayment,
  listPlatformFeeDue,
  markPlatformFeePaid
} from './finance.js';
import {
  XPayApiError,
  getXPayConfig,
  createXPayCheckoutSession,
  createXPayRefund,
  verifyXPaySignature
} from './xpay.js';
let serviceAccount;

try {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not configured');
  }

  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (error) {
  console.error('FIREBASE SERVICE ACCOUNT ERROR:', error.message);
  throw error;
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const app = express();
if (process.env.VERCEL === '1') app.set('trust proxy', 1);

const ALLOWED_ORIGINS = new Set([
  'https://elawamy-8d7e9.web.app'
]);
const LOCAL_DEV_ORIGINS = new Set([
  'http://localhost:5000',
  'http://127.0.0.1:5000',
  'http://localhost:5001',
  'http://127.0.0.1:5001'
]);
const allowLocalDevOrigins = !process.env.VERCEL && process.env.NODE_ENV !== 'production';

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.has(origin) || (allowLocalDevOrigins && LOCAL_DEV_ORIGINS.has(origin))) {
      return callback(null, true);
    }

    return callback(null, false);
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS']
}));

app.use('/api/webhooks/xpay', express.raw({ type: 'application/json', limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BUCKET = 'elawamy-files';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'
  );
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

function canUploadForOrder(order, role) {
  if (role === 'buyer') {
    return order.status === 'pending';
  }

  if (role === 'seller') {
    return (
      order.status === 'accepted' ||
      order.status === 'revision_requested'
    );
  }

  return false;
}

async function storageObjectInfo(path) {
  if (!path || typeof path !== 'string') {
    return null;
  }

  try {
    const { data, error } = await supabase
      .storage
      .from(BUCKET)
      .info(path);

    if (error) {
      console.error('STORAGE FILE INFO ERROR:', error.message);
      return null;
    }

    return data || null;
  } catch (error) {
    console.error(
      'STORAGE FILE INFO ERROR:',
      error?.message || 'Unknown error'
    );
    return null;
  }
}


async function requireFirebaseUser(req, res, next) {
  try {
    const header = req.headers.authorization || '';

    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Missing Firebase Authorization token'
      });
    }

    const token = header.slice(7);

    req.user = await admin.auth().verifyIdToken(token, true);

    next();
  } catch (error) {
    console.error('AUTH ERROR:', error.message);

    return res.status(401).json({
      error: 'Invalid Firebase authentication token'
    });
  }
}


const USER_CONTROL_PERMISSIONS = [
  'buying',
  'barberBooking',
  'payments',
  'cancelOrder',
  'selling',
  'createService',
  'editService',
  'serviceStatus',
  'portfolio',
  'orderActions',
  'chat',
  'orderChat',
  'customOffers',
  'reviews',
  'files',
  'wallet',
  'paymentProfile',
  'withdraw',
  'affiliate',
  'community',
  'support',
  'disputes',
  'favorites',
  'favoriteGroups',
  'follow',
  'serviceRequests',
  'notifications',
  'profileEdit',
  'verification'
];

function normalizeUserControls(data = {}) {
  const disabledFeatures = Array.isArray(data.disabledFeatures)
    ? [...new Set(data.disabledFeatures.map(value => String(value).trim()).filter(value => USER_CONTROL_PERMISSIONS.includes(value)))]
    : [];

  return {
    disabledFeatures,
    reason: typeof data.reason === 'string' ? data.reason.slice(0, 500) : '',
    updatedBy: data.updatedBy || null,
    updatedAt: data.updatedAt || null
  };
}

async function getUserControls(db, uid) {
  const snap = await db.collection('userControls').doc(uid).get();
  return snap.exists ? normalizeUserControls(snap.data()) : {
    disabledFeatures: [],
    reason: '',
    updatedBy: null,
    updatedAt: null
  };
}

function requireUserPermission(permission) {
  if (!USER_CONTROL_PERMISSIONS.includes(permission)) {
    throw new Error(`Unknown user permission: ${permission}`);
  }

  return async (req, res, next) => {
    try {
      if (!req.user?.uid) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Admins keep an emergency override so the control panel cannot lock itself out.
      if (req.user.admin === true) {
        return next();
      }

      const controls = await getUserControls(admin.firestore(), req.user.uid);
      if (controls.disabledFeatures.includes(permission)) {
        return res.status(403).json({
          error: 'FEATURE_DISABLED',
          feature: permission,
          message: 'هذه الميزة موقوفة لهذا الحساب من الإدارة.'
        });
      }

      req.userControls = controls;
      return next();
    } catch (error) {
      console.error(`USER PERMISSION CHECK ERROR [${permission}]:`, error);
      return res.status(500).json({ error: 'Could not check account permissions' });
    }
  };
}


function publicRateLimit({ name, maxRequests, windowMs = 60_000 }) {
  return async (req, res, next) => {
    try {
      const clientIp = String(req.ip || '').trim();
      if (!clientIp) return res.status(503).json({ error: 'Rate limit identity is unavailable.' });

      const db = admin.firestore();
      const keySecret = process.env.PUBLIC_RATE_LIMIT_HASH_SECRET || SUPABASE_SERVICE_ROLE_KEY;
      const key = createPublicRateLimitKey(name, clientIp, keySecret);
      const ref = db.collection('_publicRateLimits').doc(key);
      const now = Date.now();
      let decision;

      await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        decision = getPublicRateLimitWindow(snap.exists ? snap.data() : {}, now, windowMs, maxRequests);
        if (!decision.allowed) {
          const error = new Error('PUBLIC_RATE_LIMIT_EXCEEDED');
          error.retryAfter = decision.retryAfter;
          throw error;
        }
        tx.set(ref, {
          count: decision.count,
          windowStartMs: decision.windowStartMs,
          expiresAt: admin.firestore.Timestamp.fromMillis(decision.expiresAtMs),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      });

      return next();
    } catch (error) {
      if (error?.message === 'PUBLIC_RATE_LIMIT_EXCEEDED') {
        res.set('Retry-After', String(error.retryAfter));
        return res.status(429).json({ error: 'Too many requests. Please try again later.', retryAfter: error.retryAfter });
      }
      console.error('PUBLIC RATE LIMIT ERROR:', error?.message || error);
      return res.status(503).json({ error: 'Request protection is temporarily unavailable.' });
    }
  };
}

function rateLimit({ name, maxRequests, windowMs = 60_000 }) {
  return async (req, res, next) => {
    try {
      const uid = req.user?.uid;
      if (!uid) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const db = admin.firestore();
      const ref = db
        .collection('_rateLimits')
        .doc(`${uid}__${name}`);

      const now = Date.now();

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);

        let windowStartMs = now;
        let count = 0;

        if (snap.exists) {
          const data = snap.data() || {};
          const storedStart = Number(data.windowStartMs);
          const storedCount = Number(data.count);

          if (
            Number.isFinite(storedStart) &&
            Number.isFinite(storedCount) &&
            now - storedStart < windowMs
          ) {
            windowStartMs = storedStart;
            count = storedCount;
          }
        }

        if (count >= maxRequests) {
          const retryAfter = Math.max(
            1,
            Math.ceil((windowStartMs + windowMs - now) / 1000)
          );

          const error = new Error('RATE_LIMIT_EXCEEDED');
          error.retryAfter = retryAfter;
          throw error;
        }

        tx.set(
          ref,
          {
            count: count + 1,
            windowStartMs,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      });

      next();
    } catch (error) {
      if (error?.message === 'RATE_LIMIT_EXCEEDED') {
        res.set('Retry-After', String(error.retryAfter));
        return res.status(429).json({
          error: 'Too many requests. Please try again later.',
          retryAfter: error.retryAfter
        });
      }

      console.error('RATE LIMIT ERROR:', error);
      return res.status(500).json({
        error: 'Internal server error'
      });
    }
  };
}

async function recalculateServiceRating(serviceId) {
  const db = admin.firestore();
  const serviceRef = db.collection('services').doc(serviceId);
  const serviceSnap = await serviceRef.get();

  if (!serviceSnap.exists) {
    throw new Error('SERVICE_NOT_FOUND');
  }

  const service = serviceSnap.data() || {};
  const reviewsSnap = await db
    .collection('reviews')
    .where('serviceId', '==', serviceId)
    .get();

  let total = 0;
  let count = 0;

  for (const reviewDoc of reviewsSnap.docs) {
    const data = reviewDoc.data() || {};
    const rating = Number(data.rating);
    if (Number.isFinite(rating) && rating >= 1 && rating <= 5) {
      total += rating;
      count += 1;
    }
  }

  const rating = count > 0
    ? Math.round((total / count) * 10) / 10
    : 0;

  await serviceRef.update({
    rating,
    ratingCount: count,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  const sellerId = String(service.ownerId || '').trim();
  let sellerRating = 0;
  let sellerRatingCount = 0;

  if (sellerId) {
    const sellerServicesSnap = await db
      .collection('services')
      .where('ownerId', '==', sellerId)
      .get();

    let weightedTotal = 0;
    for (const serviceDoc of sellerServicesSnap.docs) {
      const data = serviceDoc.data() || {};
      const serviceCount = Number(data.ratingCount || 0);
      const serviceRating = Number(data.rating || 0);
      if (serviceCount > 0 && Number.isFinite(serviceRating)) {
        weightedTotal += serviceRating * serviceCount;
        sellerRatingCount += serviceCount;
      }
    }

    sellerRating = sellerRatingCount > 0
      ? Math.round((weightedTotal / sellerRatingCount) * 10) / 10
      : 0;

    await db.collection('sellerProfiles').doc(sellerId).set({
      rating: sellerRating,
      ratingCount: sellerRatingCount,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

  }

  return {
    rating,
    ratingCount: count,
    sellerRating,
    sellerRatingCount
  };
}

app.post(
  '/api/reviews/recalculate',
  requireFirebaseUser,
  requireUserPermission('reviews'),
  rateLimit({ name: 'reviews-recalculate', maxRequests: 5 }),
  async (req, res) => {
    try {
      const serviceId = String(
        req.body?.serviceId || ''
      ).trim();

      const orderId = String(
        req.body?.orderId || ''
      ).trim();

      if (!serviceId || !orderId) {
        return res.status(400).json({
          error: 'serviceId and orderId are required'
        });
      }

      const db = admin.firestore();

      const reviewId =
        `${orderId}__${req.user.uid}`;

      const reviewRef = db
        .collection('reviews')
        .doc(reviewId);

      const reviewSnap = await reviewRef.get();

      if (!reviewSnap.exists) {
        return res.status(404).json({
          error: 'Review not found'
        });
      }

      const review = reviewSnap.data();

      if (review.userId !== req.user.uid) {
        return res.status(403).json({
          error: 'Review does not belong to this user'
        });
      }

      if (review.serviceId !== serviceId) {
        return res.status(400).json({
          error: 'Review service mismatch'
        });
      }

      if (review.orderId !== orderId) {
        return res.status(400).json({
          error: 'Review order mismatch'
        });
      }

      const orderSnap = await db
        .collection('orders')
        .doc(orderId)
        .get();

      if (!orderSnap.exists) {
        return res.status(404).json({
          error: 'Order not found'
        });
      }

      const order = orderSnap.data();

      if (order.userId !== req.user.uid) {
        return res.status(403).json({
          error: 'Order does not belong to this user'
        });
      }

      if (order.status !== 'completed') {
        return res.status(400).json({
          error: 'Order is not completed'
        });
      }

      if (order.serviceId !== serviceId) {
        return res.status(400).json({
          error: 'Order service mismatch'
        });
      }

      const serviceSnap = await db
        .collection('services')
        .doc(serviceId)
        .get();

      if (!serviceSnap.exists) {
        return res.status(404).json({
          error: 'Service not found'
        });
      }

      const result =
        await recalculateServiceRating(serviceId);

      const sellerId = String(serviceSnap.data()?.ownerId || '');
      if (sellerId) {
        await db.collection('notifications').doc(`review__${reviewId}`).set({
          userId: sellerId,
          type: 'new_review',
          title: 'تقييم جديد',
          body: `حصلت خدمتك على تقييم ${Number(review.rating) || 0} نجوم.`,
          orderId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          read: false
        }, { merge: false });
      }

      return res.json({
        ok: true,
        serviceId,
        ...result
      });

    } catch (error) {
      console.error(
        'RECALCULATE REVIEW ERROR:',
        error
      );

      return res.status(500).json({
        error: 'Could not recalculate service rating'
      });
    }
  }
);




function barberCleanText(value, max = 160) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function barberParseTime(value) {
  const match = /^(?:([01]\d|2[0-3])):([0-5]\d)$/.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function barberFormatTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function barberCairoNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minute: Number(values.hour) * 60 + Number(values.minute)
  };
}

function barberCairoLocalToEpoch(date, minute) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!match || !Number.isInteger(minute) || minute < 0 || minute > 24 * 60) return null;
  const desired = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Math.floor(minute / 60), minute % 60, 0);
  let guess = desired;
  for (let i = 0; i < 3; i += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(guess));
    const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    const represented = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), 0);
    guess += desired - represented;
  }
  return guess;
}

function barberBookingPurgeAtMs(booking) {
  const date = String(booking?.localDate || '');
  let endMinute = booking?.endMinute === undefined || booking?.endMinute === null ? NaN : Number(booking.endMinute);
  if (!Number.isFinite(endMinute)) {
    const parsed = barberParseTime(booking?.endTime);
    if (parsed !== null) endMinute = parsed;
    else {
      const start = Number.isFinite(Number(booking?.startMinute)) ? Number(booking.startMinute) : barberParseTime(booking?.startTime);
      const duration = Number(booking?.durationMinutes || 30);
      endMinute = Number.isFinite(start) ? start + duration : NaN;
    }
  }
  const endMs = barberCairoLocalToEpoch(date, endMinute);
  return Number.isFinite(endMs) ? endMs + 60 * 60 * 1000 : null;
}

async function barberReleaseExpiredBookingLocks(db, bookingId, nowMs = Date.now()) {
  const bookingRef = db.collection('barberBookings').doc(String(bookingId));

  return db.runTransaction(async tx => {
    const bookingSnap = await tx.get(bookingRef);
    if (!bookingSnap.exists) return { processed: false, locksDeleted: 0 };

    const booking = bookingSnap.data() || {};
    if (booking.locksReleasedAt) {
      return { processed: false, locksDeleted: 0 };
    }

    const purgeAt = barberBookingPurgeAtMs(booking);
    if (!purgeAt || purgeAt > nowMs) {
      return { processed: false, locksDeleted: 0 };
    }

    const lockIds = Array.isArray(booking.lockIds) ? booking.lockIds : [];
    const lockRefs = lockIds.map(id =>
      db.collection('barberBookingLocks').doc(String(id))
    );
    const locks = await Promise.all(lockRefs.map(ref => tx.get(ref)));

    let locksDeleted = 0;
    for (let i = 0; i < locks.length; i += 1) {
      const lockData = locks[i].data() || {};
      if (
        locks[i].exists &&
        String(lockData.bookingId || '') === String(bookingId)
      ) {
        tx.delete(lockRefs[i]);
        locksDeleted += 1;
      }
    }

    // Keep the booking history; release its old locks only.
    tx.update(bookingRef, {
      purgeAt: admin.firestore.FieldValue.delete(),
      locksReleasedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { processed: true, locksDeleted };
  });
}

async function barberCleanupExpiredBookings(db, limit = 20) {
  const nowMs = Date.now();
  const today = barberCairoNow().date;
  const cappedLimit = Math.max(1, Math.min(limit, 250));
  const collection = db.collection('barberBookings');

  const [expiredSnap, pastSnap, todaySnap] = await Promise.all([
    collection
      .where('purgeAt', '<=', admin.firestore.Timestamp.fromMillis(nowMs))
      .orderBy('purgeAt', 'asc')
      .limit(cappedLimit)
      .get()
      .catch(error => {
        console.error('BARBER PURGE-AT QUERY ERROR:', error?.message || error);
        return { docs: [] };
      }),
    // Cover older records created before purgeAt was introduced.
    collection.where('localDate', '<', today).orderBy('localDate', 'asc').limit(cappedLimit).get(),
    collection.where('localDate', '==', today).limit(cappedLimit).get()
  ]);

  const unique = new Map();
  for (const snap of [...expiredSnap.docs, ...pastSnap.docs, ...todaySnap.docs]) {
    unique.set(snap.id, snap);
  }

  let processed = 0;
  let locksReleased = 0;

  for (const snap of unique.values()) {
    const booking = snap.data() || {};
    if (booking.locksReleasedAt) continue;

    const purgeAt = barberBookingPurgeAtMs(booking);
    if (!purgeAt || purgeAt > nowMs) continue;

    const result = await barberReleaseExpiredBookingLocks(db, snap.id, nowMs);
    if (result.processed) processed += 1;
    locksReleased += result.locksDeleted;
  }

  // Keep the old response field for compatibility; no booking records are deleted.
  return { checked: unique.size, deleted: 0, processed, locksReleased };
}

async function cleanupExpiredPublicRateLimits(db, limit = 400) {
  const now = admin.firestore.Timestamp.fromMillis(Date.now());
  const snap = await db.collection('_publicRateLimits').where('expiresAt', '<=', now).limit(Math.max(1, Math.min(limit, 500))).get();
  if (snap.empty) return 0;
  const batch = db.batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
  return snap.size;
}

async function barberLogAudit(db, shopId, req, action, targetType, targetId, summary) {
  try {
    await db.collection('barberShops').doc(String(shopId)).collection('auditLog').add({
      actorId: String(req?.user?.uid || ''),
      actorLabel: barberCleanText(req?.user?.email || req?.user?.name || req?.user?.uid || 'حساب الصالون', 200),
      action: barberCleanText(action, 80), targetType: barberCleanText(targetType, 40),
      targetId: barberCleanText(targetId || '', 150), summary: barberCleanText(summary || '', 500),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (error) {
    console.error('BARBER AUDIT LOG ERROR:', error?.message || error);
  }
}

function barberTimestampIso(value) {
  return value?.toDate?.()?.toISOString?.() || null;
}

function barberValidateDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('INVALID_BOOKING_DATE');
  const parsed = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) throw new Error('INVALID_BOOKING_DATE');
  const today = barberCairoNow().date;
  const day = Date.parse(`${date}T12:00:00Z`);
  const start = Date.parse(`${today}T12:00:00Z`);
  if (day < start) throw new Error('BOOKING_DATE_IN_PAST');
  if (day > start + 90 * 24 * 60 * 60 * 1000) throw new Error('BOOKING_DATE_TOO_FAR');
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function barberLockId(shopId, barberId, date, minute) {
  const safe = value => String(value).replace(/[^A-Za-z0-9_-]/g, '_');
  return `${safe(shopId)}__${safe(barberId)}__${date.replace(/-/g, '')}__${minute}`;
}

function barberLockExpired(data, nowMs = Date.now()) {
  const value = data?.expiresAt;
  if (!value) return false;
  const expiresAt = typeof value.toMillis === 'function' ? value.toMillis() : Number(value);
  return Number.isFinite(expiresAt) && expiresAt <= nowMs;
}

async function barberPublicShop(snap) {
  const data = snap.data() || {};
  return {
    id: snap.id,
    name: data.name || '',
    phone: data.phone || '',
    city: data.city || '',
    address: data.address || '',
    description: data.description || '',
    imageUrl: data.imageUrl || await barberPhotoUrl(data.imagePath),
    openTime: data.openTime || '09:00',
    closeTime: data.closeTime || '21:00',
    closedDays: Array.isArray(data.closedDays) ? data.closedDays : [],
    closedDates: Array.isArray(data.closedDates) ? data.closedDates : [],
    // One-off salon holidays are public availability information; audit metadata stays private.
    // Missing status is treated as pending (fail closed).
    status: data.status || 'pending'
  };
}

async function barberPublicProfile(snap) {
  const data = snap.data() || {};
  return {
    id: snap.id,
    name: data.name || 'الحلاق',
    active: data.active === true,
    imageUrl: data.imageUrl || await barberPhotoUrl(data.imagePath),
    rating: Number(data.rating || 0),
    ratingCount: Number(data.ratingCount || 0)
  };
}

function barberEffectiveSchedule(shop, barber = {}) {
  const shopOpen = barberParseTime(shop?.openTime || '09:00');
  const shopClose = barberParseTime(shop?.closeTime || '21:00');
  const requestedOpen = barberParseTime(barber?.openTime || shop?.openTime || '09:00');
  const requestedClose = barberParseTime(barber?.closeTime || shop?.closeTime || '21:00');
  return {
    // Individual hours may narrow the salon hours, but can never open the salon early or keep it open late.
    openMinute: shopOpen === null || requestedOpen === null ? null : Math.max(shopOpen, requestedOpen),
    closeMinute: shopClose === null || requestedClose === null ? null : Math.min(shopClose, requestedClose)
  };
}

function barberAvailabilityStart(shop, date, dayOfWeek, barber = {}) {
  const schedule = barberEffectiveSchedule(shop, barber);
  const openMinute = schedule.openMinute;
  const closeMinute = schedule.closeMinute;
  if (openMinute === null || closeMinute === null || closeMinute <= openMinute) throw new Error('INVALID_SHOP_SCHEDULE');
  const closureReason = getBarberClosureReason(shop, barber, date, dayOfWeek);
  if (closureReason) return { openMinute, closeMinute, closed: true, closureReason };
  const now = barberCairoNow();
  return { openMinute, closeMinute, closed: false, currentMinute: now.date === date ? now.minute : -1 };
}

function barberClaimCodeHash(code) {
  return crypto.createHash('sha256').update(String(code || '').toLowerCase()).digest('hex');
}

function barberNewClaimCode() {
  return crypto.randomBytes(12).toString('hex');
}

const BARBER_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const BARBER_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

async function barberPhotoUrl(path) {
  if (!path || typeof path !== 'string') return '';
  try {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 24 * 7);
    if (!error && data?.signedUrl) return data.signedUrl;
  } catch (error) {
    console.error('BARBER PHOTO URL ERROR:', error?.message || error);
  }
  try {
    return supabase.storage.from(BUCKET).getPublicUrl(path).data?.publicUrl || '';
  } catch {
    return '';
  }
}

async function barberVerifyImagePath(path, expectedPrefix) {
  if (typeof path !== 'string' || !path.startsWith(expectedPrefix) || path.includes('..') || path.length > 500) {
    throw new Error('BARBER_IMAGE_PATH_INVALID');
  }
  const info = await storageObjectInfo(path);
  if (!info) throw new Error('BARBER_IMAGE_NOT_FOUND');
  const contentType = String(info.contentType || '').toLowerCase();
  const size = Number(info.size);
  if (!BARBER_IMAGE_TYPES.has(contentType) || !Number.isFinite(size) || size < 1 || size > BARBER_IMAGE_MAX_BYTES) {
    throw new Error('BARBER_IMAGE_INVALID');
  }
  return path;
}

async function barberGetResources(db, shopId, serviceId, barberId) {
  const shopRef = db.collection('barberShops').doc(shopId);
  const serviceRef = shopRef.collection('services').doc(serviceId);
  const barberRef = shopRef.collection('barbers').doc(barberId);
  const [shopSnap, serviceSnap, barberSnap] = await Promise.all([shopRef.get(), serviceRef.get(), barberRef.get()]);
  if (!shopSnap.exists || shopSnap.data()?.status !== 'active') throw new Error('BARBER_SHOP_NOT_FOUND');
  if (!serviceSnap.exists || serviceSnap.data()?.active !== true) throw new Error('BARBER_SERVICE_NOT_FOUND');
  if (!barberSnap.exists || barberSnap.data()?.active !== true) throw new Error('BARBER_NOT_FOUND');
  return {
    shopRef, serviceRef, barberRef,
    shop: shopSnap.data(), service: serviceSnap.data(), barber: barberSnap.data()
  };
}

async function barberConfirmXPayPayment(db, session) {
  const bookingId = barberCleanText(session?.metadata?.bookingId, 150);
  const sessionId = barberCleanText(session?.id, 200);
  const amount = Number(session?.amountTotal) / 100;
  if (!bookingId || !sessionId || !Number.isFinite(amount)) throw new Error('BARBER_XPAY_METADATA_INVALID');
  if (String(session?.currency || 'EGP').toUpperCase() !== 'EGP') throw new Error('BARBER_XPAY_CURRENCY_MISMATCH');
  const ref = db.collection('barberBookings').doc(bookingId);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, needsRefund: true, bookingId };
    const booking = snap.data() || {};
    if (booking.paymentStatus === 'paid' && booking.xpayCheckoutSessionId === sessionId) return { ok: true, alreadyPaid: true, bookingId };
    if (booking.xpayCheckoutSessionId !== sessionId) return { ok: false, needsRefund: true, bookingId };
    const holdUntil = booking.paymentHoldExpiresAt?.toMillis?.() || 0;
    if (booking.status !== 'pending_payment' || booking.paymentStatus !== 'pending' || holdUntil <= Date.now()) {
      if (booking.status === 'pending_payment') {
        const lockIds = Array.isArray(booking.lockIds) ? booking.lockIds : [];
        const lockRefs = lockIds.map(id => db.collection('barberBookingLocks').doc(id));
        const locks = await Promise.all(lockRefs.map(lockRef => tx.get(lockRef)));
        for (let i = 0; i < locks.length; i += 1) if (locks[i].exists && locks[i].data()?.bookingId === bookingId) tx.delete(lockRefs[i]);
        tx.update(ref, { status: 'cancelled', paymentStatus: 'expired', cancelledAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
      return { ok: false, needsRefund: true, bookingId };
    }
    const lockIds = Array.isArray(booking.lockIds) ? booking.lockIds : [];
    const lockRefs = lockIds.map(id => db.collection('barberBookingLocks').doc(id));
    const locks = await Promise.all(lockRefs.map(lockRef => tx.get(lockRef)));
    if (Math.round(Number(booking.price) * 100) !== Math.round(amount * 100)) {
      for (let i = 0; i < locks.length; i += 1) if (locks[i].exists && locks[i].data()?.bookingId === bookingId) tx.delete(lockRefs[i]);
      tx.update(ref, { status: 'cancelled', paymentStatus: 'refund_pending', paymentFailureReason: 'amount_mismatch', cancelledAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return { ok: false, needsRefund: true, bookingId };
    }
    for (let i = 0; i < locks.length; i += 1) {
      if (locks[i].exists && locks[i].data()?.bookingId === bookingId) tx.update(lockRefs[i], { expiresAt: null });
    }
    tx.update(ref, {
      status: 'confirmed', paymentStatus: 'paid', paymentProvider: 'xpay', paymentHoldExpiresAt: null,
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      xpayPaymentIntentId: session?.paymentIntent?.id || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { ok: true, bookingId, alreadyPaid: false };
  });
}

async function barberFailXPayPayment(db, session, reason = 'payment_failed') {
  const bookingId = barberCleanText(session?.metadata?.bookingId, 150);
  const sessionId = barberCleanText(session?.id, 200);
  if (!bookingId || !sessionId) return { ok: false, skipped: true };
  const bookingRef = db.collection('barberBookings').doc(bookingId);
  return db.runTransaction(async tx => {
    const snap = await tx.get(bookingRef);
    if (!snap.exists) return { ok: false, skipped: true };
    const booking = snap.data() || {};
    if (booking.paymentStatus === 'paid' || booking.status !== 'pending_payment') return { ok: true, ignored: true };
    if (booking.xpayCheckoutSessionId && booking.xpayCheckoutSessionId !== sessionId) return { ok: true, ignored: true };
    const lockIds = Array.isArray(booking.lockIds) ? booking.lockIds : [];
    const lockRefs = lockIds.map(id => db.collection('barberBookingLocks').doc(id));
    const locks = await Promise.all(lockRefs.map(ref => tx.get(ref)));
    for (let i = 0; i < locks.length; i += 1) {
      if (locks[i].exists && locks[i].data()?.bookingId === bookingId) tx.delete(lockRefs[i]);
    }
    tx.update(bookingRef, {
      status: 'cancelled', paymentStatus: 'failed', paymentFailureReason: String(reason).slice(0, 120),
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { ok: true, bookingId };
  });
}

app.get('/api/barbershops', publicRateLimit({ name: 'barber-shops-list', maxRequests: 60 }), async (_req, res) => {
  try {
    const db = admin.firestore();
    const snap = await db.collection('barberShops').where('status', '==', 'active').limit(100).get();
    const shops = (await Promise.all(snap.docs.map(barberPublicShop))).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    return res.json({ ok: true, shops });
  } catch (error) {
    console.error('BARBER SHOP LIST ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر تحميل صالونات الحلاقة.' });
  }
});

app.get('/api/barbershops/mine', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-shops-mine', maxRequests: 40 }), async (req, res) => {
  try {
    const snap = await admin.firestore().collection('barberShops').where('ownerId', '==', req.user.uid).limit(30).get();
    const shops = await Promise.all(snap.docs.map(async shopSnap => ({
      ...await barberPublicShop(shopSnap),
      updatedAt: barberTimestampIso(shopSnap.data()?.updatedAt),
      lastUpdatedBy: shopSnap.data()?.lastUpdatedBy || shopSnap.data()?.updatedBy || '',
      reviewNote: barberCleanText(shopSnap.data()?.reviewNote || '', 500)
    })));
    return res.json({ ok: true, shops });
  } catch (error) {
    console.error('MY BARBER SHOPS ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر تحميل صالوناتك.' });
  }
});

app.get('/api/barbershops/:shopId/manage', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-shop-manage', maxRequests: 30 }), async (req, res) => {
  try {
    const db = admin.firestore();
    const shopRef = db.collection('barberShops').doc(barberCleanText(req.params.shopId, 150));
    const shopSnap = await shopRef.get();
    if (!shopSnap.exists) return res.status(404).json({ error: 'الصالون غير موجود.' });
    if (shopSnap.data()?.ownerId !== req.user.uid) return res.status(403).json({ error: 'لا يمكنك إدارة هذا الصالون.' });
    const [servicesSnap, barbersSnap, auditSnap] = await Promise.all([
      shopRef.collection('services').limit(100).get(),
      shopRef.collection('barbers').limit(100).get(),
      shopRef.collection('auditLog').orderBy('createdAt', 'desc').limit(20).get().catch(() => ({ docs: [] }))
    ]);
    const shopData = shopSnap.data() || {};
    const services = servicesSnap.docs.map(doc => ({ id: doc.id, name: doc.data()?.name || '', durationMinutes: Number(doc.data()?.durationMinutes || 30), price: Number(doc.data()?.price || 0), active: doc.data()?.active === true, updatedAt: barberTimestampIso(doc.data()?.updatedAt), lastUpdatedBy: doc.data()?.lastUpdatedBy || doc.data()?.updatedBy || '' }));
    const barbers = await Promise.all(barbersSnap.docs.map(async doc => ({
      id: doc.id, name: doc.data()?.name || 'الحلاق', active: doc.data()?.active === true,
      linked: Boolean(doc.data()?.userId), imageUrl: doc.data()?.imageUrl || await barberPhotoUrl(doc.data()?.imagePath),
      openTime: doc.data()?.openTime || shopData.openTime || '09:00', closeTime: doc.data()?.closeTime || shopData.closeTime || '21:00',
      closedDays: Array.isArray(doc.data()?.closedDays) ? doc.data().closedDays : [],
      closedDates: Array.isArray(doc.data()?.closedDates) ? doc.data().closedDates : [],
      rating: Number(doc.data()?.rating || 0), ratingCount: Number(doc.data()?.ratingCount || 0),
      updatedAt: barberTimestampIso(doc.data()?.updatedAt), lastUpdatedBy: doc.data()?.lastUpdatedBy || doc.data()?.updatedBy || ''
    })));
    const recentChanges = auditSnap.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: barberTimestampIso(doc.data()?.createdAt) }));
    return res.json({ ok: true, shop: { ...await barberPublicShop(shopSnap), updatedAt: barberTimestampIso(shopData.updatedAt), lastUpdatedBy: shopData.lastUpdatedBy || shopData.updatedBy || '', ownerEmail: barberCleanText(req.user.email || '', 200) }, services, barbers, recentChanges });
  } catch (error) {
    console.error('BARBER SHOP MANAGE ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر تحميل إعدادات الصالون.' });
  }
});

app.post('/api/barbershops/:shopId/settings', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-shop-settings-save', maxRequests: 20 }), async (req, res) => {
  try {
    const db = admin.firestore();
    const shopRef = db.collection('barberShops').doc(barberCleanText(req.params.shopId, 150));
    const shopSnap = await shopRef.get();
    if (!shopSnap.exists) return res.status(404).json({ error: 'الصالون غير موجود.' });
    if (shopSnap.data()?.ownerId !== req.user.uid) return res.status(403).json({ error: 'لا يمكنك تعديل هذا الصالون.' });
    const name = barberCleanText(req.body?.name, 100);
    const phone = barberCleanText(req.body?.phone, 24);
    const city = barberCleanText(req.body?.city, 80);
    const address = barberCleanText(req.body?.address, 220);
    const description = barberCleanText(req.body?.description, 700);
    if (name.length < 3 || phone.length < 6 || city.length < 2 || address.length < 3) return res.status(400).json({ error: 'أكمل اسم الصالون والهاتف والمدينة والعنوان.' });
    if (!/^[+0-9 ()-]{6,24}$/.test(phone)) return res.status(400).json({ error: 'رقم الهاتف غير صحيح.' });
    await shopRef.update({ name, phone, city, address, description, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: req.user.uid, lastUpdatedBy: barberCleanText(req.user.email || req.user.uid, 200) });
    await barberLogAudit(db, shopRef.id, req, 'update-shop-profile', 'shop', shopRef.id, 'تعديل بيانات الصالون الأساسية');
    return res.json({ ok: true, shopId: shopRef.id });
  } catch (error) {
    console.error('BARBER SHOP SETTINGS ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر حفظ إعدادات الصالون.' });
  }
});

app.post('/api/barbershops/:shopId/services/:serviceId/settings', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-service-settings-save', maxRequests: 30 }), async (req, res) => {
  try {
    const db = admin.firestore();
    const shopRef = db.collection('barberShops').doc(barberCleanText(req.params.shopId, 150));
    const shopSnap = await shopRef.get();
    if (!shopSnap.exists) return res.status(404).json({ error: 'الصالون غير موجود.' });
    if (shopSnap.data()?.ownerId !== req.user.uid) return res.status(403).json({ error: 'لا يمكنك تعديل خدمات هذا الصالون.' });
    const serviceRef = shopRef.collection('services').doc(barberCleanText(req.params.serviceId, 150));
    const serviceSnap = await serviceRef.get();
    if (!serviceSnap.exists) return res.status(404).json({ error: 'الخدمة غير موجودة.' });
    const name = barberCleanText(req.body?.name, 100);
    const durationMinutes = Number(req.body?.durationMinutes);
    const price = Number(req.body?.price);
    const active = req.body?.active === true;
    if (name.length < 2 || !Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 180 || durationMinutes % 15 !== 0 || !Number.isFinite(price) || price < 1 || price > 100000) return res.status(400).json({ error: 'أدخل اسمًا ومدة وسعرًا صحيحًا للخدمة.' });
    await serviceRef.update({ name, durationMinutes, price: Math.round(price * 100) / 100, active, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: req.user.uid, lastUpdatedBy: barberCleanText(req.user.email || req.user.uid, 200) });
    await barberLogAudit(db, shopRef.id, req, 'update-service', 'service', serviceRef.id, `تعديل الخدمة: ${name}${active ? '' : ' (موقوفة)'}`);
    return res.json({ ok: true, service: { id: serviceRef.id, name, durationMinutes, price, active } });
  } catch (error) {
    console.error('BARBER SERVICE SETTINGS ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر حفظ إعدادات الخدمة.' });
  }
});

app.post('/api/barbershops/:shopId/barbers/:barberId/settings', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-profile-settings-save', maxRequests: 30 }), async (req, res) => {
  try {
    const db = admin.firestore();
    const shopRef = db.collection('barberShops').doc(barberCleanText(req.params.shopId, 150));
    const shopSnap = await shopRef.get();
    if (!shopSnap.exists) return res.status(404).json({ error: 'الصالون غير موجود.' });
    if (shopSnap.data()?.ownerId !== req.user.uid) return res.status(403).json({ error: 'لا يمكنك إدارة حلاقين هذا الصالون.' });
    const barberRef = shopRef.collection('barbers').doc(barberCleanText(req.params.barberId, 150));
    const barberSnap = await barberRef.get();
    if (!barberSnap.exists) return res.status(404).json({ error: 'الحلاق غير موجود.' });
    const name = barberCleanText(req.body?.name, 80);
    const openTime = barberCleanText(req.body?.openTime, 5);
    const closeTime = barberCleanText(req.body?.closeTime, 5);
    const openMinute = barberParseTime(openTime);
    const closeMinute = barberParseTime(closeTime);
    const closedDays = Array.isArray(req.body?.closedDays) ? [...new Set(req.body.closedDays.map(Number))] : [];
    const closedDates = req.body?.closedDates === undefined
      ? normalizeBarberClosedDates(barberSnap.data()?.closedDates || [])
      : normalizeBarberClosedDates(req.body.closedDates);
    const active = req.body?.active === true;
    const shopOpenMinute = barberParseTime(shopSnap.data()?.openTime || '09:00');
    const shopCloseMinute = barberParseTime(shopSnap.data()?.closeTime || '21:00');
    if (name.length < 2 || openMinute === null || closeMinute === null || closeMinute <= openMinute) return res.status(400).json({ error: 'اكتب اسم الحلاق وحدد ساعات عمل صحيحة.' });
    if (shopOpenMinute === null || shopCloseMinute === null || openMinute < shopOpenMinute || closeMinute > shopCloseMinute) return res.status(400).json({ error: `ساعات الحلاق لازم تكون داخل ساعات الصالون (${shopSnap.data()?.openTime || '09:00'} إلى ${shopSnap.data()?.closeTime || '21:00'}).` });
    if (closedDays.length > 7 || closedDays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) return res.status(400).json({ error: 'أيام الإجازة غير صحيحة.' });
    await barberRef.update({ name, openTime, closeTime, closedDays, closedDates, active, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: req.user.uid, lastUpdatedBy: barberCleanText(req.user.email || req.user.uid, 200) });
    await barberLogAudit(db, shopRef.id, req, 'update-barber', 'barber', barberRef.id, `تعديل بيانات الحلاق: ${name}${active ? '' : ' (موقوف)'}`);
    return res.json({ ok: true, barber: { id: barberRef.id, name, openTime, closeTime, closedDays, closedDates, active } });
  } catch (error) {
    if (error?.message === 'BARBER_CLOSED_DATES_INVALID') return res.status(400).json({ error: 'تواريخ الإجازات غير صحيحة. استخدم YYYY-MM-DD وبحد أقصى 120 تاريخًا.' });
    console.error('BARBER PROFILE SETTINGS ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر حفظ إعدادات الحلاق.' });
  }
});

app.post('/api/barbershops/:shopId/barbers/:barberId/photo', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-owner-photo-save', maxRequests: 8 }), async (req, res) => {
  try {
    const db = admin.firestore();
    const shopId = barberCleanText(req.params.shopId, 150);
    const barberId = barberCleanText(req.params.barberId, 150);
    const shopRef = db.collection('barberShops').doc(shopId);
    const barberRef = shopRef.collection('barbers').doc(barberId);
    const [shopSnap, barberSnap] = await Promise.all([shopRef.get(), barberRef.get()]);
    if (!shopSnap.exists || !barberSnap.exists) return res.status(404).json({ error: 'الصالون أو الحلاق غير موجود.' });
    if (shopSnap.data()?.ownerId !== req.user.uid) return res.status(403).json({ error: 'لا يمكنك تغيير صورة هذا الحلاق.' });
    const imagePath = barberCleanText(req.body?.imagePath, 500);
    await barberVerifyImagePath(imagePath, `barbershops/${shopId}/barbers/${barberId}/${req.user.uid}/`);
    await barberRef.update({ imagePath, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: req.user.uid, lastUpdatedBy: barberCleanText(req.user.email || req.user.uid, 200) });
    await barberLogAudit(db, shopId, req, 'update-barber-photo', 'barber', barberId, `تحديث صورة الحلاق: ${barberSnap.data()?.name || ''}`);
    return res.json({ ok: true, imageUrl: await barberPhotoUrl(imagePath) });
  } catch (error) {
    const status = ({ BARBER_IMAGE_PATH_INVALID: 400, BARBER_IMAGE_NOT_FOUND: 409, BARBER_IMAGE_INVALID: 415 })[error?.message] || 500;
    if (status >= 500) console.error('BARBER OWNER PHOTO ERROR:', error?.message || error);
    return res.status(status).json({ error: status >= 500 ? 'تعذر حفظ صورة الحلاق.' : error.message });
  }
});

app.get('/api/barbershops/:shopId/audit', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-shop-audit', maxRequests: 30 }), async (req, res) => {
  try {
    const shopRef = admin.firestore().collection('barberShops').doc(barberCleanText(req.params.shopId, 150));
    const shopSnap = await shopRef.get();
    if (!shopSnap.exists) return res.status(404).json({ error: 'الصالون غير موجود.' });
    if (shopSnap.data()?.ownerId !== req.user.uid) return res.status(403).json({ error: 'لا يمكنك عرض سجل هذا الصالون.' });
    const snap = await shopRef.collection('auditLog').orderBy('createdAt', 'desc').limit(50).get();
    return res.json({ ok: true, entries: snap.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: barberTimestampIso(doc.data()?.createdAt) })) });
  } catch (error) {
    console.error('BARBER SHOP AUDIT ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر تحميل سجل التعديلات.' });
  }
});

// Owner-only daily appointment ledger. Restricting the query by shop and date avoids a broad customer-data scan.
app.get('/api/barbershops/:shopId/bookings', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-shop-bookings-day', maxRequests: 40 }), async (req, res) => {
  try {
    const db = admin.firestore();
    const shopId = barberCleanText(req.params.shopId, 150);
    const date = barberCleanText(req.query?.date || barberCairoNow().date, 10);
    const parsedDate = Date.parse(`${date}T12:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsedDate) || new Date(parsedDate).toISOString().slice(0, 10) !== date) {
      return res.status(400).json({ error: 'تاريخ عرض الحجوزات غير صحيح.' });
    }
    const shopRef = db.collection('barberShops').doc(shopId);
    const shopSnap = await shopRef.get();
    if (!shopSnap.exists) return res.status(404).json({ error: 'الصالون غير موجود.' });
    if (shopSnap.data()?.ownerId !== req.user.uid) return res.status(403).json({ error: 'لا يمكنك عرض حجوزات هذا الصالون.' });
    const snap = await db.collection('barberBookings')
      .where('shopId', '==', shopId)
      .where('localDate', '==', date)
      .limit(300)
      .get();
    const bookings = snap.docs.map(doc => {
      const item = doc.data() || {};
      return {
        id: doc.id,
        barberId: String(item.barberId || ''),
        barberName: String(item.barberName || 'الحلاق'),
        serviceName: String(item.serviceName || 'خدمة حلاقة'),
        customerName: String(item.customerName || 'عميل'),
        customerPhone: String(item.customerPhone || ''),
        localDate: String(item.localDate || date),
        startTime: String(item.startTime || ''),
        endTime: String(item.endTime || ''),
        startMinute: Number.isInteger(item.startMinute) ? item.startMinute : null,
        endMinute: Number.isInteger(item.endMinute) ? item.endMinute : null,
        price: Number(item.price || 0),
        paymentMethod: String(item.paymentMethod || 'onsite'),
        paymentStatus: String(item.paymentStatus || 'unpaid'),
        status: String(item.status || 'confirmed'),
        attendanceStatus: String(item.attendanceStatus || ''),
        createdAt: barberTimestampIso(item.createdAt),
        paidAt: barberTimestampIso(item.paidAt),
        cancelledAt: barberTimestampIso(item.cancelledAt),
        attendanceUpdatedAt: barberTimestampIso(item.attendanceUpdatedAt),
        attendanceUpdatedByLabel: String(item.attendanceUpdatedByLabel || '')
      };
    }).sort((a, b) => `${a.startTime}`.localeCompare(`${b.startTime}`));
    return res.json({ ok: true, shopId, date, limit: 300, bookings });
  } catch (error) {
    console.error('BARBER SHOP BOOKINGS DAY ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر تحميل حجوزات اليوم.' });
  }
});

// Owner-only finance report, scoped to one salon and a maximum 31-day window.
app.get('/api/barbershops/:shopId/financial-report', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-shop-financial-report', maxRequests: 20 }), async (req, res) => {
  try {
    const db = admin.firestore();
    const shopId = barberCleanText(req.params.shopId, 150);
    const startDate = barberCleanText(req.query?.startDate, 10);
    const endDate = barberCleanText(req.query?.endDate, 10);
    const validDate = value => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const timestamp = Date.parse(`${value}T12:00:00Z`);
      return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
    };
    if (!validDate(startDate) || !validDate(endDate)) {
      return res.status(400).json({ error: 'تاريخ بداية أو نهاية التقرير غير صحيح.' });
    }
    const daySpan = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000;
    if (daySpan < 0 || daySpan > 30) {
      return res.status(400).json({ error: 'الفترة القصوى للتقرير 31 يومًا، ويجب أن تكون البداية قبل النهاية.' });
    }
    const shopRef = db.collection('barberShops').doc(shopId);
    const shopSnap = await shopRef.get();
    if (!shopSnap.exists) return res.status(404).json({ error: 'الصالون غير موجود.' });
    if (shopSnap.data()?.ownerId !== req.user.uid) return res.status(403).json({ error: 'لا يمكنك عرض التقرير المالي لهذا الصالون.' });

    const reportLimit = 3000;
    const snap = await db.collection('barberBookings')
      .where('shopId', '==', shopId)
      .where('localDate', '>=', startDate)
      .where('localDate', '<=', endDate)
      .orderBy('localDate', 'asc')
      .limit(reportLimit)
      .get();
    const bookings = snap.docs.map(doc => {
      const item = doc.data() || {};
      const amount = Number(item.price ?? 0);
      return {
        id: doc.id,
        barberId: String(item.barberId || ''),
        barberName: String(item.barberName || 'الحلاق'),
        serviceName: String(item.serviceName || 'خدمة حلاقة'),
        customerName: String(item.customerName || 'عميل'),
        localDate: String(item.localDate || ''),
        startTime: String(item.startTime || ''),
        endTime: String(item.endTime || ''),
        price: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0,
        paymentMethod: String(item.paymentMethod || 'onsite'),
        paymentStatus: String(item.paymentStatus || 'unpaid'),
        status: String(item.status || 'confirmed'),
        attendanceStatus: String(item.attendanceStatus || ''),
        paidAt: barberTimestampIso(item.paidAt),
        createdAt: barberTimestampIso(item.createdAt)
      };
    }).sort((a, b) => `${a.localDate} ${a.startTime}`.localeCompare(`${b.localDate} ${b.startTime}`));
    return res.json({
      ok: true, shopId, startDate, endDate, limit: reportLimit,
      truncated: snap.size >= reportLimit,
      bookings
    });
  } catch (error) {
    console.error('BARBER FINANCIAL REPORT ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر تحميل التقرير المالي للصالون.' });
  }
});

app.get('/api/barbershops/:shopId', publicRateLimit({ name: 'barber-shop-detail', maxRequests: 90 }), async (req, res) => {
  try {
    const db = admin.firestore();
    const shopRef = db.collection('barberShops').doc(String(req.params.shopId || '').trim());
    const snap = await shopRef.get();
    if (!snap.exists || snap.data()?.status !== 'active') return res.status(404).json({ error: 'صالون الحلاقة غير موجود.' });
    const [serviceSnap, barberSnap] = await Promise.all([
      shopRef.collection('services').where('active', '==', true).limit(50).get(),
      shopRef.collection('barbers').where('active', '==', true).limit(50).get()
    ]);
    return res.json({
      ok: true, shop: await barberPublicShop(snap),
      services: serviceSnap.docs.map(item => ({ id: item.id, name: item.data().name || '', durationMinutes: Number(item.data().durationMinutes || 30), price: Number(item.data().price || 0) })),
      barbers: await Promise.all(barberSnap.docs.map(barberPublicProfile))
    });
  } catch (error) {
    console.error('BARBER SHOP DETAIL ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر تحميل تفاصيل الصالون.' });
  }
});

app.post('/api/barbershops', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-shop-create', maxRequests: 5 }), async (req, res) => {
  try {
    const name = barberCleanText(req.body?.name, 100);
    const phone = barberCleanText(req.body?.phone, 24);
    const city = barberCleanText(req.body?.city, 80);
    const address = barberCleanText(req.body?.address, 220);
    const description = barberCleanText(req.body?.description, 700);
    const openTime = barberCleanText(req.body?.openTime, 5);
    const closeTime = barberCleanText(req.body?.closeTime, 5);
    const barberName = barberCleanText(req.body?.barberName, 80);
    const imagePath = barberCleanText(req.body?.imagePath, 500);
    const closedDays = Array.isArray(req.body?.closedDays) ? [...new Set(req.body.closedDays.map(Number))] : [];
    const openMinute = barberParseTime(openTime);
    const closeMinute = barberParseTime(closeTime);
    if (name.length < 3 || phone.length < 6 || city.length < 2 || address.length < 3 || barberName.length < 2) return res.status(400).json({ error: 'أكمل اسم الصالون والهاتف والمدينة والعنوان واسم الحلاق.' });
    if (!/^[+0-9 ()-]{6,24}$/.test(phone)) return res.status(400).json({ error: 'رقم الهاتف غير صحيح.' });
    if (openMinute === null || closeMinute === null || closeMinute <= openMinute) return res.status(400).json({ error: 'حدد ساعات عمل صحيحة، على ألا يتجاوز الإغلاق منتصف الليل.' });
    if (closedDays.length > 7 || closedDays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) return res.status(400).json({ error: 'أيام الإجازة غير صحيحة.' });
    const db = admin.firestore();
    if (imagePath) await barberVerifyImagePath(imagePath, `barbershops/${req.user.uid}/new-shop/`);
    const shopRef = db.collection('barberShops').doc();
    const barberRef = shopRef.collection('barbers').doc();
    const claimCode = barberNewClaimCode();
    const claimRef = db.collection('barberClaimCodes').doc(barberClaimCodeHash(claimCode));
    const now = admin.firestore.FieldValue.serverTimestamp();
    const batch = db.batch();
    batch.create(shopRef, {
      ownerId: req.user.uid, name, phone, city, address, description,
      ...(imagePath ? { imagePath } : {}),
      openTime, closeTime, closedDays, closedDates: [], status: 'pending',
      updatedBy: req.user.uid, lastUpdatedBy: barberCleanText(req.user.email || req.user.uid, 200),
      createdAt: now, updatedAt: now
    });
    batch.create(barberRef, { name: barberName, active: true, createdAt: now, updatedAt: now, updatedBy: req.user.uid, lastUpdatedBy: barberCleanText(req.user.email || req.user.uid, 200) });
    batch.create(claimRef, {
      shopId: shopRef.id, barberId: barberRef.id, createdBy: req.user.uid,
      createdAt: now, expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000)
    });
    await batch.commit();
    await barberLogAudit(db, shopRef.id, req, 'create-shop', 'shop', shopRef.id, 'إنشاء حساب صالون وملف الحلاق الأول');
    return res.status(201).json({ ok: true, shop: { id: shopRef.id, name, status: 'pending' }, barberClaimCode: claimCode });
  } catch (error) {
    console.error('BARBER SHOP CREATE ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر إنشاء الصالون.' });
  }
});

app.get('/api/admin/barbershops/pending', requireFirebaseUser, rateLimit({ name: 'admin-pending-barber-shops', maxRequests: 30 }), async (req, res) => {
  if (req.user.admin !== true) return res.status(403).json({ error: 'Admin access required' });
  try {
    const snap = await admin.firestore().collection('barberShops')
      .where('status', '==', 'pending')
      .limit(100)
      .get();
    const shops = (await Promise.all(snap.docs.map(async shopSnap => {
      const data = shopSnap.data() || {};
      return {
        ...await barberPublicShop(shopSnap),
        ownerId: barberCleanText(data.ownerId || '', 256),
        createdAt: data.createdAt?.toDate?.()?.toISOString?.() || null
      };
    }))).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return res.json({ ok: true, shops });
  } catch (error) {
    console.error('ADMIN PENDING BARBER SHOPS ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر تحميل طلبات صالونات الحلاقة.' });
  }
});

app.post('/api/admin/barbershops/:shopId/review', requireFirebaseUser, rateLimit({ name: 'admin-review-barber-shop', maxRequests: 30 }), async (req, res) => {
  if (req.user.admin !== true) return res.status(403).json({ error: 'Admin access required' });
  const shopId = barberCleanText(req.params?.shopId || '', 150);
  const action = String(req.body?.action || '').trim();
  const reviewNote = barberCleanText(req.body?.note || '', 500);
  if (!shopId || !['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Invalid shopId or review action' });
  }
  if (action === 'reject' && reviewNote.length < 5) {
    return res.status(400).json({ error: 'اكتب سبب الرفض في 5 أحرف على الأقل.' });
  }
  try {
    const db = admin.firestore();
    const shopRef = db.collection('barberShops').doc(shopId);
    const nextStatus = action === 'approve' ? 'active' : 'rejected';
    await db.runTransaction(async tx => {
      const shopSnap = await tx.get(shopRef);
      if (!shopSnap.exists) throw new Error('BARBER_SHOP_NOT_FOUND');
      const shop = shopSnap.data() || {};
      if (shop.status !== 'pending') throw new Error('BARBER_SHOP_NOT_PENDING');
      tx.update(shopRef, {
        status: nextStatus,
        reviewNote: action === 'reject' ? reviewNote : '',
        reviewedBy: req.user.uid,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    await barberLogAudit(db, shopId, req, action === 'approve' ? 'approve-shop' : 'reject-shop', 'shop', shopId, action === 'approve' ? 'اعتماد طلب الصالون' : `رفض طلب الصالون: ${reviewNote}`);
    return res.json({ ok: true, shopId, status: nextStatus });
  } catch (error) {
    const status = ({ BARBER_SHOP_NOT_FOUND: 404, BARBER_SHOP_NOT_PENDING: 409 })[error?.message] || 500;
    if (status >= 500) console.error('ADMIN BARBER SHOP REVIEW ERROR:', error?.message || error);
    return res.status(status).json({ error: status >= 500 ? 'تعذر مراجعة طلب الصالون.' : error.message });
  }
});

app.post('/api/barbershops/:shopId/services', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-service-create', maxRequests: 30 }), async (req, res) => {
  try {
    const db = admin.firestore();
    const shopRef = db.collection('barberShops').doc(String(req.params.shopId || '').trim());
    const shopSnap = await shopRef.get();
    if (!shopSnap.exists) return res.status(404).json({ error: 'الصالون غير موجود.' });
    if (shopSnap.data()?.ownerId !== req.user.uid) return res.status(403).json({ error: 'لا يمكنك تعديل هذا الصالون.' });
    const name = barberCleanText(req.body?.name, 100);
    const durationMinutes = Number(req.body?.durationMinutes);
    const price = Number(req.body?.price);
    if (name.length < 2 || !Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 180 || durationMinutes % 15 !== 0 || !Number.isFinite(price) || price < 1 || price > 100000) return res.status(400).json({ error: 'أدخل اسم خدمة صحيحًا ومدة من 15 إلى 180 دقيقة بفواصل 15 دقيقة وسعرًا صالحًا.' });
    const serviceRef = shopRef.collection('services').doc();
    await serviceRef.create({ name, durationMinutes, price: Math.round(price * 100) / 100, active: true, updatedBy: req.user.uid, lastUpdatedBy: barberCleanText(req.user.email || req.user.uid, 200), createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    await barberLogAudit(db, shopRef.id, req, 'create-service', 'service', serviceRef.id, `إضافة الخدمة: ${name}`);
    return res.status(201).json({ ok: true, service: { id: serviceRef.id, name, durationMinutes, price, active: true } });
  } catch (error) {
    console.error('BARBER SERVICE CREATE ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر إضافة الخدمة.' });
  }
});

app.post('/api/barbershops/:shopId/barbers', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-employee-create', maxRequests: 30 }), async (req, res) => {
  try {
    const db = admin.firestore();
    const shopRef = db.collection('barberShops').doc(String(req.params.shopId || '').trim());
    const shopSnap = await shopRef.get();
    if (!shopSnap.exists) return res.status(404).json({ error: 'الصالون غير موجود.' });
    if (shopSnap.data()?.ownerId !== req.user.uid) return res.status(403).json({ error: 'لا يمكنك تعديل هذا الصالون.' });
    const name = barberCleanText(req.body?.name, 80);
    if (name.length < 2) return res.status(400).json({ error: 'اكتب اسم الحلاق.' });
    const barberRef = shopRef.collection('barbers').doc();
    const claimCode = barberNewClaimCode();
    const claimRef = admin.firestore().collection('barberClaimCodes').doc(barberClaimCodeHash(claimCode));
    const now = admin.firestore.FieldValue.serverTimestamp();
    const batch = admin.firestore().batch();
    batch.create(barberRef, { name, active: true, createdAt: now, updatedAt: now, updatedBy: req.user.uid, lastUpdatedBy: barberCleanText(req.user.email || req.user.uid, 200) });
    batch.create(claimRef, {
      shopId: shopRef.id, barberId: barberRef.id, createdBy: req.user.uid,
      createdAt: now, expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000)
    });
    await batch.commit();
    await barberLogAudit(db, shopRef.id, req, 'create-barber', 'barber', barberRef.id, `إضافة الحلاق: ${name}`);
    return res.status(201).json({ ok: true, barber: { id: barberRef.id, name }, barberClaimCode: claimCode });
  } catch (error) {
    console.error('BARBER EMPLOYEE CREATE ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر إضافة الحلاق.' });
  }
});

app.post('/api/barbershops/:shopId/schedule', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-schedule-update', maxRequests: 20 }), async (req, res) => {
  try {
    const db = admin.firestore();
    const shopRef = db.collection('barberShops').doc(String(req.params.shopId || '').trim());
    const snap = await shopRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'الصالون غير موجود.' });
    if (snap.data()?.ownerId !== req.user.uid) return res.status(403).json({ error: 'لا يمكنك تعديل مواعيد هذا الصالون.' });
    const openTime = barberCleanText(req.body?.openTime, 5);
    const closeTime = barberCleanText(req.body?.closeTime, 5);
    const openMinute = barberParseTime(openTime);
    const closeMinute = barberParseTime(closeTime);
    const closedDays = Array.isArray(req.body?.closedDays) ? [...new Set(req.body.closedDays.map(Number))] : [];
    const closedDates = req.body?.closedDates === undefined
      ? normalizeBarberClosedDates(snap.data()?.closedDates || [])
      : normalizeBarberClosedDates(req.body.closedDates);
    if (openMinute === null || closeMinute === null || closeMinute <= openMinute) return res.status(400).json({ error: 'حدد ساعات عمل صحيحة.' });
    if (closedDays.length > 7 || closedDays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) return res.status(400).json({ error: 'أيام الإجازة غير صحيحة.' });
    await shopRef.update({ openTime, closeTime, closedDays, closedDates, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: req.user.uid, lastUpdatedBy: barberCleanText(req.user.email || req.user.uid, 200) });
    await barberLogAudit(db, shopRef.id, req, 'update-shop-schedule', 'shop', shopRef.id, `تعديل ساعات العمل إلى ${openTime}–${closeTime} وتحديث إجازات الصالون`);
    return res.json({ ok: true, shopId: shopRef.id, openTime, closeTime, closedDays, closedDates });
  } catch (error) {
    if (error?.message === 'BARBER_CLOSED_DATES_INVALID') return res.status(400).json({ error: 'تواريخ إجازات الصالون غير صحيحة. استخدم YYYY-MM-DD وبحد أقصى 120 تاريخًا.' });
    console.error('BARBER SCHEDULE UPDATE ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر تحديث مواعيد العمل.' });
  }
});

// Create a signed image upload URL. Uploaded salon/barber photos are validated again before saving.
app.post('/api/barbershops/photo-upload-url', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-photo-upload-url', maxRequests: 12 }), async (req, res) => {
  try {
    const purpose = barberCleanText(req.body?.purpose, 20);
    const name = barberCleanText(req.body?.name, 160).replace(/[^a-zA-Z0-9._-]/g, '_');
    const contentType = String(req.body?.contentType || '').toLowerCase();
    const size = Number(req.body?.size);
    const shopId = barberCleanText(req.body?.shopId, 150);
    const barberId = barberCleanText(req.body?.barberId, 150);
    if (!['shop', 'barber'].includes(purpose) || !name || !BARBER_IMAGE_TYPES.has(contentType) || !Number.isFinite(size) || size < 1 || size > BARBER_IMAGE_MAX_BYTES) {
      return res.status(400).json({ error: 'اختار صورة JPG أو PNG أو WebP لا يتجاوز حجمها 8 ميجابايت.' });
    }
    const db = admin.firestore();
    let prefix;
    if (purpose === 'shop' && !shopId) {
      prefix = `barbershops/${req.user.uid}/new-shop/`;
    } else if (purpose === 'shop') {
      const shopSnap = await db.collection('barberShops').doc(shopId).get();
      if (!shopSnap.exists) return res.status(404).json({ error: 'الصالون غير موجود.' });
      if (shopSnap.data()?.ownerId !== req.user.uid) return res.status(403).json({ error: 'لا يمكنك تغيير صورة هذا الصالون.' });
      prefix = `barbershops/${shopId}/shop/${req.user.uid}/`;
    } else {
      if (!shopId || !barberId) return res.status(400).json({ error: 'بيانات الحلاق غير مكتملة.' });
      const shopRef = db.collection('barberShops').doc(shopId);
      const barberRef = shopRef.collection('barbers').doc(barberId);
      const [shopSnap, barberSnap] = await Promise.all([shopRef.get(), barberRef.get()]);
      if (!shopSnap.exists || !barberSnap.exists) return res.status(404).json({ error: 'الصالون أو الحلاق غير موجود.' });
      const allowedOwner = shopSnap.data()?.ownerId === req.user.uid;
      const allowedBarber = barberSnap.data()?.userId === req.user.uid;
      if (!allowedOwner && !allowedBarber) return res.status(403).json({ error: 'لا يمكنك تغيير صورة هذا الحلاق.' });
      prefix = `barbershops/${shopId}/barbers/${barberId}/${req.user.uid}/`;
    }
    const path = `${prefix}${crypto.randomUUID()}-${name}`;
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data?.signedUrl) {
      console.error('BARBER PHOTO SIGNED UPLOAD ERROR:', error?.message || 'missing signed URL');
      return res.status(500).json({ error: 'تعذر تجهيز رفع الصورة.' });
    }
    return res.json({ ok: true, path, signedUrl: data.signedUrl, token: data.token || null });
  } catch (error) {
    console.error('BARBER PHOTO UPLOAD URL ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر تجهيز رفع الصورة.' });
  }
});

app.post('/api/barbershops/:shopId/photo', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-shop-photo-save', maxRequests: 8 }), async (req, res) => {
  try {
    const shopId = barberCleanText(req.params.shopId, 150);
    const imagePath = barberCleanText(req.body?.imagePath, 500);
    const shopRef = admin.firestore().collection('barberShops').doc(shopId);
    const shopSnap = await shopRef.get();
    if (!shopSnap.exists) return res.status(404).json({ error: 'الصالون غير موجود.' });
    if (shopSnap.data()?.ownerId !== req.user.uid) return res.status(403).json({ error: 'لا يمكنك تغيير صورة هذا الصالون.' });
    await barberVerifyImagePath(imagePath, `barbershops/${shopId}/shop/${req.user.uid}/`);
    await shopRef.update({ imagePath, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: req.user.uid, lastUpdatedBy: barberCleanText(req.user.email || req.user.uid, 200) });
    await barberLogAudit(admin.firestore(), shopId, req, 'update-shop-photo', 'shop', shopId, 'تحديث صورة الصالون');
    return res.json({ ok: true, imageUrl: await barberPhotoUrl(imagePath) });
  } catch (error) {
    const status = ({ BARBER_IMAGE_PATH_INVALID: 400, BARBER_IMAGE_NOT_FOUND: 409, BARBER_IMAGE_INVALID: 415 })[error?.message] || 500;
    if (status >= 500) console.error('BARBER SHOP PHOTO SAVE ERROR:', error?.message || error);
    return res.status(status).json({ error: status >= 500 ? 'تعذر حفظ صورة الصالون.' : error.message });
  }
});

app.get('/api/barbershops/:shopId/barbers/mine', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-managed-list', maxRequests: 40 }), async (req, res) => {
  try {
    const shopRef = admin.firestore().collection('barberShops').doc(barberCleanText(req.params.shopId, 150));
    const shopSnap = await shopRef.get();
    if (!shopSnap.exists) return res.status(404).json({ error: 'الصالون غير موجود.' });
    if (shopSnap.data()?.ownerId !== req.user.uid) return res.status(403).json({ error: 'لا يمكنك إدارة حلاقين هذا الصالون.' });
    const barbersSnap = await shopRef.collection('barbers').limit(100).get();
    const shop = shopSnap.data() || {};
    const barbers = await Promise.all(barbersSnap.docs.map(async snap => {
      const data = snap.data() || {};
      return { id: snap.id, name: data.name || 'الحلاق', active: data.active === true, linked: Boolean(data.userId),
        imageUrl: data.imageUrl || await barberPhotoUrl(data.imagePath),
        openTime: data.openTime || shop.openTime || '09:00', closeTime: data.closeTime || shop.closeTime || '21:00',
        closedDays: Array.isArray(data.closedDays) ? data.closedDays : [],
        closedDates: Array.isArray(data.closedDates) ? data.closedDates : [], rating: Number(data.rating || 0), ratingCount: Number(data.ratingCount || 0),
        updatedAt: barberTimestampIso(data.updatedAt), lastUpdatedBy: data.lastUpdatedBy || data.updatedBy || '' };
    }));
    return res.json({ ok: true, barbers });
  } catch (error) {
    console.error('BARBER MANAGED LIST ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر تحميل قائمة الحلاقين.' });
  }
});

app.post('/api/barbershops/:shopId/barbers/:barberId/claim-code', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-claim-code-create', maxRequests: 15 }), async (req, res) => {
  try {
    const db = admin.firestore();
    const shopId = barberCleanText(req.params.shopId, 150);
    const barberId = barberCleanText(req.params.barberId, 150);
    const shopRef = db.collection('barberShops').doc(shopId);
    const barberRef = shopRef.collection('barbers').doc(barberId);
    const [shopSnap, barberSnap] = await Promise.all([shopRef.get(), barberRef.get()]);
    if (!shopSnap.exists || !barberSnap.exists) return res.status(404).json({ error: 'الصالون أو الحلاق غير موجود.' });
    if (shopSnap.data()?.ownerId !== req.user.uid) return res.status(403).json({ error: 'لا يمكنك إصدار كود لهذا الحلاق.' });
    if (barberSnap.data()?.userId) return res.status(409).json({ error: 'BARBER_PROFILE_ALREADY_LINKED' });
    const claimCode = barberNewClaimCode();
    const claimRef = db.collection('barberClaimCodes').doc(barberClaimCodeHash(claimCode));
    await claimRef.create({ shopId, barberId, createdBy: req.user.uid, createdAt: admin.firestore.FieldValue.serverTimestamp(), expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000) });
    await barberLogAudit(db, shopId, req, 'create-claim-code', 'barber', barberId, `إصدار كود ربط جديد للحلاق: ${barberSnap.data()?.name || 'الحلاق'}`);
    return res.json({ ok: true, barberName: barberSnap.data()?.name || 'الحلاق', barberClaimCode: claimCode });
  } catch (error) {
    console.error('BARBER CLAIM CODE CREATE ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر إنشاء كود الربط.' });
  }
});

app.post('/api/barbers/claim', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-account-claim', maxRequests: 6 }), async (req, res) => {
  try {
    const code = String(req.body?.code || '').trim().toLowerCase();
    if (!/^[a-f0-9]{24}$/.test(code)) return res.status(400).json({ error: 'BARBER_CLAIM_CODE_INVALID' });
    const db = admin.firestore();
    const claimRef = db.collection('barberClaimCodes').doc(barberClaimCodeHash(code));
    const accountRef = db.collection('barberAccounts').doc(req.user.uid);
    const nowMs = Date.now();
    const profile = await db.runTransaction(async tx => {
      const accountSnap = await tx.get(accountRef);
      const claimSnap = await tx.get(claimRef);
      if (accountSnap.exists) throw new Error('BARBER_ACCOUNT_ALREADY_LINKED');
      if (!claimSnap.exists) throw new Error('BARBER_CLAIM_CODE_INVALID');
      const claim = claimSnap.data() || {};
      const expiry = claim.expiresAt?.toMillis?.() || 0;
      if (!expiry || expiry <= nowMs) {
        // Throwing aborts the transaction, so expired codes are rejected without a write.
        throw new Error('BARBER_CLAIM_CODE_EXPIRED');
      }
      const shopRef = db.collection('barberShops').doc(String(claim.shopId || ''));
      const barberRef = shopRef.collection('barbers').doc(String(claim.barberId || ''));
      const [shopSnap, barberSnap] = await Promise.all([tx.get(shopRef), tx.get(barberRef)]);
      if (!shopSnap.exists || !barberSnap.exists || barberSnap.data()?.active !== true) throw new Error('BARBER_CLAIM_CODE_INVALID');
      if (barberSnap.data()?.userId) throw new Error('BARBER_PROFILE_ALREADY_LINKED');
      const shop = shopSnap.data() || {};
      const barber = barberSnap.data() || {};
      tx.update(barberRef, { userId: req.user.uid, linkedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      tx.create(accountRef, { userId: req.user.uid, shopId: claim.shopId, barberId: claim.barberId, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      tx.delete(claimRef);
      return { shopId: claim.shopId, barberId: claim.barberId, shopName: shop.name || '', barberName: barber.name || 'الحلاق' };
    });
    await barberLogAudit(db, profile.shopId, req, 'link-barber-account', 'barber', profile.barberId, `ربط حساب الحلاق ${profile.barberName}`);
    return res.json({ ok: true, profile });
  } catch (error) {
    const status = ({ BARBER_CLAIM_CODE_INVALID: 400, BARBER_CLAIM_CODE_EXPIRED: 410, BARBER_PROFILE_ALREADY_LINKED: 409, BARBER_ACCOUNT_ALREADY_LINKED: 409 })[error?.message] || 500;
    if (status >= 500) console.error('BARBER ACCOUNT CLAIM ERROR:', error?.message || error);
    return res.status(status).json({ error: status >= 500 ? 'تعذر ربط حساب الحلاق.' : error.message });
  }
});

app.get('/api/barber-schedule/me', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-schedule-me', maxRequests: 40 }), async (req, res) => {
  try {
    const db = admin.firestore();
    const accountSnap = await db.collection('barberAccounts').doc(req.user.uid).get();
    if (!accountSnap.exists) return res.status(404).json({ error: 'BARBER_PROFILE_NOT_LINKED' });
    const account = accountSnap.data() || {};
    const shopRef = db.collection('barberShops').doc(String(account.shopId || ''));
    const barberRef = shopRef.collection('barbers').doc(String(account.barberId || ''));
    const [shopSnap, barberSnap] = await Promise.all([shopRef.get(), barberRef.get()]);
    if (!shopSnap.exists || !barberSnap.exists || barberSnap.data()?.userId !== req.user.uid) return res.status(404).json({ error: 'BARBER_PROFILE_NOT_LINKED' });
    const shop = shopSnap.data() || {};
    const barber = barberSnap.data() || {};
    const today = barberCairoNow();
    const bookingsSnap = await db.collection('barberBookings').where('shopId', '==', shopRef.id).where('barberId', '==', barberRef.id).where('localDate', '>=', today.date).orderBy('localDate', 'asc').limit(100).get();
    const barberAppointments = bookingsSnap.docs.map(snap => ({ id: snap.id, ...(snap.data() || {}) }))
      .filter(item => item.barberId === barberRef.id && item.status === 'confirmed')
      .sort((a, b) => `${a.localDate || ''} ${a.startTime || ''}`.localeCompare(`${b.localDate || ''} ${b.startTime || ''}`));
    const shapeAppointment = item => ({
      id: item.id, serviceName: item.serviceName || 'خدمة حلاقة', customerName: item.customerName || 'عميل',
      customerPhone: item.customerPhone || '', localDate: item.localDate || '', startTime: item.startTime || '', endTime: item.endTime || '',
      startMinute: Number.isInteger(item.startMinute) ? item.startMinute : null,
      endMinute: Number.isInteger(item.endMinute) ? item.endMinute : null,
      price: Number(item.price || 0), paymentStatus: item.paymentStatus || 'unpaid',
      attendanceStatus: item.attendanceStatus || '',
      attendanceUpdatedAt: item.attendanceUpdatedAt?.toDate?.()?.toISOString?.() || null,
      attendanceUpdatedByLabel: item.attendanceUpdatedByLabel || '',
      createdAt: item.createdAt?.toDate?.()?.toISOString?.() || null
    });
    const todayAppointments = barberAppointments
      .filter(item => String(item.localDate || '') === today.date)
      .slice(0, 100).map(shapeAppointment);
    const upcomingAppointments = barberAppointments
      .filter(item => String(item.localDate || '') >= today.date && !(String(item.localDate || '') === today.date && Number(item.startMinute ?? -1) <= today.minute))
      .slice(0, 100).map(shapeAppointment);
    return res.json({ ok: true, profile: {
      shopId: shopRef.id, barberId: barberRef.id, shopName: shop.name || '', shopStatus: shop.status || 'pending',
      barberName: barber.name || 'الحلاق', imageUrl: await barberPhotoUrl(shop.imagePath), barberImageUrl: await barberPhotoUrl(barber.imagePath),
      openTime: barber.openTime || shop.openTime || '09:00', closeTime: barber.closeTime || shop.closeTime || '21:00',
      shopOpenTime: shop.openTime || '09:00', shopCloseTime: shop.closeTime || '21:00',
      closedDays: Array.isArray(barber.closedDays) ? barber.closedDays : [],
      closedDates: Array.isArray(barber.closedDates) ? barber.closedDates : [],
      shopClosedDays: Array.isArray(shop.closedDays) ? shop.closedDays : [],
      rating: Number(barber.rating || 0), ratingCount: Number(barber.ratingCount || 0), todayAppointments, upcomingAppointments
    } });
  } catch (error) {
    console.error('BARBER SCHEDULE PROFILE ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر تحميل ملف الحلاق والحجوزات.' });
  }
});

app.post('/api/barber-schedule/me', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-schedule-save', maxRequests: 15 }), async (req, res) => {
  try {
    const db = admin.firestore();
    const accountSnap = await db.collection('barberAccounts').doc(req.user.uid).get();
    if (!accountSnap.exists) return res.status(404).json({ error: 'BARBER_PROFILE_NOT_LINKED' });
    const account = accountSnap.data() || {};
    const barberRef = db.collection('barberShops').doc(String(account.shopId || '')).collection('barbers').doc(String(account.barberId || ''));
    const barberSnap = await barberRef.get();
    if (!barberSnap.exists || barberSnap.data()?.userId !== req.user.uid) return res.status(404).json({ error: 'BARBER_PROFILE_NOT_LINKED' });
    const openTime = barberCleanText(req.body?.openTime, 5);
    const closeTime = barberCleanText(req.body?.closeTime, 5);
    const openMinute = barberParseTime(openTime);
    const closeMinute = barberParseTime(closeTime);
    const closedDays = Array.isArray(req.body?.closedDays) ? [...new Set(req.body.closedDays.map(Number))] : [];
    const closedDates = req.body?.closedDates === undefined
      ? normalizeBarberClosedDates(barberSnap.data()?.closedDates || [])
      : normalizeBarberClosedDates(req.body.closedDates);
    if (openMinute === null || closeMinute === null || closeMinute <= openMinute) return res.status(400).json({ error: 'حدد ساعات عمل صحيحة.' });
    if (closedDays.length > 7 || closedDays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) return res.status(400).json({ error: 'أيام الإجازة غير صحيحة.' });
    const accountShopSnap = await db.collection('barberShops').doc(String(account.shopId || '')).get();
    if (!accountShopSnap.exists) return res.status(404).json({ error: 'الصالون غير موجود.' });
    const shopOpenMinute = barberParseTime(accountShopSnap.data()?.openTime || '09:00');
    const shopCloseMinute = barberParseTime(accountShopSnap.data()?.closeTime || '21:00');
    if (shopOpenMinute === null || shopCloseMinute === null || openMinute < shopOpenMinute || closeMinute > shopCloseMinute) {
      return res.status(400).json({ error: `مواعيد الحلاق لازم تكون داخل ساعات الصالون (${accountShopSnap.data()?.openTime || '09:00'} إلى ${accountShopSnap.data()?.closeTime || '21:00'}).` });
    }
    await barberRef.update({ openTime, closeTime, closedDays, closedDates, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: req.user.uid, lastUpdatedBy: barberCleanText(req.user.email || req.user.uid, 200) });
    await barberLogAudit(db, account.shopId, req, 'barber-self-schedule-update', 'barber', account.barberId, `الحلاق عدّل ساعات عمله إلى ${openTime}–${closeTime}`);
    return res.json({ ok: true, openTime, closeTime, closedDays, closedDates });
  } catch (error) {
    if (error?.message === 'BARBER_CLOSED_DATES_INVALID') return res.status(400).json({ error: 'تواريخ الإجازات غير صحيحة. استخدم YYYY-MM-DD وبحد أقصى 120 تاريخًا.' });
    console.error('BARBER SCHEDULE SAVE ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر حفظ مواعيد الحلاق.' });
  }
});

app.post('/api/barber-schedule/me/photo', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-profile-photo-save', maxRequests: 8 }), async (req, res) => {
  try {
    const db = admin.firestore();
    const accountSnap = await db.collection('barberAccounts').doc(req.user.uid).get();
    if (!accountSnap.exists) return res.status(404).json({ error: 'BARBER_PROFILE_NOT_LINKED' });
    const account = accountSnap.data() || {};
    const shopId = String(account.shopId || '');
    const barberId = String(account.barberId || '');
    const barberRef = db.collection('barberShops').doc(shopId).collection('barbers').doc(barberId);
    const barberSnap = await barberRef.get();
    if (!barberSnap.exists || barberSnap.data()?.userId !== req.user.uid) return res.status(404).json({ error: 'BARBER_PROFILE_NOT_LINKED' });
    const imagePath = barberCleanText(req.body?.imagePath, 500);
    await barberVerifyImagePath(imagePath, `barbershops/${shopId}/barbers/${barberId}/${req.user.uid}/`);
    await barberRef.update({ imagePath, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: req.user.uid, lastUpdatedBy: barberCleanText(req.user.email || req.user.uid, 200) });
    await barberLogAudit(db, shopId, req, 'barber-self-photo-update', 'barber', barberId, 'الحلاق حدّث صورته الشخصية');
    return res.json({ ok: true, imageUrl: await barberPhotoUrl(imagePath) });
  } catch (error) {
    const status = ({ BARBER_IMAGE_PATH_INVALID: 400, BARBER_IMAGE_NOT_FOUND: 409, BARBER_IMAGE_INVALID: 415 })[error?.message] || 500;
    if (status >= 500) console.error('BARBER PROFILE PHOTO SAVE ERROR:', error?.message || error);
    return res.status(status).json({ error: status >= 500 ? 'تعذر حفظ صورة الحلاق.' : error.message });
  }
});

app.get('/api/cron/barber-booking-cleanup', async (req, res) => {
  // Vercel Cron requests do not have a Firebase user, so the user-scoped rateLimit middleware
  // must not run here. Require a configured secret and an exact Bearer match instead.
  const expectedSecret = String(process.env.CRON_SECRET || '');
  const authorization = String(req.headers.authorization || '');
  if (!expectedSecret || authorization !== `Bearer ${expectedSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const db = admin.firestore();
    const result = await barberCleanupExpiredBookings(db, 250);
    const publicRateLimitRecordsRemoved = await cleanupExpiredPublicRateLimits(db, 400);
    return res.json({ ok: true, ...result, publicRateLimitRecordsRemoved, checkedAt: new Date().toISOString() });
  } catch (error) {
    console.error('BARBER CRON CLEANUP ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر حذف الحجوزات المنتهية.' });
  }
});

app.get('/api/barber-bookings/payment-config', requireFirebaseUser, async (req, res) => {
  return res.json({ ok: true, onlineAvailable: false, provider: 'cash', paymentMethods: ['onsite'] });
});

app.get('/api/barbershops/:shopId/availability', publicRateLimit({ name: 'barber-availability', maxRequests: 90 }), async (req, res) => {
  try {
    const shopId = barberCleanText(req.params.shopId, 150);
    const serviceId = barberCleanText(req.query?.serviceId, 150);
    const barberId = barberCleanText(req.query?.barberId, 150);
    const date = barberCleanText(req.query?.date, 10);
    const dayOfWeek = barberValidateDate(date);
    if (!serviceId || !barberId) return res.status(400).json({ error: 'حدد الخدمة والحلاق.' });
    const db = admin.firestore();
    const { shop, service, barber } = await barberGetResources(db, shopId, serviceId, barberId);
    const duration = Number(service.durationMinutes);
    if (!Number.isInteger(duration) || duration < 15 || duration > 180 || duration % 15 !== 0) throw new Error('INVALID_BARBER_SERVICE_DURATION');
    const schedule = barberAvailabilityStart(shop, date, dayOfWeek, barber);
    if (schedule.closed) return res.json({ ok: true, date, durationMinutes: duration, slots: [], closed: true, closureReason: schedule.closureReason });
    const lockMinutes = [];
    for (let minute = Math.ceil(schedule.openMinute / 15) * 15; minute < schedule.closeMinute; minute += 15) lockMinutes.push(minute);
    const refs = lockMinutes.map(minute => db.collection('barberBookingLocks').doc(barberLockId(shopId, barberId, date, minute)));
    const snaps = await Promise.all(refs.map(ref => ref.get()));
    const locked = new Map(snaps.map((snap, index) => [lockMinutes[index], snap.exists && !barberLockExpired(snap.data())]));
    const now = barberCairoNow();
    const slots = [];
    for (let start = Math.ceil(schedule.openMinute / 15) * 15; start + duration <= schedule.closeMinute; start += 15) {
      if (date === now.date && start <= now.minute) continue;
      let free = true;
      for (let minute = start; minute < start + duration; minute += 15) {
        if (locked.get(minute)) { free = false; break; }
      }
      if (free) slots.push(barberFormatTime(start));
    }
    return res.json({ ok: true, date, durationMinutes: duration, slots });
  } catch (error) {
    const status = ({ INVALID_BOOKING_DATE: 400, BOOKING_DATE_IN_PAST: 400, BOOKING_DATE_TOO_FAR: 400, BARBER_SHOP_NOT_FOUND: 404, BARBER_SERVICE_NOT_FOUND: 404, BARBER_NOT_FOUND: 404, INVALID_SHOP_SCHEDULE: 409 })[error?.message] || 500;
    if (status >= 500) console.error('BARBER AVAILABILITY ERROR:', error?.message || error);
    return res.status(status).json({ error: status >= 500 ? 'تعذر تحميل المواعيد المتاحة.' : error.message });
  }
});

app.post('/api/barber-bookings', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-booking-create', maxRequests: 8 }), async (req, res) => {
  try {
    const shopId = barberCleanText(req.body?.shopId, 150);
    const serviceId = barberCleanText(req.body?.serviceId, 150);
    const barberId = barberCleanText(req.body?.barberId, 150);
    const date = barberCleanText(req.body?.date, 10);
    const startTime = barberCleanText(req.body?.startTime, 5);
    const requestedPaymentMethod = String(req.body?.paymentMethod || 'onsite');
    if (requestedPaymentMethod !== 'onsite') {
      return res.status(403).json({
        error: 'SALON_CASH_ONLY',
        message: 'حجوزات الصالونات تُدفع نقدًا داخل الصالون فقط.'
      });
    }
    const paymentMethod = 'onsite';
    const customerName = barberCleanText(req.body?.customerName || req.user.name || '', 100);
    const customerPhone = barberCleanText(req.body?.customerPhone || '', 24);
    if (!shopId || !serviceId || !barberId || !startTime || !['onsite', 'online'].includes(paymentMethod)) return res.status(400).json({ error: 'بيانات الحجز غير مكتملة.' });
    if (customerName.length < 2) return res.status(400).json({ error: 'اكتب اسم العميل.' });
    if (customerPhone && !/^[+0-9 ()-]{6,24}$/.test(customerPhone)) return res.status(400).json({ error: 'رقم الهاتف غير صحيح.' });
    if (paymentMethod === 'online') {
      const paymentControls = await getUserControls(admin.firestore(), req.user.uid);
      if (paymentControls.disabledFeatures.includes('payments')) return res.status(403).json({ error: 'ميزة الدفع موقوفة لهذا الحساب.' });
      if (getFinanceConfig().provider !== 'xpay' || getXPayConfig().configured !== true) return res.status(503).json({ error: 'ONLINE_PAYMENT_NOT_CONFIGURED' });
    }
    const dayOfWeek = barberValidateDate(date);
    const startMinute = barberParseTime(startTime);
    if (startMinute === null || startMinute % 15 !== 0) return res.status(400).json({ error: 'وقت الحجز غير صحيح.' });
    const db = admin.firestore();
    const bookingRef = db.collection('barberBookings').doc();
    const restrictionRef = db.collection('barberBookingRestrictions').doc(req.user.uid);
    const shopRef = db.collection('barberShops').doc(shopId);
    const serviceRef = shopRef.collection('services').doc(serviceId);
    const barberRef = shopRef.collection('barbers').doc(barberId);
    const nowMs = Date.now();
    const result = await db.runTransaction(async tx => {
      const [shopSnap, serviceSnap, barberSnap, restrictionSnap] = await Promise.all([tx.get(shopRef), tx.get(serviceRef), tx.get(barberRef), tx.get(restrictionRef)]);
      if (!shopSnap.exists || shopSnap.data()?.status !== 'active') throw new Error('BARBER_SHOP_NOT_FOUND');
      if (!serviceSnap.exists || serviceSnap.data()?.active !== true) throw new Error('BARBER_SERVICE_NOT_FOUND');
      if (!barberSnap.exists || barberSnap.data()?.active !== true) throw new Error('BARBER_NOT_FOUND');
      const shop = shopSnap.data();
      const service = serviceSnap.data();
      const barber = barberSnap.data();
      const duration = Number(service.durationMinutes);
      if (!Number.isInteger(duration) || duration < 15 || duration > 180 || duration % 15 !== 0) throw new Error('INVALID_BARBER_SERVICE_DURATION');
      const schedule = barberAvailabilityStart(shop, date, dayOfWeek, barber);
      if (schedule.closed) throw new Error(schedule.closureReason || 'BARBER_SHOP_CLOSED');
      if (startMinute < schedule.openMinute || startMinute + duration > schedule.closeMinute) throw new Error('BARBER_TIME_OUTSIDE_HOURS');
      const current = barberCairoNow();
      if (date === current.date && startMinute <= current.minute) throw new Error('BOOKING_DATE_IN_PAST');
      const segmentMinutes = [];
      for (let minute = startMinute; minute < startMinute + duration; minute += 15) segmentMinutes.push(minute);
      const lockRefs = segmentMinutes.map(minute => db.collection('barberBookingLocks').doc(barberLockId(shopId, barberId, date, minute)));
      const lockSnaps = await Promise.all(lockRefs.map(ref => tx.get(ref)));
      const expiredBookingIds = new Set();
      for (const lockSnap of lockSnaps) {
        if (!lockSnap.exists) continue;
        const lock = lockSnap.data() || {};
        if (!barberLockExpired(lock, nowMs)) throw new Error('BARBER_SLOT_UNAVAILABLE');
        if (lock.bookingId) expiredBookingIds.add(String(lock.bookingId));
      }
      const cooldownUntilMs = restrictionSnap.data()?.nextBookingAllowedAt?.toMillis?.() || 0;
      if (restrictionSnap.exists && cooldownUntilMs > nowMs) throw new Error('BARBER_BOOKING_COOLDOWN');
      const expiredBookingRefs = [...expiredBookingIds].filter(id => id !== bookingRef.id).map(id => db.collection('barberBookings').doc(id));
      const expiredBookingSnaps = await Promise.all(expiredBookingRefs.map(ref => tx.get(ref)));
      const price = Number(service.price);
      if (!Number.isFinite(price) || price < 1 || price > 100000) throw new Error('INVALID_BARBER_SERVICE_PRICE');
      const holdExpiresAt = paymentMethod === 'online' ? admin.firestore.Timestamp.fromMillis(nowMs + 15 * 60 * 1000) : null;
      for (let i = 0; i < expiredBookingSnaps.length; i += 1) {
        const stale = expiredBookingSnaps[i];
        if (stale.exists && stale.data()?.status === 'pending_payment') tx.update(expiredBookingRefs[i], { status: 'cancelled', paymentStatus: 'expired', cancelledAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
      const lockIds = lockRefs.map(ref => ref.id);
      const endMinute = startMinute + duration;
      const purgeAtMs = (barberCairoLocalToEpoch(date, endMinute) || (nowMs + duration * 60 * 1000)) + 60 * 60 * 1000;
      tx.create(bookingRef, {
        shopId, shopName: String(shop.name || ''), serviceId, serviceName: String(service.name || ''),
        barberId, barberName: String(barber.name || ''), userId: req.user.uid,
        customerName, customerPhone, localDate: date, startTime, startMinute,
        endTime: barberFormatTime(startMinute + duration), endMinute: startMinute + duration,
        durationMinutes: duration, price: Math.round(price * 100) / 100, currency: 'EGP',
        paymentMethod, paymentProvider: paymentMethod === 'online' ? 'xpay' : null,
        paymentStatus: paymentMethod === 'online' ? 'pending' : 'unpaid',
        status: paymentMethod === 'online' ? 'pending_payment' : 'confirmed',
        paymentHoldExpiresAt: holdExpiresAt, lockIds,
        purgeAt: admin.firestore.Timestamp.fromMillis(purgeAtMs),
        createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      tx.set(restrictionRef, {
        userId: req.user.uid,
        lastBookingId: bookingRef.id,
        lastBookingCreatedAt: admin.firestore.Timestamp.fromMillis(nowMs),
        nextBookingAllowedAt: admin.firestore.Timestamp.fromMillis(nowMs + 7 * 24 * 60 * 60 * 1000),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      for (let i = 0; i < lockRefs.length; i += 1) {
        tx.set(lockRefs[i], {
          shopId, barberId, localDate: date, slotMinute: segmentMinutes[i],
          bookingId: bookingRef.id, expiresAt: holdExpiresAt,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      return { id: bookingRef.id, paymentMethod, status: paymentMethod === 'online' ? 'pending_payment' : 'confirmed', price: Math.round(price * 100) / 100, nextBookingAllowedAt: new Date(nowMs + 7 * 24 * 60 * 60 * 1000).toISOString(), purgeAt: new Date(purgeAtMs).toISOString() };
    });
    return res.status(201).json({ ok: true, booking: result });
  } catch (error) {
    const statuses = {
      INVALID_BOOKING_DATE: 400, BOOKING_DATE_IN_PAST: 400, BOOKING_DATE_TOO_FAR: 400,
      BARBER_SHOP_NOT_FOUND: 404, BARBER_SERVICE_NOT_FOUND: 404, BARBER_NOT_FOUND: 404,
      BARBER_SHOP_CLOSED: 409, BARBER_SHOP_DATE_CLOSED: 409, BARBER_DATE_CLOSED: 409, BARBER_WEEKLY_DAY_OFF: 409, BARBER_TIME_OUTSIDE_HOURS: 400, BARBER_SLOT_UNAVAILABLE: 409,
      INVALID_BARBER_SERVICE_DURATION: 409, INVALID_BARBER_SERVICE_PRICE: 409,
      BARBER_BOOKING_COOLDOWN: 429
    };
    const status = statuses[error?.message] || 500;
    if (status >= 500) console.error('BARBER BOOKING CREATE ERROR:', error?.message || error);
    if (error?.message === 'BARBER_BOOKING_COOLDOWN') {
      const restriction = await admin.firestore().collection('barberBookingRestrictions').doc(req.user.uid).get().catch(() => null);
      const nextBookingAllowedAt = barberTimestampIso(restriction?.data()?.nextBookingAllowedAt);
      return res.status(429).json({ error: 'BARBER_BOOKING_COOLDOWN', nextBookingAllowedAt });
    }
    return res.status(status).json({ error: status >= 500 ? 'تعذر إنشاء الحجز.' : error.message });
  }
});

app.get('/api/barber-bookings/mine', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-bookings-mine', maxRequests: 40 }), async (req, res) => {
  try {
    const db = admin.firestore();
    const ownSnap = await db.collection('barberBookings').where('userId', '==', req.user.uid).limit(100).get();
    const ownedShops = await db.collection('barberShops').where('ownerId', '==', req.user.uid).limit(30).get();
    const ownerSnaps = await Promise.all(ownedShops.docs.map(shop => db.collection('barberBookings').where('shopId', '==', shop.id).limit(100).get()));
    const all = new Map();
    for (const snap of [ownSnap, ...ownerSnaps]) for (const docSnap of snap.docs) {
      const data = docSnap.data() || {};
      all.set(docSnap.id, { id: docSnap.id, ...data, viewerRole: data.userId === req.user.uid ? 'customer' : 'owner' });
    }
    const bookings = [...all.values()].sort((a, b) => `${b.localDate || ''} ${b.startTime || ''}`.localeCompare(`${a.localDate || ''} ${a.startTime || ''}`));
    return res.json({ ok: true, bookings: bookings.slice(0, 100) });
  } catch (error) {
    console.error('BARBER BOOKINGS MINE ERROR:', error?.message || error);
    return res.status(500).json({ error: 'تعذر تحميل الحجوزات.' });
  }
});

app.post('/api/barber-bookings/:bookingId/review', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-booking-review', maxRequests: 10 }), async (req, res) => {
  const bookingId = barberCleanText(req.params.bookingId, 150);
  const rating = Number(req.body?.rating);
  const comment = barberCleanText(req.body?.comment || '', 500);

  if (!bookingId) return res.status(400).json({ error: 'BARBER_BOOKING_NOT_FOUND' });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'INVALID_BARBER_RATING' });
  }

  try {
    const db = admin.firestore();
    const bookingRef = db.collection('barberBookings').doc(bookingId);
    let savedReview = null;

    await db.runTransaction(async tx => {
      const bookingSnap = await tx.get(bookingRef);
      if (!bookingSnap.exists) throw new Error('BARBER_BOOKING_NOT_FOUND');

      const booking = bookingSnap.data() || {};
      if (booking.userId !== req.user.uid) throw new Error('BARBER_REVIEW_FORBIDDEN');
      if (booking.status !== 'confirmed' || booking.attendanceStatus === 'no_show') throw new Error('BARBER_REVIEW_NOT_COMPLETED');
      if (booking.ratingSubmitted === true) throw new Error('BARBER_REVIEW_ALREADY_SUBMITTED');

      const localDate = String(booking.localDate || '');
      let endMinute = Number.isInteger(booking.endMinute) ? booking.endMinute : barberParseTime(booking.endTime);
      if (!Number.isInteger(endMinute) || endMinute < 0 || endMinute > 1440) {
        throw new Error('BARBER_REVIEW_INVALID_BOOKING_TIME');
      }
      const endAt = barberCairoLocalToEpoch(localDate, endMinute);
      if (!Number.isFinite(endAt)) throw new Error('BARBER_REVIEW_INVALID_BOOKING_TIME');
      if (endAt > Date.now()) throw new Error('BARBER_REVIEW_TOO_EARLY');

      const shopId = barberCleanText(booking.shopId, 150);
      const barberId = barberCleanText(booking.barberId, 150);
      if (!shopId || !barberId) throw new Error('BARBER_REVIEW_PROFILE_NOT_FOUND');
      const shopRef = db.collection('barberShops').doc(shopId);
      const barberRef = shopRef.collection('barbers').doc(barberId);
      const [shopSnap, barberSnap] = await Promise.all([tx.get(shopRef), tx.get(barberRef)]);
      if (!shopSnap.exists || !barberSnap.exists) throw new Error('BARBER_REVIEW_PROFILE_NOT_FOUND');

      const barber = barberSnap.data() || {};
      const currentCountValue = Number(barber.ratingCount || 0);
      const currentCount = Number.isFinite(currentCountValue) ? Math.max(0, Math.floor(currentCountValue)) : 0;
      const currentRatingValue = Number(barber.rating || 0);
      const currentRating = currentCount > 0 && Number.isFinite(currentRatingValue)
        ? Math.min(5, Math.max(0, currentRatingValue))
        : 0;
      const nextCount = currentCount + 1;
      const nextRating = Number((((currentRating * currentCount) + rating) / nextCount).toFixed(2));
      const actorLabel = barberCleanText(req.user.email || req.user.name || req.user.uid, 200);
      const auditRef = shopRef.collection('auditLog').doc();

      tx.update(bookingRef, {
        ratingSubmitted: true,
        rating,
        ratingComment: comment,
        ratingBy: req.user.uid,
        ratingAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      tx.update(barberRef, {
        rating: nextRating,
        ratingCount: nextCount,
        ratingUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      tx.create(auditRef, {
        actorId: req.user.uid,
        actorLabel,
        action: 'customer-rate-barber',
        targetType: 'barber',
        targetId: barberId,
        summary: `العميل أضاف تقييمًا للحلاق: ${rating}/5`,
        bookingId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      savedReview = { bookingId, rating, ratingCount: nextCount, averageRating: nextRating };
    });

    return res.json({ ok: true, ...savedReview });
  } catch (error) {
    const statuses = {
      BARBER_BOOKING_NOT_FOUND: 404,
      BARBER_REVIEW_FORBIDDEN: 403,
      BARBER_REVIEW_NOT_COMPLETED: 409,
      BARBER_REVIEW_ALREADY_SUBMITTED: 409,
      BARBER_REVIEW_TOO_EARLY: 409,
      BARBER_REVIEW_INVALID_BOOKING_TIME: 409,
      BARBER_REVIEW_PROFILE_NOT_FOUND: 409
    };
    const status = statuses[error?.message] || 500;
    if (status >= 500) console.error('BARBER REVIEW SAVE ERROR:', error?.message || error);
    return res.status(status).json({ error: status >= 500 ? 'تعذر حفظ تقييم الحلاق.' : error.message });
  }
});

app.post('/api/barber-bookings/mark-cash-paid', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-booking-cash-paid', maxRequests: 20 }), async (req, res) => {
  try {
    const bookingId = barberCleanText(req.body?.bookingId, 150);
    if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });
    const db = admin.firestore();
    const bookingRef = db.collection('barberBookings').doc(bookingId);
    let auditShopId = '';
    let auditSummary = '';
    let paymentChanged = false;
    await db.runTransaction(async tx => {
      const bookingSnap = await tx.get(bookingRef);
      if (!bookingSnap.exists) throw new Error('BARBER_BOOKING_NOT_FOUND');
      const booking = bookingSnap.data() || {};
      const shopRef = db.collection('barberShops').doc(String(booking.shopId || ''));
      const shopSnap = await tx.get(shopRef);
      if (!shopSnap.exists || shopSnap.data()?.ownerId !== req.user.uid) throw new Error('NOT_BARBER_BOOKING_OWNER');
      if (booking.paymentMethod !== 'onsite' || booking.status !== 'confirmed') throw new Error('BARBER_CASH_PAYMENT_NOT_ALLOWED');
      if (booking.paymentStatus === 'paid') { auditShopId = shopRef.id; return; }
      if (booking.paymentStatus !== 'unpaid') throw new Error('BARBER_CASH_PAYMENT_STATE_INVALID');
      tx.update(bookingRef, { paymentStatus: 'paid', paymentProvider: 'cash', paidAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(), paymentUpdatedBy: req.user.uid, paymentUpdatedByLabel: barberCleanText(req.user.email || req.user.uid, 200) });
      auditShopId = shopRef.id;
      paymentChanged = true;
      auditSummary = `تسجيل تحصيل نقدي بقيمة ${Number(booking.price || 0)} جنيه لحجز ${booking.customerName || ''} بتاريخ ${booking.localDate || ''} ${booking.startTime || ''}`;
    });
    if (paymentChanged) await barberLogAudit(db, auditShopId, req, 'booking-cash-payment-collected', 'booking', bookingId, auditSummary);
    return res.json({ ok: true, bookingId, paymentStatus: 'paid' });
  } catch (error) {
    const status = ({ BARBER_BOOKING_NOT_FOUND: 404, NOT_BARBER_BOOKING_OWNER: 403, BARBER_CASH_PAYMENT_NOT_ALLOWED: 409, BARBER_CASH_PAYMENT_STATE_INVALID: 409 })[error?.message] || 500;
    if (status >= 500) console.error('BARBER CASH PAYMENT ERROR:', error?.message || error);
    return res.status(status).json({ error: status >= 500 ? 'تعذر تحديث الدفع النقدي.' : error.message });
  }
});

app.post('/api/barber-bookings/:bookingId/reschedule', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-booking-reschedule', maxRequests: 12 }), async (req, res) => {
  try {
    const bookingId = barberCleanText(req.params.bookingId, 150);
    const date = barberCleanText(req.body?.date, 10);
    const startTime = barberCleanText(req.body?.startTime, 5);
    if (!bookingId || !date || !startTime) return res.status(400).json({ error: 'بيانات الموعد الجديد غير مكتملة.' });
    const dayOfWeek = barberValidateDate(date);
    const startMinute = barberParseTime(startTime);
    if (startMinute === null || startMinute % 15 !== 0) return res.status(400).json({ error: 'وقت الموعد الجديد غير صحيح.' });

    const db = admin.firestore();
    const bookingRef = db.collection('barberBookings').doc(bookingId);
    let auditShopId = '';
    let auditSummary = '';
    const result = await db.runTransaction(async tx => {
      const bookingSnap = await tx.get(bookingRef);
      if (!bookingSnap.exists) throw new Error('BARBER_BOOKING_NOT_FOUND');
      const booking = bookingSnap.data() || {};
      if (String(booking.userId || '') !== String(req.user.uid)) throw new Error('BARBER_RESCHEDULE_FORBIDDEN');
      if (booking.status !== 'confirmed' || booking.paymentMethod !== 'onsite' || booking.paymentStatus !== 'unpaid' || booking.attendanceStatus) {
        throw new Error('BARBER_BOOKING_NOT_RESCHEDULABLE');
      }
      const oldDate = String(booking.localDate || '');
      const oldStartMinute = Number.isInteger(booking.startMinute) ? booking.startMinute : barberParseTime(booking.startTime);
      const oldStartEpoch = barberCairoLocalToEpoch(oldDate, oldStartMinute);
      if (!Number.isFinite(oldStartEpoch) || oldStartEpoch <= Date.now()) throw new Error('BARBER_RESCHEDULE_TOO_LATE');
      if (oldDate === date && oldStartMinute === startMinute) throw new Error('BARBER_RESCHEDULE_UNCHANGED');

      const shopId = String(booking.shopId || '');
      const serviceId = String(booking.serviceId || '');
      const barberId = String(booking.barberId || '');
      if (!shopId || !serviceId || !barberId) throw new Error('BARBER_BOOKING_RESOURCES_INVALID');
      const shopRef = db.collection('barberShops').doc(shopId);
      const serviceRef = shopRef.collection('services').doc(serviceId);
      const barberRef = shopRef.collection('barbers').doc(barberId);
      const [shopSnap, serviceSnap, barberSnap] = await Promise.all([tx.get(shopRef), tx.get(serviceRef), tx.get(barberRef)]);
      if (!shopSnap.exists || shopSnap.data()?.status !== 'active') throw new Error('BARBER_SHOP_NOT_FOUND');
      if (!serviceSnap.exists || serviceSnap.data()?.active !== true) throw new Error('BARBER_SERVICE_NOT_FOUND');
      if (!barberSnap.exists || barberSnap.data()?.active !== true) throw new Error('BARBER_NOT_FOUND');

      // Preserve the original booking's duration and price when moving the same service.
      const duration = Number(booking.durationMinutes);
      if (!Number.isInteger(duration) || duration < 15 || duration > 180 || duration % 15 !== 0) throw new Error('INVALID_BARBER_SERVICE_DURATION');
      const shop = shopSnap.data();
      const barber = barberSnap.data();
      const schedule = barberAvailabilityStart(shop, date, dayOfWeek, barber);
      if (schedule.closed) throw new Error(schedule.closureReason || 'BARBER_SHOP_CLOSED');
      if (startMinute < schedule.openMinute || startMinute + duration > schedule.closeMinute) throw new Error('BARBER_TIME_OUTSIDE_HOURS');
      const current = barberCairoNow();
      if (date === current.date && startMinute <= current.minute) throw new Error('BOOKING_DATE_IN_PAST');

      const segmentMinutes = [];
      for (let minute = startMinute; minute < startMinute + duration; minute += 15) segmentMinutes.push(minute);
      const newLockRefs = segmentMinutes.map(minute => db.collection('barberBookingLocks').doc(barberLockId(shopId, barberId, date, minute)));
      const newLockIds = new Set(newLockRefs.map(ref => ref.id));
      const oldLockIds = Array.isArray(booking.lockIds) ? booking.lockIds.map(String) : [];
      const oldLockRefs = oldLockIds.map(id => db.collection('barberBookingLocks').doc(id));
      const allLockRefsById = new Map([...oldLockRefs, ...newLockRefs].map(ref => [ref.id, ref]));
      const allLockRefs = [...allLockRefsById.values()];
      const allLockSnaps = await Promise.all(allLockRefs.map(ref => tx.get(ref)));
      const lockSnapById = new Map(allLockSnaps.map(snap => [snap.id, snap]));
      const nowMs = Date.now();
      const expiredBookingIds = new Set();
      for (const lockRef of newLockRefs) {
        const lockSnap = lockSnapById.get(lockRef.id);
        if (!lockSnap?.exists) continue;
        const lock = lockSnap.data() || {};
        if (String(lock.bookingId || '') === bookingId) continue;
        if (!barberLockExpired(lock, nowMs)) throw new Error('BARBER_SLOT_UNAVAILABLE');
        if (lock.bookingId) expiredBookingIds.add(String(lock.bookingId));
      }
      const expiredBookingRefs = [...expiredBookingIds].map(id => db.collection('barberBookings').doc(id));
      const expiredBookingSnaps = await Promise.all(expiredBookingRefs.map(ref => tx.get(ref)));

      for (let i = 0; i < expiredBookingSnaps.length; i += 1) {
        const stale = expiredBookingSnaps[i];
        if (stale.exists && stale.data()?.status === 'pending_payment') {
          tx.update(expiredBookingRefs[i], {
            status: 'cancelled', paymentStatus: 'expired',
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      }
      for (const oldLockRef of oldLockRefs) {
        if (newLockIds.has(oldLockRef.id)) continue;
        const oldLockSnap = lockSnapById.get(oldLockRef.id);
        if (oldLockSnap?.exists && String(oldLockSnap.data()?.bookingId || '') === bookingId) tx.delete(oldLockRef);
      }

      const endMinute = startMinute + duration;
      const purgeAtMs = barberCairoLocalToEpoch(date, endMinute) + 60 * 60 * 1000;
      for (let i = 0; i < newLockRefs.length; i += 1) {
        tx.set(newLockRefs[i], {
          shopId, barberId, localDate: date, slotMinute: segmentMinutes[i],
          bookingId, expiresAt: null, createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      tx.update(bookingRef, {
        localDate: date, startTime, startMinute,
        endTime: barberFormatTime(endMinute), endMinute,
        lockIds: [...newLockIds],
        purgeAt: admin.firestore.Timestamp.fromMillis(purgeAtMs),
        locksReleasedAt: admin.firestore.FieldValue.delete(),
        lastRescheduledFrom: { localDate: oldDate, startTime: String(booking.startTime || ''), endTime: String(booking.endTime || '') },
        rescheduleCount: Number(booking.rescheduleCount || 0) + 1,
        rescheduledBy: req.user.uid,
        rescheduledAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      auditShopId = shopId;
      auditSummary = `تم تعديل موعد ${booking.customerName || ''} مع ${booking.barberName || ''} من ${oldDate} ${booking.startTime || ''} إلى ${date} ${startTime}`;
      return { bookingId, shopId, serviceId, barberId, localDate: date, startTime, endTime: barberFormatTime(endMinute), durationMinutes: duration, price: Number(booking.price || 0) };
    });
    await barberLogAudit(db, auditShopId, req, 'booking-rescheduled', 'booking', bookingId, auditSummary);
    return res.json({ ok: true, booking: result });
  } catch (error) {
    const statuses = {
      INVALID_BOOKING_DATE: 400, BOOKING_DATE_IN_PAST: 400, BOOKING_DATE_TOO_FAR: 400,
      BARBER_BOOKING_NOT_FOUND: 404, BARBER_RESCHEDULE_FORBIDDEN: 403,
      BARBER_BOOKING_NOT_RESCHEDULABLE: 409, BARBER_RESCHEDULE_TOO_LATE: 409,
      BARBER_RESCHEDULE_UNCHANGED: 400, BARBER_BOOKING_RESOURCES_INVALID: 409,
      BARBER_SHOP_NOT_FOUND: 404, BARBER_SERVICE_NOT_FOUND: 404, BARBER_NOT_FOUND: 404,
      BARBER_SHOP_CLOSED: 409, BARBER_SHOP_DATE_CLOSED: 409, BARBER_DATE_CLOSED: 409, BARBER_WEEKLY_DAY_OFF: 409,
      BARBER_TIME_OUTSIDE_HOURS: 400, BARBER_SLOT_UNAVAILABLE: 409, INVALID_BARBER_SERVICE_DURATION: 409
    };
    const status = statuses[error?.message] || 500;
    if (status >= 500) console.error('BARBER BOOKING RESCHEDULE ERROR:', error?.message || error);
    const friendly = {
      BARBER_RESCHEDULE_FORBIDDEN: 'لا يمكنك تعديل موعد ليس تابعًا لحسابك.',
      BARBER_BOOKING_NOT_RESCHEDULABLE: 'يمكن تعديل الحجز المؤكد غير المدفوع فقط، قبل تسجيل الحضور.',
      BARBER_RESCHEDULE_TOO_LATE: 'لا يمكن تعديل الموعد بعد بدايته.',
      BARBER_RESCHEDULE_UNCHANGED: 'اختار تاريخًا أو وقتًا مختلفًا عن الموعد الحالي.',
      BARBER_BOOKING_RESOURCES_INVALID: 'تعذر التحقق من تفاصيل الحجز.',
      BARBER_SLOT_UNAVAILABLE: 'الموعد الجديد اتحجز للتو. اختار وقتًا آخر.',
      BARBER_SHOP_CLOSED: 'الصالون إجازة في اليوم المختار.',
      BARBER_SHOP_DATE_CLOSED: 'الصالون كله إجازة في التاريخ المختار.',
      BARBER_DATE_CLOSED: 'الحلاق إجازة في التاريخ المختار.',
      BARBER_WEEKLY_DAY_OFF: 'هذا يوم الإجازة الأسبوعية للحلاق. اختار يومًا آخر.',
      BARBER_TIME_OUTSIDE_HOURS: 'الوقت المختار خارج مواعيد العمل.',
      BOOKING_DATE_IN_PAST: 'لا يمكن اختيار وقت مضى.',
      BOOKING_DATE_TOO_FAR: 'التعديل متاح خلال الـ90 يومًا القادمة فقط.'
    };
    return res.status(status).json({ error: status >= 500 ? 'تعذر تعديل موعد الحجز.' : (friendly[error?.message] || error.message) });
  }
});

app.post('/api/barber-bookings/attendance', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-booking-attendance', maxRequests: 30 }), async (req, res) => {
  try {
    const bookingId = barberCleanText(req.body?.bookingId, 150);
    const attendanceStatus = barberCleanText(req.body?.attendanceStatus, 20);
    if (!bookingId || !['completed', 'no_show'].includes(attendanceStatus)) {
      return res.status(400).json({ error: 'اختار حالة حضور صحيحة.' });
    }
    const db = admin.firestore();
    const bookingRef = db.collection('barberBookings').doc(bookingId);
    let auditShopId = '';
    let auditBarberId = '';
    let auditSummary = '';
    let updatedAtIso = null;
    await db.runTransaction(async tx => {
      const bookingSnap = await tx.get(bookingRef);
      if (!bookingSnap.exists) throw new Error('BARBER_BOOKING_NOT_FOUND');
      const booking = bookingSnap.data() || {};
      const shopId = String(booking.shopId || '');
      const barberId = String(booking.barberId || '');
      const shopRef = db.collection('barberShops').doc(shopId);
      const [shopSnap, accountSnap] = await Promise.all([
        tx.get(shopRef),
        booking.userId === req.user.uid ? Promise.resolve(null) : tx.get(db.collection('barberAccounts').doc(req.user.uid))
      ]);
      const isOwner = shopSnap.exists && shopSnap.data()?.ownerId === req.user.uid;
      const account = accountSnap?.exists ? accountSnap.data() || {} : {};
      const isAssignedBarber = accountSnap?.exists && account.shopId === shopId && account.barberId === barberId;
      if (!isOwner && !isAssignedBarber) throw new Error('NOT_BARBER_BOOKING_PARTICIPANT');
      if (booking.status !== 'confirmed') throw new Error('BARBER_ATTENDANCE_BOOKING_NOT_ACTIVE');
      if (booking.attendanceStatus) throw new Error('BARBER_ATTENDANCE_ALREADY_SET');
      const endMinute = Number.isInteger(booking.endMinute) ? booking.endMinute : barberParseTime(booking.endTime);
      if (!Number.isInteger(endMinute) || endMinute < 0 || endMinute > 1440) throw new Error('BARBER_ATTENDANCE_INVALID_TIME');
      const endEpoch = barberCairoLocalToEpoch(String(booking.localDate || ''), endMinute);
      if (!Number.isFinite(endEpoch)) throw new Error('BARBER_ATTENDANCE_INVALID_TIME');
      if (endEpoch > Date.now()) throw new Error('BARBER_ATTENDANCE_TOO_EARLY');
      const actorLabel = barberCleanText(req.user.email || req.user.name || req.user.uid, 200);
      const updatedAt = admin.firestore.FieldValue.serverTimestamp();
      tx.update(bookingRef, {
        attendanceStatus,
        attendanceUpdatedAt: updatedAt,
        attendanceUpdatedBy: req.user.uid,
        attendanceUpdatedByLabel: actorLabel,
        updatedAt
      });
      auditShopId = shopId;
      auditBarberId = barberId;
      auditSummary = `${attendanceStatus === 'completed' ? 'تم تأكيد تنفيذ' : 'تم تسجيل عدم حضور العميل لموعد'} الحلاقة ${booking.customerName || ''} — ${booking.localDate || ''} ${booking.startTime || ''}`;
      updatedAtIso = new Date().toISOString();
    });
    await barberLogAudit(db, auditShopId, req, `booking-attendance-${attendanceStatus}`, 'booking', bookingId, auditSummary);
    return res.json({ ok: true, bookingId, barberId: auditBarberId, attendanceStatus, updatedAt: updatedAtIso });
  } catch (error) {
    const status = ({
      BARBER_BOOKING_NOT_FOUND: 404,
      NOT_BARBER_BOOKING_PARTICIPANT: 403,
      BARBER_ATTENDANCE_BOOKING_NOT_ACTIVE: 409,
      BARBER_ATTENDANCE_ALREADY_SET: 409,
      BARBER_ATTENDANCE_INVALID_TIME: 409,
      BARBER_ATTENDANCE_TOO_EARLY: 409
    })[error?.message] || 500;
    if (status >= 500) console.error('BARBER BOOKING ATTENDANCE ERROR:', error?.message || error);
    const friendly = {
      BARBER_ATTENDANCE_BOOKING_NOT_ACTIVE: 'لا يمكن تغيير الحضور إلا لحجز مؤكد.',
      BARBER_ATTENDANCE_ALREADY_SET: 'تم تسجيل حالة الحضور لهذا الحجز بالفعل.',
      BARBER_ATTENDANCE_INVALID_TIME: 'تعذر التحقق من وقت انتهاء الموعد.',
      BARBER_ATTENDANCE_TOO_EARLY: 'يمكن تسجيل الحضور بعد انتهاء الموعد فقط.',
      NOT_BARBER_BOOKING_PARTICIPANT: 'غير مسموح لك بإدارة هذا الحجز.'
    };
    return res.status(status).json({ error: status >= 500 ? 'تعذر حفظ حالة الحضور.' : (friendly[error?.message] || error.message) });
  }
});

app.post('/api/barber-bookings/cancel', requireFirebaseUser, requireUserPermission('barberBooking'), rateLimit({ name: 'barber-booking-cancel', maxRequests: 15 }), async (req, res) => {
  try {
    const bookingId = barberCleanText(req.body?.bookingId, 150);
    if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });
    const db = admin.firestore();
    const bookingRef = db.collection('barberBookings').doc(bookingId);
    let auditShopId = '';
    let auditSummary = '';
    await db.runTransaction(async tx => {
      const bookingSnap = await tx.get(bookingRef);
      if (!bookingSnap.exists) throw new Error('BARBER_BOOKING_NOT_FOUND');
      const booking = bookingSnap.data() || {};
      const shopRef = db.collection('barberShops').doc(String(booking.shopId || ''));
      const restrictionUserId = String(booking.userId || '');
      const restrictionRef = restrictionUserId ? db.collection('barberBookingRestrictions').doc(restrictionUserId) : null;
      const [shopSnap, restrictionSnap] = await Promise.all([
        tx.get(shopRef),
        restrictionRef ? tx.get(restrictionRef) : Promise.resolve(null)
      ]);
      let assignedBarber = false;
      if (booking.userId !== req.user.uid && (!shopSnap.exists || shopSnap.data()?.ownerId !== req.user.uid)) {
        const accountRef = db.collection('barberAccounts').doc(req.user.uid);
        const accountSnap = await tx.get(accountRef);
        const account = accountSnap.data() || {};
        assignedBarber = accountSnap.exists && account.shopId === booking.shopId && account.barberId === booking.barberId;
      }
      if (booking.userId !== req.user.uid && (!shopSnap.exists || shopSnap.data()?.ownerId !== req.user.uid) && !assignedBarber) throw new Error('NOT_BARBER_BOOKING_PARTICIPANT');
      if (!['confirmed', 'pending_payment'].includes(booking.status) || booking.attendanceStatus) throw new Error('BARBER_BOOKING_NOT_CANCELLABLE');
      if (booking.paymentStatus === 'paid') throw new Error('BARBER_BOOKING_ALREADY_PAID');
      auditShopId = String(booking.shopId || '');
      auditSummary = `إلغاء حجز ${booking.customerName || ''} مع ${booking.barberName || 'الحلاق'} بتاريخ ${booking.localDate || ''} ${booking.startTime || ''}`;
      const lockIds = Array.isArray(booking.lockIds) ? booking.lockIds : [];
      const lockRefs = lockIds.map(id => db.collection('barberBookingLocks').doc(id));
      const locks = await Promise.all(lockRefs.map(ref => tx.get(ref)));
      for (let i = 0; i < locks.length; i += 1) if (locks[i].exists && locks[i].data()?.bookingId === bookingId) tx.delete(lockRefs[i]);
      tx.update(bookingRef, { status: 'cancelled', paymentStatus: booking.paymentStatus === 'pending' ? 'cancelled' : booking.paymentStatus, cancelledAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      if (restrictionRef && restrictionSnap?.exists && String(restrictionSnap.data()?.lastBookingId || '') === bookingId) {
        tx.delete(restrictionRef);
      }
    });
    await barberLogAudit(db, auditShopId, req, 'booking-cancelled', 'booking', bookingId, auditSummary);
    return res.json({ ok: true, bookingId });
  } catch (error) {
    const status = ({ BARBER_BOOKING_NOT_FOUND: 404, NOT_BARBER_BOOKING_PARTICIPANT: 403, BARBER_BOOKING_NOT_CANCELLABLE: 409, BARBER_BOOKING_ALREADY_PAID: 409 })[error?.message] || 500;
    if (status >= 500) console.error('BARBER BOOKING CANCEL ERROR:', error?.message || error);
    return res.status(status).json({ error: status >= 500 ? 'تعذر إلغاء الحجز.' : error.message });
  }
});

app.post('/api/barber-bookings/checkout', requireFirebaseUser, requireUserPermission('payments'), rateLimit({ name: 'barber-booking-checkout', maxRequests: 8 }), async (req, res) => {
  return res.status(410).json({
    error: 'SALON_CASH_ONLY',
    message: 'حجوزات الصالونات تُدفع نقدًا داخل الصالون فقط.'
  });
});

app.get('/api/finance/config', requireFirebaseUser, async (req, res) => {
  return res.json({ ok: true, ...getFinanceConfig() });
});


app.get('/api/seller/direct-payment-profile', requireFirebaseUser, requireUserPermission('paymentProfile'), async (req, res) => {
  try {
    const profile = await getSellerDirectPaymentProfile({
      db: admin.firestore(),
      uid: req.user.uid
    });
    return res.json({ ok: true, ...profile });
  } catch (error) {
    console.error('GET DIRECT PAYMENT PROFILE ERROR:', error);
    return res.status(500).json({ error: 'Could not load payment profile' });
  }
});

app.post('/api/seller/direct-payment-profile', requireFirebaseUser, requireUserPermission('paymentProfile'), rateLimit({ name: 'direct-payment-profile', maxRequests: 5, windowMs: 300000 }), async (req, res) => {
  try {
    const result = await saveSellerDirectPaymentProfile({
      db: admin.firestore(),
      uid: req.user.uid,
      method: req.body?.method,
      account: req.body?.account,
      accountName: req.body?.accountName
    });
    return res.json(result);
  } catch (error) {
    console.error('SAVE DIRECT PAYMENT PROFILE ERROR:', error);
    const status = {
      INVALID_PAYMENT_METHOD: 400,
      INVALID_PAYMENT_ACCOUNT: 400,
      INVALID_PAYMENT_ACCOUNT_NAME: 400
    }[error?.message] || 500;
    return res.status(status).json({
      error: status >= 500 ? 'Could not save payment profile' : error.message
    });
  }
});

app.post('/api/payments/direct/start', requireFirebaseUser, requireUserPermission('payments'), rateLimit({ name: 'direct-payment-start', maxRequests: 10, windowMs: 60000 }), async (req, res) => {
  const paymentConfig = getFinanceConfig();
  if (paymentConfig.provider !== 'direct_transfer' || paymentConfig.configured !== true) {
    return res.status(503).json({ error: 'DIRECT_PAYMENT_NOT_ENABLED', message: 'الدفع المباشر غير متاح حاليًا.' });
  }
  try {
    const orderId = String(req.body?.orderId || '').trim();
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });
    const result = await startDirectPayment({ db: admin.firestore(), uid: req.user.uid, orderId });
    return res.json(result);
  } catch (error) {
    console.error('DIRECT PAYMENT START ERROR:', error);
    const status = {
      ORDER_NOT_FOUND: 404,
      NOT_ORDER_BUYER: 403,
      ORDER_NOT_PAYABLE: 409,
      ORDER_ALREADY_PAID: 409,
      DIRECT_PAYMENT_STATE_INVALID: 409,
      ORDER_PAYMENT_STATE_INVALID: 409,
      SELLER_PAYMENT_PROFILE_MISSING: 409,
      INVALID_ORDER_TOTAL: 409,
      INVALID_PAYMENT_ACCOUNT: 409
    }[error?.message] || 500;
    return res.status(status).json({ error: status >= 500 ? 'Could not start direct payment' : error.message });
  }
});

app.post('/api/payments/direct/submit', requireFirebaseUser, requireUserPermission('payments'), rateLimit({ name: 'direct-payment-submit', maxRequests: 10, windowMs: 60000 }), async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || '').trim();
    const reference = String(req.body?.reference || '').trim();
    const note = String(req.body?.note || '').trim();
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });
    const result = await submitDirectPayment({ db: admin.firestore(), uid: req.user.uid, orderId, reference, note });
    return res.json(result);
  } catch (error) {
    console.error('DIRECT PAYMENT SUBMIT ERROR:', error);
    const status = {
      ORDER_NOT_FOUND: 404,
      NOT_ORDER_BUYER: 403,
      ORDER_PAYMENT_STATE_INVALID: 409,
      DIRECT_PAYMENT_STATE_INVALID: 409,
      ORDER_ALREADY_PAID: 409,
      INVALID_PAYMENT_REFERENCE: 400
    }[error?.message] || 500;
    return res.status(status).json({ error: status >= 500 ? 'Could not submit direct payment' : error.message });
  }
});

app.post('/api/payments/direct/confirm', requireFirebaseUser, requireUserPermission('payments'), rateLimit({ name: 'direct-payment-confirm', maxRequests: 10, windowMs: 60000 }), async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || '').trim();
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });
    const result = await confirmDirectPayment({ db: admin.firestore(), uid: req.user.uid, orderId });
    try {
      const db = admin.firestore();
      const snap = await db.collection('orders').doc(orderId).get();
      if (snap.exists) {
        const order = snap.data() || {};
        await db.collection('notifications').doc(`payment_received__${orderId}`).set({
          userId: order.userId,
          type: 'payment_confirmed',
          title: 'تم تأكيد الدفع',
          body: 'تم تأكيد استلام البائع للدفع المباشر، ويمكن الآن بدء تنفيذ الطلب.',
          orderId,
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    } catch (notificationError) {
      console.error('DIRECT PAYMENT CONFIRM NOTIFICATION ERROR:', notificationError);
    }
    return res.json(result);
  } catch (error) {
    console.error('DIRECT PAYMENT CONFIRM ERROR:', error);
    const status = {
      ORDER_NOT_FOUND: 404,
      NOT_ORDER_SELLER: 403,
      ORDER_PAYMENT_STATE_INVALID: 409,
      DIRECT_PAYMENT_STATE_INVALID: 409,
      PAYMENT_REFERENCE_MISSING: 409,
      INVALID_ORDER_TOTAL: 409
    }[error?.message] || 500;
    return res.status(status).json({ error: status >= 500 ? 'Could not confirm direct payment' : error.message });
  }
});

app.post('/api/payments/direct/reject', requireFirebaseUser, requireUserPermission('payments'), rateLimit({ name: 'direct-payment-reject', maxRequests: 10, windowMs: 60000 }), async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || '').trim();
    const reason = String(req.body?.reason || '').trim();
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });
    const result = await rejectDirectPayment({ db: admin.firestore(), uid: req.user.uid, orderId, reason });
    try {
      const db = admin.firestore();
      const snap = await db.collection('orders').doc(orderId).get();
      if (snap.exists) {
        const order = snap.data() || {};
        await db.collection('notifications').doc(`direct_payment_rejected__${orderId}`).set({
          userId: order.userId,
          type: 'payment_rejected',
          title: 'تم رفض إثبات الدفع',
          body: 'راجع بيانات التحويل وأعد إرسال مرجع الدفع الصحيح.',
          orderId,
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    } catch (notificationError) {
      console.error('DIRECT PAYMENT REJECT NOTIFICATION ERROR:', notificationError);
    }
    return res.json(result);
  } catch (error) {
    console.error('DIRECT PAYMENT REJECT ERROR:', error);
    const status = {
      ORDER_NOT_FOUND: 404,
      NOT_ORDER_SELLER: 403,
      ORDER_PAYMENT_STATE_INVALID: 409,
      DIRECT_PAYMENT_STATE_INVALID: 409
    }[error?.message] || 500;
    return res.status(status).json({ error: status >= 500 ? 'Could not reject direct payment' : error.message });
  }
});

app.get('/api/admin/platform-fees', requireFirebaseUser, async (req, res) => {
  try {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin access required' });
    const items = await listPlatformFeeDue({ db: admin.firestore() });
    return res.json({ ok: true, items });
  } catch (error) {
    console.error('LIST PLATFORM FEES ERROR:', error);
    return res.status(500).json({ error: 'Could not load platform fees' });
  }
});

app.post('/api/admin/platform-fees/mark-paid', requireFirebaseUser, rateLimit({ name: 'admin-platform-fees', maxRequests: 20 }), async (req, res) => {
  try {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin access required' });
    const sellerId = String(req.body?.sellerId || '').trim();
    const reference = String(req.body?.reference || '').trim();
    const amount = Number(req.body?.amount);
    const result = await markPlatformFeePaid({
      db: admin.firestore(),
      adminUid: req.user.uid,
      sellerId,
      amount,
      reference
    });
    return res.json(result);
  } catch (error) {
    console.error('MARK PLATFORM FEE PAID ERROR:', error);
    const status = {
      INVALID_PLATFORM_FEE_PAYMENT: 400,
      INVALID_PLATFORM_FEE_REFERENCE: 400,
      PLATFORM_FEE_PAYMENT_EXCEEDS_DUE: 409
    }[error?.message] || 500;
    return res.status(status).json({ error: status >= 500 ? 'Could not settle platform fee' : error.message });
  }
});


app.post(
  '/api/payments/xpay/checkout',
  requireFirebaseUser,
  requireUserPermission('payments'),
  rateLimit({ name: 'xpay-checkout', maxRequests: 8, windowMs: 60_000 }),
  async (req, res) => {
    try {
      const orderId = String(req.body?.orderId || '').trim();
      if (!orderId) return res.status(400).json({ error: 'orderId is required' });

      const config = getFinanceConfig();
      const xpay = getXPayConfig();
      if (config.provider !== 'xpay' || !xpay.configured) {
        return res.status(503).json({ error: 'XPAY_NOT_CONFIGURED' });
      }

      const db = admin.firestore();
      const orderRef = db.collection('orders').doc(orderId);
      const nowMs = Date.now();

      const claim = await db.runTransaction(async tx => {
        const snap = await tx.get(orderRef);
        if (!snap.exists) throw new Error('ORDER_NOT_FOUND');
        const order = snap.data() || {};
        if (order.userId !== req.user.uid) throw new Error('NOT_ORDER_BUYER');
        if (order.status !== 'pending') throw new Error('ORDER_NOT_PAYABLE');
        if (order.paymentStatus === 'paid' && order.financeStatus === 'escrowed') {
          throw new Error('ORDER_ALREADY_PAID');
        }
        if (order.paymentStatus !== 'pending' || order.financeStatus !== 'unfunded') {
          throw new Error('ORDER_PAYMENT_STATE_INVALID');
        }

        const expiresAt = order.xpayCheckoutExpiresAt ? Date.parse(order.xpayCheckoutExpiresAt) : 0;
        if (order.xpayCheckoutUrl && expiresAt > nowMs + 60_000) {
          return {
            existing: true,
            url: order.xpayCheckoutUrl,
            sessionId: order.xpayCheckoutSessionId || null
          };
        }

        if (order.xpayPaymentCreationStatus === 'creating') {
          const started = Number(order.xpayPaymentCreationStartedAtMs || 0);
          if (started > nowMs - 120_000) {
            throw new Error('PAYMENT_CREATION_IN_PROGRESS');
          }
        }

        const nextAttempt = Number(order.xpayPaymentAttempt || 0) + 1;
        const idempotencyKey = `elawamy-order-${orderId}-${nextAttempt}`;
        tx.update(orderRef, {
          paymentProvider: 'xpay',
          xpayPaymentAttempt: nextAttempt,
          xpayPaymentCreationStatus: 'creating',
          xpayPaymentCreationStartedAtMs: nowMs,
          xpayAttemptKey: idempotencyKey,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return {
          existing: false,
          idempotencyKey,
          serviceName: String(order.serviceName || 'طلب ElaWamy'),
          totalPrice: Number(order.totalPrice ?? order.price),
          email: String(order.userEmail || req.user.email || '')
        };
      });

      if (claim.existing) {
        return res.json({ ok: true, provider: 'xpay', url: claim.url, sessionId: claim.sessionId, reused: true });
      }

      const returnUrl = String(
        process.env.XPAY_RETURN_URL || `https://elawamy-8d7e9.web.app/orders?order=${encodeURIComponent(orderId)}&payment=return`
      ).replace('{ORDER_ID}', encodeURIComponent(orderId));
      const cancelUrl = String(
        process.env.XPAY_CANCEL_URL || `https://elawamy-8d7e9.web.app/orders?order=${encodeURIComponent(orderId)}&payment=cancelled`
      ).replace('{ORDER_ID}', encodeURIComponent(orderId));

      try {
        const session = await createXPayCheckoutSession({
          orderId,
          serviceName: claim.serviceName,
          totalPrice: claim.totalPrice,
          returnUrl,
          cancelUrl,
          idempotencyKey: claim.idempotencyKey
        });

        const expiresAt = session?.expiresAt || null;
        await orderRef.update({
          paymentProvider: 'xpay',
          xpayCheckoutSessionId: session?.id || null,
          xpayCheckoutUrl: session?.url || null,
          xpayCheckoutExpiresAt: expiresAt,
          xpayPaymentCreationStatus: 'ready',
          xpayPaymentCreationStartedAtMs: null,
          xpayPaymentStatus: session?.paymentStatus || 'unpaid',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        if (!session?.url) throw new Error('XPAY_CHECKOUT_URL_MISSING');
        return res.json({ ok: true, provider: 'xpay', url: session.url, sessionId: session.id });
      } catch (error) {
        await orderRef.update({
          xpayPaymentCreationStatus: 'failed',
          xpayPaymentCreationStartedAtMs: null,
          xpayLastErrorCode: error?.code || 'xpay_error',
          xpayLastErrorRequestId: error?.requestId || null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }).catch(() => {});
        throw error;
      }
    } catch (error) {
      console.error('XPAY CHECKOUT ERROR:', error?.code || error?.message, error?.requestId || '');
      const status = {
        ORDER_NOT_FOUND: 404,
        NOT_ORDER_BUYER: 403,
        ORDER_NOT_PAYABLE: 409,
        ORDER_ALREADY_PAID: 409,
        ORDER_PAYMENT_STATE_INVALID: 409,
        PAYMENT_CREATION_IN_PROGRESS: 409,
        XPAY_NOT_CONFIGURED: 503,
        XPAY_CHECKOUT_URL_MISSING: 502,
        INVALID_ORDER_TOTAL: 409
      }[error?.message] || error?.status || 500;
      const code = error?.code || error?.message || 'XPAY_CHECKOUT_ERROR';
      return res.status(status).json({
        error: status >= 500 ? 'تعذر بدء الدفع عبر XPay.' : code
      });
    }
  }
);

app.post('/api/webhooks/xpay', async (req, res) => {
  try {
    const signature = req.headers['xpay-signature'];
    const rawBody = req.body;
    const verified = verifyXPaySignature(rawBody, signature);
    if (!verified.valid) {
      return res.status(400).send('invalid signature');
    }

    const event = verified.event || {};
    const eventId = String(event.id || '').trim();
    if (!eventId) return res.status(400).send('missing event id');

    const db = admin.firestore();
    const eventRef = db.collection('xpayWebhookEvents').doc(eventId);
    const previous = await eventRef.get();
    if (previous.exists && previous.data()?.status === 'processed') {
      return res.status(200).send('ok');
    }

    const object = event?.data?.object || {};
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        if (object.paymentStatus === 'paid') {
          const isBarberBookingPayment = object?.metadata?.context === 'barber_booking';
          const result = isBarberBookingPayment
            ? await barberConfirmXPayPayment(db, object)
            : await confirmXPayPayment({ db, session: object });
          if (isBarberBookingPayment) {
            if (result?.needsRefund) {
              const paymentIntentId = String(object?.paymentIntent?.id || '').trim();
              if (!paymentIntentId) throw new Error('BARBER_LATE_PAYMENT_REFUND_REQUIRES_PAYMENT_INTENT');
              await createXPayRefund({ paymentIntentId, orderId: String(result.bookingId), reason: 'requested_by_customer' });
            }
            break;
          }
          try {
            const notificationId = `payment_received__${result.orderId}`;
            const orderSnap = await db.collection('orders').doc(result.orderId).get();
            if (orderSnap.exists) {
              const order = orderSnap.data() || {};
              await db.collection('notifications').doc(notificationId).set({
                userId: order.sellerId,
                type: 'payment_received',
                title: 'تم دفع الطلب',
                body: 'تم تأكيد الدفع للطلب ويمكنك البدء في التنفيذ.',
                orderId: result.orderId,
                read: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
              });
            }
          } catch (notificationError) {
            console.error('XPAY PAYMENT NOTIFICATION ERROR:', notificationError);
          }
        }
        break;
      }

      case 'checkout.session.async_payment_failed':
        if (object?.metadata?.context === 'barber_booking') await barberFailXPayPayment(db, object, 'async_payment_failed');
        else await markXPayPaymentFailed({ db, session: object, reason: 'async_payment_failed' });
        break;

      case 'checkout.session.expired':
        if (object?.metadata?.context === 'barber_booking') await barberFailXPayPayment(db, object, 'checkout_expired');
        else await markXPayPaymentFailed({ db, session: object, reason: 'checkout_expired' });
        break;

      case 'refund.created':
        if (object.status === 'succeeded') {
          await recordXPayRefund({ db, refund: object });
        }
        break;

      case 'charge.refunded': {
        const refund = Array.isArray(object.refunds) ? object.refunds[object.refunds.length - 1] : null;
        if (refund?.status === 'succeeded') {
          await recordXPayRefund({ db, refund });
        }
        break;
      }

      default:
        break;
    }

    await eventRef.set({
      eventId,
      type: String(event.type || ''),
      livemode: Boolean(event.livemode),
      status: 'processed',
      processedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return res.status(200).send('ok');
  } catch (error) {
    console.error('XPAY WEBHOOK ERROR:', error?.message, error?.requestId || '');
    return res.status(500).send('webhook processing failed');
  }
});


app.post(
  '/api/payments/demo/confirm',
  requireFirebaseUser,
  requireUserPermission('payments'),
  rateLimit({ name: 'demo-payment', maxRequests: 10 }),
  async (req, res) => {
    try {
      const paymentConfig = getFinanceConfig();
      if (process.env.NODE_ENV === 'production' || paymentConfig.provider !== 'demo' || paymentConfig.configured !== true) {
        return res.status(503).json({ error: 'DEMO_PAYMENT_NOT_ENABLED', message: 'الدفع التجريبي غير متاح حاليًا.' });
      }

      const orderId = String(req.body?.orderId || '').trim();
      if (!orderId) return res.status(400).json({ error: 'orderId is required' });

      const result = await confirmDemoPayment({
        db: admin.firestore(),
        uid: req.user.uid,
        orderId
      });

      try {
        const orderSnap = await admin.firestore().collection('orders').doc(orderId).get();
        if (orderSnap.exists) {
          const order = orderSnap.data() || {};
          await admin.firestore().collection('notifications').add({
            userId: order.sellerId,
            type: 'payment_received',
            title: 'تم دفع الطلب',
            body: 'تم تأكيد الدفع للطلب ويمكنك البدء في التنفيذ.',
            orderId,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      } catch (notificationError) {
        console.error('PAYMENT NOTIFICATION ERROR:', notificationError);
      }

      return res.json(result);
    } catch (error) {
      console.error('DEMO PAYMENT ERROR:', error);
      const status = {
        ORDER_NOT_FOUND: 404,
        NOT_ORDER_BUYER: 403,
        ORDER_NOT_PAYABLE: 409,
        ORDER_PAYMENT_STATE_INVALID: 409,
        INVALID_ORDER_TOTAL: 409
      }[error?.message] || 500;
      return res.status(status).json({
        error: status === 500 ? 'Could not confirm payment' : error.message
      });
    }
  }
);

app.post(
  '/api/orders/complete',
  requireFirebaseUser,
  requireUserPermission('orderActions'),
  rateLimit({ name: 'orders-complete', maxRequests: 10 }),
  async (req, res) => {
    try {
      const orderId = String(req.body?.orderId || '').trim();
      if (!orderId) return res.status(400).json({ error: 'orderId is required' });

      const result = await completeOrderAndRelease({
        db: admin.firestore(),
        uid: req.user.uid,
        orderId
      });

      try {
        const db = admin.firestore();
        const snap = await db.collection('orders').doc(orderId).get();
        if (snap.exists) {
          const order = snap.data() || {};
          await db.collection('notifications').add({
            userId: order.sellerId,
            type: 'order_completed',
            title: 'اكتمل الطلب',
            body: 'تم تأكيد استلام الطلب وتحويل أرباحك إلى الرصيد المتاح.',
            orderId,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      } catch (notificationError) {
        console.error('COMPLETE NOTIFICATION ERROR:', notificationError);
      }

      return res.json(result);
    } catch (error) {
      console.error('COMPLETE ORDER ERROR:', error);
      const status = {
        ORDER_NOT_FOUND: 404,
        NOT_ORDER_BUYER: 403,
        ORDER_NOT_DELIVERED: 409,
        ORDER_NOT_FUNDED: 409,
        INVALID_FINANCIAL_DATA: 409,
        SELLER_PENDING_BALANCE_MISMATCH: 409
      }[error?.message] || 500;
      return res.status(status).json({
        error: status === 500 ? 'Could not complete order' : error.message
      });
    }
  }
);

app.post(
  '/api/orders/cancel',
  requireFirebaseUser,
  requireUserPermission('cancelOrder'),
  rateLimit({ name: 'orders-cancel', maxRequests: 10 }),
  async (req, res) => {
    try {
      const orderId = String(req.body?.orderId || '').trim();
      if (!orderId) return res.status(400).json({ error: 'orderId is required' });

      const db = admin.firestore();
      const orderSnap = await db.collection('orders').doc(orderId).get();
      if (!orderSnap.exists) return res.status(404).json({ error: 'ORDER_NOT_FOUND' });
      const order = orderSnap.data() || {};
      if (order.userId !== req.user.uid) return res.status(403).json({ error: 'NOT_ORDER_BUYER' });

      if (getFinanceConfig().provider === 'xpay' && order.paymentProvider === 'xpay' && order.paymentStatus === 'paid') {
        const begin = await beginXPayRefund({ db, uid: req.user.uid, orderId });
        if (begin.alreadyRefunded) return res.json(begin);
        if (begin.refundPending) {
          try {
            const refund = await createXPayRefund({
              paymentIntentId: begin.paymentIntentId,
              orderId
            });
            const finalRefund = refund?.status === 'succeeded'
              ? await recordXPayRefund({ db, refund })
              : { ok: true, refundPending: true, orderId, refundId: refund?.id || null };
            return res.json(finalRefund);
          } catch (refundError) {
            await db.collection('orders').doc(orderId).update({
              xpayRefundStatus: 'failed',
              xpayRefundError: refundError?.code || 'XPAY_REFUND_ERROR',
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }).catch(() => {});
            throw refundError;
          }
        }
      }

      const result = await cancelOrder({
        db,
        uid: req.user.uid,
        orderId
      });

      return res.json(result);
    } catch (error) {
      console.error('CANCEL ORDER ERROR:', error);
      const status = {
        ORDER_NOT_FOUND: 404,
        NOT_ORDER_BUYER: 403,
        ORDER_NOT_CANCELLABLE: 409,
        ORDER_PAYMENT_STATE_INVALID: 409,
        DIRECT_PAYMENT_REFUND_REQUIRED: 409,
        INVALID_FINANCIAL_DATA: 409,
        SELLER_PENDING_BALANCE_MISMATCH: 409,
        XPAY_PAYMENT_INTENT_MISSING: 409,
        XPAY_PAYMENT_PENDING_CANNOT_CANCEL: 409,
        XPAY_NOT_CONFIGURED: 503,
        ORDER_REFUND_STATE_INVALID: 409
      }[error?.message] || error?.status || 500;
      return res.status(status).json({
        error: status === 500 ? 'Could not cancel order' : (error?.code || error?.message)
      });
    }
  }
);

app.post(
  '/api/wallet/withdraw',
  requireFirebaseUser,
  requireUserPermission('withdraw'),
  rateLimit({ name: 'wallet-withdraw', maxRequests: 5, windowMs: 300000 }),
  async (req, res) => {
    try {
      const result = await requestWithdrawal({
        db: admin.firestore(),
        uid: req.user.uid,
        method: req.body?.method,
        account: req.body?.account,
        amount: req.body?.amount
      });
      return res.status(201).json(result);
    } catch (error) {
      console.error('WITHDRAW REQUEST ERROR:', error);
      const status = {
        INVALID_WITHDRAWAL_METHOD: 400,
        INVALID_WITHDRAWAL_ACCOUNT: 400,
        WITHDRAWAL_BELOW_MINIMUM: 400,
        INSUFFICIENT_AVAILABLE_BALANCE: 409
      }[error?.message] || 500;
      return res.status(status).json({
        error: status === 500 ? 'Could not request withdrawal' : error.message
      });
    }
  }
);

app.post(
  '/api/admin/withdrawals/process',
  requireFirebaseUser,
  rateLimit({ name: 'admin-withdrawals', maxRequests: 20 }),
  async (req, res) => {
    try {
      if (req.user.admin !== true) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const withdrawalId = String(req.body?.withdrawalId || '').trim();
      const action = String(req.body?.action || '').trim();

      if (!withdrawalId || !['approve', 'mark_paid', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'Invalid withdrawal action' });
      }

      const result = await processWithdrawal({
        db: admin.firestore(),
        adminUid: req.user.uid,
        withdrawalId,
        action
      });

      return res.json(result);
    } catch (error) {
      console.error('PROCESS WITHDRAWAL ERROR:', error);
      const status = {
        WITHDRAWAL_NOT_FOUND: 404,
        INVALID_WITHDRAWAL: 409,
        WITHDRAWAL_NOT_APPROVABLE: 409,
        WITHDRAWAL_NOT_PAYABLE: 409,
        WITHDRAWAL_NOT_REJECTABLE: 409,
        WITHDRAWAL_LOCK_MISMATCH: 409,
        INVALID_WITHDRAWAL_ACTION: 400
      }[error?.message] || 500;
      return res.status(status).json({
        error: status === 500 ? 'Could not process withdrawal' : error.message
      });
    }
  }
);

app.post(
  '/api/orders/create',
  requireFirebaseUser,
  requireUserPermission('buying'),
  rateLimit({ name: 'orders-create', maxRequests: 10 }),
  async (req, res) => {
    try {
      const serviceId = String(
        req.body?.serviceId || ''
      ).trim();

      const answers = req.body?.answers;
      const selectedExtras = req.body?.selectedExtras;

      if (!serviceId) {
        return res.status(400).json({
          error: 'serviceId is required'
        });
      }

      const result = await createOrder({
        db: admin.firestore(),
        uid: req.user.uid,
        serviceId,
        answers,
        selectedExtras
      });

      return res.status(201).json({
        ok: true,
        ...result
      });

    } catch (error) {
      console.error(
        'CREATE ORDER ERROR:',
        error
      );

      const errors = {
        INVALID_ORDER_DATA: 400,
        SERVICE_NOT_FOUND: 404,
        SERVICE_NOT_APPROVED: 409,
        INVALID_SELLER: 403,
        INVALID_SERVICE_PRICE: 409,
        INVALID_SERVICE_DELIVERY: 409,
        INVALID_REQUIREMENTS: 400,
        INVALID_REQUIREMENT_INDEX: 400,
        DUPLICATE_REQUIREMENT: 400,
        MISSING_REQUIRED_REQUIREMENT: 400,
        INVALID_SERVICE_REQUIREMENT: 409,
        INVALID_EXTRAS: 400,
        INVALID_EXTRA_INDEX: 400,
        DUPLICATE_EXTRA: 400,
        INVALID_SERVICE_EXTRA: 409,
        INVALID_ORDER_TOTAL: 409,
        INVALID_TOTAL_DELIVERY: 409
      };

      const status = errors[error?.message] || 500;

      return res.status(status).json({
        error:
          status === 500
            ? 'Could not create order'
            : error.message
      });
    }
  }
);

app.post(
  '/api/orders/accept',
  requireFirebaseUser,
  requireUserPermission('orderActions'),
  rateLimit({ name: 'orders-accept', maxRequests: 10 }),
  async (req, res) => {
    try {
      const orderId = String(req.body?.orderId || '').trim();

      if (!orderId) {
        return res.status(400).json({ error: 'orderId is required' });
      }

      const db = admin.firestore();
      const orderRef = db.collection('orders').doc(orderId);

      const result = await db.runTransaction(async tx => {
        const snap = await tx.get(orderRef);

        if (!snap.exists) throw new Error('ORDER_NOT_FOUND');

        const order = snap.data() || {};

        if (order.sellerId !== req.user.uid) {
          throw new Error('NOT_ORDER_SELLER');
        }

        if (order.status !== 'pending') {
          throw new Error('ORDER_NOT_ACCEPTABLE');
        }

        if (order.paymentStatus !== 'paid' || !['escrowed', 'direct_paid'].includes(order.financeStatus)) {
          throw new Error('ORDER_NOT_FUNDED');
        }

        const deliveryDays = Math.max(1, Number(order.deliveryDays || 1));
        if (!Number.isInteger(deliveryDays) || deliveryDays > 90) {
          throw new Error('INVALID_DELIVERY_DAYS');
        }

        const nowMs = Date.now();
        const acceptedAt = admin.firestore.Timestamp.fromMillis(nowMs);
        const dueAt = admin.firestore.Timestamp.fromMillis(
          nowMs + deliveryDays * 24 * 60 * 60 * 1000
        );

        tx.update(orderRef, {
          status: 'accepted',
          acceptedAt,
          startedAt: acceptedAt,
          dueAt,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return {
          ok: true,
          orderId,
          status: 'accepted',
          acceptedAt,
          dueAt
        };
      });

      try {
        const freshOrder = await db.collection('orders').doc(orderId).get();
        const order = freshOrder.data() || {};
        await db.collection('notifications').add({
          userId: order.userId,
          type: 'order_accepted',
          title: 'تم قبول الطلب',
          body: 'البائع قبل طلبك وبدأ في تنفيذ الخدمة.',
          orderId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          read: false
        });
      } catch (notificationError) {
        console.error('ACCEPT NOTIFICATION ERROR:', notificationError);
      }

      return res.json(result);
    } catch (error) {
      console.error('ACCEPT ORDER ERROR:', error);
      const status = {
        ORDER_NOT_FOUND: 404,
        NOT_ORDER_SELLER: 403,
        ORDER_NOT_ACCEPTABLE: 409,
        ORDER_NOT_FUNDED: 409,
        INVALID_DELIVERY_DAYS: 409
      }[error?.message] || 500;

      return res.status(status).json({
        error: status === 500 ? 'Could not accept order' : error.message
      });
    }
  }
);

app.post(
  '/api/orders/deliver',
  requireFirebaseUser,
  requireUserPermission('orderActions'),
  rateLimit({ name: 'orders-deliver', maxRequests: 10 }),
  async (req, res) => {
    try {
      const orderId = String(req.body?.orderId || '').trim();
      const nextStatus = String(req.body?.status || '').trim();

      if (!orderId || !['delivered', 'redelivered'].includes(nextStatus)) {
        return res.status(400).json({
          error: 'Invalid orderId or delivery status'
        });
      }

      const db = admin.firestore();
      const orderRef = db.collection('orders').doc(orderId);
      const orderSnap = await orderRef.get();

      if (!orderSnap.exists) {
        return res.status(404).json({
          error: 'Order not found'
        });
      }

      const order = orderSnap.data() || {};

      if (order.sellerId !== req.user.uid) {
        return res.status(403).json({
          error: 'Only the seller can deliver this order'
        });
      }

      const expectedStatus =
        nextStatus === 'delivered'
          ? 'accepted'
          : 'revision_requested';

      if (order.status !== expectedStatus) {
        return res.status(409).json({
          error: 'Order is not in the correct status for this delivery'
        });
      }

      const filesSnap = await orderRef
        .collection('files')
        .where('role', '==', 'seller')
        .limit(20)
        .get();

      let hasValidSellerFile = false;

      for (const fileDoc of filesSnap.docs) {
        const file = fileDoc.data() || {};

        if (file.uploaderId !== req.user.uid) {
          continue;
        }

        if (typeof file.path !== 'string' || !file.path) {
          continue;
        }

        if (await storageObjectInfo(file.path)) {
          hasValidSellerFile = true;
          break;
        }
      }

      if (!hasValidSellerFile) {
        return res.status(409).json({
          error: 'Cannot deliver order before uploading a valid delivery file'
        });
      }

      await db.runTransaction(async tx => {
        const freshSnap = await tx.get(orderRef);

        if (!freshSnap.exists) {
          throw new Error('ORDER_NOT_FOUND');
        }

        const freshOrder = freshSnap.data() || {};

        if (freshOrder.sellerId !== req.user.uid) {
          throw new Error('NOT_ORDER_SELLER');
        }

        if (freshOrder.status !== expectedStatus) {
          throw new Error('ORDER_STATUS_CHANGED');
        }

        const now = admin.firestore.FieldValue.serverTimestamp();

        tx.update(orderRef, {
          status: nextStatus,
          ...(nextStatus === 'delivered'
            ? { deliveredAt: now }
            : { redeliveredAt: now }),
          updatedAt: now
        });
      });

      const notification = nextStatus === 'delivered'
        ? {
            type: 'order_delivered',
            title: 'تم تسليم الطلب',
            body: 'تم تسليم طلبك وإرفاق ملفات التسليم.'
          }
        : {
            type: 'order_redelivered',
            title: 'تمت إعادة تسليم الطلب',
            body: 'تم تنفيذ التعديلات وإعادة تسليم العمل.'
          };

      try {
        await db.collection('notifications').add({
          userId: order.userId,
          type: notification.type,
          title: notification.title,
          body: notification.body,
          orderId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          read: false
        });
      } catch (notificationError) {
        console.error(
          'DELIVERY NOTIFICATION ERROR:',
          notificationError
        );
      }

      return res.json({
        ok: true,
        orderId,
        status: nextStatus
      });

    } catch (error) {
      console.error('DELIVER ORDER ERROR:', error);

      const status = {
        ORDER_NOT_FOUND: 404,
        NOT_ORDER_SELLER: 403,
        ORDER_STATUS_CHANGED: 409
      }[error?.message] || 500;

      return res.status(status).json({
        error:
          status === 500
            ? 'Could not deliver order'
            : error.message
      });
    }
  }
);


app.post('/api/offers/accept', requireFirebaseUser, requireUserPermission('customOffers'), rateLimit({ name: 'offers-accept', maxRequests: 10 }), async (req, res) => {
  try {
    const offerId = String(req.body?.offerId || '').trim();
    if (!offerId) return res.status(400).json({ error: 'offerId is required' });
    const db = admin.firestore();
    const offerRef = db.collection('customOffers').doc(offerId);
    const orderRef = db.collection('orders').doc();
    const result = await db.runTransaction(async tx => {
      const offerSnap = await tx.get(offerRef);
      if (!offerSnap.exists) throw new Error('OFFER_NOT_FOUND');
      const offer = offerSnap.data() || {};
      if (offer.buyerId !== req.user.uid) throw new Error('NOT_OFFER_BUYER');
      if (offer.sellerId === req.user.uid) throw new Error('INVALID_OFFER_SELLER');
      if (offer.status !== 'pending') throw new Error('OFFER_NOT_ACCEPTABLE');

      if (offer.serviceId) {
        const serviceRef = db.collection('services').doc(String(offer.serviceId));
        const serviceSnap = await tx.get(serviceRef);
        if (!serviceSnap.exists) throw new Error('OFFER_SERVICE_NOT_FOUND');
        const service = serviceSnap.data() || {};
        if (service.status !== 'approved' || service.ownerId !== offer.sellerId) {
          throw new Error('OFFER_SERVICE_INVALID');
        }
      }

      const sellerUserSnap = await tx.get(db.collection('users').doc(String(offer.sellerId)));
      if (sellerUserSnap.exists && sellerUserSnap.data()?.status === 'blocked') {
        throw new Error('OFFER_SELLER_BLOCKED');
      }

      const totalPrice = Number(offer.price);
      const deliveryDays = Number(offer.deliveryDays);
      if (!Number.isFinite(totalPrice) || totalPrice <= 0 || totalPrice > 100000) throw new Error('INVALID_OFFER_PRICE');
      if (!Number.isInteger(deliveryDays) || deliveryDays < 1 || deliveryDays > 90) throw new Error('INVALID_OFFER_DELIVERY');
      const now = admin.firestore.FieldValue.serverTimestamp();
      tx.set(orderRef, {
        serviceId: String(offer.serviceId || ''),
        serviceName: String(offer.serviceName || offer.title || 'عرض مخصص'),
        sellerId: String(offer.sellerId || ''),
        userId: req.user.uid,
        basePrice: totalPrice,
        extrasTotal: 0,
        totalPrice,
        price: totalPrice,
        baseDeliveryDays: deliveryDays,
        extrasDeliveryDays: 0,
        deliveryDays,
        requirements: [],
        selectedExtras: [],
        offerId,
        status: 'pending',
        paymentStatus: 'pending',
        paymentProvider: null,
        paymentId: null,
        paidAt: null,
        platformFee: 0,
        sellerNetAmount: 0,
        financeStatus: 'unfunded',
        createdAt: now,
        updatedAt: now
      });
      tx.update(offerRef, { status: 'accepted', orderId: orderRef.id, acceptedAt: now, updatedAt: now });
      return { ok: true, orderId: orderRef.id };
    });
    const orderSnap = await db.collection('orders').doc(result.orderId).get();
    if (orderSnap.exists) {
      const order = orderSnap.data() || {};
      await db.collection('notifications').add({
        userId: order.sellerId,
        type: 'offer_accepted',
        title: 'تم قبول عرضك',
        body: 'المشتري قبل العرض وتم إنشاء طلب جديد.',
        orderId: result.orderId,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    return res.json(result);
  } catch (error) {
    const map = {
      OFFER_NOT_FOUND: 404,
      NOT_OFFER_BUYER: 403,
      INVALID_OFFER_SELLER: 409,
      OFFER_NOT_ACCEPTABLE: 409,
      OFFER_SERVICE_NOT_FOUND: 404,
      OFFER_SERVICE_INVALID: 409,
      OFFER_SELLER_BLOCKED: 409,
      INVALID_OFFER_PRICE: 400,
      INVALID_OFFER_DELIVERY: 400
    };
    const status = map[error?.message] || 500;
    console.error('ACCEPT OFFER ERROR:', error);
    return res.status(status).json({ error: status === 500 ? 'Could not accept offer' : error.message });
  }
});

app.post('/api/offers/withdraw', requireFirebaseUser, requireUserPermission('customOffers'), rateLimit({ name: 'offers-withdraw', maxRequests: 10 }), async (req, res) => {
  try {
    const offerId = String(req.body?.offerId || '').trim();
    if (!offerId) return res.status(400).json({ error: 'offerId is required' });
    const db = admin.firestore();
    const ref = db.collection('customOffers').doc(offerId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'OFFER_NOT_FOUND' });
    const offer = snap.data() || {};
    if (offer.sellerId !== req.user.uid) return res.status(403).json({ error: 'NOT_OFFER_SELLER' });
    if (offer.status !== 'pending') return res.status(409).json({ error: 'OFFER_NOT_WITHDRAWABLE' });
    await ref.update({ status: 'withdrawn', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.json({ ok: true, offerId, status: 'withdrawn' });
  } catch (error) {
    console.error('WITHDRAW OFFER ERROR:', error);
    return res.status(500).json({ error: 'Could not withdraw offer' });
  }
});


app.get('/api/admin/users', requireFirebaseUser, rateLimit({ name: 'admin-list-users', maxRequests: 20 }), async (req, res) => {
  try {
    if (req.user.admin !== true) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const users = [];
    let pageToken;

    do {
      const result = await admin.auth().listUsers(1000, pageToken);

      for (const user of result.users) {
        users.push({
          uid: user.uid,
          email: user.email || '',
          displayName: user.displayName || '',
          disabled: user.disabled === true,
          emailVerified: user.emailVerified === true,
          creationTime: user.metadata?.creationTime || null,
          lastSignInTime: user.metadata?.lastSignInTime || null
        });
      }

      pageToken = result.pageToken || undefined;
    } while (pageToken);

    return res.json({
      ok: true,
      total: users.length,
      users
    });
  } catch (error) {
    console.error('ADMIN LIST USERS ERROR:', error);
    return res.status(500).json({
      error: 'Could not list Firebase Authentication users'
    });
  }
});



function adminSerialize(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && typeof value.toDate === 'function') {
    try { return value.toDate().toISOString(); } catch {}
  }
  if (typeof value === 'object' && typeof value.path === 'string' && value.constructor?.name === 'DocumentReference') {
    return { path: value.path };
  }
  if (Array.isArray(value)) return value.map(adminSerialize);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = adminSerialize(child);
    return out;
  }
  return value;
}

async function getAdminUserCollectionDocs(db, collectionName, fields, uid, limit = 250) {
  const merged = new Map();
  for (const field of fields) {
    try {
      const snap = await db.collection(collectionName)
        .where(field, '==', uid)
        .limit(limit)
        .get();
      snap.docs.forEach(doc => merged.set(doc.id, {
        id: doc.id,
        ...adminSerialize(doc.data())
      }));
    } catch (error) {
      console.warn(`ADMIN USER QUERY SKIPPED ${collectionName}.${field}:`, error.message);
    }
  }
  return [...merged.values()];
}

app.get('/api/admin/users/:userId', requireFirebaseUser, rateLimit({ name: 'admin-user-detail', maxRequests: 40 }), async (req, res) => {
  try {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin access required' });

    const userId = String(req.params?.userId || '').trim();
    if (!userId || userId.length > 256) return res.status(400).json({ error: 'Invalid userId' });

    const db = admin.firestore();
    const authUser = await admin.auth().getUser(userId);
    const controls = await getUserControls(db, userId);

    const directCollections = [
      ['sellerProfiles', ['ownerId', 'userId']],
      ['sellerPaymentProfiles', ['userId', 'sellerId']],
      ['wallets', ['userId']],
      ['affiliateProfiles', ['userId']],
      ['verificationRequests', ['userId']],
    ];

    const activityCollections = [
      ['services', ['ownerId', 'userId']],
      ['orders', ['userId', 'buyerId', 'sellerId']],
      ['customOffers', ['userId', 'buyerId', 'sellerId']],
      ['reviews', ['userId', 'sellerId', 'buyerId']],
      ['disputes', ['userId', 'buyerId', 'sellerId']],
      ['serviceRequests', ['userId', 'buyerId', 'sellerId']],
      ['notifications', ['userId']],
      ['supportTickets', ['userId']],
      ['affiliateReferrals', ['userId', 'referrerId', 'referredId']],
      ['conversations', ['userId', 'buyerId', 'sellerId']],
      ['withdrawals', ['userId', 'sellerId']],
      ['transactions', ['userId', 'sellerId', 'buyerId']],
      ['files', ['userId', 'ownerId']],
    ];

    const [directResults, activityResults] = await Promise.all([
      Promise.all(directCollections.map(([name, fields]) => getAdminUserCollectionDocs(db, name, fields, userId, 25))),
      Promise.all(activityCollections.map(([name, fields]) => getAdminUserCollectionDocs(db, name, fields, userId, 200)))
    ]);

    const direct = {};
    directCollections.forEach(([name], index) => {
      direct[name] = directResults[index];
    });

    const userDoc = await db.collection('users').doc(userId).get();
    direct.users = userDoc.exists
      ? [{ id: userDoc.id, ...adminSerialize(userDoc.data()) }]
      : [];

    const activity = {};
    activityCollections.forEach(([name], index) => {
      activity[name] = activityResults[index];
    });

    const sellerProfile = await db.collection('sellerProfiles').doc(userId).get();
    if (sellerProfile.exists) {
      direct.sellerProfiles = [{ id: sellerProfile.id, ...adminSerialize(sellerProfile.data()) }];

      try {
        const portfolioSnap = await sellerProfile.ref.collection('portfolio').limit(200).get();
        activity.portfolio = portfolioSnap.docs.map(doc => ({
          id: doc.id,
          ...adminSerialize(doc.data())
        }));
      } catch (error) {
        console.warn('ADMIN USER PORTFOLIO QUERY SKIPPED:', error.message);
      }
    } else {
      activity.portfolio = [];
    }

    try {
      const favoritesSnap = await db.collection('favorites').doc(userId).collection('services').limit(200).get();
      activity.favoriteServices = favoritesSnap.docs.map(doc => ({
        id: doc.id,
        ...adminSerialize(doc.data())
      }));
    } catch (error) {
      console.warn('ADMIN USER FAVORITES QUERY SKIPPED:', error.message);
      activity.favoriteServices = [];
    }

    direct.auth = {
      uid: authUser.uid,
      email: authUser.email || '',
      phoneNumber: authUser.phoneNumber || '',
      displayName: authUser.displayName || '',
      photoURL: authUser.photoURL || '',
      disabled: authUser.disabled === true,
      emailVerified: authUser.emailVerified === true,
      creationTime: authUser.metadata?.creationTime || null,
      lastSignInTime: authUser.metadata?.lastSignInTime || null,
      lastRefreshTime: authUser.metadata?.lastRefreshTime || null,
      providerData: adminSerialize(authUser.providerData || []),
      customClaims: adminSerialize(authUser.customClaims || {})
    };

    const counts = Object.fromEntries(
      Object.entries({ ...direct, ...activity }).map(([name, docs]) => [name, Array.isArray(docs) ? docs.length : 0])
    );

    return res.json({
      ok: true,
      userId,
      auth: direct.auth,
      controls: adminSerialize(controls),
      direct,
      activity,
      counts
    });
  } catch (error) {
    console.error('ADMIN USER DETAIL ERROR:', error);
    const status = error?.code === 'auth/user-not-found' ? 404 : 500;
    return res.status(status).json({ error: status === 404 ? 'User not found' : 'Could not load user details' });
  }
});

app.post('/api/admin/users/status', requireFirebaseUser, rateLimit({ name: 'admin-user-status', maxRequests: 30 }), async (req, res) => {
  try {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin access required' });
    const userId = String(req.body?.userId || '').trim();
    const status = String(req.body?.status || '').trim();
    if (!userId || !['active', 'blocked'].includes(status)) return res.status(400).json({ error: 'Invalid user status' });
    await admin.auth().updateUser(userId, { disabled: status === 'blocked' });

    // Invalidate existing sessions when an account is blocked.
    // This works together with verifyIdToken(..., true) above.
    if (status === 'blocked') {
      await admin.auth().revokeRefreshTokens(userId);
    }

    await admin.firestore().collection('users').doc(userId).set({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return res.json({ ok: true, userId, status, disabled: status === 'blocked' });
  } catch (error) {
    console.error('ADMIN USER STATUS ERROR:', error);
    const status = error?.code === 'auth/user-not-found' ? 404 : 500;
    return res.status(status).json({ error: status === 404 ? 'User not found' : 'Could not update user status' });
  }
});


app.post('/api/admin/users/controls', requireFirebaseUser, rateLimit({ name: 'admin-user-controls', maxRequests: 40 }), async (req, res) => {
  try {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin access required' });

    const userId = String(req.body?.userId || '').trim();
    const disabledFeatures = Array.isArray(req.body?.disabledFeatures)
      ? req.body.disabledFeatures
      : null;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

    if (!userId || userId.length > 256) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    if (!Array.isArray(disabledFeatures)) {
      return res.status(400).json({ error: 'disabledFeatures must be an array' });
    }

    if (disabledFeatures.length > USER_CONTROL_PERMISSIONS.length) {
      return res.status(400).json({ error: 'Too many disabled features' });
    }

    const invalid = [...new Set(disabledFeatures.map(value => String(value).trim()))]
      .filter(value => !USER_CONTROL_PERMISSIONS.includes(value));

    if (invalid.length) {
      return res.status(400).json({
        error: 'Unknown user permission',
        invalid
      });
    }

    if (reason.length > 500) {
      return res.status(400).json({ error: 'Reason is too long' });
    }

    await admin.auth().getUser(userId);

    const db = admin.firestore();
    await db.collection('userControls').doc(userId).set({
      disabledFeatures: [...new Set(disabledFeatures.map(value => String(value).trim()))],
      reason,
      updatedBy: req.user.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    const controls = await getUserControls(db, userId);

    return res.json({
      ok: true,
      userId,
      controls: adminSerialize(controls)
    });
  } catch (error) {
    console.error('ADMIN USER CONTROLS ERROR:', error);
    const status = error?.code === 'auth/user-not-found' ? 404 : 500;
    return res.status(status).json({
      error: status === 404 ? 'User not found' : 'Could not update user controls'
    });
  }
});


app.post('/api/admin/services/feature', requireFirebaseUser, rateLimit({ name: 'admin-service-feature', maxRequests: 40 }), async (req, res) => {
  try {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin access required' });
    const serviceId = String(req.body?.serviceId || '').trim();
    const featured = req.body?.featured === true;
    if (!serviceId) return res.status(400).json({ error: 'serviceId is required' });

    const db = admin.firestore();
    const serviceRef = db.collection('services').doc(serviceId);
    const serviceSnap = await serviceRef.get();
    if (!serviceSnap.exists) return res.status(404).json({ error: 'Service not found' });
    const service = serviceSnap.data() || {};
    if (service.status !== 'approved') return res.status(409).json({ error: 'Only approved services can be featured' });

    await serviceRef.update({
      featured,
      featuredUntil: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    if (service.ownerId) {
      await db.collection('notifications').add({
        userId: service.ownerId,
        type: featured ? 'service_featured' : 'service_unfeatured',
        title: featured ? 'تم تمييز خدمتك' : 'تم إلغاء تمييز خدمتك',
        body: featured ? 'أصبحت خدمتك ضمن الخدمات المميزة.' : 'تم إلغاء تمييز خدمتك من قبل الإدارة.',
        orderId: '',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        read: false
      });
    }

    return res.json({ ok: true, serviceId, featured });
  } catch (error) {
    console.error('ADMIN FEATURE SERVICE ERROR:', error);
    return res.status(500).json({ error: 'Could not update featured status' });
  }
});

app.get('/api/seller/stats', requireFirebaseUser, rateLimit({ name: 'seller-stats', maxRequests: 20 }), async (req, res) => {
  try {
    const db = admin.firestore();
    const uid = req.user.uid;
    const ordersSnap = await db.collection('orders').where('sellerId', '==', uid).limit(500).get();
    const sellerProfileSnap = await db.collection('sellerProfiles').doc(uid).get();
    const sellerProfile = sellerProfileSnap.exists ? (sellerProfileSnap.data() || {}) : {};
    const sinceMs = Date.now() - 180 * 24 * 60 * 60 * 1000;
    let completed = 0;
    let cancelled = 0;
    let gross = 0;
    for (const d of ordersSnap.docs) {
      const o = d.data() || {};
      const created = o.createdAt?.toMillis?.() || 0;
      if (created && created < sinceMs) continue;
      const value = Number(o.price || 0);
      if (o.status === 'completed') { completed += 1; gross += Number(o.sellerNetAmount || value); }
      if (o.status === 'cancelled') cancelled += 1;
    }
    const totalClosed = completed + cancelled;
    const completionRate = totalClosed ? Math.round((completed / totalClosed) * 1000) / 10 : 100;
    const level = getSellerLevel(sellerProfile.completedOrders);
    return res.json({ ok: true, completed, cancelled, gross, completionRate, level });
  } catch (error) {
    console.error('SELLER STATS ERROR:', error);
    return res.status(500).json({ error: 'Could not calculate seller stats' });
  }
});


// ElaWamy AI — authenticated assistant with one safe, reversible tool.
const ELAWAMY_AI_SYSTEM_INSTRUCTION = [
  'أنت ElaWamy AI، المساعد الذكي الرسمي لمنصة العوامي للخدمات الرقمية.',
  'أجب باللغة العربية المصرية الواضحة ما لم يطلب المستخدم لغة أخرى.',
  'ساعد المستخدم في كتابة أوصاف الخدمات والإعلانات وخطط العمل وفهم استخدام منصة العوامي.',
  'لا تدّعِ أنك قرأت الطلبات أو الرصيد أو بيانات الحساب؛ لا يوجد في هذه النسخة وصول مباشر إلى هذه البيانات.',
  'الأداة المتاحة الوحيدة هي create_service_draft: تحفظ مسودة خدمة خاصة بصاحب الحساب ولا تنشرها.',
  'لا تستخدم create_service_draft إلا بعد أن يطلب المستخدم صراحةً حفظ الخدمة كمسودة، وبعد أن تتأكد أن الاسم والتصنيف والوصف متوفرة.',
  'لا تنشر خدمة ولا تعدّل طلبًا أو رصيدًا أو مدفوعات أو حسابات مستخدمين.',
  'لا تطلب كلمات المرور أو رموز التحقق أو مفاتيح API أو بيانات البطاقات أو بيانات الدفع أو مستندات خاصة.',
  'لا توصي المستخدم بإرسال بيانات شخصية أو مالية أو أسرار إلى المحادثة.',
  'إذا لم تكن تعرف معلومة تخص العوامي، صرّح بذلك ولا تخترعها.',
  'كن عمليًا ومختصرًا، واعرض خطوات واضحة.'
].join('\n');

const ELAWAMY_AI_TOOLS = [{
  type: 'function',
  name: 'create_service_draft',
  description: 'Save a private draft of a marketplace service for the authenticated user. This does not publish or submit the service.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'اسم الخدمة' },
      category: { type: 'string', description: 'تصنيف الخدمة' },
      description: { type: 'string', description: 'وصف الخدمة بالتفصيل' },
      price: { type: 'number', description: 'السعر المقترح بالجنيه المصري، إن توفر' },
      deliveryDays: { type: 'integer', description: 'مدة التسليم بالأيام، إن توفرت' }
    },
    required: ['title', 'category', 'description']
  }
}];

async function saveElaWamyAiServiceDraft(uid, args = {}) {
  const title = String(args.title || '').trim().slice(0, 120);
  const category = String(args.category || '').trim().slice(0, 60);
  const description = String(args.description || '').trim().slice(0, 3000);
  const rawPrice = Number(args.price);
  const rawDays = Number(args.deliveryDays);
  const price = Number.isFinite(rawPrice) && rawPrice >= 0 && rawPrice <= 10_000_000
    ? rawPrice
    : null;
  const deliveryDays = Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= 90
    ? rawDays
    : 3;

  if (!title || !category || description.length < 20) {
    return { ok: false, message: 'المسودة تحتاج اسمًا وتصنيفًا ووصفًا لا يقل عن 20 حرفًا.' };
  }

  const ref = admin.firestore().collection('aiServiceDrafts').doc();
  await ref.create({
    ownerId: uid,
    title,
    category,
    description,
    price,
    deliveryDays,
    status: 'draft',
    source: 'elawamy-ai',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return {
    ok: true,
    draftId: ref.id,
    title,
    status: 'draft',
    message: 'تم حفظ مسودة الخدمة في حساب صاحبها، ولم يتم نشرها.'
  };
}

// ElaWamy AI team: ten specialist roles, two-stage answers, and admin-reviewed development plans.
// The roles are orchestration personas; they are not ten separately billed model instances.
const ELAWAMY_AI_TEAM_ROLES = [
  { id: 'customer_helper', name: 'مساعد العملاء', group: 'customers', focus: 'فهم سؤال العميل والرد عليه بلغة واضحة وخطوات عملية.' },
  { id: 'customer_reviewer', name: 'مراجع خدمة العملاء', group: 'customers', focus: 'مراجعة الإجابة، كشف التخمين أو النقص، وتصحيحها قبل عرضها.' },
  { id: 'architect', name: 'مهندس المعمارية', group: 'development', focus: 'تصميم الحل وتقسيم العمل وتحديد أثر التغييرات.' },
  { id: 'web_frontend', name: 'مطور الموقع', group: 'development', focus: 'واجهات الموقع وإمكانية الاستخدام وإمكانية الوصول.' },
  { id: 'mobile_app', name: 'مطور التطبيق', group: 'development', focus: 'تطبيق Android وExpo وتجربة الهاتف.' },
  { id: 'backend', name: 'مطور الخادم', group: 'development', focus: 'واجهات API والخدمات الخلفية والتحقق من المدخلات.' },
  { id: 'firebase', name: 'مهندس Firebase', group: 'development', focus: 'Authentication وFirestore وقواعد الأمان والبيانات.' },
  { id: 'security', name: 'خبير الأمان', group: 'development', focus: 'الصلاحيات والخصوصية وإساءة الاستخدام وحماية الأسرار.' },
  { id: 'qa', name: 'مختبر الجودة', group: 'development', focus: 'حالات الاختبار والانحدار ومعايير قبول التغيير.' },
  { id: 'release', name: 'مسؤول النشر', group: 'development', focus: 'خطة النشر والنسخ الاحتياطي والتراجع ومراقبة ما بعد النشر.' }
];

function extractElaWamyGeminiText(result) {
  return (Array.isArray(result?.steps) ? result.steps : [])
    .filter(step => step?.type === 'model_output' && Array.isArray(step.content))
    .flatMap(step => step.content
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text))
    .join('\n')
    .trim();
}

async function requestElaWamyGeminiText({ apiKey, model, systemInstruction, prompt, maxOutputTokens = 1100 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35_000);
  try {
    let providerResponse;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      providerResponse = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
          'Api-Revision': '2026-05-20'
        },
        body: JSON.stringify({
          model,
          store: false,
          system_instruction: systemInstruction,
          generation_config: { max_output_tokens: maxOutputTokens },
          input: [{ type: 'user_input', content: [{ type: 'text', text: prompt }] }]
        }),
        signal: controller.signal
      });
      if (providerResponse.status !== 503 || attempt === 2) break;
      await new Promise(resolve => setTimeout(resolve, 700 * (2 ** attempt)));
    }

    const result = await providerResponse.json().catch(() => ({}));
    if (!providerResponse.ok) {
      const error = new Error(`Gemini provider returned ${providerResponse.status}`);
      error.status = providerResponse.status;
      throw error;
    }
    const text = extractElaWamyGeminiText(result);
    if (!text) throw new Error('Gemini returned an empty response');
    return text.slice(0, 18_000);
  } finally {
    clearTimeout(timeout);
  }
}

async function requestElaWamyOpenRouterReview({ prompt, maxTokens = 900 }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const model = String(process.env.OPENROUTER_REVIEW_MODEL || 'openrouter/free').trim();
  // Fail closed: never let a configuration mistake select a paid OpenRouter model.
  if (model !== 'openrouter/free' && !model.endsWith(':free')) {
    throw new Error('OPENROUTER_REVIEW_MODEL must be openrouter/free or a :free model ID');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://elawamy-8d7e9.web.app',
        'X-Title': 'Elawamy AI'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'أنت مراجع مستقل لإجابات فريق العوامي. لا تخترع معلومات أو حقائق أو قدرات غير مثبتة. صحح الأخطاء والنواقص فقط، وحافظ على اللغة العربية المصرية الواضحة. أعد الإجابة النهائية مباشرة دون شرح داخلي أو ذكر سلسلة التفكير.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: maxTokens,
        temperature: 0.15,
        provider: { data_collection: 'deny', zdr: true }
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`OpenRouter reviewer returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const content = data?.choices?.[0]?.message?.content;
    const text = typeof content === 'string'
      ? content.trim()
      : Array.isArray(content)
        ? content.filter(part => part?.type === 'text').map(part => String(part.text || '')).join('\n').trim()
        : '';
    if (!text) throw new Error('OpenRouter reviewer returned an empty response');
    return text.slice(0, 18_000);
  } finally {
    clearTimeout(timeout);
  }
}

async function reviewElaWamyAiOutput({ apiKey, model, originalPrompt, draft, purpose = 'customer' }) {
  const reviewerPrompt = [
    `نوع المراجعة: ${purpose === 'development' ? 'خطة تطوير تقنية' : 'رد خدمة عملاء'}`,
    'راجع المسودة التالية بعين ناقدة. صحح الأخطاء والتناقضات، واذكر بوضوح ما لا يمكن التحقق منه. لا تخترع حقائق، ولا تحذف تحذيرات الأمان أو الخصوصية.',
    'طلب المستخدم/الأدمن:',
    String(originalPrompt || '').slice(0, 5000),
    'المسودة المطلوب مراجعتها:',
    String(draft || '').slice(0, 14_000),
    'أعد النسخة النهائية فقط. إذا كانت المسودة سليمة، حسّن الوضوح دون إضافة ادعاءات.'
  ].join('\n\n');

  try {
    const reviewed = await requestElaWamyOpenRouterReview({
      prompt: reviewerPrompt,
      maxTokens: purpose === 'development' ? 1700 : 850
    });
    if (reviewed) return { text: reviewed, reviewer: 'OpenRouter free reviewer' };
  } catch (error) {
    // The free reviewer is optional. Gemini remains the no-payment fallback.
    console.warn('ELAWAMY OPENROUTER REVIEW SKIPPED:', error?.message || error);
  }

  try {
    const reviewed = await requestElaWamyGeminiText({
      apiKey,
      model,
      systemInstruction: 'أنت مراجع جودة ثانٍ لفريق العوامي. لا تخترع معلومات. راجع المسودة وصحح الأخطاء والنواقص مع الحفاظ على التحذيرات والقيود.',
      prompt: reviewerPrompt,
      maxOutputTokens: purpose === 'development' ? 1700 : 850
    });
    return { text: reviewed, reviewer: 'Gemini second review' };
  } catch (error) {
    console.warn('ELAWAMY GEMINI SECOND REVIEW SKIPPED:', error?.message || error);
    return { text: String(draft || ''), reviewer: 'review unavailable' };
  }
}

const ELAWAMY_AI_DEVELOPMENT_SYSTEM = [
  'أنت فريق تطوير العوامي المكوّن من ثمانية تخصصات تعمل كمراجعين متعاونين، وليس وكيلًا يملك صلاحية تنفيذ الأوامر.',
  'الأدوار: مهندس المعمارية، مطور الموقع، مطور التطبيق، مطور الخادم، مهندس Firebase، خبير الأمان، مختبر الجودة، مسؤول النشر.',
  'كل دور يراجع المهمة من اختصاصه، ثم راجع الأدوار نتائج بعضهم وحدد الاختلافات والتعارضات قبل التقرير النهائي.',
  'لا تدّعِ أنك فتحت ملفات غير مرفقة أو نفذت اختبارات أو عدّلت ملفات أو نشرت تحديثًا.',
  'لا تطلب أسرارًا أو مفاتيح API أو كلمات مرور أو رموز تحقق أو بيانات عملاء.',
  'لا تقترح تشغيل أوامر مدمرة أو تعديل بيانات إنتاج أو مدفوعات دون مراجعة بشرية.',
  'اكتب تقريرًا عربيًا منظمًا بهذه الأقسام: ملخص المهمة، رأي كل متخصص، مراجعة متبادلة والاختلافات، المقترح، المخاطر والصلاحيات، خطة الاختبارات، خطة التراجع، وما يحتاج موافقة الأدمن.',
  'أي تعديل برمجي يجب أن يظل اقتراحًا ينتظر موافقة الأدمن. الموافقة لا تعني النشر أو التنفيذ التلقائي.'
].join('\n');

app.post(
  '/api/ai/chat',
  requireFirebaseUser,
  rateLimit({ name: 'ai-chat-minute', maxRequests: 8, windowMs: 60_000 }),
  rateLimit({ name: 'ai-chat-daily', maxRequests: 30, windowMs: 24 * 60 * 60 * 1000 }),
  async (req, res) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error: 'AI_NOT_CONFIGURED',
          message: 'مساعد العوامي لم يتم تفعيله على الخادم بعد.'
        });
      }

      const history = req.body?.history;
      if (!Array.isArray(history) || history.length < 1 || history.length > 45) {
        return res.status(400).json({ error: 'INVALID_HISTORY' });
      }

      const lastStep = history[history.length - 1];
      if (!lastStep || lastStep.type !== 'user_input') {
        return res.status(400).json({ error: 'LAST_MESSAGE_MUST_BE_USER_INPUT' });
      }

      const lastText = typeof lastStep.content === 'string'
        ? lastStep.content
        : Array.isArray(lastStep.content)
          ? lastStep.content
              .filter(part => part && part.type === 'text' && typeof part.text === 'string')
              .map(part => part.text)
              .join('\n')
          : '';

      if (!lastText.trim() || lastText.length > 2500) {
        return res.status(400).json({ error: 'MESSAGE_REQUIRED_OR_TOO_LONG' });
      }

      let historyBytes = 0;
      try {
        historyBytes = Buffer.byteLength(JSON.stringify(history), 'utf8');
      } catch {
        return res.status(400).json({ error: 'INVALID_HISTORY' });
      }
      if (historyBytes > 48_000) {
        return res.status(413).json({ error: 'CONVERSATION_TOO_LONG', message: 'ابدأ محادثة جديدة للمتابعة.' });
      }

      const model = String(process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
      if (!/^[a-zA-Z0-9._-]{3,100}$/.test(model)) {
        return res.status(500).json({ error: 'INVALID_AI_MODEL_CONFIGURATION' });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 40_000);
      let workingHistory = [...history];
      let finalSteps = [];
      let finalReply = '';
      let savedDraft = null;

      try {
        for (let round = 0; round < 3; round += 1) {
          let providerResponse;

          for (let attempt = 0; attempt < 3; attempt += 1) {
            providerResponse = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey,
                'Api-Revision': '2026-05-20'
              },
              body: JSON.stringify({
                model,
                store: false,
                system_instruction: ELAWAMY_AI_SYSTEM_INSTRUCTION,
                generation_config: { max_output_tokens: 700 },
                input: workingHistory,
                tools: ELAWAMY_AI_TOOLS
              }),
              signal: controller.signal
            });

            if (providerResponse.status !== 503 || attempt === 2) break;

            const delay = 800 * (2 ** attempt) + Math.floor(Math.random() * 300);
            await new Promise(resolve => setTimeout(resolve, delay));
          }

          const result = await providerResponse.json().catch(() => ({}));
          if (!providerResponse.ok) {
            console.error('ELAWAMY AI PROVIDER ERROR:', providerResponse.status);
            if (savedDraft) {
              finalReply = `تم حفظ مسودة الخدمة «${savedDraft.title}» في قسم المسودات. لم يتم نشرها.`;
              break;
            }
            if (providerResponse.status === 429) {
              return res.status(429).json({ error: 'AI_RATE_LIMIT', message: 'وصل المساعد إلى حد الاستخدام المؤقت. جرّب مرة أخرى لاحقًا.' });
            }
            if (providerResponse.status === 401 || providerResponse.status === 403) {
              return res.status(503).json({ error: 'AI_KEY_INVALID', message: 'مفتاح الذكاء الاصطناعي يحتاج مراجعة في إعدادات الخادم.' });
            }
            return res.status(502).json({ error: 'AI_PROVIDER_UNAVAILABLE', message: 'تعذر الاتصال بمزود الذكاء الاصطناعي الآن.' });
          }

          const steps = Array.isArray(result.steps) ? result.steps : [];
          if (!steps.length) {
            return res.status(502).json({ error: 'AI_EMPTY_RESPONSE', message: 'لم يصل رد من المساعد. حاول مرة أخرى.' });
          }

          finalSteps = [...finalSteps, ...steps];
          workingHistory = [...workingHistory, ...steps];

          const functionCalls = steps.filter(step => step?.type === 'function_call');
          if (!functionCalls.length) {
            finalReply = steps
              .filter(step => step?.type === 'model_output' && Array.isArray(step.content))
              .flatMap(step => step.content.filter(part => part?.type === 'text').map(part => String(part.text || '')))
              .join('\n')
              .trim();
            break;
          }

          const functionResults = [];
          for (const call of functionCalls.slice(0, 2)) {
            let toolResult;
            if (call.name === 'create_service_draft' && !savedDraft) {
              toolResult = await saveElaWamyAiServiceDraft(req.user.uid, call.arguments || {});
              if (toolResult.ok) savedDraft = toolResult;
            } else {
              toolResult = { ok: false, message: 'هذه العملية غير متاحة أو تم تنفيذ الحد الأقصى من المسودات في الطلب الواحد.' };
            }

            const functionResult = {
              type: 'function_result',
              name: String(call.name || ''),
              call_id: String(call.id || ''),
              result: [{ type: 'text', text: JSON.stringify(toolResult) }]
            };
            functionResults.push(functionResult);
            finalSteps.push(functionResult);
          }

          workingHistory = [...workingHistory, ...functionResults];
        }
      } finally {
        clearTimeout(timeout);
      }

      if (!finalReply && savedDraft) {
        finalReply = `تم حفظ مسودة الخدمة «${savedDraft.title}» في قسم المسودات. لم يتم نشرها.`;
      }
      if (!finalReply) {
        return res.status(502).json({ error: 'AI_EMPTY_RESPONSE', message: 'لم يكتمل رد المساعد. حاول مرة أخرى.' });
      }

      const reviewedResponse = await reviewElaWamyAiOutput({
        apiKey,
        model,
        originalPrompt: lastText,
        draft: finalReply,
        purpose: 'customer'
      });
      finalReply = reviewedResponse.text || finalReply;

      return res.json({
        ok: true,
        reply: finalReply,
        steps: finalSteps,
        savedDraft,
        reviewedBy: reviewedResponse.reviewer
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        return res.status(504).json({ error: 'AI_TIMEOUT', message: 'استغرق الرد وقتًا أطول من المعتاد. حاول مرة أخرى.' });
      }
      console.error('ELAWAMY AI CHAT ERROR:', error?.message || error);
      return res.status(500).json({ error: 'AI_CHAT_FAILED', message: 'حدث خطأ أثناء تشغيل مساعد العوامي.' });
    }
  }
);

app.get(
  '/api/ai/drafts',
  requireFirebaseUser,
  rateLimit({ name: 'ai-drafts-list', maxRequests: 30, windowMs: 60_000 }),
  async (req, res) => {
    try {
      const snapshot = await admin.firestore()
        .collection('aiServiceDrafts')
        .where('ownerId', '==', req.user.uid)
        .limit(20)
        .get();

      const drafts = snapshot.docs.map(doc => {
        const data = doc.data() || {};
        return {
          id: doc.id,
          title: String(data.title || ''),
          category: String(data.category || ''),
          description: String(data.description || ''),
          price: data.price ?? null,
          deliveryDays: Number(data.deliveryDays || 3),
          status: String(data.status || 'draft'),
          createdAt: data.createdAt?.toMillis?.() || 0
        };
      }).sort((a, b) => b.createdAt - a.createdAt);

      return res.json({ ok: true, drafts });
    } catch (error) {
      console.error('ELAWAMY AI DRAFTS ERROR:', error?.message || error);
      return res.status(500).json({ error: 'AI_DRAFTS_UNAVAILABLE' });
    }
  }
);


// Admin-only development team queue. AI output is a proposal; approval never executes code.
app.post(
  '/api/ai/team/tasks',
  requireFirebaseUser,
  rateLimit({ name: 'ai-team-task-create', maxRequests: 3, windowMs: 60_000 }),
  async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin access required' });
    try {
      const task = typeof req.body?.task === 'string' ? req.body.task.trim() : '';
      if (!task || task.length > 5000) {
        return res.status(400).json({ error: 'TASK_REQUIRED', message: 'اكتب مهمة من 1 إلى 5000 حرف.' });
      }
      const containsSecret = /AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(task);
      if (containsSecret) {
        return res.status(400).json({ error: 'POSSIBLE_SECRET_IN_TASK', message: 'احذف مفاتيح API أو المفاتيح الخاصة من المهمة قبل إرسالها.' });
      }

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return res.status(503).json({ error: 'AI_NOT_CONFIGURED', message: 'مفتاح Gemini غير مضبوط على الخادم.' });
      const model = String(process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
      if (!/^[a-zA-Z0-9._-]{3,100}$/.test(model)) {
        return res.status(500).json({ error: 'INVALID_AI_MODEL_CONFIGURATION' });
      }

      const roleBriefs = ELAWAMY_AI_TEAM_ROLES
        .filter(role => role.group === 'development')
        .map(role => `- ${role.name}: ${role.focus}`)
        .join('\n');
      const prompt = [
        'مهمة التطوير المطلوب دراستها:',
        task,
        '',
        'التزم بالأدوار الثمانية التالية، واجعل كل دور يقدم ملاحظاته المستقلة ثم يراجع نقاط التعارض مع بقية الأدوار:',
        roleBriefs,
        '',
        'اكتب تقريرًا تنفيذيًا منظمًا. افصل بين الحقائق المتاحة والافتراضات. إذا كانت الملفات أو الاختبارات غير متاحة، اذكر ذلك صراحةً. لا تكتب أن تغييرًا نُفذ أو نُشر.'
      ].join('\n');

      const initialReport = await requestElaWamyGeminiText({
        apiKey,
        model,
        systemInstruction: ELAWAMY_AI_DEVELOPMENT_SYSTEM,
        prompt,
        maxOutputTokens: 2200
      });
      const reviewed = await reviewElaWamyAiOutput({
        apiKey,
        model,
        originalPrompt: task,
        draft: initialReport,
        purpose: 'development'
      });
      const report = reviewed.text || initialReport;
      const db = admin.firestore();
      const taskRef = db.collection('aiTeamTasks').doc();
      await taskRef.create({
        task,
        report: report.slice(0, 18_000),
        initialReport: initialReport.slice(0, 18_000),
        reviewer: reviewed.reviewer,
        roles: ELAWAMY_AI_TEAM_ROLES.filter(role => role.group === 'development').map(role => ({ id: role.id, name: role.name })),
        status: 'pending_review',
        createdBy: req.user.uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        decision: null,
        decisionBy: null,
        decisionNote: ''
      });

      return res.status(201).json({
        ok: true,
        taskId: taskRef.id,
        task,
        report,
        reviewer: reviewed.reviewer,
        status: 'pending_review',
        roles: ELAWAMY_AI_TEAM_ROLES.filter(role => role.group === 'development').map(role => role.name)
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        return res.status(504).json({ error: 'AI_TIMEOUT', message: 'استغرق إعداد تقرير الفريق وقتًا أطول من المعتاد.' });
      }
      console.error('ELAWAMY AI TEAM TASK ERROR:', error?.message || error);
      return res.status(502).json({ error: 'AI_TEAM_UNAVAILABLE', message: 'تعذر على فريق التطوير إعداد التقرير الآن.' });
    }
  }
);

app.get(
  '/api/ai/team/tasks',
  requireFirebaseUser,
  rateLimit({ name: 'ai-team-task-list', maxRequests: 30, windowMs: 60_000 }),
  async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin access required' });
    try {
      const snapshot = await admin.firestore().collection('aiTeamTasks').orderBy('createdAt', 'desc').limit(50).get();
      const tasks = snapshot.docs.map(doc => {
        const data = doc.data() || {};
        return {
          id: doc.id,
          task: String(data.task || ''),
          report: String(data.report || ''),
          reviewer: String(data.reviewer || ''),
          status: String(data.status || 'pending_review'),
          createdAt: data.createdAt?.toMillis?.() || 0,
          decision: data.decision || null,
          decisionNote: String(data.decisionNote || '')
        };
      }).sort((a, b) => b.createdAt - a.createdAt);
      return res.json({ ok: true, tasks });
    } catch (error) {
      console.error('ELAWAMY AI TEAM LIST ERROR:', error?.message || error);
      return res.status(500).json({ error: 'AI_TEAM_LIST_UNAVAILABLE' });
    }
  }
);

app.post(
  '/api/ai/team/tasks/:taskId/decision',
  requireFirebaseUser,
  rateLimit({ name: 'ai-team-task-decision', maxRequests: 30, windowMs: 60_000 }),
  async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin access required' });
    const taskId = String(req.params?.taskId || '').trim();
    const action = String(req.body?.action || '').trim();
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
    if (!/^[A-Za-z0-9_-]{10,150}$/.test(taskId) || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'INVALID_TASK_DECISION' });
    }
    if (action === 'reject' && note.length < 4) {
      return res.status(400).json({ error: 'REJECTION_NOTE_REQUIRED', message: 'اكتب سبب الرفض في 4 أحرف على الأقل.' });
    }

    try {
      const db = admin.firestore();
      const taskRef = db.collection('aiTeamTasks').doc(taskId);
      const nextStatus = action === 'approve' ? 'approved_for_manual_implementation' : 'rejected';
      await db.runTransaction(async transaction => {
        const taskSnap = await transaction.get(taskRef);
        if (!taskSnap.exists) throw new Error('AI_TEAM_TASK_NOT_FOUND');
        if (taskSnap.data()?.status !== 'pending_review') throw new Error('AI_TEAM_TASK_ALREADY_REVIEWED');
        transaction.update(taskRef, {
          status: nextStatus,
          decision: action,
          decisionBy: req.user.uid,
          decisionNote: note,
          decisionAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });
      return res.json({ ok: true, taskId, status: nextStatus, decision: action });
    } catch (error) {
      if (error?.message === 'AI_TEAM_TASK_NOT_FOUND') return res.status(404).json({ error: 'AI_TEAM_TASK_NOT_FOUND' });
      if (error?.message === 'AI_TEAM_TASK_ALREADY_REVIEWED') return res.status(409).json({ error: 'AI_TEAM_TASK_ALREADY_REVIEWED' });
      console.error('ELAWAMY AI TEAM DECISION ERROR:', error?.message || error);
      return res.status(500).json({ error: 'AI_TEAM_DECISION_FAILED' });
    }
  }
);

app.get('/health', (req, res) => {
  const localEmulators =
    !process.env.VERCEL &&
    process.env.NODE_ENV !== 'production' &&
    process.env.FIREBASE_AUTH_EMULATOR_HOST === '127.0.0.1:9099' &&
    process.env.FIRESTORE_EMULATOR_HOST === '127.0.0.1:8080';
  res.json({
    ok: true,
    service: 'elawamy-file-server',
    ...(!process.env.VERCEL && process.env.NODE_ENV !== 'production' ? { localEmulators } : {})
  });
});

app.get(
  '/api/files/test',
  requireFirebaseUser,
  async (req, res) => {
    res.json({
      ok: true,
      uid: req.user.uid,
      email: req.user.email || null
    });
  }
);

app.post(
  '/api/files/upload-url',
  requireFirebaseUser,
  requireUserPermission('files'),
  rateLimit({ name: 'files-upload-url', maxRequests: 10 }),
  async (req, res) => {
    try {
      const {
        orderId,
        role,
        name,
        contentType,
        size
      } = req.body || {};

      if (
        !orderId ||
        !['buyer', 'seller'].includes(role)
      ) {
        return res.status(400).json({
          error: 'Invalid orderId or role'
        });
      }

      if (
        !name ||
        typeof name !== 'string' ||
        name.length > 200
      ) {
        return res.status(400).json({
          error: 'Invalid file name'
        });
      }

      if (
        !contentType ||
        typeof contentType !== 'string' ||
        contentType.length > 120
      ) {
        return res.status(400).json({
          error: 'Invalid content type'
        });
      }

      if (
        !Number.isFinite(size) ||
        size < 1 ||
        size > 50 * 1024 * 1024
      ) {
        return res.status(400).json({
          error: 'File size must be between 1 byte and 50 MB'
        });
      }

      const orderRef = admin
        .firestore()
        .collection('orders')
        .doc(orderId);

      const orderSnap = await orderRef.get();

      if (!orderSnap.exists) {
        return res.status(404).json({
          error: 'Order not found'
        });
      }

      const order = orderSnap.data();

      const allowed =
        (role === 'buyer' &&
          order.userId === req.user.uid) ||
        (role === 'seller' &&
          order.sellerId === req.user.uid);

      if (!allowed) {
        return res.status(403).json({
          error: 'Not allowed for this order'
        });
      }

      if (!canUploadForOrder(order, role)) {
        return res.status(403).json({
          error: 'File upload is not allowed in the current order status'
        });
      }

      const safeName = name
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 150);

      const fileId = crypto.randomUUID();

      const path =
        `orders/${orderId}/${role}/${fileId}-${safeName}`;

      const {
        data,
        error
      } = await supabase.storage
        .from(BUCKET)
        .createSignedUploadUrl(path);

      if (error) {
        console.error(
          'SIGNED UPLOAD ERROR:',
          error
        );

        return res.status(500).json({
          error: 'Could not create upload URL'
        });
      }

      res.json({
        ok: true,
        path,
        token: data.token,
        signedUrl: data.signedUrl
      });

    } catch (error) {
      console.error(
        'UPLOAD URL ERROR:',
        error
      );

      res.status(500).json({
        error: 'Internal server error'
      });
    }
  }
);

app.post(
  '/api/files/complete',
  requireFirebaseUser,
  requireUserPermission('files'),
  rateLimit({ name: 'files-complete', maxRequests: 10 }),
  async (req, res) => {
    try {
      const {
        orderId,
        role,
        path,
        name,
        contentType,
        size
      } = req.body || {};

      if (
        !orderId ||
        !['buyer', 'seller'].includes(role)
      ) {
        return res.status(400).json({
          error: 'Invalid orderId or role'
        });
      }

      if (
        !path ||
        !path.startsWith(
          `orders/${orderId}/${role}/`
        )
      ) {
        return res.status(400).json({
          error: 'Invalid file path'
        });
      }

      if (
        !name ||
        typeof name !== 'string' ||
        name.length > 200
      ) {
        return res.status(400).json({
          error: 'Invalid file name'
        });
      }

      if (
        !contentType ||
        typeof contentType !== 'string' ||
        contentType.length > 120
      ) {
        return res.status(400).json({
          error: 'Invalid content type'
        });
      }

      if (
        !Number.isFinite(size) ||
        size < 1 ||
        size > 50 * 1024 * 1024
      ) {
        return res.status(400).json({
          error: 'Invalid file size'
        });
      }

      const orderRef = admin
        .firestore()
        .collection('orders')
        .doc(orderId);

      const orderSnap = await orderRef.get();

      if (!orderSnap.exists) {
        return res.status(404).json({
          error: 'Order not found'
        });
      }

      const order = orderSnap.data();

      const allowed =
        (role === 'buyer' &&
          order.userId === req.user.uid) ||
        (role === 'seller' &&
          order.sellerId === req.user.uid);

      if (!allowed) {
        return res.status(403).json({
          error: 'Not allowed for this order'
        });
      }

      if (!canUploadForOrder(order, role)) {
        return res.status(403).json({
          error: 'File upload is not allowed in the current order status'
        });
      }

      const prefix = `orders/${orderId}/${role}/`;

      if (!path.startsWith(prefix)) {
        return res.status(400).json({ error: 'Invalid file path' });
      }

      const fileName = path.slice(prefix.length);
      const fileId = fileName.slice(0, 36);

      const uuidPattern =
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

      if (!uuidPattern.test(fileId)) {
        return res.status(400).json({ error: 'Invalid file id' });
      }

      if (!fileName.startsWith(`${fileId}-`) || fileName.length <= 37) {
        return res.status(400).json({ error: 'Invalid file path' });
      }

      const storageInfo = await storageObjectInfo(path);

        if (!storageInfo) {
          return res.status(409).json({
            error: 'Uploaded file was not found in storage'
          });
        }

        const actualSize = Number(storageInfo.size);
        const actualContentType =
          typeof storageInfo.contentType === 'string'
            ? storageInfo.contentType.trim()
            : '';

        if (
          !Number.isSafeInteger(actualSize) ||
          actualSize < 1 ||
          actualSize > 50 * 1024 * 1024
        ) {
          return res.status(413).json({
            error: 'Uploaded file size is invalid or exceeds 50 MB'
          });
        }

        if (!actualContentType || actualContentType.length > 120) {
          return res.status(415).json({
            error: 'Uploaded file content type is invalid'
          });
        }

        await orderRef
          .collection('files')
          .doc(fileId)
          .set({
            fileId,
            orderId,
            uploaderId: req.user.uid,
            role,
            path,
            name,
            contentType: actualContentType,
            size: actualSize,
            createdAt:
              admin.firestore.FieldValue.serverTimestamp()
          });

      res.json({
        ok: true,
        fileId
      });

    } catch (error) {
      console.error(
        'COMPLETE FILE ERROR:',
        error
      );

      res.status(500).json({
        error: 'Internal server error'
      });
    }
  }
);


app.get(
  '/api/files/download-url',
  requireFirebaseUser,
  requireUserPermission('files'),
  rateLimit({ name: 'files-download-url', maxRequests: 30 }),
  async (req, res) => {
    try {
      const { orderId, fileId } = req.query || {};

      if (!orderId || !fileId) {
        return res.status(400).json({
          error: 'Invalid orderId or fileId'
        });
      }

      const orderRef = admin
        .firestore()
        .collection('orders')
        .doc(orderId);

      const orderSnap = await orderRef.get();

      if (!orderSnap.exists) {
        return res.status(404).json({
          error: 'Order not found'
        });
      }

      const order = orderSnap.data();

      const allowed =
        order.userId === req.user.uid ||
        order.sellerId === req.user.uid;

      if (!allowed) {
        return res.status(403).json({
          error: 'Not allowed for this order'
        });
      }

      const fileRef = orderRef
        .collection('files')
        .doc(fileId);

      const fileSnap = await fileRef.get();

      if (!fileSnap.exists) {
        return res.status(404).json({
          error: 'File not found'
        });
      }

      const file = fileSnap.data();

      const prefix = `orders/${orderId}/`;

      if (
        !file.path ||
        !file.path.startsWith(prefix) ||
        !(
          file.path.startsWith(`${prefix}buyer/`) ||
          file.path.startsWith(`${prefix}seller/`)
        )
      ) {
        return res.status(400).json({
          error: 'Invalid file path'
        });
      }

      const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(file.path, 3600);

      if (error) {
        console.error('SIGNED DOWNLOAD ERROR:', error);

        return res.status(500).json({
          error: 'Could not create download URL'
        });
      }

      res.json({
        ok: true,
        url: data.signedUrl,
        name: file.name,
        contentType: file.contentType,
        size: file.size
      });
    } catch (error) {
      console.error('DOWNLOAD URL ERROR:', error);

      res.status(500).json({
        error: 'Internal server error'
      });
    }
  }
);

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(
      `ElaWamy file server running on port ${PORT}`
    );
  });
}

export default app;
