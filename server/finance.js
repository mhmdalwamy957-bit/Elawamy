import crypto from 'crypto';
import admin from 'firebase-admin';

const CURRENCY = 'EGP';
const FEE_PERCENT = clampPercent(process.env.PLATFORM_FEE_PERCENT, 7);
const MIN_WITHDRAWAL_RAW = Number(process.env.MIN_WITHDRAWAL ?? 100);
const MIN_WITHDRAWAL = Number.isFinite(MIN_WITHDRAWAL_RAW) && MIN_WITHDRAWAL_RAW > 0
  ? Math.max(1, Math.round(MIN_WITHDRAWAL_RAW * 100) / 100)
  : 100;

function clampPercent(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(50, Math.max(0, n));
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('INVALID_MONEY');
  return Math.round(n * 100) / 100;
}

function positiveMoney(value) {
  const n = money(value);
  return n > 0 ? n : null;
}

function walletDefaults() {
  return {
    availableBalance: 0,
    pendingBalance: 0,
    lockedBalance: 0,
    lifetimeGross: 0,
    lifetimeFees: 0,
    lifetimeNet: 0,
    platformFeeDue: 0,
    currency: CURRENCY
  };
}

function normalizeWallet(data = {}) {
  const base = walletDefaults();
  return {
    ...base,
    ...data,
    availableBalance: money(data.availableBalance ?? 0),
    pendingBalance: money(data.pendingBalance ?? 0),
    lockedBalance: money(data.lockedBalance ?? 0),
    lifetimeGross: money(data.lifetimeGross ?? 0),
    lifetimeFees: money(data.lifetimeFees ?? 0),
    lifetimeNet: money(data.lifetimeNet ?? 0),
    platformFeeDue: money(data.platformFeeDue ?? 0)
  };
}

// Public seller reputation must not reveal private lifetime earnings.
export function getSellerLevel(completedOrders) {
  const raw = Number(completedOrders ?? 0);
  const count = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  if (count >= 100) return 'platinum';
  if (count >= 40) return 'gold';
  if (count >= 15) return 'silver';
  if (count >= 5) return 'bronze';
  return 'new';
}

function feeFor(total) {
  return money((total * FEE_PERCENT) / 100);
}

export function getFinanceConfig() {
  const requested = String(process.env.PAYMENTS_PROVIDER || '').trim().toLowerCase();
  const xpaySecret = String(process.env.XPAY_SECRET_KEY || '').trim();
  const xpayWebhookSecret = String(process.env.XPAY_WEBHOOK_SECRET || '').trim();
  const xpayConfigured = Boolean(
    /^sk_(test|live)_/.test(xpaySecret) && xpayWebhookSecret
  );

  let provider;
  if (requested === 'xpay') provider = 'xpay';
  else if (requested === 'demo' && process.env.NODE_ENV !== 'production') provider = 'demo';
  else if (requested === 'direct_transfer') provider = 'direct_transfer';
  else provider = 'unconfigured';

  const modeValue = String(process.env.PAYMENTS_MODE || '').trim().toLowerCase();
  const mode = provider === 'xpay'
    ? (modeValue === 'live' ? 'live' : 'test')
    : provider === 'demo'
      ? 'demo'
      : provider === 'direct_transfer'
        ? 'manual'
        : 'unavailable';
  const configured = provider === 'xpay'
    ? xpayConfigured
    : provider !== 'unconfigured';

  return {
    currency: CURRENCY,
    feePercent: FEE_PERCENT,
    minWithdrawal: MIN_WITHDRAWAL,
    provider,
    mode,
    directPaymentMethod: provider === 'direct_transfer' ? 'vodafone_cash' : null,
    configured
  };
}

function assertOrderBuyer(order, uid) {
  if (order.userId !== uid) throw new Error('NOT_ORDER_BUYER');
}


function cleanReference(value, max = 120) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function cleanPaymentAccount(value) {
  return String(value ?? '').replace(/\s+/g, '').trim();
}

function assertVodafoneCashNumber(value) {
  const account = cleanPaymentAccount(value);
  if (!/^01\d{9}$/.test(account)) throw new Error('INVALID_PAYMENT_ACCOUNT');
  return account;
}

export async function getSellerDirectPaymentProfile({ db, uid }) {
  const ref = db.collection('sellerPaymentProfiles').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return { configured: false, method: 'vodafone_cash', account: '', accountName: '' };
  const data = snap.data() || {};
  return {
    configured: Boolean(data.account),
    method: data.method || 'vodafone_cash',
    account: data.account || '',
    accountName: data.accountName || ''
  };
}

export async function saveSellerDirectPaymentProfile({ db, uid, method, account, accountName }) {
  const cleanMethod = String(method || '').trim();
  if (cleanMethod !== 'vodafone_cash') throw new Error('INVALID_PAYMENT_METHOD');
  const cleanAccount = assertVodafoneCashNumber(account);
  const cleanName = String(accountName || '').trim().slice(0, 100);
  if (!cleanName) throw new Error('INVALID_PAYMENT_ACCOUNT_NAME');

  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.collection('sellerPaymentProfiles').doc(uid).set({
    method: cleanMethod,
    account: cleanAccount,
    accountName: cleanName,
    updatedAt: now
  });

  return { ok: true, method: cleanMethod, account: cleanAccount, accountName: cleanName };
}

export async function startDirectPayment({ db, uid, orderId }) {
  const orderRef = db.collection('orders').doc(orderId);

  return db.runTransaction(async tx => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new Error('ORDER_NOT_FOUND');
    const order = orderSnap.data() || {};

    assertOrderBuyer(order, uid);
    if (order.status !== 'pending') throw new Error('ORDER_NOT_PAYABLE');
    if (!['pending', 'awaiting_transfer', 'rejected'].includes(order.directPaymentStatus || 'pending')) {
      throw new Error('DIRECT_PAYMENT_STATE_INVALID');
    }
    if (order.paymentStatus === 'paid') throw new Error('ORDER_ALREADY_PAID');
    if (order.financeStatus !== 'unfunded') throw new Error('ORDER_PAYMENT_STATE_INVALID');

    const profileRef = db.collection('sellerPaymentProfiles').doc(order.sellerId);
    const profileSnap = await tx.get(profileRef);
    if (!profileSnap.exists) throw new Error('SELLER_PAYMENT_PROFILE_MISSING');
    const profile = profileSnap.data() || {};
    const account = assertVodafoneCashNumber(profile.account);
    const accountName = String(profile.accountName || '').trim();
    if (!accountName) throw new Error('SELLER_PAYMENT_PROFILE_MISSING');

    const totalPrice = positiveMoney(order.totalPrice ?? order.price);
    if (totalPrice === null) throw new Error('INVALID_ORDER_TOTAL');

    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.update(orderRef, {
      paymentProvider: 'direct_transfer',
      paymentMethod: 'vodafone_cash',
      directPaymentStatus: 'awaiting_transfer',
      directPaymentAccount: account,
      directPaymentAccountName: accountName,
      directPaymentStartedAt: now,
      directPaymentRejectedReason: null,
      updatedAt: now
    });

    return {
      ok: true,
      orderId,
      provider: 'direct_transfer',
      method: 'vodafone_cash',
      account,
      accountName,
      totalPrice,
      feePercent: FEE_PERCENT,
      instructions: 'حوّل المبلغ كاملًا إلى رقم Vodafone Cash الموضح، ثم أرسل رقم/مرجع التحويل لإتمام الطلب.'
    };
  });
}

export async function submitDirectPayment({ db, uid, orderId, reference, note }) {
  const cleanRef = cleanReference(reference);
  const cleanNote = cleanReference(note, 300);
  if (cleanRef.length < 4) throw new Error('INVALID_PAYMENT_REFERENCE');

  const orderRef = db.collection('orders').doc(orderId);
  return db.runTransaction(async tx => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) throw new Error('ORDER_NOT_FOUND');
    const order = snap.data() || {};
    assertOrderBuyer(order, uid);
    if (order.status !== 'pending' || order.paymentProvider !== 'direct_transfer') {
      throw new Error('ORDER_PAYMENT_STATE_INVALID');
    }
    if (!['awaiting_transfer', 'rejected'].includes(order.directPaymentStatus || '')) {
      throw new Error('DIRECT_PAYMENT_STATE_INVALID');
    }
    if (order.paymentStatus === 'paid') throw new Error('ORDER_ALREADY_PAID');

    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.update(orderRef, {
      directPaymentStatus: 'buyer_submitted',
      directPaymentReference: cleanRef,
      directPaymentNote: cleanNote,
      directPaymentSubmittedAt: now,
      directPaymentRejectedReason: null,
      updatedAt: now
    });

    return { ok: true, orderId, directPaymentStatus: 'buyer_submitted' };
  });
}

export async function confirmDirectPayment({ db, uid, orderId }) {
  const orderRef = db.collection('orders').doc(orderId);
  return db.runTransaction(async tx => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new Error('ORDER_NOT_FOUND');
    const order = orderSnap.data() || {};
    if (order.sellerId !== uid) throw new Error('NOT_ORDER_SELLER');
    if (order.status !== 'pending' || order.paymentProvider !== 'direct_transfer') {
      throw new Error('ORDER_PAYMENT_STATE_INVALID');
    }
    if (order.paymentStatus !== 'pending' || order.financeStatus !== 'unfunded') {
      throw new Error('ORDER_PAYMENT_STATE_INVALID');
    }
    if (order.directPaymentStatus !== 'buyer_submitted') throw new Error('DIRECT_PAYMENT_STATE_INVALID');
    if (!cleanReference(order.directPaymentReference)) throw new Error('PAYMENT_REFERENCE_MISSING');

    const totalPrice = positiveMoney(order.totalPrice ?? order.price);
    if (totalPrice === null) throw new Error('INVALID_ORDER_TOTAL');
    const platformFee = feeFor(totalPrice);
    const sellerNetAmount = money(totalPrice - platformFee);

    const walletRef = db.collection('wallets').doc(order.sellerId);
    const walletSnap = await tx.get(walletRef);
    const wallet = normalizeWallet(walletSnap.exists ? walletSnap.data() : {});
    const now = admin.firestore.FieldValue.serverTimestamp();
    const paymentId = `DIRECT-${crypto.randomUUID()}`;

    tx.set(walletRef, {
      ...wallet,
      platformFeeDue: money(wallet.platformFeeDue + platformFee),
      currency: CURRENCY,
      updatedAt: now
    }, { merge: true });

    const buyerTxnRef = db.collection('transactions').doc();
    const sellerTxnRef = db.collection('transactions').doc();
    const feeDueTxnRef = db.collection('transactions').doc();
    const platformTxnRef = db.collection('transactions').doc();

    tx.set(buyerTxnRef, {
      userId: order.userId,
      role: 'buyer',
      orderId,
      type: 'order_payment',
      direction: 'debit',
      amount: totalPrice,
      fee: 0,
      netAmount: totalPrice,
      currency: CURRENCY,
      status: 'completed',
      provider: 'direct_transfer',
      paymentId,
      paymentMethod: 'vodafone_cash',
      paymentReference: order.directPaymentReference,
      createdAt: now
    });

    tx.set(sellerTxnRef, {
      userId: order.sellerId,
      role: 'seller',
      orderId,
      type: 'direct_sale',
      direction: 'credit',
      amount: totalPrice,
      fee: platformFee,
      netAmount: sellerNetAmount,
      currency: CURRENCY,
      status: 'completed',
      provider: 'direct_transfer',
      paymentId,
      paymentMethod: 'vodafone_cash',
      paymentReference: order.directPaymentReference,
      note: 'تم الدفع مباشرةً إلى وسيلة الدفع الخاصة بالبائع؛ العمولة مستحقة للمنصة بشكل منفصل.',
      createdAt: now
    });

    tx.set(feeDueTxnRef, {
      userId: order.sellerId,
      role: 'seller',
      orderId,
      type: 'platform_fee_due',
      direction: 'debit',
      amount: platformFee,
      fee: 0,
      netAmount: platformFee,
      currency: CURRENCY,
      status: 'pending',
      provider: 'direct_transfer',
      paymentId,
      createdAt: now
    });

    tx.set(platformTxnRef, {
      userId: '__platform__',
      role: 'platform',
      orderId,
      type: 'platform_fee_due',
      direction: 'credit',
      amount: platformFee,
      fee: 0,
      netAmount: platformFee,
      currency: CURRENCY,
      status: 'pending',
      provider: 'direct_transfer',
      paymentId,
      createdAt: now
    });

    tx.update(orderRef, {
      paymentStatus: 'paid',
      paymentProvider: 'direct_transfer',
      paymentId,
      paidAt: now,
      platformFee,
      sellerNetAmount,
      financeStatus: 'direct_paid',
      directPaymentStatus: 'confirmed',
      platformFeeStatus: 'due',
      updatedAt: now
    });

    return { ok: true, orderId, totalPrice, platformFee, sellerNetAmount, paymentId };
  });
}

export async function rejectDirectPayment({ db, uid, orderId, reason }) {
  const cleanReason = cleanReference(reason || 'لم يتم العثور على تحويل مؤكد.', 300);
  const orderRef = db.collection('orders').doc(orderId);
  return db.runTransaction(async tx => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) throw new Error('ORDER_NOT_FOUND');
    const order = snap.data() || {};
    if (order.sellerId !== uid) throw new Error('NOT_ORDER_SELLER');
    if (order.status !== 'pending' || order.paymentProvider !== 'direct_transfer') {
      throw new Error('ORDER_PAYMENT_STATE_INVALID');
    }
    if (order.directPaymentStatus !== 'buyer_submitted') throw new Error('DIRECT_PAYMENT_STATE_INVALID');
    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.update(orderRef, {
      directPaymentStatus: 'rejected',
      directPaymentRejectedReason: cleanReason,
      directPaymentRejectedAt: now,
      updatedAt: now
    });
    return { ok: true, orderId, directPaymentStatus: 'rejected' };
  });
}

export async function listPlatformFeeDue({ db }) {
  const snap = await db.collection('wallets').where('platformFeeDue', '>', 0).limit(100).get();
  const items = [];
  for (const docSnap of snap.docs) {
    const wallet = normalizeWallet(docSnap.data() || {});
    const userSnap = await db.collection('users').doc(docSnap.id).get();
    const user = userSnap.exists ? (userSnap.data() || {}) : {};
    items.push({
      sellerId: docSnap.id,
      email: user.email || '',
      name: user.name || '',
      platformFeeDue: wallet.platformFeeDue,
      updatedAt: wallet.updatedAt || null
    });
  }
  items.sort((a, b) => b.platformFeeDue - a.platformFeeDue);
  return items;
}

export async function markPlatformFeePaid({ db, adminUid, sellerId, amount, reference }) {
  const requested = positiveMoney(amount);
  if (!sellerId || requested === null) throw new Error('INVALID_PLATFORM_FEE_PAYMENT');
  const cleanRef = cleanReference(reference, 160);
  if (cleanRef.length < 4) throw new Error('INVALID_PLATFORM_FEE_REFERENCE');

  const walletRef = db.collection('wallets').doc(sellerId);
  const txnRef = db.collection('transactions').doc();
  return db.runTransaction(async tx => {
    const snap = await tx.get(walletRef);
    const wallet = normalizeWallet(snap.exists ? snap.data() : {});
    if (wallet.platformFeeDue < requested) throw new Error('PLATFORM_FEE_PAYMENT_EXCEEDS_DUE');
    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.set(walletRef, {
      ...wallet,
      platformFeeDue: money(wallet.platformFeeDue - requested),
      updatedAt: now
    }, { merge: true });
    tx.set(txnRef, {
      userId: sellerId,
      role: 'seller',
      type: 'platform_fee_payment',
      direction: 'debit',
      amount: requested,
      fee: 0,
      netAmount: requested,
      currency: CURRENCY,
      status: 'completed',
      provider: 'manual_direct_transfer',
      adminUid,
      reference: cleanRef,
      createdAt: now
    });
    return { ok: true, sellerId, amount: requested, remainingDue: money(wallet.platformFeeDue - requested) };
  });
}

export async function confirmDemoPayment({ db, uid, orderId }) {
  const orderRef = db.collection('orders').doc(orderId);

  return db.runTransaction(async tx => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new Error('ORDER_NOT_FOUND');

    const order = orderSnap.data() || {};
    assertOrderBuyer(order, uid);

    if (!['pending'].includes(order.status)) {
      throw new Error('ORDER_NOT_PAYABLE');
    }

    if (order.paymentStatus === 'paid' && order.financeStatus === 'escrowed') {
      return {
        ok: true,
        alreadyPaid: true,
        orderId,
        totalPrice: money(order.totalPrice ?? order.price),
        sellerNetAmount: money(order.sellerNetAmount ?? 0),
        platformFee: money(order.platformFee ?? 0)
      };
    }

    if (order.paymentStatus !== 'pending' || order.financeStatus === 'refunded') {
      throw new Error('ORDER_PAYMENT_STATE_INVALID');
    }

    const totalPrice = positiveMoney(order.totalPrice ?? order.price);
    if (totalPrice === null) throw new Error('INVALID_ORDER_TOTAL');

    const platformFee = feeFor(totalPrice);
    const sellerNetAmount = money(totalPrice - platformFee);

    const walletRef = db.collection('wallets').doc(order.sellerId);
    const walletSnap = await tx.get(walletRef);
    const wallet = normalizeWallet(walletSnap.exists ? walletSnap.data() : {});

    const paymentId = `DEMO-${crypto.randomUUID()}`;
    const now = admin.firestore.FieldValue.serverTimestamp();

    tx.set(walletRef, {
      ...wallet,
      pendingBalance: money(wallet.pendingBalance + sellerNetAmount),
      currency: CURRENCY,
      updatedAt: now
    }, { merge: true });

    const buyerTxnRef = db.collection('transactions').doc();
    const sellerTxnRef = db.collection('transactions').doc();

    tx.set(buyerTxnRef, {
      userId: order.userId,
      role: 'buyer',
      orderId,
      type: 'order_payment',
      direction: 'debit',
      amount: totalPrice,
      fee: 0,
      netAmount: totalPrice,
      currency: CURRENCY,
      status: 'completed',
      provider: 'demo',
      paymentId,
      createdAt: now
    });

    tx.set(sellerTxnRef, {
      userId: order.sellerId,
      role: 'seller',
      orderId,
      type: 'sale_hold',
      direction: 'credit',
      amount: sellerNetAmount,
      fee: platformFee,
      netAmount: sellerNetAmount,
      currency: CURRENCY,
      status: 'pending',
      provider: 'demo',
      paymentId,
      createdAt: now
    });

    tx.update(orderRef, {
      paymentStatus: 'paid',
      paymentProvider: 'demo',
      paymentId,
      paidAt: now,
      platformFee,
      sellerNetAmount,
      financeStatus: 'escrowed',
      updatedAt: now
    });

    return {
      ok: true,
      alreadyPaid: false,
      orderId,
      totalPrice,
      sellerNetAmount,
      platformFee,
      paymentId
    };
  });
}


export async function confirmXPayPayment({ db, session }) {
  const sessionId = String(session?.id || '').trim();
  const metadataOrderId = String(session?.metadata?.orderId || '').trim();
  if (!sessionId || !metadataOrderId) throw new Error('XPAY_SESSION_METADATA_MISSING');
  if (session?.currency && String(session.currency).toUpperCase() !== CURRENCY) {
    throw new Error('XPAY_CURRENCY_MISMATCH');
  }
  if (session?.paymentStatus !== 'paid') {
    throw new Error('XPAY_PAYMENT_NOT_PAID');
  }

  const totalPrice = positiveMoney(session.amountTotal == null ? 0 : Number(session.amountTotal) / 100);
  if (totalPrice === null) throw new Error('INVALID_ORDER_TOTAL');

  const orderRef = db.collection('orders').doc(metadataOrderId);

  return db.runTransaction(async tx => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new Error('ORDER_NOT_FOUND');
    const order = orderSnap.data() || {};

    if (order.paymentStatus === 'paid' && order.financeStatus === 'escrowed') {
      if (String(order.xpayCheckoutSessionId || '') === sessionId) {
        return {
          ok: true,
          alreadyPaid: true,
          orderId: metadataOrderId,
          totalPrice: money(order.totalPrice ?? order.price),
          sellerNetAmount: money(order.sellerNetAmount ?? 0),
          platformFee: money(order.platformFee ?? 0),
          paymentIntentId: order.xpayPaymentIntentId || null
        };
      }
      throw new Error('ORDER_ALREADY_PAID');
    }

    if (order.status !== 'pending' || order.paymentStatus !== 'pending' || order.financeStatus !== 'unfunded') {
      throw new Error('ORDER_PAYMENT_STATE_INVALID');
    }

    const expectedTotal = positiveMoney(order.totalPrice ?? order.price);
    if (expectedTotal === null || expectedTotal !== totalPrice) {
      throw new Error('XPAY_AMOUNT_MISMATCH');
    }

    const platformFee = feeFor(totalPrice);
    const sellerNetAmount = money(totalPrice - platformFee);
    const walletRef = db.collection('wallets').doc(order.sellerId);
    const walletSnap = await tx.get(walletRef);
    const wallet = normalizeWallet(walletSnap.exists ? walletSnap.data() : {});
    const now = admin.firestore.FieldValue.serverTimestamp();

    const paymentIntentId = String(session?.paymentIntent?.id || '').trim() || null;
    const customerId = String(session?.customerId || session?.customer?.id || '').trim() || null;
    const chargeId = String(session?.paymentIntent?.charges?.[0]?.id || '').trim() || null;
    const paymentId = paymentIntentId || sessionId;

    tx.set(walletRef, {
      ...wallet,
      pendingBalance: money(wallet.pendingBalance + sellerNetAmount),
      currency: CURRENCY,
      updatedAt: now
    }, { merge: true });

    const buyerTxnRef = db.collection('transactions').doc();
    const sellerTxnRef = db.collection('transactions').doc();
    const platformTxnRef = db.collection('transactions').doc();

    tx.set(buyerTxnRef, {
      userId: order.userId,
      role: 'buyer',
      orderId: metadataOrderId,
      type: 'order_payment',
      direction: 'debit',
      amount: totalPrice,
      fee: 0,
      netAmount: totalPrice,
      currency: CURRENCY,
      status: 'completed',
      provider: 'xpay',
      paymentId,
      xpayCheckoutSessionId: sessionId,
      xpayPaymentIntentId: paymentIntentId,
      xpayChargeId: chargeId,
      createdAt: now
    });

    tx.set(sellerTxnRef, {
      userId: order.sellerId,
      role: 'seller',
      orderId: metadataOrderId,
      type: 'sale_hold',
      direction: 'credit',
      amount: sellerNetAmount,
      fee: platformFee,
      netAmount: sellerNetAmount,
      currency: CURRENCY,
      status: 'pending',
      provider: 'xpay',
      paymentId,
      xpayCheckoutSessionId: sessionId,
      xpayPaymentIntentId: paymentIntentId,
      createdAt: now
    });

    tx.set(platformTxnRef, {
      userId: '__platform__',
      role: 'platform',
      orderId: metadataOrderId,
      type: 'platform_fee',
      direction: 'credit',
      amount: platformFee,
      fee: 0,
      netAmount: platformFee,
      currency: CURRENCY,
      status: 'completed',
      provider: 'xpay',
      paymentId,
      xpayCheckoutSessionId: sessionId,
      xpayPaymentIntentId: paymentIntentId,
      createdAt: now
    });

    tx.update(orderRef, {
      paymentStatus: 'paid',
      paymentProvider: 'xpay',
      paymentId,
      paidAt: now,
      platformFee,
      sellerNetAmount,
      financeStatus: 'escrowed',
      xpayCheckoutSessionId: sessionId,
      xpayPaymentIntentId: paymentIntentId,
      xpayChargeId: chargeId,
      xpayCustomerId: customerId,
      xpayPaymentStatus: 'paid',
      xpayAmountTotalMinor: Math.round(totalPrice * 100),
      xpayRefundStatus: null,
      updatedAt: now
    });

    return {
      ok: true,
      alreadyPaid: false,
      orderId: metadataOrderId,
      totalPrice,
      sellerNetAmount,
      platformFee,
      paymentId,
      paymentIntentId,
      checkoutSessionId: sessionId
    };
  });
}

export async function markXPayPaymentFailed({ db, session, reason = 'PAYMENT_FAILED' }) {
  const sessionId = String(session?.id || '').trim();
  const orderId = String(session?.metadata?.orderId || '').trim();
  if (!sessionId || !orderId) return { ok: false, skipped: true };

  const ref = db.collection('orders').doc(orderId);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, skipped: true };
    const order = snap.data() || {};
    if (order.paymentStatus === 'paid' || order.financeStatus === 'escrowed') {
      return { ok: true, ignored: true };
    }
    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.update(ref, {
      paymentProvider: 'xpay',
      xpayCheckoutSessionId: sessionId,
      xpayPaymentStatus: 'unpaid',
      paymentStatus: 'pending',
      financeStatus: 'unfunded',
      xpayFailureReason: String(reason).slice(0, 200),
      updatedAt: now
    });
    return { ok: true, skipped: false };
  });
}

export async function recordXPayRefund({ db, refund }) {
  const refundId = String(refund?.id || '').trim();
  const paymentIntentId = String(refund?.paymentIntentId || '').trim();
  const metadataOrderId = String(refund?.metadata?.orderId || '').trim();
  const orderId = metadataOrderId;
  if (!refundId) throw new Error('XPAY_REFUND_ID_MISSING');

  let orderRef = orderId
    ? db.collection('orders').doc(orderId)
    : null;

  if (!orderRef && paymentIntentId) {
    const qs = await db.collection('orders')
      .where('xpayPaymentIntentId', '==', paymentIntentId)
      .limit(1)
      .get();
    if (qs.empty) return { ok: false, skipped: true };
    orderRef = qs.docs[0].ref;
  }

  if (!orderRef) return { ok: false, skipped: true };

  return db.runTransaction(async tx => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return { ok: false, skipped: true };
    const order = orderSnap.data() || {};

    if (order.paymentStatus === 'refunded' && order.financeStatus === 'refunded') {
      return { ok: true, alreadyRefunded: true, orderId: orderRef.id };
    }

    if (order.status !== 'pending' || order.paymentStatus !== 'paid' || order.financeStatus !== 'escrowed') {
      throw new Error('ORDER_REFUND_STATE_INVALID');
    }

    const sellerNetAmount = positiveMoney(order.sellerNetAmount);
    const totalPrice = positiveMoney(order.totalPrice ?? order.price);
    const platformFee = money(order.platformFee ?? 0);
    if (sellerNetAmount === null || totalPrice === null) throw new Error('INVALID_FINANCIAL_DATA');

    const walletRef = db.collection('wallets').doc(order.sellerId);
    const walletSnap = await tx.get(walletRef);
    const wallet = normalizeWallet(walletSnap.exists ? walletSnap.data() : {});

    if (wallet.pendingBalance < sellerNetAmount) {
      throw new Error('SELLER_PENDING_BALANCE_MISMATCH');
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const buyerTxnRef = db.collection('transactions').doc();
    const reversalTxnRef = db.collection('transactions').doc();
    const feeReversalTxnRef = db.collection('transactions').doc();

    tx.set(walletRef, {
      ...wallet,
      pendingBalance: money(wallet.pendingBalance - sellerNetAmount),
      currency: CURRENCY,
      updatedAt: now
    }, { merge: true });

    tx.set(buyerTxnRef, {
      userId: order.userId,
      role: 'buyer',
      orderId: orderRef.id,
      type: 'order_refund',
      direction: 'credit',
      amount: totalPrice,
      fee: 0,
      netAmount: totalPrice,
      currency: CURRENCY,
      status: 'completed',
      provider: 'xpay',
      refundId,
      paymentId: order.paymentId || order.xpayPaymentIntentId || order.xpayCheckoutSessionId || null,
      createdAt: now
    });

    tx.set(reversalTxnRef, {
      userId: order.sellerId,
      role: 'seller',
      orderId: orderRef.id,
      type: 'sale_reversal',
      direction: 'debit',
      amount: sellerNetAmount,
      fee: platformFee,
      netAmount: sellerNetAmount,
      currency: CURRENCY,
      status: 'completed',
      provider: 'xpay',
      refundId,
      createdAt: now
    });

    tx.set(feeReversalTxnRef, {
      userId: '__platform__',
      role: 'platform',
      orderId: orderRef.id,
      type: 'platform_fee_reversal',
      direction: 'debit',
      amount: platformFee,
      fee: 0,
      netAmount: platformFee,
      currency: CURRENCY,
      status: 'completed',
      provider: 'xpay',
      refundId,
      createdAt: now
    });

    tx.update(orderRef, {
      status: 'cancelled',
      paymentStatus: 'refunded',
      financeStatus: 'refunded',
      xpayRefundStatus: 'succeeded',
      xpayRefundId: refundId,
      refundedAt: now,
      updatedAt: now
    });

    return { ok: true, orderId: orderRef.id, refunded: totalPrice, refundId };
  });
}

export async function beginXPayRefund({ db, uid, orderId }) {
  const orderRef = db.collection('orders').doc(orderId);
  return db.runTransaction(async tx => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) throw new Error('ORDER_NOT_FOUND');
    const order = snap.data() || {};
    assertOrderBuyer(order, uid);
    if (order.status !== 'pending') throw new Error('ORDER_NOT_CANCELLABLE');
    if (order.paymentProvider !== 'xpay' || order.paymentStatus !== 'paid' || order.financeStatus !== 'escrowed') {
      throw new Error('ORDER_PAYMENT_STATE_INVALID');
    }
    if (!order.xpayPaymentIntentId) throw new Error('XPAY_PAYMENT_INTENT_MISSING');
    if (order.xpayRefundStatus === 'succeeded' || order.paymentStatus === 'refunded') {
      return { ok: true, alreadyRefunded: true, orderId };
    }
    if (order.xpayRefundStatus === 'requested') {
      return { ok: true, refundPending: true, orderId, paymentIntentId: order.xpayPaymentIntentId };
    }
    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.update(orderRef, {
      xpayRefundStatus: 'requested',
      updatedAt: now
    });
    return {
      ok: true,
      refundPending: true,
      orderId,
      paymentIntentId: order.xpayPaymentIntentId
    };
  });
}

export async function completeOrderAndRelease({ db, uid, orderId }) {
  const orderRef = db.collection('orders').doc(orderId);

  return db.runTransaction(async tx => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new Error('ORDER_NOT_FOUND');

    const order = orderSnap.data() || {};
    assertOrderBuyer(order, uid);

    if (!['delivered', 'redelivered'].includes(order.status)) {
      throw new Error('ORDER_NOT_DELIVERED');
    }

    const isDirect = order.financeStatus === 'direct_paid' && order.paymentProvider === 'direct_transfer';
    if (!isDirect && (order.financeStatus !== 'escrowed' || order.paymentStatus !== 'paid')) {
      throw new Error('ORDER_NOT_FUNDED');
    }
    if (isDirect && order.paymentStatus !== 'paid') {
      throw new Error('ORDER_NOT_FUNDED');
    }

    const sellerNetAmount = positiveMoney(order.sellerNetAmount);
    const platformFee = money(order.platformFee ?? 0);
    const totalPrice = positiveMoney(order.totalPrice ?? order.price);

    if (sellerNetAmount === null || totalPrice === null) {
      throw new Error('INVALID_FINANCIAL_DATA');
    }

    if (isDirect) {
      const sellerProfileRef = db.collection('sellerProfiles').doc(order.sellerId);
      const sellerProfileSnap = await tx.get(sellerProfileRef);
      const sellerProfile = sellerProfileSnap.exists ? (sellerProfileSnap.data() || {}) : {};
      const now = admin.firestore.FieldValue.serverTimestamp();
      const currentCompleted = Number(sellerProfile.completedOrders ?? 0);
      const completedOrders = (Number.isFinite(currentCompleted) ? Math.max(0, Math.floor(currentCompleted)) : 0) + 1;
      const walletRef = db.collection('wallets').doc(order.sellerId);
      const walletSnap = await tx.get(walletRef);
      const wallet = normalizeWallet(walletSnap.exists ? walletSnap.data() : {});
      const lifetimeNet = money(wallet.lifetimeNet + sellerNetAmount);
      const level = getSellerLevel(completedOrders);

      tx.set(walletRef, {
        ...wallet,
        lifetimeGross: money(wallet.lifetimeGross + totalPrice),
        lifetimeFees: money(wallet.lifetimeFees + platformFee),
        lifetimeNet,
        currency: CURRENCY,
        updatedAt: now
      }, { merge: true });

      // Keep lifetime earnings private in wallets; sellerProfiles is publicly readable.
      tx.set(sellerProfileRef, {
        completedOrders,
        level,
        updatedAt: now
      }, { merge: true });

      tx.update(orderRef, {
        status: 'completed',
        financeStatus: 'direct_completed',
        completedAt: now,
        updatedAt: now
      });

      return {
        ok: true,
        orderId,
        sellerNetAmount,
        platformFee,
        totalPrice,
        directPayment: true,
        platformFeeStatus: order.platformFeeStatus || 'due'
      };
    }

    const walletRef = db.collection('wallets').doc(order.sellerId);
    const walletSnap = await tx.get(walletRef);
    const wallet = normalizeWallet(walletSnap.exists ? walletSnap.data() : {});

    const sellerProfileRef = db.collection('sellerProfiles').doc(order.sellerId);
    const sellerProfileSnap = await tx.get(sellerProfileRef);
    const sellerProfile = sellerProfileSnap.exists
      ? (sellerProfileSnap.data() || {})
      : {};

    if (wallet.pendingBalance < sellerNetAmount) {
      throw new Error('SELLER_PENDING_BALANCE_MISMATCH');
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const txnRef = db.collection('transactions').doc();

    tx.set(walletRef, {
      ...wallet,
      pendingBalance: money(wallet.pendingBalance - sellerNetAmount),
      availableBalance: money(wallet.availableBalance + sellerNetAmount),
      lifetimeGross: money(wallet.lifetimeGross + totalPrice),
      lifetimeFees: money(wallet.lifetimeFees + platformFee),
      lifetimeNet: money(wallet.lifetimeNet + sellerNetAmount),
      currency: CURRENCY,
      updatedAt: now
    }, { merge: true });

    tx.set(txnRef, {
      userId: order.sellerId,
      role: 'seller',
      orderId,
      type: 'sale_release',
      direction: 'credit',
      amount: sellerNetAmount,
      fee: platformFee,
      netAmount: sellerNetAmount,
      currency: CURRENCY,
      status: 'completed',
      provider: order.paymentProvider || 'demo',
      createdAt: now
    });

    tx.update(orderRef, {
      status: 'completed',
      financeStatus: 'released',
      completedAt: now,
      updatedAt: now
    });

    const currentCompleted = Number(sellerProfile.completedOrders ?? 0);
    const completedOrders = (Number.isFinite(currentCompleted) ? Math.max(0, Math.floor(currentCompleted)) : 0) + 1;
    const level = getSellerLevel(completedOrders);
    // Keep lifetime earnings private in wallets; sellerProfiles is publicly readable.
    tx.set(sellerProfileRef, {
      completedOrders,
      level,
      updatedAt: now
    }, { merge: true });

    return {
      ok: true,
      orderId,
      sellerNetAmount,
      platformFee,
      totalPrice
    };
  });
}

export async function cancelOrder({ db, uid, orderId }) {
  const orderRef = db.collection('orders').doc(orderId);

  return db.runTransaction(async tx => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new Error('ORDER_NOT_FOUND');

    const order = orderSnap.data() || {};
    assertOrderBuyer(order, uid);

    if (order.status !== 'pending') {
      throw new Error('ORDER_NOT_CANCELLABLE');
    }

    if (
      order.paymentProvider === 'xpay' &&
      order.paymentStatus === 'pending' &&
      order.xpayCheckoutSessionId
    ) {
      throw new Error('XPAY_PAYMENT_PENDING_CANNOT_CANCEL');
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const update = {
      status: 'cancelled',
      updatedAt: now
    };

    if (order.paymentStatus === 'pending') {
      update.financeStatus = 'unfunded';
      tx.update(orderRef, update);
      return { ok: true, orderId, refunded: 0 };
    }

    if (order.paymentProvider === 'direct_transfer' && order.paymentStatus === 'paid') {
      throw new Error('DIRECT_PAYMENT_REFUND_REQUIRED');
    }

    if (order.paymentStatus !== 'paid' || order.financeStatus !== 'escrowed') {
      throw new Error('ORDER_PAYMENT_STATE_INVALID');
    }

    const sellerNetAmount = positiveMoney(order.sellerNetAmount);
    const totalPrice = positiveMoney(order.totalPrice ?? order.price);

    if (sellerNetAmount === null || totalPrice === null) {
      throw new Error('INVALID_FINANCIAL_DATA');
    }

    const walletRef = db.collection('wallets').doc(order.sellerId);
    const walletSnap = await tx.get(walletRef);
    const wallet = normalizeWallet(walletSnap.exists ? walletSnap.data() : {});

    if (wallet.pendingBalance < sellerNetAmount) {
      throw new Error('SELLER_PENDING_BALANCE_MISMATCH');
    }

    const refundTxnRef = db.collection('transactions').doc();
    const reversalTxnRef = db.collection('transactions').doc();

    tx.set(walletRef, {
      ...wallet,
      pendingBalance: money(wallet.pendingBalance - sellerNetAmount),
      currency: CURRENCY,
      updatedAt: now
    }, { merge: true });

    tx.set(refundTxnRef, {
      userId: order.userId,
      role: 'buyer',
      orderId,
      type: 'order_refund',
      direction: 'credit',
      amount: totalPrice,
      fee: 0,
      netAmount: totalPrice,
      currency: CURRENCY,
      status: 'completed',
      provider: order.paymentProvider || 'demo',
      createdAt: now
    });

    tx.set(reversalTxnRef, {
      userId: order.sellerId,
      role: 'seller',
      orderId,
      type: 'sale_reversal',
      direction: 'debit',
      amount: sellerNetAmount,
      fee: money(order.platformFee ?? 0),
      netAmount: sellerNetAmount,
      currency: CURRENCY,
      status: 'completed',
      provider: order.paymentProvider || 'demo',
      createdAt: now
    });

    tx.update(orderRef, {
      ...update,
      paymentStatus: 'refunded',
      financeStatus: 'refunded',
      refundedAt: now
    });

    return { ok: true, orderId, refunded: totalPrice };
  });
}

export async function requestWithdrawal({ db, uid, method, account, amount }) {
  const cleanMethod = String(method || '').trim();
  const cleanAccount = String(account || '').trim();
  const requestedAmount = positiveMoney(amount);

  if (!['bank', 'ewallet', 'instapay'].includes(cleanMethod)) {
    throw new Error('INVALID_WITHDRAWAL_METHOD');
  }
  if (!cleanAccount || cleanAccount.length > 120) {
    throw new Error('INVALID_WITHDRAWAL_ACCOUNT');
  }
  if (requestedAmount === null || requestedAmount < MIN_WITHDRAWAL) {
    throw new Error('WITHDRAWAL_BELOW_MINIMUM');
  }

  const walletRef = db.collection('wallets').doc(uid);
  const withdrawalRef = db.collection('withdrawals').doc();
  const txnRef = db.collection('transactions').doc();

  return db.runTransaction(async tx => {
    const walletSnap = await tx.get(walletRef);
    const wallet = normalizeWallet(walletSnap.exists ? walletSnap.data() : {});

    if (wallet.availableBalance < requestedAmount) {
      throw new Error('INSUFFICIENT_AVAILABLE_BALANCE');
    }

    const now = admin.firestore.FieldValue.serverTimestamp();

    tx.set(walletRef, {
      ...wallet,
      availableBalance: money(wallet.availableBalance - requestedAmount),
      lockedBalance: money(wallet.lockedBalance + requestedAmount),
      updatedAt: now
    }, { merge: true });

    tx.set(withdrawalRef, {
      sellerId: uid,
      amount: requestedAmount,
      currency: CURRENCY,
      method: cleanMethod,
      account: cleanAccount,
      status: 'requested',
      createdAt: now,
      updatedAt: now
    });

    tx.set(txnRef, {
      userId: uid,
      role: 'seller',
      withdrawalId: withdrawalRef.id,
      type: 'withdrawal_hold',
      direction: 'debit',
      amount: requestedAmount,
      fee: 0,
      netAmount: requestedAmount,
      currency: CURRENCY,
      status: 'pending',
      provider: 'internal',
      createdAt: now
    });

    return {
      ok: true,
      withdrawalId: withdrawalRef.id,
      amount: requestedAmount,
      status: 'requested'
    };
  });
}

export async function processWithdrawal({ db, adminUid, withdrawalId, action }) {
  const withdrawalRef = db.collection('withdrawals').doc(withdrawalId);
  const txRef = db.collection('transactions').doc();

  return db.runTransaction(async t => {
    const withdrawalSnap = await t.get(withdrawalRef);
    if (!withdrawalSnap.exists) throw new Error('WITHDRAWAL_NOT_FOUND');

    const withdrawal = withdrawalSnap.data() || {};
    const sellerId = withdrawal.sellerId;
    const amount = positiveMoney(withdrawal.amount);

    if (!sellerId || amount === null) throw new Error('INVALID_WITHDRAWAL');

    const walletRef = db.collection('wallets').doc(sellerId);
    const walletSnap = await t.get(walletRef);
    const wallet = normalizeWallet(walletSnap.exists ? walletSnap.data() : {});
    const now = admin.firestore.FieldValue.serverTimestamp();

    if (action === 'approve') {
      if (withdrawal.status !== 'requested') throw new Error('WITHDRAWAL_NOT_APPROVABLE');
      t.update(withdrawalRef, {
        status: 'approved',
        approvedBy: adminUid,
        approvedAt: now,
        updatedAt: now
      });
      return { ok: true, withdrawalId, status: 'approved' };
    }

    if (action === 'mark_paid') {
      if (withdrawal.status !== 'approved') {
        throw new Error('WITHDRAWAL_NOT_PAYABLE');
      }
      if (wallet.lockedBalance < amount) throw new Error('WITHDRAWAL_LOCK_MISMATCH');

      t.update(walletRef, {
        lockedBalance: money(wallet.lockedBalance - amount),
        updatedAt: now
      });
      t.update(withdrawalRef, {
        status: 'paid',
        paidBy: adminUid,
        paidAt: now,
        updatedAt: now
      });
      t.set(txRef, {
        userId: sellerId,
        role: 'seller',
        withdrawalId,
        type: 'withdrawal_paid',
        direction: 'debit',
        amount,
        fee: 0,
        netAmount: amount,
        currency: CURRENCY,
        status: 'completed',
        provider: 'manual_demo',
        createdAt: now
      });
      return { ok: true, withdrawalId, status: 'paid' };
    }

    if (action === 'reject') {
      if (!['requested', 'approved'].includes(withdrawal.status)) {
        throw new Error('WITHDRAWAL_NOT_REJECTABLE');
      }
      if (wallet.lockedBalance < amount) throw new Error('WITHDRAWAL_LOCK_MISMATCH');

      t.update(walletRef, {
        lockedBalance: money(wallet.lockedBalance - amount),
        availableBalance: money(wallet.availableBalance + amount),
        updatedAt: now
      });
      t.update(withdrawalRef, {
        status: 'rejected',
        rejectedBy: adminUid,
        rejectedAt: now,
        updatedAt: now
      });
      t.set(txRef, {
        userId: sellerId,
        role: 'seller',
        withdrawalId,
        type: 'withdrawal_reversal',
        direction: 'credit',
        amount,
        fee: 0,
        netAmount: amount,
        currency: CURRENCY,
        status: 'completed',
        provider: 'internal',
        createdAt: now
      });
      return { ok: true, withdrawalId, status: 'rejected' };
    }

    throw new Error('INVALID_WITHDRAWAL_ACTION');
  });
}
