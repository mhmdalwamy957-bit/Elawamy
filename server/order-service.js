import admin from 'firebase-admin';
function cleanText(value, max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

function toPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toPositiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function validateAnswers(service, answers) {
  const requirements = Array.isArray(service.requirements)
    ? service.requirements
    : [];

  if (!Array.isArray(answers) || answers.length > 20) {
    throw new Error('INVALID_REQUIREMENTS');
  }

  const answerMap = new Map();

  for (const item of answers) {
    const index = Number(item?.questionIndex);

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= requirements.length
    ) {
      throw new Error('INVALID_REQUIREMENT_INDEX');
    }

    if (answerMap.has(index)) {
      throw new Error('DUPLICATE_REQUIREMENT');
    }

    const answer = cleanText(item?.answer, 3000);

    if (answer.length > 0) {
      answerMap.set(index, answer);
    }
  }

  const snapshot = requirements.map((item, index) => {
    const question = cleanText(item?.question, 500);
    const required = item?.required !== false;
    const answer = answerMap.get(index) || '';

    if (!question) {
      throw new Error('INVALID_SERVICE_REQUIREMENT');
    }

    if (required && !answer) {
      throw new Error('MISSING_REQUIRED_REQUIREMENT');
    }

    return {
      question,
      required,
      answer
    };
  });

  return snapshot;
}

function validateExtras(service, selectedExtras) {
  const extras = Array.isArray(service.extras)
    ? service.extras
    : [];

  if (!Array.isArray(selectedExtras) || selectedExtras.length > 10) {
    throw new Error('INVALID_EXTRAS');
  }

  const indexes = new Set();
  const selected = [];

  for (const rawIndex of selectedExtras) {
    const index = Number(rawIndex);

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= extras.length
    ) {
      throw new Error('INVALID_EXTRA_INDEX');
    }

    if (indexes.has(index)) {
      throw new Error('DUPLICATE_EXTRA');
    }

    indexes.add(index);

    const extra = extras[index];

    const title = cleanText(extra?.title, 200);
    const description = cleanText(extra?.description, 1000);
    const price = toPositiveNumber(extra?.price);
    const deliveryDays = toPositiveInteger(extra?.deliveryDays);

    if (
      !title ||
      price === null ||
      price > 100000 ||
      deliveryDays === null ||
      deliveryDays > 90
    ) {
      throw new Error('INVALID_SERVICE_EXTRA');
    }

    selected.push({
      index,
      title,
      description,
      price,
      deliveryDays
    });
  }

  return selected;
}

export async function createOrder({
  db,
  uid,
  serviceId,
  answers,
  selectedExtras
}) {
  if (!uid || !serviceId) {
    throw new Error('INVALID_ORDER_DATA');
  }

  const serviceRef = db.collection('services').doc(serviceId);
  const serviceSnap = await serviceRef.get();

  if (!serviceSnap.exists) {
    throw new Error('SERVICE_NOT_FOUND');
  }

  const service = serviceSnap.data() || {};

  if (service.status !== 'approved') {
    throw new Error('SERVICE_NOT_APPROVED');
  }

  if (!service.ownerId || service.ownerId === uid) {
    throw new Error('INVALID_SELLER');
  }

  const basePrice = toPositiveNumber(service.price);

  if (basePrice === null || basePrice > 100000) {
    throw new Error('INVALID_SERVICE_PRICE');
  }

  const baseDeliveryDays = toPositiveInteger(service.deliveryDays);

  if (baseDeliveryDays === null || baseDeliveryDays > 90) {
    throw new Error('INVALID_SERVICE_DELIVERY');
  }

  const requirementSnapshot =
    validateAnswers(service, answers);

  const extraSnapshot =
    validateExtras(service, selectedExtras);

  const extrasTotal = extraSnapshot.reduce(
    (sum, extra) => sum + extra.price,
    0
  );

  const extrasDeliveryDays = extraSnapshot.reduce(
    (sum, extra) => sum + extra.deliveryDays,
    0
  );

  const totalPrice = basePrice + extrasTotal;
  const deliveryDays =
    baseDeliveryDays + extrasDeliveryDays;

  if (totalPrice > 100000) {
    throw new Error('INVALID_ORDER_TOTAL');
  }

  if (!Number.isInteger(deliveryDays) || deliveryDays < 1 || deliveryDays > 90) {
    throw new Error('INVALID_TOTAL_DELIVERY');
  }

  const orderRef = db.collection('orders').doc();

  const order = {
    serviceId,
    serviceName: String(service.name || 'خدمة'),
    sellerId: service.ownerId,
    userId: uid,

    basePrice,
    extrasTotal,
    totalPrice,

    price: totalPrice,

    baseDeliveryDays,
    extrasDeliveryDays,
    deliveryDays,

    requirements: requirementSnapshot,
    selectedExtras: extraSnapshot,

    status: 'pending',

    paymentStatus: 'pending',
    paymentProvider: null,
    paymentId: null,
    paidAt: null,
    platformFee: 0,
    sellerNetAmount: 0,
    financeStatus: 'unfunded',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  await orderRef.set(order);

  await db.collection('notifications').add({
    userId: service.ownerId,
    type: 'new_order',
    title: 'طلب جديد',
    body: `لديك طلب جديد بانتظار تأكيد الدفع على خدمة: ${service.name || 'خدمة'}.`,
    orderId: orderRef.id,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return {
    orderId: orderRef.id,
    serviceId,
    totalPrice,
    deliveryDays
  };
}
