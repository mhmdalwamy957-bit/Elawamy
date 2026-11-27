import {
  db,
  auth,
  onAuthStateChanged,
  collection,
  getDocs,
  query,
  where,
  doc,
  getDoc
} from './firebase.js';

const page = document.getElementById('sellerDashboard');

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[c]));

const money = value =>
  Number(value || 0).toLocaleString('ar-EG');

const statusText = status => ({
  pending: 'طلب جديد',
  accepted: 'قيد التنفيذ',
  delivered: 'تم التسليم',
  revision_requested: 'تعديلات مطلوبة',
  redelivered: 'إعادة تسليم',
  completed: 'مكتمل',
  cancelled: 'ملغي'
}[status] || status || 'غير معروف');

const statusClass = status => ({
  pending: 'pending',
  accepted: 'accepted',
  delivered: 'delivered',
  revision_requested: 'revision',
  redelivered: 'accepted',
  completed: 'completed',
  cancelled: 'cancelled'
}[status] || '');

function formatDate(timestamp) {
  if (!timestamp) return '';

  try {
    const date = timestamp.toDate
      ? timestamp.toDate()
      : new Date(timestamp);

    return date.toLocaleDateString('ar-EG', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch {
    return '';
  }
}

function averageRating(services) {
  let totalRating = 0;
  let totalCount = 0;

  for (const service of services) {
    const rating = Number(service.rating || 0);
    const count = Number(service.ratingCount || 0);

    if (
      Number.isFinite(rating) &&
      Number.isFinite(count) &&
      count > 0
    ) {
      totalRating += rating * count;
      totalCount += count;
    }
  }

  return totalCount
    ? totalRating / totalCount
    : 0;
}

function renderStats({
  services,
  orders,
  completedOrders,
  rating,
  wallet = {},
  disputesCount = 0
}) {
  const totalSales = completedOrders.reduce(
    (sum, order) => sum + Number(order.price || 0),
    0
  );

  return `
    <div class="seller-dashboard-grid">

      <div class="dashboard-stat">
        <span>الخدمات</span>
        <strong>${services.length}</strong>
      </div>

      <div class="dashboard-stat">
        <span>طلبات جديدة</span>
        <strong>${orders.filter(o => o.status === 'pending').length}</strong>
      </div>

      <div class="dashboard-stat">
        <span>قيد التنفيذ</span>
        <strong>
          ${orders.filter(o =>
            ['accepted', 'delivered', 'revision_requested', 'redelivered']
              .includes(o.status)
          ).length}
        </strong>
      </div>

      <div class="dashboard-stat">
        <span>طلبات مكتملة</span>
        <strong>${completedOrders.length}</strong>
      </div>

      <div class="dashboard-stat">
        <span>متوسط التقييم</span>
        <strong>
          ${rating ? rating.toFixed(1) : '0.0'}
          <small>★</small>
        </strong>
      </div>

      <div class="dashboard-stat">
        <span>إجمالي المبيعات المكتملة</span>
        <strong>${money(totalSales)} <small>ج.م</small></strong>
      </div>

      <div class="dashboard-stat">
        <span>الرصيد المتاح</span>
        <strong>${money(wallet.availableBalance)} <small>ج.م</small></strong>
      </div>

      <div class="dashboard-stat">
        <span>أرباح معلقة</span>
        <strong>${money(wallet.pendingBalance)} <small>ج.م</small></strong>
      </div>

      <div class="dashboard-stat">
        <span>نزاعات مفتوحة</span>
        <strong>${disputesCount}</strong>
      </div>

    </div>
  `;
}

function renderOrders(orders) {
  const latest = [...orders]
    .sort((a, b) => {
      const aTime = a.createdAt?.toMillis?.() || 0;
      const bTime = b.createdAt?.toMillis?.() || 0;
      return bTime - aTime;
    })
    .slice(0, 8);

  if (!latest.length) {
    return `
      <div class="dashboard-section">
        <h2>آخر الطلبات</h2>
        <div class="empty">
          لا توجد طلبات على خدماتك حتى الآن.
        </div>
      </div>
    `;
  }

  return `
    <div class="dashboard-section">
      <div class="dashboard-section-head">
        <h2>آخر الطلبات</h2>
        <a href="/orders">عرض كل الطلبات</a>
      </div>

      <div class="dashboard-orders">
        ${latest.map(order => `
          <a
            class="dashboard-order"
            href="/orders?order=${encodeURIComponent(order.id)}"
          >
            <div>
              <strong>${esc(order.serviceName || 'خدمة')}</strong>
              <span class="muted">
                ${formatDate(order.createdAt)}
              </span>
            </div>

            <div class="dashboard-order-side">
              <strong>${money(order.price)} ج.م</strong>
              <span class="order-status ${statusClass(order.status)}">
                ${statusText(order.status)}
              </span>
            </div>
          </a>
        `).join('')}
      </div>
    </div>
  `;
}

function renderServices(services) {
  return `
    <div class="dashboard-section">
      <div class="dashboard-section-head">
        <h2>خدماتي</h2>
        <a href="/add-service">إضافة خدمة</a>
      </div>

      ${
        services.length
          ? `
            <div class="dashboard-services">
              ${services.map(service => `
                <div class="dashboard-service">
                  <a
                    href="/service?id=${encodeURIComponent(service.id)}"
                  >
                    <div>
                      <strong>${esc(service.name || 'خدمة')}</strong>
                      <span>
                        ${money(service.price)} ج.م
                      </span>
                    </div>
                  </a>

                  <div class="dashboard-service-actions">
                    <span>
                      ${Number(service.ratingCount || 0)} تقييم
                    </span>

                    <a
                      class="btn"
                      href="/edit-service?id=${encodeURIComponent(service.id)}"
                    >
                      تعديل
                    </a>
                  </div>
                </div>
              `).join('')}
            </div>
          `
          : `
            <div class="empty">
              لا توجد خدمات منشورة.
              <br><br>
              <a class="btn" href="/add-service">أضف أول خدمة</a>
            </div>
          `
      }
    </div>
  `;
}

function renderQuickActions() {
  return `
    <div class="dashboard-section">
      <h2>اختصارات سريعة</h2>

      <div class="dashboard-actions">
        <a class="btn" href="/add-service">
          + إضافة خدمة
        </a>

        <a class="btn" href="/orders">
          الطلبات
        </a>

        <a class="btn" href="/profile">
          تعديل الحساب
        </a>

        <a class="btn secondary" href="/disputes">
          ⚠️ النزاعات
        </a>
      </div>
    </div>
  `;
}

async function loadDashboard(user) {
  if (!user) {
    location.href =
      `/login?redirect=${encodeURIComponent('/seller-dashboard')}`;
    return;
  }

  page.innerHTML = `
    <p class="muted">جاري تحميل لوحة التحكم...</p>
  `;

  try {
    const servicesSnap = await getDocs(
      query(
        collection(db, 'services'),
        where('ownerId', '==', user.uid)
      )
    );

    const ordersSnap = await getDocs(
      query(
        collection(db, 'orders'),
        where('sellerId', '==', user.uid)
      )
    );

    const services = servicesSnap.docs.map(item => ({
      id: item.id,
      ...item.data()
    }));

    const orders = ordersSnap.docs.map(item => ({
      id: item.id,
      ...item.data()
    }));

    const completedOrders = orders.filter(
      order => order.status === 'completed'
    );

    const rating = averageRating(services);

    let wallet = {};
    try {
      const walletSnap = await getDoc(doc(db, 'wallets', user.uid));
      wallet = walletSnap.exists() ? walletSnap.data() : {};
    } catch (error) {
      console.warn('WALLET SUMMARY ERROR:', error);
    }

    let disputesCount = 0;
    try {
      const disputeSnap = await getDocs(
        query(collection(db, 'disputes'), where('sellerId', '==', user.uid))
      );
      disputesCount = disputeSnap.docs.filter(d => ['open', 'in_review'].includes(d.data()?.status)).length;
    } catch (error) {
      console.warn('SELLER DISPUTES COUNT ERROR:', error);
    }

    page.innerHTML = `
      <section class="seller-dashboard">

        <div class="dashboard-header">
          <div>
            <span class="muted">لوحة تحكم البائع</span>
            <h1>أهلاً بك في ElaWamy</h1>
            <p class="muted">
              تابع خدماتك وطلباتك ومبيعاتك من مكان واحد.
            </p>
          </div>

          <a class="btn" href="/add-service">
            + أضف خدمة
          </a>
        </div>

        ${renderStats({
          services,
          orders,
          completedOrders,
          rating,
          wallet,
          disputesCount
        })}

        ${renderQuickActions()}

        ${renderOrders(orders)}

        ${renderServices(services)}

      </section>
    `;

  } catch (error) {
    console.error('SELLER DASHBOARD ERROR:', error);

    page.innerHTML = `
      <div class="empty">
        <h2>حدث خطأ</h2>
        <p>
          تعذر تحميل لوحة تحكم البائع.
        </p>
        <button class="btn" onclick="location.reload()">
          إعادة المحاولة
        </button>
      </div>
    `;
  }
}

onAuthStateChanged(auth, loadDashboard);
