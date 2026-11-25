import {
  auth,
  db,
  onAuthStateChanged,
  collection,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  signOut
} from './firebase.js';

const page = document.getElementById('buyerDashboard');

const mobileMenu = document.getElementById('mobileMenu');
const mainNav = document.getElementById('mainNav');

mobileMenu?.addEventListener('click', () => {
  const open = mainNav?.classList.toggle('open');
  mobileMenu.setAttribute('aria-expanded', String(Boolean(open)));
});

document.getElementById('logout')?.addEventListener('click', async () => {
  try {
    await signOut(auth);
    location.replace('/');
  } catch (error) {
    console.error('LOGOUT ERROR:', error);
  }
});

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function money(value) {
  return Number(value || 0).toLocaleString('ar-EG');
}

function timeValue(value) {
  return value?.toMillis?.() ?? value?.seconds * 1000 ?? 0;
}

function formatDate(value) {
  const ms = timeValue(value);
  return ms
    ? new Date(ms).toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' })
    : '';
}

const statusText = {
  pending: 'قيد الانتظار',
  accepted: 'قيد التنفيذ',
  delivered: 'تم التسليم',
  revision_requested: 'مطلوب تعديل',
  redelivered: 'إعادة تسليم',
  completed: 'مكتمل',
  cancelled: 'ملغي'
};

async function load(user) {
  try {
    const orders = (await getDocs(
      query(
        collection(db, 'orders'),
        where('userId', '==', user.uid),
        orderBy('createdAt', 'desc'),
        limit(20)
      )
    )).docs.map(d => ({ id: d.id, ...d.data() }));

    let favorites = 0;
    try {
      favorites = (await getDocs(collection(db, 'favorites', user.uid, 'services'))).size;
    } catch (error) {
      console.warn('FAVORITES COUNT ERROR:', error);
    }

    let disputes = 0;
    try {
      const disputeSnaps = await Promise.all([
        getDocs(query(collection(db, 'disputes'), where('buyerId', '==', user.uid))),
        getDocs(query(collection(db, 'disputes'), where('sellerId', '==', user.uid)))
      ]);
      const disputeMap = new Map();
      [...disputeSnaps[0].docs, ...disputeSnaps[1].docs].forEach(d => disputeMap.set(d.id, d.data()));
      disputes = [...disputeMap.values()].filter(d => ['open', 'in_review'].includes(d.status)).length;
    } catch (error) {
      console.warn('BUYER DISPUTES COUNT ERROR:', error);
    }

    let notifications = 0;
    try {
      notifications = (await getDocs(
        query(
          collection(db, 'notifications'),
          where('userId', '==', user.uid),
          where('read', '==', false),
          limit(50)
        )
      )).size;
    } catch (error) {
      console.warn('NOTIFICATIONS COUNT ERROR:', error);
    }

    const pending = orders.filter(o => ['pending', 'accepted', 'revision_requested', 'redelivered'].includes(o.status)).length;
    const completed = orders.filter(o => o.status === 'completed');
    const completedTotal = completed.reduce((sum, o) => sum + Number(o.price || o.totalPrice || 0), 0);

    const latest = orders.slice(0, 6);

    page.innerHTML = `
      <div class="dashboard-section-head">
        <div>
          <h1>لوحة المشتري</h1>
          <p class="muted">مرحبًا ${esc(user.email || 'مستخدم')}</p>
        </div>
        <a class="btn" href="/">تصفح الخدمات</a>
      </div>

      <div class="seller-dashboard-grid">
        <div class="dashboard-stat"><span>كل الطلبات</span><strong>${orders.length}</strong></div>
        <div class="dashboard-stat"><span>طلبات نشطة</span><strong>${pending}</strong></div>
        <div class="dashboard-stat"><span>طلبات مكتملة</span><strong>${completed.length}</strong></div>
        <div class="dashboard-stat"><span>إجمالي المشتريات المكتملة</span><strong>${money(completedTotal)} <small>ج.م</small></strong></div>
        <div class="dashboard-stat"><span>المفضلة</span><strong>${favorites}</strong></div>
        <div class="dashboard-stat"><span>إشعارات غير مقروءة</span><strong>${notifications}</strong></div>
        <div class="dashboard-stat"><span>نزاعات مفتوحة</span><strong>${disputes}</strong></div>
      </div>

      <div class="dashboard-section">
        <div class="dashboard-section-head">
          <h2>آخر الطلبات</h2>
          <a href="/orders">عرض كل الطلبات</a>
        </div>
        ${latest.length ? `
          <div class="dashboard-orders">
            ${latest.map(order => `
              <a class="dashboard-order" href="/orders?order=${encodeURIComponent(order.id)}">
                <div>
                  <strong>${esc(order.serviceName || 'خدمة')}</strong>
                  <span class="muted">${formatDate(order.createdAt)}</span>
                </div>
                <div class="dashboard-order-side">
                  <strong>${money(order.price || order.totalPrice)} ج.م</strong>
                  <span class="order-status">${esc(statusText[order.status] || order.status)}</span>
                </div>
              </a>
            `).join('')}
          </div>
        ` : '<div class="empty">لا توجد طلبات حتى الآن.</div>'}
      </div>

      <div class="dashboard-section">
        <div class="dashboard-section-head"><h2>اختصارات</h2></div>
        <div class="dashboard-quick-links">
          <a class="btn" href="/orders">📦 طلباتي</a>
          <a class="btn secondary" href="/favorites">♥ المفضلة</a>
          <a class="btn secondary" href="/support">🎧 الدعم الفني</a>
          <a class="btn secondary" href="/disputes">⚠️ النزاعات</a>
          <a class="btn secondary" href="/profile">👤 حسابي</a>
        </div>
      </div>
    `;
  } catch (error) {
    console.error('BUYER DASHBOARD ERROR:', error);
    page.innerHTML = `<div class="empty">تعذر تحميل لوحة المشتري. <button class="btn" id="retryBuyerDashboard">إعادة المحاولة</button></div>`;
    document.getElementById('retryBuyerDashboard')?.addEventListener('click', () => load(user));
  }
}

onAuthStateChanged(auth, user => {
  if (!user) {
    location.replace('/login?redirect=%2Fbuyer-dashboard');
    return;
  }
  load(user);
});
