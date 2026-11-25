import {
  auth,
  db,
  onAuthStateChanged,
  getIdTokenResult,
  getIdToken,
  collection,
  query,
  where,
  orderBy,
  getDocs,
  addDoc,
  doc,
  updateDoc,
  serverTimestamp
} from './firebase.js';

const statusBox = document.getElementById('adminStatus');
const panel = document.getElementById('adminPanel');
const list = document.getElementById('pendingServices');
const withdrawalList = document.getElementById('withdrawalRequests');
const disputesList = document.getElementById('adminDisputesList');
const usersList = document.getElementById('adminUsersList');
const ordersList = document.getElementById('adminOrdersList');
const offersList = document.getElementById('adminOffersList');
const platformFeesList = document.getElementById('platformFeeRequests');
const barberShopList = document.getElementById('adminBarberShops');
const API_BASE = 'https://elawamy-file-server.vercel.app';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[char]));

const money = value => Number(value || 0).toLocaleString('ar-EG');

const USER_CONTROL_PERMISSIONS = [
  ['buying', 'الشراء'],
  ['barberBooking', 'حجز صالونات الحلاقة'],
  ['payments', 'الدفع'],
  ['cancelOrder', 'إلغاء الطلبات'],
  ['selling', 'البيع'],
  ['createService', 'إنشاء الخدمات'],
  ['editService', 'تعديل الخدمات'],
  ['serviceStatus', 'إيقاف/تفعيل الخدمات'],
  ['portfolio', 'معرض الأعمال'],
  ['orderActions', 'إدارة وتنفيذ الطلبات'],
  ['chat', 'المحادثات'],
  ['orderChat', 'محادثات الطلبات'],
  ['customOffers', 'العروض المخصصة'],
  ['reviews', 'التقييمات'],
  ['files', 'الملفات'],
  ['wallet', 'المحفظة'],
  ['paymentProfile', 'بيانات الدفع'],
  ['withdraw', 'السحب'],
  ['affiliate', 'Affiliate'],
  ['community', 'المجتمع'],
  ['support', 'الدعم'],
  ['disputes', 'النزاعات'],
  ['favorites', 'المفضلة'],
  ['favoriteGroups', 'مجموعات المفضلة'],
  ['follow', 'متابعة البائعين'],
  ['serviceRequests', 'طلبات الخدمات'],
  ['notifications', 'الإشعارات'],
  ['profileEdit', 'تعديل الملف الشخصي'],
  ['verification', 'التوثيق']
];

function dateText(value) {
  if (!value) return '-';
  try {
    const date = value?.toDate ? value.toDate() : new Date(value);
    return date.toLocaleString('ar-EG');
  } catch {
    return '-';
  }
}


function openUserDetailsModal() {
  let modal = document.getElementById('adminUserDetailsModal');
  if (!modal) return null;
  modal.hidden = false;
  document.body.classList.add('admin-modal-open');
  return modal;
}

function closeUserDetailsModal() {
  const modal = document.getElementById('adminUserDetailsModal');
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove('admin-modal-open');
}

function prettyJson(value) {
  try {
    return esc(JSON.stringify(value ?? {}, null, 2));
  } catch {
    return esc(String(value ?? ''));
  }
}

function renderUserDetailSection(title, items) {
  const safeItems = Array.isArray(items) ? items : [];
  return `
    <details class="user-detail-block" open>
      <summary><strong>${esc(title)}</strong><span class="user-detail-count">${safeItems.length}</span></summary>
      ${safeItems.length
        ? safeItems.map(item => `<pre class="user-detail-json">${prettyJson(item)}</pre>`).join('')
        : '<div class="empty">لا توجد بيانات.</div>'}
    </details>
  `;
}

function renderUserControls(controls = {}) {
  const disabled = new Set(Array.isArray(controls.disabledFeatures) ? controls.disabledFeatures : []);
  return `
    <section class="user-controls-panel" data-user-controls>
      <div class="user-controls-head">
        <div>
          <h3>التحكم في الحساب</h3>
          <p class="muted">اقفل أو افتح أي ميزة لهذا الحساب فقط.</p>
        </div>
      </div>
      <div class="user-controls-grid">
        ${USER_CONTROL_PERMISSIONS.map(([id, label]) => `
          <label class="user-control-row">
            <span>${esc(label)}</span>
            <select class="user-control-select" data-permission="${esc(id)}">
              <option value="on" ${disabled.has(id) ? '' : 'selected'}>مفتوح</option>
              <option value="off" ${disabled.has(id) ? 'selected' : ''}>مغلق</option>
            </select>
          </label>
        `).join('')}
      </div>
      <label class="user-controls-reason">
        <span>سبب التقييد</span>
        <textarea data-controls-reason maxlength="500" placeholder="سبب إيقاف بعض الميزات...">${esc(controls.reason || '')}</textarea>
      </label>
      <div class="user-controls-actions">
        <button class="btn" type="button" data-save-user-controls>حفظ الصلاحيات</button>
        <span class="muted" data-controls-status></span>
      </div>
    </section>
  `;
}

async function saveUserControls(userId, root) {
  const button = root.querySelector('[data-save-user-controls]');
  const status = root.querySelector('[data-controls-status]');
  const reason = root.querySelector('[data-controls-reason]')?.value?.trim() || '';
  const disabledFeatures = [...root.querySelectorAll('.user-control-select')]
    .filter(select => select.value === 'off')
    .map(select => select.dataset.permission)
    .filter(Boolean);

  button.disabled = true;
  status.textContent = 'جاري الحفظ...';

  try {
    const token = await getIdToken(auth.currentUser, true);
    const response = await fetch(`${API_BASE}/api/admin/users/controls`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ userId, disabledFeatures, reason })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'تعذر حفظ الصلاحيات');
    status.textContent = 'تم حفظ الصلاحيات.';
  } catch (error) {
    console.error('ADMIN USER CONTROLS ERROR:', error);
    status.textContent = `فشل الحفظ: ${error.message || error}`;
  } finally {
    button.disabled = false;
  }
}

async function loadUserDetails(userId) {
  const modal = openUserDetailsModal();
  const body = document.getElementById('adminUserDetailsBody');
  const title = document.getElementById('adminUserDetailsTitle');
  if (!modal || !body) return;

  title.textContent = 'تفاصيل الحساب';
  body.innerHTML = '<div class="user-detail-loading">جاري تحميل كل بيانات الحساب...</div>';

  try {
    const token = await getIdToken(auth.currentUser, true);
    const response = await fetch(`${API_BASE}/api/admin/users/${encodeURIComponent(userId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'تعذر تحميل تفاصيل الحساب');

    const authData = data.auth || {};
    const direct = data.direct || {};
    const activity = data.activity || {};
    const counts = data.counts || {};

    title.textContent = `تفاصيل الحساب — ${authData.displayName || authData.email || data.userId}`;

    const stats = Object.entries(counts)
      .filter(([key]) => key !== 'auth')
      .map(([key, value]) => `<div class="user-stat"><span>${esc(key)}</span><strong>${money(value)}</strong></div>`)
      .join('');

    const directSections = [
      ['users', direct.users],
      ['sellerProfiles', direct.sellerProfiles],
      ['sellerPaymentProfiles', direct.sellerPaymentProfiles],
      ['wallets', direct.wallets],
      ['affiliateProfiles', direct.affiliateProfiles],
      ['verificationRequests', direct.verificationRequests]
    ].map(([name, items]) => renderUserDetailSection(name, items)).join('');

    const activitySections = [
      ['services', activity.services],
      ['orders', activity.orders],
      ['customOffers', activity.customOffers],
      ['reviews', activity.reviews],
      ['disputes', activity.disputes],
      ['serviceRequests', activity.serviceRequests],
      ['withdrawals', activity.withdrawals],
      ['transactions', activity.transactions],
      ['notifications', activity.notifications],
      ['supportTickets', activity.supportTickets],
      ['affiliateReferrals', activity.affiliateReferrals],
      ['conversations', activity.conversations],
      ['files', activity.files],
      ['portfolio', activity.portfolio],
      ['favoriteServices', activity.favoriteServices]
    ].map(([name, items]) => renderUserDetailSection(name, items)).join('');

    body.innerHTML = `
      <div class="user-detail-hero">
        <div>
          <h3>${esc(authData.displayName || 'بدون اسم')}</h3>
          <div class="muted">${esc(authData.email || '-')}</div>
          <div class="muted">UID: ${esc(authData.uid || data.userId)}</div>
        </div>
        <div class="user-detail-badges">
          <span class="badge">${authData.disabled ? 'محظور' : 'نشط'}</span>
          <span class="badge">${authData.emailVerified ? 'البريد متحقق' : 'البريد غير متحقق'}</span>
        </div>
      </div>

      <div class="user-detail-grid">
        <div><strong>الهاتف:</strong> ${esc(authData.phoneNumber || '-')}</div>
        <div><strong>تاريخ الإنشاء:</strong> ${esc(dateText(authData.creationTime))}</div>
        <div><strong>آخر دخول:</strong> ${esc(dateText(authData.lastSignInTime))}</div>
        <div><strong>آخر تحديث جلسة:</strong> ${esc(dateText(authData.lastRefreshTime))}</div>
        <div><strong>الصلاحيات:</strong> ${esc(JSON.stringify(authData.customClaims || {}))}</div>
        <div><strong>مزود الدخول:</strong> ${esc((authData.providerData || []).map(x => x.providerId || '-').join(', ') || '-')}</div>
      </div>

      <h3 class="user-detail-heading">ملخص النشاط</h3>
      <div class="user-stats">${stats || '<div class="empty">لا توجد إحصاءات.</div>'}</div>

      ${renderUserControls(data.controls || {})}

      <h3 class="user-detail-heading">بيانات الحساب المباشرة</h3>
      ${directSections}

      <h3 class="user-detail-heading">كل نشاط الحساب</h3>
      ${activitySections}

      <details class="user-detail-block">
        <summary><strong>بيانات Authentication الخام</strong></summary>
        <pre class="user-detail-json">${prettyJson(authData)}</pre>
      </details>
    `;

    body.querySelector('[data-save-user-controls]')?.addEventListener('click', () => {
      const controlsRoot = body.querySelector('[data-user-controls]');
      if (controlsRoot) saveUserControls(data.userId, controlsRoot);
    });
  } catch (error) {
    console.error('ADMIN USER DETAIL ERROR:', error);
    body.innerHTML = `<div class="empty">تعذر تحميل تفاصيل الحساب.<br>${esc(error.message || error)}</div>`;
  }
}

function showSection(section) {
  document.querySelectorAll('.admin-section').forEach(item => {
    item.hidden = item.id !== `admin-${section}`;
  });

  document.querySelectorAll('.admin-tab').forEach(button => {
    button.classList.toggle('active', button.dataset.section === section);
  });
}

async function loadPendingServices() {
  list.innerHTML = '<p class="muted">جاري تحميل الخدمات...</p>';

  try {
    const snapshot = await getDocs(
      query(
        collection(db, 'services'),
        where('status', '==', 'pending'),
        orderBy('createdAt', 'desc')
      )
    );

    const services = snapshot.docs.map(item => ({
      id: item.id,
      ...item.data()
    }));

    if (!services.length) {
      list.innerHTML = `
        <div class="empty">
          <strong>لا توجد خدمات قيد المراجعة.</strong>
          <p>كل الخدمات الحالية تمت مراجعتها.</p>
        </div>
      `;
      return;
    }

    list.innerHTML = services.map(service => `
      <article class="card admin-item" data-service-id="${esc(service.id)}" style="padding:20px;margin-bottom:16px">
        <div>
          <span class="badge">قيد المراجعة</span>
          <h3>${esc(service.name || 'بدون اسم')}</h3>

          <p>${esc(service.description || '')}</p>

          <p>
            <strong>القسم:</strong> ${esc(service.category || '-')}
            <br>
            <strong>السعر:</strong> ${money(service.price)} ج.م
            <br>
            <strong>مدة التسليم:</strong> ${esc(service.deliveryDays || '-')} يوم
            <br>
            <strong>البائع:</strong> ${esc(service.ownerEmail || service.ownerId || '-')}
            <br>
            <strong>تاريخ الإرسال:</strong> ${dateText(service.createdAt)}
          </p>

          ${
            service.imageUrl
              ? `<p><a href="${esc(service.imageUrl)}" target="_blank" rel="noopener">عرض صورة الخدمة</a></p>`
              : ''
          }
        </div>

        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:15px">
          <button class="btn small approve-service" type="button" data-id="${esc(service.id)}">
            ✓ اعتماد الخدمة
          </button>

          <button class="btn small secondary reject-service" type="button" data-id="${esc(service.id)}">
            رفض الخدمة
          </button>
        </div>
      </article>
    `).join('');

    list.querySelectorAll('.approve-service').forEach(button => {
      button.addEventListener('click', () =>
        moderateService(button.dataset.id, 'approved', button)
      );
    });

    list.querySelectorAll('.reject-service').forEach(button => {
      button.addEventListener('click', () =>
        moderateService(button.dataset.id, 'rejected', button)
      );
    });
  } catch (error) {
    console.error('ADMIN SERVICES ERROR:', error);
    list.innerHTML = `
      <div class="empty">
        <strong>تعذر تحميل الخدمات.</strong>
        <p>${esc(error?.message || 'تحقق من صلاحيات الأدمن والقواعد.')}</p>
      </div>
    `;
  }
}


async function loadDisputes() {
  if (!disputesList) return;
  disputesList.innerHTML = '<p class="muted">جاري تحميل النزاعات...</p>';

  try {
    const [openSnap, reviewSnap] = await Promise.all([
      getDocs(query(collection(db, 'disputes'), where('status', '==', 'open'), orderBy('createdAt', 'desc'))),
      getDocs(query(collection(db, 'disputes'), where('status', '==', 'in_review'), orderBy('createdAt', 'desc')))
    ]);

    const map = new Map();
    [...openSnap.docs, ...reviewSnap.docs].forEach(d => map.set(d.id, { id: d.id, ...d.data() }));
    const items = [...map.values()].sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));

    if (!items.length) {
      disputesList.innerHTML = '<div class="empty">لا توجد نزاعات مفتوحة.</div>';
      return;
    }

    disputesList.innerHTML = items.map(item => `
      <article class="card admin-item" style="padding:20px;margin-bottom:16px">
        <div>
          <span class="badge">${esc(item.status || '-')}</span>
          <h3>${esc(item.reason || 'نزاع')}</h3>
          <p>
            <strong>الطلب:</strong> ${esc(item.orderId || '-')}<br>
            <strong>المشتري:</strong> ${esc(item.buyerId || '-')}<br>
            <strong>البائع:</strong> ${esc(item.sellerId || '-')}<br>
            <strong>السبب:</strong> ${esc(item.reason || '-')}<br>
            <strong>الوصف:</strong> ${esc(item.description || '-')}
          </p>
          ${item.evidence ? `<div class="notice"><strong>الأدلة:</strong><br>${esc(item.evidence)}</div>` : ''}
          ${item.resolution ? `<div class="support-reply"><strong>القرار الحالي:</strong><br>${esc(item.resolution)}</div>` : ''}
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:15px">
          <button class="btn small dispute-action" data-id="${esc(item.id)}" data-status="in_review">قيد المراجعة</button>
          <button class="btn small dispute-action" data-id="${esc(item.id)}" data-status="resolved_buyer">حل لصالح المشتري</button>
          <button class="btn small dispute-action" data-id="${esc(item.id)}" data-status="resolved_seller">حل لصالح البائع</button>
          <button class="btn small secondary dispute-action" data-id="${esc(item.id)}" data-status="closed">إغلاق</button>
        </div>
      </article>
    `).join('');

    disputesList.querySelectorAll('.dispute-action').forEach(button => {
      button.addEventListener('click', () => processDispute(button.dataset.id, button.dataset.status, button));
    });
  } catch (error) {
    console.error('ADMIN DISPUTES ERROR:', error);
    disputesList.innerHTML = `<div class="empty"><strong>تعذر تحميل النزاعات.</strong><p>${esc(error?.message || 'تحقق من الصلاحيات والفهارس.')}</p></div>`;
  }
}

async function processDispute(disputeId, status, button) {
  let resolution = '';
  if (['resolved_buyer', 'resolved_seller', 'closed'].includes(status)) {
    resolution = prompt('اكتب ملخص القرار/سبب الإغلاق:', '') ?? '';
    if (!resolution.trim()) {
      alert('اكتب ملخص القرار أولًا.');
      return;
    }
  }

  button.disabled = true;
  try {
    await updateDoc(doc(db, 'disputes', disputeId), {
      status,
      resolution,
      assignedTo: auth.currentUser?.uid || '',
      updatedAt: serverTimestamp()
    });
    await loadDisputes();
  } catch (error) {
    console.error('ADMIN DISPUTE UPDATE ERROR:', error);
    alert('تعذر تحديث النزاع: ' + (error?.message || error));
    button.disabled = false;
  }
}



async function loadPendingBarberShops() {
  if (!barberShopList) return;
  barberShopList.innerHTML = '<p class="muted">جاري تحميل طلبات الصالونات...</p>';
  try {
    const token = await getIdToken(auth.currentUser, true);
    const response = await fetch(`${API_BASE}/api/admin/barbershops/pending`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'تعذر تحميل طلبات الصالونات');
    const shops = Array.isArray(data.shops) ? data.shops : [];
    barberShopList.innerHTML = shops.length ? shops.map(shop => `
      <article class="card admin-item" style="padding:20px;margin-bottom:16px" data-barber-shop-id="${esc(shop.id)}">
        <span class="badge">قيد المراجعة</span>
        <h3>${esc(shop.name || 'صالون بدون اسم')}</h3>
        <p><strong>المدينة:</strong> ${esc(shop.city || '-')}<br>
          <strong>العنوان:</strong> ${esc(shop.address || '-')}<br>
          <strong>الهاتف:</strong> ${esc(shop.phone || '-')}<br>
          <strong>الوصف:</strong> ${esc(shop.description || '-')}<br>
          <strong>صاحب الطلب UID:</strong> <code>${esc(shop.ownerId || '-')}</code><br>
          <strong>وقت التقديم:</strong> ${esc(dateText(shop.createdAt))}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn small" type="button" data-review-barber-shop="approve" data-id="${esc(shop.id)}">اعتماد الصالون</button>
          <button class="btn small secondary" type="button" data-review-barber-shop="reject" data-id="${esc(shop.id)}">رفض الطلب</button>
        </div>
      </article>
    `).join('') : '<div class="empty"><strong>لا توجد طلبات صالونات معلّقة.</strong><p>ستظهر الطلبات الجديدة هنا قبل نشرها للعملاء.</p></div>';

    barberShopList.querySelectorAll('[data-review-barber-shop]').forEach(button => {
      button.addEventListener('click', () => reviewBarberShop(button));
    });
  } catch (error) {
    console.error('ADMIN BARBER SHOPS ERROR:', error);
    barberShopList.innerHTML = `<div class="empty">تعذر تحميل طلبات الصالونات.<br>${esc(error.message || error)}</div>`;
  }
}

async function reviewBarberShop(button) {
  const shopId = button.dataset.id;
  const action = button.dataset.reviewBarberShop;
  let note = '';
  if (action === 'reject') {
    note = (prompt('اكتب سبب رفض الطلب ليتمكن صاحب الصالون من معرفة المطلوب:', '') || '').trim();
    if (note.length < 5) {
      alert('اكتب سببًا واضحًا لا يقل عن 5 أحرف.');
      return;
    }
  } else if (!window.confirm('اعتماد هذا الصالون سيجعله ظاهرًا للعملاء وقابلًا لاستقبال الحجوزات. هل تريد المتابعة؟')) {
    return;
  }

  button.disabled = true;
  try {
    const token = await getIdToken(auth.currentUser, true);
    const response = await fetch(`${API_BASE}/api/admin/barbershops/${encodeURIComponent(shopId)}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, note })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'تعذرت مراجعة طلب الصالون');
    alert(action === 'approve' ? 'تم اعتماد الصالون وأصبح مؤهلًا للظهور للعملاء.' : 'تم رفض الطلب وحفظ سبب الرفض.');
    await loadPendingBarberShops();
  } catch (error) {
    alert(`تعذر مراجعة الطلب: ${error.message || error}`);
    button.disabled = false;
  }
}

async function loadPlatformFees() {
  if (!platformFeesList) return;
  platformFeesList.innerHTML = '<p class="muted">جاري تحميل العمولات...</p>';
  try {
    const token = await getIdToken(auth.currentUser, true);
    const response = await fetch(`${API_BASE}/api/admin/platform-fees`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'تعذر تحميل العمولات');
    const items = Array.isArray(data.items) ? data.items : [];
    platformFeesList.innerHTML = items.length
      ? items.map(item => `
        <article class="card admin-item" style="padding:20px;margin-bottom:16px">
          <div>
            <span class="badge">مستحقة</span>
            <h3>${money(item.platformFeeDue)} ج.م</h3>
            <p><strong>البائع:</strong> ${esc(item.name || item.email || item.sellerId)}<br><strong>UID:</strong> ${esc(item.sellerId)}<br><strong>المبلغ المستحق:</strong> ${money(item.platformFeeDue)} ج.م</p>
          </div>
          <button class="btn small settle-platform-fee" data-id="${esc(item.sellerId)}" data-due="${esc(item.platformFeeDue)}">تسجيل سداد</button>
        </article>
      `).join('')
      : '<div class="empty">لا توجد عمولات مستحقة.</div>';

    platformFeesList.querySelectorAll('.settle-platform-fee').forEach(button => {
      button.addEventListener('click', () => settlePlatformFee(button));
    });
  } catch (error) {
    console.error('ADMIN PLATFORM FEES ERROR:', error);
    platformFeesList.innerHTML = `<div class="empty">تعذر تحميل العمولات.<br>${esc(error.message || error)}</div>`;
  }
}

async function settlePlatformFee(button) {
  const sellerId = button.dataset.id;
  const due = Number(button.dataset.due || 0);
  const amountText = prompt(`المبلغ المسدد (المستحق ${money(due)} ج.م):`, String(due));
  if (amountText === null) return;
  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount <= 0 || amount > due) {
    alert('المبلغ غير صالح.');
    return;
  }
  const reference = prompt('مرجع التحويل/الإيصال:', '') || '';
  if (reference.trim().length < 4) {
    alert('أدخل مرجعًا صحيحًا.');
    return;
  }
  button.disabled = true;
  try {
    const token = await getIdToken(auth.currentUser, true);
    const response = await fetch(`${API_BASE}/api/admin/platform-fees/mark-paid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sellerId, amount, reference: reference.trim() })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'تعذر تسجيل السداد');
    await loadPlatformFees();
  } catch (error) {
    alert('تعذر تسجيل السداد: ' + (error.message || error));
    button.disabled = false;
  }
}
async function loadWithdrawals() {
  if (!withdrawalList) return;
  withdrawalList.innerHTML = '<p class="muted">جاري تحميل طلبات السحب...</p>';

  try {
    const [requestedSnap, approvedSnap] = await Promise.all([
      getDocs(query(collection(db, 'withdrawals'), where('status', '==', 'requested'), orderBy('createdAt', 'desc'))),
      getDocs(query(collection(db, 'withdrawals'), where('status', '==', 'approved'), orderBy('createdAt', 'desc')))
    ]);

    const items = [...requestedSnap.docs, ...approvedSnap.docs]
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const at = a.createdAt?.toMillis?.() || 0;
        const bt = b.createdAt?.toMillis?.() || 0;
        return bt - at;
      });

    if (!items.length) {
      withdrawalList.innerHTML = '<div class="empty">لا توجد طلبات سحب معلقة.</div>';
      return;
    }

    withdrawalList.innerHTML = items.map(item => `
      <article class="card admin-item" style="padding:20px;margin-bottom:16px">
        <div>
          <span class="badge">${esc(item.status || '-')}</span>
          <h3>${money(item.amount)} ج.م</h3>
          <p>
            <strong>البائع:</strong> ${esc(item.sellerId || '-')}<br>
            <strong>الطريقة:</strong> ${esc(item.method || '-')}<br>
            <strong>الحساب:</strong> ${esc(item.account || '-')}<br>
            <strong>التاريخ:</strong> ${dateText(item.createdAt)}
          </p>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:15px">
          ${item.status === 'requested' ? `<button class="btn small approve-withdrawal" data-id="${esc(item.id)}" data-action="approve">موافقة</button>` : ''}
          ${item.status === 'approved' ? `<button class="btn small approve-withdrawal" data-id="${esc(item.id)}" data-action="mark_paid">تسجيل الدفع</button>` : ''}
          <button class="btn small secondary approve-withdrawal" data-id="${esc(item.id)}" data-action="reject">رفض وإرجاع الرصيد</button>
        </div>
      </article>
    `).join('');

    withdrawalList.querySelectorAll('.approve-withdrawal').forEach(button => {
      button.addEventListener('click', () => processWithdrawal(button.dataset.id, button.dataset.action, button));
    });
  } catch (error) {
    console.error('ADMIN WITHDRAWALS ERROR:', error);
    withdrawalList.innerHTML = `<div class="empty"><strong>تعذر تحميل السحوبات.</strong><p>${esc(error?.message || 'تحقق من الصلاحيات والفهارس.')}</p></div>`;
  }
}

async function processWithdrawal(withdrawalId, action, button) {
  const label = action === 'approve'
    ? 'الموافقة على طلب السحب؟'
    : action === 'mark_paid'
      ? 'تسجيل أن السحب تم دفعه؟'
      : 'رفض السحب وإرجاع المبلغ إلى رصيد البائع؟';

  if (!confirm(label)) return;
  button.disabled = true;

  try {
    const token = await getIdToken(auth.currentUser, true);
    const response = await fetch(`${API_BASE}/api/admin/withdrawals/process`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ withdrawalId, action })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'تعذر تنفيذ العملية');
    await loadWithdrawals();
  } catch (error) {
    console.error('ADMIN WITHDRAWAL ACTION ERROR:', error);
    alert(error.message || 'تعذر تنفيذ العملية');
    button.disabled = false;
  }
}

async function moderateService(serviceId, status, button) {
  const label = status === 'approved'
    ? 'اعتماد هذه الخدمة؟'
    : 'رفض هذه الخدمة؟';

  if (!confirm(label)) return;

  button.disabled = true;

  try {
    await updateDoc(doc(db, 'services', serviceId), {
      status,
      updatedAt: serverTimestamp()
    });

    await loadPendingServices();
  } catch (error) {
    console.error('ADMIN MODERATION ERROR:', error);
    alert(
      status === 'approved'
        ? 'تعذر اعتماد الخدمة. تأكد أن الحساب Admin وأن الخدمة ما زالت قيد المراجعة.'
        : 'تعذر رفض الخدمة. تأكد من صلاحيات الحساب.'
    );
    button.disabled = false;
  }
}


async function loadUsers() {
  if (!usersList) return;

  usersList.innerHTML = '<p class="muted">جاري تحميل المستخدمين...</p>';

  try {
    const token = await getIdToken(auth.currentUser, true);
    const response = await fetch(`${API_BASE}/api/admin/users`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || 'تعذر تحميل المستخدمين');
    }

    const items = Array.isArray(data.users) ? data.users : [];

    usersList.innerHTML = `
      <div class="card" style="padding:12px;margin-bottom:12px">
        <strong>إجمالي حسابات Firebase: ${items.length}</strong>
      </div>
      ${
        items.length
          ? items.map(item => `
            <article class="card admin-user-card" style="padding:16px;margin-bottom:10px;cursor:pointer" data-user-id="${esc(item.uid)}" title="اضغط لعرض كل تفاصيل الحساب">
              <div style="display:flex;justify-content:space-between;gap:12px;align-items:center">
                <div>
                  <strong>${esc(item.displayName || 'بدون اسم')}</strong>
                  <div class="muted">${esc(item.email || item.uid)}</div>
                  <div class="muted">الحالة: ${item.disabled ? 'محظور' : 'نشط'}</div>
                  <div class="muted">التحقق: ${item.emailVerified ? 'تم التحقق' : 'غير متحقق'}</div>
                </div>
                <div>
                  ${
                    item.disabled
                      ? `<button class="btn small user-status" data-id="${esc(item.uid)}" data-status="active">تفعيل</button>`
                      : `<button class="btn small secondary user-status" data-id="${esc(item.uid)}" data-status="blocked">حظر</button>`
                  }
                </div>
              </div>
            </article>
          `).join('')
          : '<div class="empty">لا توجد حسابات Firebase Authentication.</div>'
      }
    `;

    usersList.querySelectorAll('.admin-user-card').forEach(card => {
      card.addEventListener('click', event => {
        if (event.target.closest('.user-status')) return;
        loadUserDetails(card.dataset.userId);
      });
    });

    usersList.querySelectorAll('.user-status').forEach(btn => {
      btn.onclick = async () => {
        if (!confirm(btn.dataset.status === 'blocked' ? 'تعطيل تسجيل الدخول لهذا الحساب؟' : 'إعادة تفعيل تسجيل الدخول لهذا الحساب؟')) return;

        btn.disabled = true;

        try {
          const token = await getIdToken(auth.currentUser, true);
          const response = await fetch(`${API_BASE}/api/admin/users/status`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
              userId: btn.dataset.id,
              status: btn.dataset.status
            })
          });

          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || 'تعذر تحديث حالة المستخدم');

          await loadUsers();
        } catch (e) {
          alert('تعذر تحديث حالة المستخدم: ' + (e.message || e));
          btn.disabled = false;
        }
      };
    });
  } catch (error) {
    console.error('ADMIN USERS ERROR:', error);
    usersList.innerHTML = `<div class="empty">تعذر تحميل المستخدمين.<br>${esc(error.message || error)}</div>`;
  }
}

async function loadOrdersAdmin() {
  if (!ordersList) return;
  ordersList.innerHTML = '<p class="muted">جاري تحميل الطلبات...</p>';
  try { const snap=await getDocs(query(collection(db,'orders'),orderBy('createdAt','desc'))); const items=snap.docs.map(d=>({id:d.id,...d.data()})).slice(0,200); ordersList.innerHTML=items.length?items.map(o=>`<article class="card" style="padding:16px;margin-bottom:10px"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><div><strong>${esc(o.serviceName||'طلب')}</strong><div class="muted">${esc(o.userId||'-')} ← ${esc(o.sellerId||'-')}</div><div class="muted">${money(o.totalPrice??o.price)} ج.م · ${esc(o.status||'-')} · الدفع: ${esc(o.paymentStatus||'-')}</div></div><a class="btn small" href="/orders?order=${encodeURIComponent(o.id)}">فتح</a></div></article>`).join(''):'<div class="empty">لا توجد طلبات.</div>'; }
  catch(error){ console.error('ADMIN ORDERS ERROR:',error); ordersList.innerHTML=`<div class="empty">تعذر تحميل الطلبات.<br>${esc(error.message||error)}</div>`; }
}

async function loadOffersAdmin() {
  if (!offersList) return;
  offersList.innerHTML='<p class="muted">جاري تحميل العروض...</p>';
  try { const snap=await getDocs(query(collection(db,'customOffers'),orderBy('createdAt','desc'))); const items=snap.docs.map(d=>({id:d.id,...d.data()})).slice(0,200); offersList.innerHTML=items.length?items.map(o=>`<article class="card" style="padding:16px;margin-bottom:10px"><strong>${esc(o.title||o.serviceName||'عرض')}</strong><div class="muted">${esc(o.sellerId||'-')} → ${esc(o.buyerId||'-')}</div><div>${money(o.price)} ج.م · ${esc(o.deliveryDays)} يوم · ${esc(o.status||'-')}</div><div class="muted">${esc(o.description||'')}</div></article>`).join(''):'<div class="empty">لا توجد عروض.</div>'; }
  catch(error){ console.error('ADMIN OFFERS ERROR:',error); offersList.innerHTML=`<div class="empty">تعذر تحميل العروض.<br>${esc(error.message||error)}</div>`; }
}

async function init(user) {
  if (!user) {
    location.href = `/login?redirect=${encodeURIComponent('/admin')}`;
    return;
  }

  statusBox.textContent = 'جاري التحقق من صلاحيات الأدمن...';

  try {
    const tokenResult = await getIdTokenResult(user, true);

    if (tokenResult.claims.admin !== true) {
      statusBox.textContent = 'هذا الحساب ليس لديه صلاحية Admin.';
      return;
    }

    panel.hidden = false;
    statusBox.textContent = `مرحبًا ${user.email || ''} — لوحة الإدارة جاهزة.`;

    try {
      await loadPendingServices();
      await loadPendingBarberShops();
      await loadWithdrawals();
      await loadPlatformFees();
      await loadDisputes();
      await loadUsers();
      await loadOrdersAdmin();
      await loadOffersAdmin();
    } catch (error) {
      console.error('ADMIN LOAD SERVICES ERROR:', error);
      statusBox.textContent = `تم التحقق من الأدمن، لكن تعذر تحميل الخدمات: ${error.message || error}`;
    }
  } catch (error) {
    console.error('ADMIN AUTH ERROR:', error);
    statusBox.textContent = `تعذر التحقق من صلاحيات الأدمن: ${error.message || error}`;
  }
}

document.querySelectorAll('.admin-tab').forEach(button => {
  button.addEventListener('click', () => showSection(button.dataset.section));
});

document.getElementById('refreshServices')?.addEventListener(
  'click',
  loadPendingServices
);

document.getElementById('refreshBarberShops')?.addEventListener('click', loadPendingBarberShops);

document.getElementById('refreshWithdrawals')?.addEventListener(
  'click',
  loadWithdrawals
);

document.getElementById('refreshPlatformFees')?.addEventListener('click', loadPlatformFees);

onAuthStateChanged(auth, init);


document.getElementById('refreshDisputes')?.addEventListener('click', loadDisputes);


document.getElementById('refreshUsers')?.addEventListener('click', loadUsers);
document.getElementById('refreshOrders')?.addEventListener('click', loadOrdersAdmin);
document.getElementById('refreshOffers')?.addEventListener('click', loadOffersAdmin);
