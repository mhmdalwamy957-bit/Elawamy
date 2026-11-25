import {
  db,
  auth,
  collection,
  addDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  onSnapshot,
  serverTimestamp
} from './firebase.js';

const servicesRef = collection(db, 'services');

// اقرأ كل الخدمات؛ لا نستخدم where(ownerId) هنا حتى تظهر خدمات كل البائعين.
const SERVICES_PAGE_SIZE = 24;

let servicesCache = [];
let servicesLastDoc = null;
let servicesHasMore = true;
let servicesLoadingMore = false;
let servicesUnsubscribe = null;

function normalizeService(item) {
  const data = item.data() || {};

  return {
    id: item.id,
    ...data,
    // دعم الخدمات القديمة التي كانت تستخدم userId/title.
    name: String(data.name ?? data.title ?? 'خدمة بدون اسم'),
    ownerId: data.ownerId ?? data.userId ?? ''
  };
}

export function watchServices(callback, onError = () => {}) {
  if (servicesUnsubscribe) {
    servicesUnsubscribe();
  }

  servicesCache = [];
  servicesLastDoc = null;
  servicesHasMore = true;
  servicesLoadingMore = false;

  const firstPageQuery = query(
    servicesRef,
    where('status', '==', 'approved'),
    orderBy('createdAt', 'desc'),
    limit(SERVICES_PAGE_SIZE)
  );

  servicesUnsubscribe = onSnapshot(
    firstPageQuery,
    (snapshot) => {
      const firstPageServices =
        snapshot.docs.map(normalizeService);

      const firstPageIds =
        new Set(firstPageServices.map(service => service.id));

      const olderServices =
        servicesCache.filter(
          service => !firstPageIds.has(service.id)
        );

      servicesCache = [
        ...firstPageServices,
        ...olderServices
      ];

      servicesLastDoc =
        snapshot.docs.length > 0
          ? snapshot.docs[snapshot.docs.length - 1]
          : null;

      servicesHasMore =
        snapshot.docs.length === SERVICES_PAGE_SIZE;

      console.log(
        'SERVICES LOADED:',
        servicesCache.length
      );

      callback(servicesCache, {
        hasMore: servicesHasMore,
        loadingMore: servicesLoadingMore
      });
    },
    (error) => {
      console.error('Firestore services error:', error);
      onError(error);
    }
  );

  return servicesUnsubscribe;
}

export async function loadMoreServices(callback) {
  if (
    servicesLoadingMore ||
    !servicesHasMore ||
    !servicesLastDoc
  ) {
    return;
  }

  servicesLoadingMore = true;

  callback(servicesCache, {
    hasMore: servicesHasMore,
    loadingMore: servicesLoadingMore
  });

  try {
    const nextPageQuery = query(
      servicesRef,
      where('status', '==', 'approved'),
      orderBy('createdAt', 'desc'),
      startAfter(servicesLastDoc),
      limit(SERVICES_PAGE_SIZE)
    );

    const snapshot = await getDocs(nextPageQuery);

    const nextServices =
      snapshot.docs.map(normalizeService);

    servicesCache = [
      ...servicesCache,
      ...nextServices
    ];

    if (snapshot.docs.length > 0) {
      servicesLastDoc =
        snapshot.docs[snapshot.docs.length - 1];
    }

    servicesHasMore =
      snapshot.docs.length === SERVICES_PAGE_SIZE;

    console.log(
      'SERVICES LOADED TOTAL:',
      servicesCache.length
    );
  } catch (error) {
    console.error(
      'LOAD MORE SERVICES ERROR:',
      error
    );

    throw error;
  } finally {
    servicesLoadingMore = false;

    callback(servicesCache, {
      hasMore: servicesHasMore,
      loadingMore: servicesLoadingMore
    });
  }
}

export function getServicesState() {
  return {
    count: servicesCache.length,
    hasMore: servicesHasMore,
    loadingMore: servicesLoadingMore
  };
}

function safeImageUrl(value) {
  const raw = String(value || '').trim();

  if (!raw) return '';

  try {
    const url = new URL(raw, location.origin);

    if (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && location.hostname === 'localhost')
    ) {
      return url.href;
    }

    return '';
  } catch {
    return '';
  }
}

export async function createService(data) {
  const user = auth.currentUser;

  if (!user) {
    throw new Error('يجب تسجيل الدخول أولًا');
  }

  const name = String(data.name || '').trim();
  const description = String(data.description || '').trim();
  const category = String(data.category || '').trim();
  const price = Number(data.price);
  const deliveryDays = Number(data.deliveryDays);
  const imageUrl = safeImageUrl(data.imageUrl);

  const tags = Array.isArray(data.tags)
    ? data.tags
        .map(tag => String(tag || '').trim())
        .filter(Boolean)
        .slice(0, 10)
    : [];

  const requirements = Array.isArray(data.requirements)
    ? data.requirements
        .map(item => ({
          question: String(item?.question || '').trim(),
          required: item?.required !== false
        }))
        .filter(item => item.question)
        .slice(0, 20)
    : [];

  const extras = Array.isArray(data.extras)
    ? data.extras
        .map(item => ({
          title: String(item?.title || '').trim(),
          description: String(item?.description || '').trim(),
          price: Number(item?.price),
          deliveryDays: Number(item?.deliveryDays)
        }))
        .filter(
          item =>
            item.title &&
            Number.isFinite(item.price) &&
            item.price >= 1 &&
            item.price <= 100000 &&
            Number.isInteger(item.deliveryDays) &&
            item.deliveryDays >= 1 &&
            item.deliveryDays <= 90
        )
        .slice(0, 10)
    : [];

  const faq = Array.isArray(data.faq)
    ? data.faq
        .map(item => ({
          question: String(item?.question || '').trim(),
          answer: String(item?.answer || '').trim()
        }))
        .filter(item => item.question && item.answer)
        .slice(0, 20)
    : [];

  const instructions = String(data.instructions || '').trim();

  if (name.length < 3 || name.length > 80) {
    throw new Error('اسم الخدمة يجب أن يكون بين 3 و80 حرفًا');
  }

  if (description.length < 10 || description.length > 1200) {
    throw new Error('الوصف يجب أن يكون بين 10 و1200 حرف');
  }

  if (!category || category.length > 60) {
    throw new Error('اختر القسم');
  }

  if (!Number.isFinite(price) || price < 1 || price > 100000) {
    throw new Error('السعر غير صالح');
  }

  if (
    !Number.isInteger(deliveryDays) ||
    deliveryDays < 1 ||
    deliveryDays > 90
  ) {
    throw new Error('مدة التسليم يجب أن تكون بين 1 و90 يومًا');
  }

  if (tags.some(tag => tag.length > 30)) {
    throw new Error('الكلمة المفتاحية يجب ألا تتجاوز 30 حرفًا');
  }

  if (instructions.length > 2000) {
    throw new Error('تعليمات المشتري طويلة جدًا');
  }

  const docRef = await addDoc(servicesRef, {
    name,
    description,
    category,
    price,
    deliveryDays,
    imageUrl,
    tags,
    requirements,
    extras,
    faq,
    instructions,
    rating: 0,
    ratingCount: 0,
    ownerId: user.uid,
    status: 'pending',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  return docRef.id;
}
