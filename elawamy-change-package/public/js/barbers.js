import { auth, onAuthStateChanged } from './firebase.js';
import { createBarberWhatsAppReminderUrl } from './barber-whatsapp.js';
import { summarizeBarberFinance } from './barber-finance.js';

const API_BASE = (() => {
  const localHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const localPort = ['5000', '5001'].includes(window.location.port);
  return localHost && localPort
    ? 'http://127.0.0.1:3000'
    : 'https://elawamy-file-server.vercel.app';
})();
const $ = id => document.getElementById(id);
let currentUser = null;
let publicShops = [];
let ownedShops = [];
let selectedShop = null;
let selectedDetails = null;
let selectedTime = '';
let paymentOnlineAvailable = false;
let managedShopData = null;
let managedDailyBookings = [];
let filteredManagedBookings = [];
let financeReportBookings = [];
let financeReportWasTruncated = false;

function parseClosedDatesText(value) {
  return [...new Set(String(value || '').split(/[\s,،;；]+/).map(item => item.trim()).filter(Boolean))];
}
function esc(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function money(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toLocaleString('ar-EG', { maximumFractionDigits: 2 }) : '0';
}
function barberRatingLabel(barber) {
  const rating = Number(barber?.rating || 0);
  const count = Number(barber?.ratingCount || 0);
  return count > 0 ? `★ ${rating.toFixed(1)} (${count} تقييم)` : 'لا توجد تقييمات بعد';
}
function canRateBooking(booking) {
  if (booking.viewerRole !== 'customer' || booking.status !== 'confirmed' || booking.attendanceStatus === 'no_show' || booking.ratingSubmitted) return false;
  const today = cairoToday();
  if (String(booking.localDate || '') < today) return true;
  if (String(booking.localDate || '') > today) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const nowMinute = Number(values.hour) * 60 + Number(values.minute);
  const rawEnd = booking.endMinute ?? booking.endTime;
  const end = typeof rawEnd === 'number' ? rawEnd : (typeof rawEnd === 'string' && /^\d{2}:\d{2}$/.test(rawEnd) ? Number(rawEnd.slice(0, 2)) * 60 + Number(rawEnd.slice(3, 5)) : NaN);
  return Number.isFinite(end) && end <= nowMinute;
}
function showNotice(message, type = 'info') {
  const notice = $('barberNotice');
  notice.textContent = message;
  notice.className = `barber-notice${type === 'error' ? ' error' : type === 'warn' ? ' warn' : ''}`;
  notice.hidden = !message;
  if (message) notice.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function errorMessage(value) {
  const messages = {
    'BARBER_SLOT_UNAVAILABLE': 'الموعد اتحجز للتو. اختار وقتًا آخر.',
    'BARBER_SHOP_NOT_FOUND': 'الصالون غير متاح حاليًا.',
    'BARBER_SERVICE_NOT_FOUND': 'الخدمة دي لم تعد متاحة.',
    'BARBER_NOT_FOUND': 'الحلاق ده لم يعد متاحًا.',
    'BARBER_PROFILE_ALREADY_LINKED': 'ملف الحلاق مرتبط بحساب بالفعل.',
    'BARBER_ACCOUNT_ALREADY_LINKED': 'حسابك مرتبط بملف حلاق بالفعل.',
    'BARBER_IMAGE_NOT_FOUND': 'الصورة لم تصل للتخزين. ارفع الصورة مرة ثانية.',
    'BARBER_IMAGE_INVALID': 'الصورة غير صالحة أو حجمها أكبر من 8 ميجابايت.',
    'BARBER_SHOP_CLOSED': 'الصالون إجازة في اليوم المختار.',
    'BARBER_DATE_CLOSED': 'الحلاق إجازة في التاريخ المختار. اختار يومًا آخر.',
    'BARBER_TIME_OUTSIDE_HOURS': 'الوقت المختار خارج مواعيد العمل.',
    'BOOKING_DATE_IN_PAST': 'لا يمكن الحجز في وقت مضى.',
    'BOOKING_DATE_TOO_FAR': 'الحجز متاح خلال الـ90 يومًا القادمة فقط.',
    'INVALID_BOOKING_DATE': 'تاريخ الحجز غير صحيح.',
    'ONLINE_PAYMENT_NOT_CONFIGURED': 'الدفع أونلاين غير مفعّل حاليًا. اختار الدفع في الصالون.',
    'BARBER_BOOKING_PAYMENT_HOLD_EXPIRED': 'انتهت مهلة الدفع. احجز موعدًا جديدًا.',
    'BARBER_BOOKING_ALREADY_PAID': 'الحجز مدفوع بالفعل؛ لا يمكن إلغاؤه من هنا.',
    'BARBER_BOOKING_COOLDOWN': 'لا يمكنك حجز موعد آخر قبل مرور 7 أيام على آخر حجز لك.',
    'BARBER_BOOKING_NOT_FOUND': 'الحجز غير موجود.',
    'BARBER_ATTENDANCE_ALREADY_SET': 'تم تسجيل حالة الحضور لهذا الحجز بالفعل.',
    'BARBER_ATTENDANCE_TOO_EARLY': 'يمكن تسجيل الحضور بعد انتهاء الموعد فقط.',
    'BARBER_ATTENDANCE_BOOKING_NOT_ACTIVE': 'لا يمكن تغيير الحضور إلا لحجز مؤكد.',
    'INVALID_BARBER_RATING': 'اختار تقييمًا من نجمة إلى خمس نجوم.',
    'BARBER_REVIEW_FORBIDDEN': 'لا يمكنك تقييم حجز ليس تابعًا لحسابك.',
    'BARBER_REVIEW_NOT_COMPLETED': 'لا يمكن تقييم هذا الحجز في حالته الحالية.',
    'BARBER_REVIEW_ALREADY_SUBMITTED': 'أرسلت تقييمك لهذا الحجز من قبل.',
    'BARBER_REVIEW_TOO_EARLY': 'يمكنك تقييم الحلاق بعد انتهاء موعد الحجز.',
    'BARBER_REVIEW_INVALID_BOOKING_TIME': 'تعذر التحقق من وقت انتهاء الحجز.',
    'BARBER_REVIEW_PROFILE_NOT_FOUND': 'ملف الحلاق غير متاح حاليًا.',
    'BARBER_BOOKING_NOT_CANCELLABLE': 'لا يمكن إلغاء الحجز في حالته الحالية.',
    'NOT_BARBER_BOOKING_PARTICIPANT': 'غير مسموح لك بإدارة هذا الحجز.',
    'FEATURE_DISABLED': 'الميزة غير مفعلة لهذا الحساب.',
    'Authentication required': 'سجّل الدخول أولًا.',
    'Missing Firebase Authorization token': 'انتهت جلسة الدخول. سجّل الدخول مرة أخرى.'
  };
  return messages[value] || value || 'حصل خطأ غير متوقع. حاول مرة أخرى.';
}
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (currentUser) headers.Authorization = `Bearer ${await currentUser.getIdToken()}`;
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method || 'GET', headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
  } catch {
    throw new Error('تعذر الاتصال بخادم الحجز. تحقق من الإنترنت وحاول مرة أخرى.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (data.error === 'BARBER_BOOKING_COOLDOWN' && data.nextBookingAllowedAt) {
      const allowedAt = new Date(data.nextBookingAllowedAt).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'short' });
      throw new Error(`لا يمكنك حجز موعد آخر قبل مرور 7 أيام. تقدر تحجز مرة أخرى بعد ${allowedAt}.`);
    }
    throw new Error(errorMessage(data.error || `HTTP_${response.status}`));
  }
  return data;
}
function cairoToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function dayAfterCairoToday(days) {
  const today = cairoToday();
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function isSalonManagementPage() {
  const path = window.location.pathname;
  return path === '/salon' || path === '/salon/' || path === '/salon.html';
}
function setLoginVisibility(user) {
  document.querySelectorAll('[data-guest]').forEach(el => { el.hidden = Boolean(user); });
  document.querySelectorAll('[data-auth]').forEach(el => { el.hidden = !user; });
  $('signInPrompt').hidden = Boolean(user);
  $('bookingSigninHint').hidden = Boolean(user);
  $('ownerPanel').hidden = !user || !isSalonManagementPage();
  $('myBookingsSection').hidden = !user || isSalonManagementPage();
  $('barberUserLabel').textContent = user ? `مرحبًا ${user.displayName || user.email || ''}` : '';
}
function renderShops(shops) {
  const term = $('shopSearch').value.trim().toLocaleLowerCase('ar');
  const matches = shops.filter(shop => `${shop.name} ${shop.city} ${shop.address}`.toLocaleLowerCase('ar').includes(term));
  $('shopsGrid').innerHTML = matches.length ? matches.map(shop => {
    const ownerShop = ownedShops.find(item => item.id === shop.id);
    return `
    <article class="barber-shop-card">
      ${ownerShop ? `<details class="barber-kebab barber-shop-kebab"><summary aria-label="إعدادات ${esc(shop.name)}" title="إعدادات الصالون">⋮</summary><div class="barber-kebab-menu"><button type="button" data-manage-shop="${esc(shop.id)}">إعدادات الصالون</button></div></details>` : ''}
      ${shop.imageUrl ? `<img class="barber-shop-photo" src="${esc(shop.imageUrl)}" alt="صورة صالون ${esc(shop.name)}" loading="lazy">` : ''}
      <span class="barber-eyebrow">صالون حلاقة رجالي</span>
      <h3>${esc(shop.name)}</h3>
      <p>📍 ${esc(shop.city)} · ${esc(shop.address)}</p>
      <p>${esc(shop.description || 'احجز خدمتك والوقت المناسب لك مباشرةً.')}</p>
      <div class="barber-shop-meta"><span class="barber-chip">${esc(shop.openTime)} – ${esc(shop.closeTime)}</span><span class="barber-chip">مواعيد مستقلة لكل حلاق</span></div>
      <p>للتواصل: ${esc(shop.phone || 'من خلال الصالون')}</p>
      <a class="barber-button barber-button-primary" href="/barber-booking?shop=${encodeURIComponent(shop.id)}">اختار واحجز</a>
    </article>`;
  }).join('') : '<div class="barber-empty">مفيش صالونات مطابقة للبحث حاليًا. جرّب مدينة أو اسمًا آخر.</div>';
}
async function loadShops() {
  $('shopsGrid').innerHTML = '<div class="barber-empty">جاري تحميل الصالونات...</div>';
  try {
    const result = await api('/api/barbershops');
    publicShops = result.shops || [];
    renderShops(publicShops);
  } catch (error) {
    $('shopsGrid').innerHTML = `<div class="barber-empty">${esc(error.message)}</div>`;
  }
}
function fillOptions(select, items, placeholder, labelFn) {
  if (!select) return;
  const previous = select.value;
  select.innerHTML = `<option value="">${esc(placeholder)}</option>` + items.map(item => `<option value="${esc(item.id)}">${esc(labelFn(item))}</option>`).join('');
  if (items.some(item => item.id === previous)) select.value = previous;
}
function renderSelectedBarberPreview() {
  const preview = $('bookingBarberPreview');
  if (!preview) return;
  const barber = selectedDetails?.barbers?.find(item => item.id === $('bookingBarber').value);
  if (!barber) { preview.hidden = true; preview.innerHTML = ''; return; }
  preview.innerHTML = `${barber.imageUrl ? `<img class="barber-profile-avatar" src="${esc(barber.imageUrl)}" alt="صورة ${esc(barber.name)}">` : '<div class="barber-profile-avatar barber-profile-avatar-empty" aria-hidden="true">✂</div>'}<div><strong>${esc(barber.name)}</strong><p>${esc(barberRatingLabel(barber))}</p><p>المواعيد المعروضة حسب جدول الحلاق نفسه.</p></div>`;
  preview.hidden = false;
}
function syncOwnedShopOptions() {
  if ($('managedBookingDate') && !$('managedBookingDate').value) $('managedBookingDate').value = cairoToday();
  const statusLabels = { pending: 'قيد مراجعة الإدارة', rejected: 'مرفوض — أنشئ طلبًا جديدًا', active: 'معتمد' };
  const items = ownedShops.map(shop => {
    const status = statusLabels[shop.status] || 'قيد المراجعة';
    const reason = shop.status === 'rejected' && shop.reviewNote ? ` — سبب الرفض: ${shop.reviewNote}` : '';
    return { id: shop.id, name: `${shop.name} — ${shop.city} (${status})${reason}` };
  });
  for (const id of ['serviceShopSelect', 'barberShopSelect', 'scheduleShopSelect', 'photoShopSelect', 'claimShopSelect', 'profileShopSelect', 'managedBarberShopSelect', 'managedServiceShopSelect', 'managedBookingShopSelect']) {
    fillOptions($(id), items, 'اختار صالونك', item => item.name);
  }
  const requestedShopId = isSalonManagementPage() ? new URLSearchParams(window.location.search).get('shop') : '';
  if (requestedShopId && ownedShops.some(shop => shop.id === requestedShopId)) {
    for (const id of ['serviceShopSelect', 'barberShopSelect', 'scheduleShopSelect', 'photoShopSelect', 'claimShopSelect', 'profileShopSelect', 'managedBarberShopSelect', 'managedServiceShopSelect', 'managedBookingShopSelect']) {
      if ($(id)) $(id).value = requestedShopId;
    }
  }
  fillScheduleFields();
  fillShopProfileFields();
  if ($('claimShopSelect').value) loadManagedBarbers();
  const managedId = $('managedBarberShopSelect').value || $('managedServiceShopSelect').value || $('profileShopSelect').value;
  if (managedId) loadShopManagement(managedId);
  if ($('managedBookingShopSelect')?.value) { loadManagedBookings(); loadFinanceReport(); }
  renderShops(publicShops);
}
function fillScheduleFields() {
  const shop = ownedShops.find(item => item.id === $('scheduleShopSelect').value);
  $('scheduleOpenTime').value = shop?.openTime || '';
  $('scheduleCloseTime').value = shop?.closeTime || '';
  $('updateScheduleForm').querySelectorAll('input[name="closedDays"]').forEach(input => {
    input.checked = Boolean(shop && (shop.closedDays || []).includes(Number(input.value)));
  });
}
function fillShopProfileFields() {
  const shop = ownedShops.find(item => item.id === $('profileShopSelect')?.value);
  const form = $('updateShopProfileForm');
  if (!shop || !form) {
    if (form) form.reset();
    $('shopUpdatedMeta').textContent = '';
    return;
  }
  for (const field of ['name', 'phone', 'city', 'address', 'description']) {
    const input = form.elements.namedItem(field);
    if (input) input.value = shop[field] || '';
  }
  $('shopUpdatedMeta').textContent = shop.updatedAt
    ? `آخر تحديث: ${new Date(shop.updatedAt).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' })}${shop.lastUpdatedBy ? ` بواسطة ${shop.lastUpdatedBy}` : ''}`
    : 'لم يُسجّل تحديث سابق لهذا الصالون.';
}

function formatAuditDate(value) {
  if (!value) return 'وقت غير متاح';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'وقت غير متاح' : date.toLocaleString('ar-EG', { timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'short' });
}

function renderShopAudit(entries = []) {
  $('shopAuditList').innerHTML = entries.length ? entries.map(entry => `
    <article class="barber-audit-entry"><strong>${esc(entry.summary || entry.action || 'تعديل')}</strong>
      <span>${esc(entry.actorLabel || 'حساب الصالون')} · ${esc(formatAuditDate(entry.createdAt))}</span>
    </article>`).join('') : '<div class="barber-empty">لا توجد تعديلات مسجلة حتى الآن.</div>';
}

function renderManagedBarbers(barbers = [], shop) {
  const host = $('managedBarbersList');
  if (!barbers.length) { host.innerHTML = '<div class="barber-empty">لا يوجد حلاقون داخل هذا الصالون. أضف حلاقًا من نموذج الإضافة بالأسفل.</div>'; return; }
  host.innerHTML = barbers.map(barber => `
    <article class="barber-employee-card" data-managed-barber-id="${esc(barber.id)}">
      <div class="barber-employee-head">
        ${barber.imageUrl ? `<img class="barber-profile-avatar" src="${esc(barber.imageUrl)}" alt="صورة ${esc(barber.name)}">` : '<div class="barber-profile-avatar barber-profile-avatar-empty" aria-hidden="true">✂</div>'}
        <div class="barber-employee-identity"><strong>${esc(barber.name)}</strong><span class="barber-chip">${barber.active ? 'متاح للحجز' : 'موقوف مؤقتًا'}</span><span class="barber-muted barber-small">${barber.linked ? 'حساب الحلاق مربوط' : 'لم يربط حسابه بعد'}</span></div>
        <details class="barber-kebab"><summary aria-label="إعدادات الحلاق ${esc(barber.name)}" title="كل إعدادات الحلاق">⋮</summary><div class="barber-kebab-menu">
          <button type="button" data-barber-action="settings">الإعدادات وساعات العمل</button>
          <button type="button" data-barber-action="claim" ${barber.linked ? 'disabled title="الحساب مربوط بالفعل"' : ''}>${barber.linked ? 'الحساب مربوط بالفعل' : 'إصدار كود ربط جديد'}</button>
          <button type="button" data-barber-action="photo">تغيير صورة الحلاق</button>
          <button type="button" data-barber-action="toggle">${barber.active ? 'إيقاف الحلاق مؤقتًا' : 'إعادة تفعيل الحلاق'}</button>
        </div></details>
      </div>
      <div class="barber-employee-meta"><span>العمل: ${esc(barber.openTime || shop?.openTime || '09:00')}–${esc(barber.closeTime || shop?.closeTime || '21:00')}</span><span>${esc(barberRatingLabel(barber))}</span></div>
      <p class="barber-muted barber-small">آخر تحديث: ${esc(formatAuditDate(barber.updatedAt))}${barber.lastUpdatedBy ? ` · بواسطة ${esc(barber.lastUpdatedBy)}` : ''}</p>
      <form class="barber-form barber-inline-editor" data-barber-settings hidden>
        <label>اسم الحلاق<input name="name" required minlength="2" maxlength="80" value="${esc(barber.name)}"></label>
        <div class="barber-form-grid"><label>يبدأ العمل<input name="openTime" type="time" required value="${esc(barber.openTime || shop?.openTime || '09:00')}"></label><label>ينهي العمل<input name="closeTime" type="time" required value="${esc(barber.closeTime || shop?.closeTime || '21:00')}"></label></div>
        <fieldset class="barber-days"><legend>إجازات الحلاق الأسبوعية</legend>${[[0,'الأحد'],[1,'الاثنين'],[2,'الثلاثاء'],[3,'الأربعاء'],[4,'الخميس'],[5,'الجمعة'],[6,'السبت']].map(([day,label]) => `<label><input type="checkbox" name="closedDays" value="${day}" ${(barber.closedDays || []).includes(day) ? 'checked' : ''}> ${label}</label>`).join('')}</fieldset>
        <label>إجازات إضافية بالتاريخ (كل تاريخ في سطر بصيغة YYYY-MM-DD)<textarea name="closedDatesText" rows="3" maxlength="1319" placeholder="2026-12-01&#10;2026-12-15">${esc((barber.closedDates || []).join('\n'))}</textarea></label>
        <p class="barber-muted barber-small">لن تظهر مواعيد متاحة للحلاق في هذه التواريخ. الحد الأقصى 120 تاريخًا.</p>
        <label class="barber-inline-check"><input type="checkbox" name="active" ${barber.active ? 'checked' : ''}> الحلاق متاح للعملاء للحجز</label>
        <button class="barber-button barber-button-primary" type="submit">حفظ إعدادات الحلاق</button>
      </form>
      <div class="barber-claim-code barber-card-claim" data-barber-code-output hidden></div>
      <input type="file" accept="image/jpeg,image/png,image/webp" data-barber-photo-input hidden>
    </article>`).join('');
}

function renderManagedServices(services = []) {
  const host = $('managedServicesList');
  if (!services.length) { host.innerHTML = '<div class="barber-empty">لا توجد خدمات. أضف خدمة من النموذج بالأسفل.</div>'; return; }
  host.innerHTML = services.map(service => `
    <form class="barber-service-editor" data-managed-service-id="${esc(service.id)}">
      <div class="barber-service-editor-heading"><strong>${esc(service.name)}</strong><span class="barber-chip">${service.active ? 'مفعلة' : 'موقوفة'}</span></div>
      <label>اسم الخدمة<input name="name" required maxlength="100" value="${esc(service.name)}"></label>
      <div class="barber-form-grid"><label>المدة<select name="durationMinutes">${[15,30,45,60,75,90,120,150,180].map(n => `<option value="${n}" ${Number(service.durationMinutes) === n ? 'selected' : ''}>${n} دقيقة</option>`).join('')}</select></label><label>السعر بالجنيه<input name="price" type="number" min="1" max="100000" step="0.01" required value="${esc(service.price)}"></label></div>
      <label class="barber-inline-check"><input type="checkbox" name="active" ${service.active ? 'checked' : ''}> الخدمة متاحة للحجز</label>
      <p class="barber-muted barber-small">آخر تحديث: ${esc(formatAuditDate(service.updatedAt))}${service.lastUpdatedBy ? ` · بواسطة ${esc(service.lastUpdatedBy)}` : ''}</p>
      <button type="submit" class="barber-button barber-button-primary">حفظ الخدمة</button>
    </form>`).join('');
}

async function loadShopManagement(shopId) {
  if (!currentUser || !shopId) {
    managedShopData = null;
    $('managedBarbersList').innerHTML = '<div class="barber-empty">اختار الصالون لعرض الحلاقين.</div>';
    $('managedServicesList').innerHTML = '<div class="barber-empty">اختار الصالون لعرض الخدمات.</div>';
    $('shopAuditList').innerHTML = '<div class="barber-empty">اختار صالونًا لعرض السجل.</div>';
    return;
  }
  $('managedBarbersList').innerHTML = '<div class="barber-empty">جاري تحميل الحلاقين...</div>';
  try {
    const result = await api(`/api/barbershops/${encodeURIComponent(shopId)}/manage`);
    managedShopData = result;
    renderManagedBarbers(result.barbers || [], result.shop || {});
    renderManagedServices(result.services || []);
    renderShopAudit(result.recentChanges || []);
    const ownerShop = ownedShops.find(shop => shop.id === shopId);
    if (ownerShop && result.shop) Object.assign(ownerShop, result.shop);
    fillShopProfileFields();
    fillScheduleFields();
  } catch (error) {
    $('managedBarbersList').innerHTML = `<div class="barber-empty">${esc(error.message)}</div>`;
    $('managedServicesList').innerHTML = '<div class="barber-empty">تعذر تحميل الخدمات.</div>';
    $('shopAuditList').innerHTML = '<div class="barber-empty">تعذر تحميل سجل التعديلات.</div>';
  }
}

function isBookingEndedForUi(booking) {
  const date = String(booking.localDate || '');
  const today = cairoToday();
  if (date < today) return true;
  if (date > today) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const nowMinute = Number(values.hour) * 60 + Number(values.minute);
  const endMinute = Number.isInteger(booking.endMinute) ? booking.endMinute : (typeof booking.endTime === 'string' && /^\d{2}:\d{2}$/.test(booking.endTime) ? Number(booking.endTime.slice(0, 2)) * 60 + Number(booking.endTime.slice(3, 5)) : NaN);
  return Number.isFinite(endMinute) && endMinute <= nowMinute;
}
function bookingStatusLabel(booking) {
  if (booking.status === 'cancelled') return 'ملغي';
  if (booking.attendanceStatus === 'completed') return 'تم التنفيذ';
  if (booking.attendanceStatus === 'no_show') return 'العميل لم يحضر';
  if (booking.status === 'pending_payment') return 'بانتظار الدفع';
  return 'حجز مؤكد';
}
function renderManagedBookingStats(bookings) {
  const confirmed = bookings.filter(item => item.status === 'confirmed' && !item.attendanceStatus).length;
  const completed = bookings.filter(item => item.attendanceStatus === 'completed').length;
  const noShow = bookings.filter(item => item.attendanceStatus === 'no_show').length;
  const cancelled = bookings.filter(item => item.status === 'cancelled').length;
  const paid = bookings.filter(item => item.paymentStatus === 'paid' && item.status !== 'cancelled').reduce((sum, item) => sum + Number(item.price || 0), 0);
  const unpaid = bookings.filter(item => item.paymentStatus !== 'paid' && item.status === 'confirmed').reduce((sum, item) => sum + Number(item.price || 0), 0);
  $('managedBookingStats').innerHTML = [
    ['إجمالي اليوم', bookings.length, 'حجز'], ['بانتظار التنفيذ', confirmed, 'موعد'], ['تم التنفيذ', completed, 'موعد'],
    ['تم تحصيله', `${money(paid)} ج.م`, 'نقدًا / مدفوع'], ['مبالغ غير محصلة', `${money(unpaid)} ج.م`, 'متوقع'], ['إلغاء / غياب', `${cancelled} / ${noShow}`, 'حالة']
  ].map(([label, value, detail]) => `<article class="barber-operations-stat"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></article>`).join('');
}
function renderManagedBookings() {
  const status = $('managedBookingStatus').value || 'all';
  const term = ($('managedBookingSearch').value || '').trim().toLocaleLowerCase('ar');
  filteredManagedBookings = managedDailyBookings.filter(item => {
    const itemStatus = item.status === 'cancelled' ? 'cancelled' : (item.attendanceStatus || (item.status === 'confirmed' ? 'confirmed' : item.status));
    const statusMatch = status === 'all' || itemStatus === status;
    const text = `${item.customerName || ''} ${item.customerPhone || ''} ${item.serviceName || ''} ${item.barberName || ''}`.toLocaleLowerCase('ar');
    return statusMatch && (!term || text.includes(term));
  });
  $('managedBookingCount').textContent = `عرض ${filteredManagedBookings.length} من ${managedDailyBookings.length} موعد في هذا اليوم`;
  $('exportManagedBookings').disabled = filteredManagedBookings.length === 0;
  $('managedBookingList').innerHTML = filteredManagedBookings.length ? filteredManagedBookings.map(item => {
    const attendanceLabel = bookingStatusLabel(item);
    const paymentLabel = item.paymentStatus === 'paid' ? 'تم التحصيل' : 'غير محصل';
    const attendanceActions = item.status === 'confirmed' && !item.attendanceStatus && isBookingEndedForUi(item)
      ? `<button type="button" class="barber-button barber-button-primary" data-managed-booking-action="completed" data-booking-id="${esc(item.id)}">تم تنفيذ الخدمة</button><button type="button" class="barber-button barber-button-light" data-managed-booking-action="no_show" data-booking-id="${esc(item.id)}">العميل لم يحضر</button>` : '';
    const payAction = item.status === 'confirmed' && item.paymentStatus !== 'paid' && item.paymentMethod === 'onsite'
      ? `<button type="button" class="barber-button barber-button-light" data-managed-booking-action="paid" data-booking-id="${esc(item.id)}">تسجيل التحصيل النقدي</button>` : '';
    const cancelAction = item.status === 'confirmed' && item.paymentStatus !== 'paid' && !item.attendanceStatus
      ? `<button type="button" class="barber-button barber-button-danger" data-managed-booking-action="cancel" data-booking-id="${esc(item.id)}">إلغاء الحجز</button>` : '';
    const shopName = ownedShops.find(shop => shop.id === $('managedBookingShopSelect')?.value)?.name || $('managedBookingShopSelect')?.selectedOptions?.[0]?.textContent || 'صالون الحلاقة';
    const reminderUrl = item.status === 'confirmed' && !item.attendanceStatus && !isBookingEndedForUi(item)
      ? createBarberWhatsAppReminderUrl(item, shopName) : '';
    const reminderAction = reminderUrl ? `<a class="barber-button barber-button-whatsapp" href="${esc(reminderUrl)}" target="_blank" rel="noopener noreferrer" aria-label="فتح واتساب لإرسال تذكير بموعد ${esc(item.customerName || 'العميل')}">تذكير واتساب</a>` : '';
    return `<article class="barber-booking-card barber-managed-booking-card">
      <div class="barber-managed-booking-head"><span class="barber-status ${item.status === 'cancelled' || item.attendanceStatus === 'no_show' ? 'barber-status-muted' : ''}">${esc(attendanceLabel)}</span><strong>${esc(item.startTime)} – ${esc(item.endTime)}</strong></div>
      <h3>${esc(item.customerName || 'عميل')} <span>· ${esc(item.serviceName || 'خدمة حلاقة')}</span></h3>
      <p><strong>الحلاق:</strong> ${esc(item.barberName || '—')} · <strong>السعر:</strong> ${money(item.price)} ج.م</p>
      <p>${item.customerPhone ? `<strong>الهاتف:</strong> <a href="tel:${esc(item.customerPhone)}" dir="ltr">${esc(item.customerPhone)}</a>` : 'لا يوجد رقم هاتف مسجل'} · <strong>الدفع:</strong> ${esc(paymentLabel)}</p>
      ${item.createdAt ? `<p class="barber-booking-created">وقت تسجيل الحجز: ${esc(formatAuditDate(item.createdAt))}</p>` : ''}
      ${item.attendanceUpdatedAt ? `<p class="barber-booking-created">آخر تحديث للحضور: ${esc(formatAuditDate(item.attendanceUpdatedAt))}${item.attendanceUpdatedByLabel ? ` بواسطة ${esc(item.attendanceUpdatedByLabel)}` : ''}</p>` : ''}
      <div class="barber-booking-actions">${reminderAction}${payAction}${attendanceActions}${cancelAction}</div>
    </article>`;
  }).join('') : '<div class="barber-empty">لا توجد حجوزات مطابقة لهذا التاريخ والفلاتر.</div>';
}
async function loadManagedBookings() {
  const shopId = $('managedBookingShopSelect')?.value;
  const date = $('managedBookingDate')?.value || cairoToday();
  if (!currentUser || !shopId || !date) {
    managedDailyBookings = [];
    renderManagedBookingStats([]);
    $('managedBookingList').innerHTML = '<div class="barber-empty">اختار صالونًا وتاريخًا لعرض المواعيد.</div>';
    $('managedBookingCount').textContent = '';
    $('exportManagedBookings').disabled = true;
    return;
  }
  $('managedBookingList').innerHTML = '<div class="barber-empty">جاري تحميل حجوزات اليوم...</div>';
  try {
    const result = await api(`/api/barbershops/${encodeURIComponent(shopId)}/bookings?date=${encodeURIComponent(date)}`);
    managedDailyBookings = result.bookings || [];
    renderManagedBookingStats(managedDailyBookings);
    renderManagedBookings();
  } catch (error) {
    managedDailyBookings = [];
    renderManagedBookingStats([]);
    $('managedBookingList').innerHTML = `<div class="barber-empty">${esc(error.message)}</div>`;
    $('managedBookingCount').textContent = '';
    $('exportManagedBookings').disabled = true;
  }
}
function exportManagedBookingsCsv() {
  if (!filteredManagedBookings.length) return;
  const headers = ['رقم الحجز','التاريخ','من','إلى','العميل','الهاتف','الخدمة','الحلاق','المبلغ','حالة الحجز','الحضور','الدفع'];
  const rows = filteredManagedBookings.map(item => [item.id, item.localDate, item.startTime, item.endTime, item.customerName, item.customerPhone, item.serviceName, item.barberName, item.price, item.status, item.attendanceStatus || '', item.paymentStatus]);
  const quote = value => {
    let textValue = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(textValue)) textValue = `'${textValue}`;
    return `"${textValue.replace(/"/g, '""')}"`;
  };
  const csv = '\ufeff' + [headers, ...rows].map(row => row.map(quote).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `elawamy-bookings-${$('managedBookingDate').value || cairoToday()}.csv`;
  document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

function setFinanceReportPreset(preset) {
  const today = cairoToday();
  if (preset === 'month') {
    $('financeReportStart').value = `${today.slice(0, 7)}-01`;
    $('financeReportEnd').value = today;
  } else {
    const start = new Date(`${today}T12:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 6);
    $('financeReportStart').value = start.toISOString().slice(0, 10);
    $('financeReportEnd').value = today;
  }
}
function renderFinanceTable(targetId, headers, rows, emptyText) {
  const target = $(targetId);
  if (!rows.length) {
    target.innerHTML = `<p class="barber-empty">${esc(emptyText)}</p>`;
    return;
  }
  target.innerHTML = `<div class="barber-finance-table-scroll"><table class="barber-finance-table"><thead><tr>${headers.map(header => `<th scope="col">${esc(header)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map((cell, index) => `<${index === 0 ? 'th scope="row"' : 'td'}>${esc(cell)}</${index === 0 ? 'th' : 'td'}>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function renderFinanceReport() {
  const report = summarizeBarberFinance(financeReportBookings);
  const stats = [
    ['قيمة الخدمات المنفذة', `${money(report.serviceValue)} ج.م`, `${report.completedCount} خدمة مكتملة`],
    ['التحصيل المؤكد', `${money(report.collected)} ج.م`, 'من الحجوزات غير الملغاة'],
    ['مستحق عن خدمات منفذة', `${money(report.outstanding)} ج.م`, `${report.outstandingCount} خدمة غير محصّلة`],
    ['إجمالي الحجوزات', report.bookingCount, 'كل الحالات خلال الفترة'],
    ['ملغي / لم يحضر', `${report.cancelledCount} / ${report.noShowCount}`, 'لا تُحسب كخدمة منفذة'],
    ['بانتظار تسجيل الحضور', report.pendingAttendanceCount, 'حجز مؤكد بلا حالة حضور']
  ];
  $('financeReportStats').innerHTML = stats.map(([label, value, detail]) => `<article class="barber-operations-stat"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></article>`).join('');
  renderFinanceTable('financeByBarber', ['الحلاق', 'مواعيد غير ملغاة', 'خدمات منفذة', 'قيمة المنفّذ', 'المحصّل', 'مستحق'], report.barberTotals.map(item => [item.name, item.bookingCount, item.completedCount, `${money(item.serviceValue)} ج.م`, `${money(item.collected)} ج.م`, `${money(item.outstanding)} ج.م`]), 'لا توجد حجوزات للحلاقين في هذه الفترة.');
  renderFinanceTable('financeByService', ['الخدمة', 'مواعيد غير ملغاة', 'خدمات منفذة', 'قيمة المنفّذ', 'المحصّل', 'مستحق'], report.serviceTotals.map(item => [item.name, item.bookingCount, item.completedCount, `${money(item.serviceValue)} ج.م`, `${money(item.collected)} ج.م`, `${money(item.outstanding)} ج.م`]), 'لا توجد خدمات مسجلة في هذه الفترة.');
  renderFinanceTable('financeByDay', ['التاريخ', 'مواعيد غير ملغاة', 'خدمات منفذة', 'قيمة المنفّذ', 'المحصّل', 'مستحق'], report.dayTotals.map(item => [item.date, item.bookingCount, item.completedCount, `${money(item.serviceValue)} ج.م`, `${money(item.collected)} ج.م`, `${money(item.outstanding)} ج.م`]), 'لا توجد بيانات يومية لهذه الفترة.');
  $('exportFinanceReport').disabled = financeReportBookings.length === 0;
}
async function loadFinanceReport() {
  const shopId = $('managedBookingShopSelect')?.value;
  const startDate = $('financeReportStart')?.value;
  const endDate = $('financeReportEnd')?.value;
  if (!currentUser || !shopId) {
    financeReportBookings = [];
    financeReportWasTruncated = false;
    renderFinanceReport();
    $('financeReportNotice').textContent = 'اختار صالونًا من لوحة المواعيد أعلاه أولًا.';
    $('financeReportMeta').textContent = '';
    return;
  }
  if (!startDate || !endDate) {
    $('financeReportNotice').textContent = 'اختار تاريخ البداية والنهاية.';
    return;
  }
  const validDateInput = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = Date.parse(`${value}T12:00:00Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
  };
  const startEpoch = Date.parse(`${startDate}T00:00:00Z`);
  const endEpoch = Date.parse(`${endDate}T00:00:00Z`);
  const diffDays = (endEpoch - startEpoch) / 86400000;
  if (!validDateInput(startDate) || !validDateInput(endDate) || !Number.isFinite(startEpoch) || !Number.isFinite(endEpoch) || diffDays < 0 || diffDays > 30) {
    $('financeReportNotice').textContent = 'الفترة غير صحيحة. اختار فترة من يوم إلى 31 يومًا، وتأكد أن البداية قبل النهاية.';
    return;
  }
  const button = $('loadFinanceReport');
  button.disabled = true;
  button.textContent = 'جاري تحميل التقرير...';
  $('financeReportNotice').textContent = 'جاري تحميل ملخص الإيرادات...';
  try {
    const query = new URLSearchParams({ startDate, endDate });
    const result = await api(`/api/barbershops/${encodeURIComponent(shopId)}/financial-report?${query}`);
    financeReportBookings = Array.isArray(result.bookings) ? result.bookings : [];
    financeReportWasTruncated = result.truncated === true;
    renderFinanceReport();
    $('financeReportMeta').textContent = `عدد السجلات: ${financeReportBookings.length} · من ${startDate} إلى ${endDate}`;
    $('financeReportNotice').textContent = financeReportWasTruncated
      ? 'تنبيه: التقرير وصل للحد الأقصى من السجلات. قلّل الفترة للحصول على إجمالي أدق.'
      : 'تم تحديث التقرير. الأرقام مبنية على سجل الحجوزات وحالات الدفع والحضور المسجلة.';
    $('financeReportNotice').className = financeReportWasTruncated ? 'barber-notice warn' : 'barber-muted';
  } catch (error) {
    financeReportBookings = [];
    financeReportWasTruncated = false;
    renderFinanceReport();
    $('financeReportNotice').textContent = error.message;
    $('financeReportNotice').className = 'barber-notice error';
    $('financeReportMeta').textContent = '';
  } finally {
    button.disabled = false;
    button.textContent = 'تحديث التقرير';
  }
}
function exportFinanceReportCsv() {
  if (!financeReportBookings.length) return;
  const headers = ['رقم الحجز','التاريخ','من','إلى','العميل','الخدمة','الحلاق','القيمة بالجنيه','حالة الحجز','الحضور','حالة الدفع','طريقة الدفع'];
  const rows = financeReportBookings.map(item => [item.id, item.localDate, item.startTime, item.endTime, item.customerName, item.serviceName, item.barberName, item.price, item.status, item.attendanceStatus || '', item.paymentStatus, item.paymentMethod]);
  const quote = value => {
    let textValue = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(textValue)) textValue = `'${textValue}`;
    return `"${textValue.replace(/"/g, '""')}"`;
  };
  const csv = '\ufeff' + [headers, ...rows].map(row => row.map(quote).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `elawamy-finance-${$('financeReportStart').value}-${$('financeReportEnd').value}.csv`;
  document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

function selectShopForManagement(shopId) {
  for (const id of ['profileShopSelect','managedBarberShopSelect','managedServiceShopSelect','managedBookingShopSelect','serviceShopSelect','barberShopSelect','scheduleShopSelect','photoShopSelect','claimShopSelect']) {
    if ($(id) && ownedShops.some(shop => shop.id === shopId)) $(id).value = shopId;
  }
  if ($('managedBookingShopSelect') && ownedShops.some(shop => shop.id === shopId)) $('managedBookingShopSelect').value = shopId;
  fillShopProfileFields();
  fillScheduleFields();
  loadManagedShopData(shopId);
  loadManagedBookings();
  loadFinanceReport();
}

async function loadManagedShopData(shopId) {
  await loadShopManagement(shopId);
  await loadManagedBarbers();
}

async function loadOwnedShops() {
  if (!currentUser) return;
  try {
    const result = await api('/api/barbershops/mine');
    ownedShops = result.shops || [];
    syncOwnedShopOptions();
  } catch (error) {
    showNotice(error.message, 'warn');
  }
}

async function loadManagedBarbers() {
  const shopId = $('claimShopSelect')?.value;
  if (!shopId || !$('claimBarberSelect')) return;
  $('claimBarberSelect').innerHTML = '<option value="">جاري تحميل الحلاقين...</option>';
  try {
    const result = await api(`/api/barbershops/${encodeURIComponent(shopId)}/barbers/mine`);
    const barbers = result.barbers || [];
    $('claimBarberSelect').innerHTML = '<option value="">اختار الحلاق</option>' + barbers.map(barber =>
      `<option value="${esc(barber.id)}" ${barber.linked ? 'disabled' : ''}>${esc(barber.name)}${barber.linked ? ' — مرتبط بحساب' : ''}</option>`
    ).join('');
  } catch (error) {
    $('claimBarberSelect').innerHTML = '<option value="">تعذر تحميل الحلاقين</option>';
    showNotice(error.message, 'warn');
  }
}

async function uploadSalonPhoto(file, { purpose = 'shop', shopId = '', barberId = '' } = {}) {
  if (!file) throw new Error('اختار صورة للصالون أولًا.');
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) throw new Error('الصورة لازم تكون JPG أو PNG أو WebP.');
  if (file.size < 1 || file.size > 8 * 1024 * 1024) throw new Error('حجم الصورة يجب ألا يتجاوز 8 ميجابايت.');
  if (!currentUser) throw new Error('سجّل الدخول أولًا.');
  const token = await currentUser.getIdToken();
  const response = await fetch(`${API_BASE}/api/barbershops/photo-upload-url`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ purpose, shopId, barberId, name: file.name, contentType: file.type, size: file.size })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorMessage(result.error || 'تعذر تجهيز رفع الصورة.'));
  const upload = await fetch(result.signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
  if (!upload.ok) throw new Error('فشل رفع صورة الصالون إلى التخزين.');
  return result.path;
}
async function loadPaymentConfig() {
  paymentOnlineAvailable = false;
  const option = $('onlinePaymentOption');
  if (option) {
    option.disabled = true;
    option.hidden = true;
    option.style.display = 'none';
  }
  const method = $('bookingPaymentMethod');
  if (method) method.value = 'onsite';
  const help = $('onlinePaymentHelp');
  if (help) help.textContent = 'الدفع نقدًا داخل الصالون فقط، ويتم سداد قيمة الخدمة للصالون عند الحضور.';
}

async function openBooking(shopId) {
  const shop = publicShops.find(item => item.id === shopId);
  if (!shop) return;
  selectedShop = shop;
  selectedTime = '';
  selectedDetails = null;
  $('bookingPanel').hidden = false;
  $('bookingPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('bookingTitle').textContent = `احجز في ${shop.name}`;
  $('bookingSlots').innerHTML = '<p class="barber-muted">جاري تحميل الخدمات والحلاقين...</p>';
  $('bookingStartTime').value = '';
  $('submitBooking').disabled = true;
  $('bookingSummary').hidden = true;
  $('bookingDate').min = cairoToday();
  $('bookingDate').max = dayAfterCairoToday(90);
  if (!$('bookingDate').value || $('bookingDate').value < cairoToday()) $('bookingDate').value = cairoToday();
  if (currentUser) $('bookingCustomerName').value = currentUser.displayName || '';
  try {
    const details = await api(`/api/barbershops/${encodeURIComponent(shopId)}`);
    selectedDetails = details;
    fillOptions($('bookingService'), details.services || [], 'اختار الخدمة', item => `${item.name} — ${money(item.price)} ج.م / ${item.durationMinutes} دقيقة`);
    fillOptions($('bookingBarber'), details.barbers || [], 'اختار الحلاق', item => `${item.name} — ${barberRatingLabel(item)}`);
    renderSelectedBarberPreview();
    if (!(details.services || []).length) {
      $('bookingSlots').innerHTML = '<p class="barber-muted">الصالون لسه ما أضافش خدمات. جرّب صالونًا آخر أو ارجع لاحقًا.</p>';
      $('slotsMeta').textContent = 'لا توجد خدمات';
      return;
    }
    if (!(details.barbers || []).length) {
      $('bookingSlots').innerHTML = '<p class="barber-muted">لا يوجد حلاق متاح للحجز حاليًا.</p>';
      $('slotsMeta').textContent = 'لا يوجد حلاق';
      return;
    }
    await loadSlots();
  } catch (error) {
    $('bookingSlots').innerHTML = `<p class="barber-muted">${esc(error.message)}</p>`;
    showNotice(error.message, 'error');
  }
}
async function loadSlots() {
  selectedTime = '';
  $('bookingStartTime').value = '';
  $('submitBooking').disabled = true;
  const serviceId = $('bookingService').value;
  const barberId = $('bookingBarber').value;
  const date = $('bookingDate').value;
  if (!selectedShop || !serviceId || !barberId || !date) {
    $('bookingSlots').innerHTML = '<p class="barber-muted">اختار الخدمة والحلاق واليوم لعرض المواعيد المتاحة.</p>';
    $('slotsMeta').textContent = 'اختار تفاصيل الحجز أولًا.';
    $('bookingSummary').hidden = true;
    return;
  }
  $('bookingSlots').innerHTML = '<p class="barber-muted">جاري البحث عن المواعيد...</p>';
  $('slotsMeta').textContent = 'تحديث المواعيد';
  try {
    const query = new URLSearchParams({ serviceId, barberId, date });
    const result = await api(`/api/barbershops/${encodeURIComponent(selectedShop.id)}/availability?${query}`);
    if (!result.slots.length) {
      $('bookingSlots').innerHTML = '<p class="barber-muted">لا توجد أوقات متاحة في هذا اليوم. اختار يومًا آخر.</p>';
      $('slotsMeta').textContent = 'لا توجد مواعيد';
    } else {
      $('bookingSlots').innerHTML = result.slots.map(time => `<button class="barber-slot" type="button" data-slot="${esc(time)}" aria-pressed="false">${esc(time)}</button>`).join('');
      $('slotsMeta').textContent = `${result.slots.length} موعد متاح`;
    }
  } catch (error) {
    $('bookingSlots').innerHTML = `<p class="barber-muted">${esc(error.message)}</p>`;
    $('slotsMeta').textContent = 'تعذر تحميل المواعيد';
  }
}
function updateBookingSummary() {
  const service = selectedDetails?.services?.find(item => item.id === $('bookingService').value);
  const barber = selectedDetails?.barbers?.find(item => item.id === $('bookingBarber').value);
  const date = $('bookingDate').value;
  if (!service || !barber || !date || !selectedTime) {
    $('bookingSummary').hidden = true;
    $('submitBooking').disabled = true;
    return;
  }
  $('bookingSummary').innerHTML = `موعدك: <strong>${esc(service.name)}</strong> مع <strong>${esc(barber.name)}</strong> يوم <strong>${esc(date)}</strong> الساعة <strong>${esc(selectedTime)}</strong> · السعر <strong>${money(service.price)} ج.م</strong>`;
  $('bookingSummary').hidden = false;
  $('submitBooking').disabled = !currentUser;
  $('submitBooking').textContent = $('bookingPaymentMethod').value === 'online' ? 'احجز وانتقل للدفع' : 'أكد الحجز';
}
function statusName(booking) {
  if (booking.attendanceStatus === 'completed') return 'تم تنفيذ الخدمة';
  if (booking.attendanceStatus === 'no_show') return 'العميل لم يحضر';
  if (booking.status === 'confirmed') return booking.paymentStatus === 'paid' ? 'مؤكد ومدفوع' : 'مؤكد - الدفع عند الحضور';
  if (booking.status === 'pending_payment') return 'في انتظار الدفع';
  if (booking.status === 'cancelled') return 'ملغي';
  return booking.status || 'غير معروف';
}
function formatReceiptDate(date) {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : new Intl.DateTimeFormat('ar-EG', { timeZone: 'Africa/Cairo', dateStyle: 'full' }).format(d);
}
function showBookingReceipt(booking, service, barber, customerName, customerPhone, date, startTime, shop) {
  const endMinute = Number(startTime.slice(0, 2)) * 60 + Number(startTime.slice(3, 5)) + Number(service.durationMinutes || 30);
  const endTime = `${String(Math.floor(endMinute / 60)).padStart(2, '0')}:${String(endMinute % 60).padStart(2, '0')}`;
  $('bookingReceipt').innerHTML = `<article class="barber-receipt-document-card">
    <header class="barber-receipt-masthead">
      <div class="barber-receipt-wordmark"><span class="barber-receipt-mark" aria-hidden="true">E</span><span>ElaWamy</span></div>
      <div class="barber-receipt-document-title"><span>خدمات الحلاقة</span><strong>إيصال تأكيد الحجز</strong></div>
    </header>
    <section class="barber-receipt-overview">
      <div><span class="barber-receipt-overline">تأكيد الموعد</span><h2>موعدك مؤكد</h2><p>تم تسجيل حجزك بنجاح. احتفظ بالتفاصيل لوقت الزيارة.</p></div>
      <div class="barber-receipt-status"><span aria-hidden="true">✓</span><strong>تم تأكيد الموعد</strong></div>
    </section>
    <div class="barber-receipt-code"><span>رقم الحجز</span><strong dir="ltr">${esc(booking.id || '—')}</strong></div>
    <div class="barber-receipt-section-heading"><strong>تفاصيل الموعد</strong><span>بيانات الحجز</span></div>
    <dl class="barber-receipt-details">
      <div><dt>الصالون</dt><dd>${esc(shop?.name || '')}</dd></div>
      <div><dt>الحلاق</dt><dd>${esc(barber?.name || '')}</dd></div>
      <div><dt>الخدمة</dt><dd>${esc(service?.name || '')}</dd></div>
      <div><dt>اليوم والتاريخ</dt><dd>${esc(formatReceiptDate(date))} (${esc(date)})</dd></div>
      <div><dt>الوقت</dt><dd><span dir="ltr">${esc(startTime)} – ${esc(endTime)}</span> <small>(توقيت مصر)</small></dd></div>
      <div><dt>اسم العميل</dt><dd>${esc(customerName || '')}</dd></div>
      <div><dt>رقم العميل</dt><dd dir="ltr">${esc(customerPhone || '—')}</dd></div>
      <div class="barber-receipt-address-row"><dt>عنوان الصالون</dt><dd>${esc(shop?.address || '')}${shop?.city ? ' — ' + esc(shop.city) : ''}</dd></div>
    </dl>
    <section class="barber-receipt-payment">
      <div class="barber-receipt-total"><span>إجمالي الحجز</span><strong>${money(service?.price)} <small>جنيه مصري</small></strong></div>
      <div class="barber-receipt-payment-method"><span>طريقة الدفع</span><strong>نقدًا داخل الصالون</strong><p>يُدفع المبلغ مباشرةً عند الحضور.</p></div>
    </section>
    <footer class="barber-receipt-footer"><span class="barber-receipt-footer-brand">ElaWamy</span><p>تم إصدار هذا الإيصال بواسطة ElaWamy. يُرجى الاحتفاظ برقم الحجز وذكره عند الوصول إلى الصالون.</p><span class="barber-receipt-footer-tag">شكرًا لاختيارك ElaWamy</span></footer>
  </article>`;
  $('bookingSuccess').hidden = false;
  $('bookingPanel').hidden = true;
  $('bookingSuccess').scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.setTimeout(() => { try { window.print(); } catch {} }, 250);
}
$('printBookingReceipt').addEventListener('click', () => window.print());

function renderBookings(bookings) {
  $('myBookings').innerHTML = bookings.length ? bookings.map(booking => {
    const canCancel = ['confirmed', 'pending_payment'].includes(booking.status) && booking.paymentStatus !== 'paid' && !booking.attendanceStatus;
    const owner = booking.viewerRole === 'owner' && booking.userId !== currentUser?.uid;
    const statusClass = booking.status === 'cancelled' ? 'cancelled' : booking.status === 'pending_payment' ? 'pending' : '';
    return `<article class="barber-booking-card">
      <span class="barber-status ${statusClass}">${esc(statusName(booking))}</span>
      <h3>${esc(booking.shopName || 'صالون حلاقة')}</h3>
      <p>${esc(booking.serviceName || '')} · ${esc(booking.barberName || '')}</p>
      <p>التاريخ: ${esc(booking.localDate || '')} · من ${esc(booking.startTime || '')} إلى ${esc(booking.endTime || '')}</p>
      <p>السعر: ${money(booking.price)} ج.م · طريقة الدفع: ${booking.paymentMethod === 'online' ? 'أونلاين (حجز سابق)' : 'نقدًا داخل الصالون'} · ${booking.paymentStatus === 'paid' ? 'تم الدفع' : 'غير مدفوع'}</p>
      ${owner ? `<p>العميل: ${esc(booking.customerName || 'عميل')} ${booking.customerPhone ? '· ' + esc(booking.customerPhone) : ''}</p>` : ''}
      ${booking.viewerRole === 'customer' && booking.ratingSubmitted ? `<p class="barber-rating-summary">تقييمك للحلاق: ★ ${Number(booking.rating || 0)} / 5</p>` : ''}
      ${canRateBooking(booking) ? `<form class="barber-rate-form" data-rate-booking="${esc(booking.id)}"><label>قيّم الحلاق<select name="rating" required><option value="">اختار التقييم</option><option value="5">★★★★★ ممتاز</option><option value="4">★★★★ جيد جدًا</option><option value="3">★★★ جيد</option><option value="2">★★ يحتاج تحسين</option><option value="1">★ ضعيف</option></select></label><label>تعليق (اختياري)<input name="comment" maxlength="500" placeholder="اكتب تجربتك"></label><button class="barber-button barber-button-primary" type="submit">إرسال التقييم</button></form>` : ''}
      <div class="barber-booking-actions">
        ${booking.status === 'pending_payment' && booking.paymentStatus === 'pending' && booking.userId === currentUser?.uid ? `<button class="barber-button barber-button-primary" data-pay-booking="${esc(booking.id)}" type="button">استكمال الدفع</button>` : ''}
        ${owner && booking.status === 'confirmed' && booking.paymentMethod === 'onsite' && booking.paymentStatus === 'unpaid' ? `<button class="barber-button barber-button-primary" data-cash-paid="${esc(booking.id)}" type="button">تأكيد استلام الدفع في الصالون</button>` : ''}
        ${canCancel ? `<button class="barber-button barber-button-danger" data-cancel-booking="${esc(booking.id)}" type="button">إلغاء الحجز</button>` : ''}
      </div>
    </article>`;
  }).join('') : '<div class="barber-empty">لسه مفيش حجوزات ظاهرة لحسابك.</div>';
}
async function loadMyBookings() {
  if (!currentUser) return;
  $('myBookings').innerHTML = '<div class="barber-empty">جاري تحميل الحجوزات...</div>';
  try {
    const result = await api('/api/barber-bookings/mine');
    renderBookings(result.bookings || []);
  } catch (error) {
    $('myBookings').innerHTML = `<div class="barber-empty">${esc(error.message)}</div>`;
  }
}
async function checkoutBooking(bookingId) {
  try {
    const result = await api('/api/barber-bookings/checkout', { method: 'POST', body: { bookingId } });
    if (!result.url || !/^https:\/\//i.test(result.url)) throw new Error('رابط الدفع الذي رجع من البوابة غير صالح.');
    window.location.assign(result.url);
  } catch (error) {
    showNotice(error.message, 'error');
    await loadMyBookings();
  }
}

$('shopSearch').addEventListener('input', () => renderShops(publicShops));
$('shopsGrid').addEventListener('click', event => {
  const manage = event.target.closest('[data-manage-shop]');
  if (manage) {
    event.preventDefault();
    if (!currentUser) { showNotice('سجّل الدخول لإدارة الصالون.', 'warn'); return; }
    window.location.assign(`/salon?shop=${encodeURIComponent(manage.dataset.manageShop)}`);
    return;
  }
  const button = event.target.closest('[data-book-shop]');
  if (button) window.location.assign(`/barber-booking?shop=${encodeURIComponent(button.dataset.bookShop)}`);
});
$('closeBooking').addEventListener('click', () => { $('bookingPanel').hidden = true; });
for (const id of ['bookingService', 'bookingBarber', 'bookingDate']) $(id).addEventListener('change', loadSlots);
$('bookingBarber').addEventListener('change', renderSelectedBarberPreview);
$('bookingPaymentMethod').addEventListener('change', updateBookingSummary);
$('bookingSlots').addEventListener('click', event => {
  const button = event.target.closest('[data-slot]');
  if (!button) return;
  selectedTime = button.dataset.slot;
  $('bookingStartTime').value = selectedTime;
  $('bookingSlots').querySelectorAll('[data-slot]').forEach(slot => slot.setAttribute('aria-pressed', String(slot === button)));
  updateBookingSummary();
});
$('bookingForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentUser) { showNotice('سجّل الدخول أولًا لإتمام الحجز.', 'warn'); return; }
  if (!selectedShop || !selectedTime) { showNotice('اختار موعدًا متاحًا أولًا.', 'warn'); return; }
  const button = $('submitBooking');
  button.disabled = true;
  button.textContent = 'جاري تأكيد الموعد...';
  try {
    const result = await api('/api/barber-bookings', { method: 'POST', body: {
      shopId: selectedShop.id, serviceId: $('bookingService').value, barberId: $('bookingBarber').value,
      date: $('bookingDate').value, startTime: selectedTime, paymentMethod: $('bookingPaymentMethod').value,
      customerName: $('bookingCustomerName').value.trim(), customerPhone: $('bookingCustomerPhone').value.trim()
    }});
    const service = selectedDetails.services.find(item => item.id === $('bookingService').value);
    const barber = selectedDetails.barbers.find(item => item.id === $('bookingBarber').value);
    showNotice('تم تأكيد الحجز. جاري فتح إيصال الطباعة، ويمكنك حفظه PDF لو مفيش طابعة متصلة.', 'info');
    showBookingReceipt(result.booking || {}, service, barber, $('bookingCustomerName').value.trim(), $('bookingCustomerPhone').value.trim(), $('bookingDate').value, selectedTime, selectedShop);
    await Promise.all([loadSlots(), loadMyBookings()]);
    $('myBookingsSection').hidden = false;
  } catch (error) {
    showNotice(error.message, 'error');
    await loadSlots();
  } finally {
    button.textContent = $('bookingPaymentMethod').value === 'online' ? 'احجز وانتقل للدفع' : 'أكد الحجز';
    updateBookingSummary();
  }
});
$('reloadBookings').addEventListener('click', loadMyBookings);
$('scheduleShopSelect').addEventListener('change', fillScheduleFields);
$('claimShopSelect').addEventListener('change', loadManagedBarbers);
$('myBookings').addEventListener('click', async event => {
  const pay = event.target.closest('[data-pay-booking]');
  if (pay) { await checkoutBooking(pay.dataset.payBooking); return; }
  const cashPaid = event.target.closest('[data-cash-paid]');
  if (cashPaid) {
    if (!window.confirm('أكدت استلام المبلغ من العميل في الصالون؟')) return;
    cashPaid.disabled = true;
    try {
      await api('/api/barber-bookings/mark-cash-paid', { method: 'POST', body: { bookingId: cashPaid.dataset.cashPaid } });
      showNotice('تم تسجيل الدفع في الصالون. لا توجد عمولة منصة على الحجز حاليًا.');
      await loadMyBookings();
    } catch (error) { showNotice(error.message, 'error'); cashPaid.disabled = false; }
    return;
  }
  const cancel = event.target.closest('[data-cancel-booking]');
  if (!cancel) return;
  if (!window.confirm('متأكد إنك عايز تلغي الحجز؟')) return;
  cancel.disabled = true;
  try {
    await api('/api/barber-bookings/cancel', { method: 'POST', body: { bookingId: cancel.dataset.cancelBooking } });
    showNotice('تم إلغاء الحجز وتحرير الموعد.', 'info');
    await loadMyBookings();
  } catch (error) {
    showNotice(error.message, 'error');
    cancel.disabled = false;
  }
});

$('createShopForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentUser) return showNotice('سجّل الدخول أولًا.', 'warn');
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  submit.textContent = 'جاري رفع الصورة وإنشاء الصالون...';
  try {
    const data = Object.fromEntries(new FormData(form).entries());
    const imageFile = form.querySelector('[name="image"]').files?.[0];
    data.imagePath = await uploadSalonPhoto(imageFile);
    delete data.image;
    data.closedDays = [...form.querySelectorAll('input[name="closedDays"]:checked')].map(input => Number(input.value));
    const result = await api('/api/barbershops', { method: 'POST', body: data });
    form.reset();
    form.querySelector('[name="openTime"]').value = '09:00';
    form.querySelector('[name="closeTime"]').value = '21:00';
    $('newShopClaimCode').hidden = false;
    $('newShopClaimCode').innerHTML = `<strong>كود ربط الحلاق الأول:</strong><code>${esc(result.barberClaimCode)}</code><button type="button" class="barber-button barber-button-light" data-copy-code="${esc(result.barberClaimCode)}">نسخ الكود</button><p>طلب الصالون قيد مراجعة الإدارة. احتفظ بالكود وأرسله للحلاق فقط ليربط حسابه بجدوله الشخصي. صالح لمدة 30 يومًا ويستخدم مرة واحدة.</p>`;
    showNotice(`تم استلام طلب صالون ${result.shop.name} وهو قيد مراجعة الإدارة. كود ربط الحلاق الأول ظهر أسفل النموذج.`);
    await Promise.all([loadOwnedShops(), loadShops()]);
  } catch (error) { showNotice(error.message, 'error'); }
  finally {
    submit.disabled = false;
    submit.textContent = 'إنشاء الصالون';
  }
});
$('profileShopSelect').addEventListener('change', () => {
  fillShopProfileFields();
  const shopId = $('profileShopSelect').value;
  if (shopId) loadShopManagement(shopId);
});
$('managedBarberShopSelect').addEventListener('change', event => {
  if ($('managedBookingShopSelect')) $('managedBookingShopSelect').value = event.target.value;
  loadManagedBookings(); loadFinanceReport();
  if ($('managedServiceShopSelect')) $('managedServiceShopSelect').value = event.target.value;
  if ($('profileShopSelect')) $('profileShopSelect').value = event.target.value;
  if ($('scheduleShopSelect')) $('scheduleShopSelect').value = event.target.value;
  fillShopProfileFields(); fillScheduleFields(); loadShopManagement(event.target.value);
});
$('managedServiceShopSelect').addEventListener('change', event => {
  if ($('managedBookingShopSelect')) $('managedBookingShopSelect').value = event.target.value;
  loadManagedBookings(); loadFinanceReport();
  if ($('managedBarberShopSelect')) $('managedBarberShopSelect').value = event.target.value;
  if ($('profileShopSelect')) $('profileShopSelect').value = event.target.value;
  loadShopManagement(event.target.value);
});
$('managedBookingShopSelect').addEventListener('change', () => { loadManagedBookings(); loadFinanceReport(); });
$('managedBookingDate').addEventListener('change', loadManagedBookings);
$('managedBookingStatus').addEventListener('change', renderManagedBookings);
$('managedBookingSearch').addEventListener('input', renderManagedBookings);
$('refreshManagedBookings').addEventListener('click', loadManagedBookings);
$('exportManagedBookings').addEventListener('click', exportManagedBookingsCsv);
$('loadFinanceReport').addEventListener('click', loadFinanceReport);
$('financeReportThisMonth').addEventListener('click', () => { setFinanceReportPreset('month'); loadFinanceReport(); });
$('financeReportLast7Days').addEventListener('click', () => { setFinanceReportPreset('week'); loadFinanceReport(); });
$('exportFinanceReport').addEventListener('click', exportFinanceReportCsv);
$('managedBookingList').addEventListener('click', async event => {
  const button = event.target.closest('[data-managed-booking-action]');
  if (!button) return;
  const bookingId = button.dataset.bookingId;
  const action = button.dataset.managedBookingAction;
  if (!bookingId || !action) return;
  if (action === 'cancel' && !window.confirm('متأكد إنك عايز تلغي الحجز؟')) return;
  if (action === 'no_show' && !window.confirm('تأكيد تسجيل إن العميل لم يحضر؟ لن يستطيع إرسال تقييم لهذا الحجز.')) return;
  const previousText = button.textContent;
  button.disabled = true; button.textContent = 'جاري الحفظ...';
  try {
    if (action === 'paid') {
      await api('/api/barber-bookings/mark-cash-paid', { method: 'POST', body: { bookingId } });
      showNotice('تم تسجيل التحصيل النقدي.');
    } else if (action === 'cancel') {
      await api('/api/barber-bookings/cancel', { method: 'POST', body: { bookingId } });
      showNotice('تم إلغاء الحجز وتسجيل التغيير في سجل الصالون.');
    } else {
      await api('/api/barber-bookings/attendance', { method: 'POST', body: { bookingId, attendanceStatus: action } });
      showNotice(action === 'completed' ? 'تم تسجيل تنفيذ الخدمة.' : 'تم تسجيل عدم حضور العميل.');
    }
    await Promise.all([loadManagedBookings(), loadShopManagement($('managedBookingShopSelect').value)]);
  } catch (error) {
    showNotice(error.message, 'error');
    button.disabled = false; button.textContent = previousText;
  }
});

$('updateShopProfileForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const shopId = $('profileShopSelect').value;
  if (!shopId) return showNotice('اختار الصالون أولًا.', 'warn');
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(form).entries());
    await api(`/api/barbershops/${encodeURIComponent(shopId)}/settings`, { method: 'POST', body: data });
    showNotice('تم حفظ بيانات الصالون وتسجيل التعديل في سجل الحساب.');
    await Promise.all([loadOwnedShops(), loadShops(), loadShopManagement(shopId)]);
  } catch (error) { showNotice(error.message, 'error'); }
  finally { button.disabled = false; }
});

$('managedBarbersList').addEventListener('click', async event => {
  const actionButton = event.target.closest('[data-barber-action]');
  if (!actionButton) return;
  const card = actionButton.closest('[data-managed-barber-id]');
  const shopId = $('managedBarberShopSelect').value;
  const barberId = card?.dataset.managedBarberId;
  const barber = (managedShopData?.barbers || []).find(item => item.id === barberId);
  if (!card || !shopId || !barber) return;
  const action = actionButton.dataset.barberAction;
  if (action === 'settings') {
    card.querySelector('[data-barber-settings]').hidden = !card.querySelector('[data-barber-settings]').hidden;
    card.querySelector('.barber-kebab').open = false;
    return;
  }
  if (action === 'photo') {
    card.querySelector('[data-barber-photo-input]').click();
    card.querySelector('.barber-kebab').open = false;
    return;
  }
  if (action === 'claim') {
    actionButton.disabled = true;
    try {
      const result = await api(`/api/barbershops/${encodeURIComponent(shopId)}/barbers/${encodeURIComponent(barberId)}/claim-code`, { method: 'POST', body: {} });
      const output = card.querySelector('[data-barber-code-output]');
      output.hidden = false;
      output.innerHTML = `<strong>كود ربط ${esc(result.barberName)}:</strong><code>${esc(result.barberClaimCode)}</code><button type="button" class="barber-button barber-button-light" data-copy-code="${esc(result.barberClaimCode)}">نسخ الكود</button><p>الكود صالح 30 يومًا ويستخدم مرة واحدة. أرسله للحلاق فقط.</p>`;
      card.querySelector('.barber-kebab').open = false;
      showNotice('تم إنشاء كود ربط جديد، وسيُستخدم مرة واحدة فقط.');
    } catch (error) { showNotice(error.message, 'error'); }
    finally { actionButton.disabled = false; }
    return;
  }
  if (action === 'toggle') {
    const nextActive = !barber.active;
    if (!window.confirm(nextActive ? 'إعادة تفعيل هذا الحلاق وإظهاره للحجز؟' : 'إيقاف هذا الحلاق ومنع حجوزات جديدة له؟')) return;
    actionButton.disabled = true;
    try {
      await api(`/api/barbershops/${encodeURIComponent(shopId)}/barbers/${encodeURIComponent(barberId)}/settings`, { method: 'POST', body: { name: barber.name, openTime: barber.openTime || managedShopData.shop.openTime, closeTime: barber.closeTime || managedShopData.shop.closeTime, closedDays: barber.closedDays || [], active: nextActive } });
      showNotice(nextActive ? 'تم تفعيل الحلاق.' : 'تم إيقاف الحلاق مؤقتًا. الحجوزات القديمة لم تُحذف.');
      await loadShopManagement(shopId);
    } catch (error) { showNotice(error.message, 'error'); }
    finally { actionButton.disabled = false; }
  }
});
$('managedBarbersList').addEventListener('click', async event => {
  const button = event.target.closest('[data-copy-code]');
  if (!button) return;
  try { await navigator.clipboard.writeText(button.dataset.copyCode); showNotice('تم نسخ كود الربط.'); }
  catch { showNotice(`انسخ الكود يدويًا: ${button.dataset.copyCode}`, 'warn'); }
});

$('managedBarbersList').addEventListener('change', async event => {
  const input = event.target.closest('[data-barber-photo-input]');
  if (!input?.files?.[0]) return;
  const card = input.closest('[data-managed-barber-id]');
  const shopId = $('managedBarberShopSelect').value;
  const barberId = card?.dataset.managedBarberId;
  try {
    const imagePath = await uploadSalonPhoto(input.files[0], { purpose: 'barber', shopId, barberId });
    await api(`/api/barbershops/${encodeURIComponent(shopId)}/barbers/${encodeURIComponent(barberId)}/photo`, { method: 'POST', body: { imagePath } });
    showNotice('تم تحديث صورة الحلاق.');
    await loadShopManagement(shopId);
  } catch (error) { showNotice(error.message, 'error'); }
  finally { input.value = ''; }
});
$('managedBarbersList').addEventListener('submit', async event => {
  const form = event.target.closest('[data-barber-settings]');
  if (!form) return;
  event.preventDefault();
  const card = form.closest('[data-managed-barber-id]');
  const shopId = $('managedBarberShopSelect').value;
  const barberId = card?.dataset.managedBarberId;
  if (!shopId || !barberId) return;
  const data = Object.fromEntries(new FormData(form).entries());
  data.active = form.elements.namedItem('active').checked;
  data.closedDays = [...form.querySelectorAll('input[name="closedDays"]:checked')].map(input => Number(input.value));
  data.closedDates = parseClosedDatesText(form.elements.namedItem('closedDatesText')?.value);
  const button = form.querySelector('[type="submit"]'); button.disabled = true;
  try {
    await api(`/api/barbershops/${encodeURIComponent(shopId)}/barbers/${encodeURIComponent(barberId)}/settings`, { method: 'POST', body: data });
    showNotice('تم حفظ إعدادات الحلاق وتسجيل التعديل في سجل الصالون.');
    await Promise.all([loadShopManagement(shopId), loadOwnedShops()]);
  } catch (error) { showNotice(error.message, 'error'); }
  finally { button.disabled = false; }
});
$('managedServicesList').addEventListener('submit', async event => {
  const form = event.target.closest('[data-managed-service-id]');
  if (!form) return;
  event.preventDefault();
  const shopId = $('managedServiceShopSelect').value;
  const serviceId = form.dataset.managedServiceId;
  if (!shopId || !serviceId) return;
  const data = Object.fromEntries(new FormData(form).entries());
  data.active = form.elements.namedItem('active').checked;
  data.price = Number(data.price); data.durationMinutes = Number(data.durationMinutes);
  const button = form.querySelector('[type="submit"]'); button.disabled = true;
  try {
    await api(`/api/barbershops/${encodeURIComponent(shopId)}/services/${encodeURIComponent(serviceId)}/settings`, { method: 'POST', body: data });
    showNotice('تم حفظ بيانات الخدمة.');
    await loadShopManagement(shopId);
    await loadShops();
  } catch (error) { showNotice(error.message, 'error'); }
  finally { button.disabled = false; }
});

$('updateShopPhotoForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const shopId = $('photoShopSelect').value;
  const file = form.querySelector('[name="image"]').files?.[0];
  if (!shopId) return showNotice('اختار الصالون أولًا.', 'warn');
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  button.textContent = 'جاري رفع الصورة...';
  try {
    const imagePath = await uploadSalonPhoto(file, { purpose: 'shop', shopId });
    await api(`/api/barbershops/${encodeURIComponent(shopId)}/photo`, { method: 'POST', body: { imagePath } });
    form.reset();
    showNotice('تم تحديث صورة الصالون. الصورة الجديدة ستظهر في صفحة الصالونات.');
    await Promise.all([loadOwnedShops(), loadShops()]);
    if ($('managedBarberShopSelect').value === shopId) await loadShopManagement(shopId);
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'حفظ صورة الصالون';
  }
});

$('addServiceForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const shopId = $('serviceShopSelect').value;
  if (!shopId) return showNotice('اختار الصالون أولًا.', 'warn');
  const data = Object.fromEntries(new FormData(form).entries());
  data.price = Number(data.price);
  data.durationMinutes = Number(data.durationMinutes);
  try {
    await api(`/api/barbershops/${encodeURIComponent(shopId)}/services`, { method: 'POST', body: data });
    form.reset();
    showNotice('تمت إضافة الخدمة بنجاح.');
    await loadShops();
  } catch (error) { showNotice(error.message, 'error'); }
});
$('addBarberForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const shopId = $('barberShopSelect').value;
  if (!shopId) return showNotice('اختار الصالون أولًا.', 'warn');
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    const result = await api(`/api/barbershops/${encodeURIComponent(shopId)}/barbers`, { method: 'POST', body: data });
    form.reset();
    $('newBarberClaimCode').hidden = false;
    $('newBarberClaimCode').innerHTML = `<strong>كود ربط الحلاق ${esc(result.barber?.name || data.name)}:</strong><code>${esc(result.barberClaimCode)}</code><button type="button" class="barber-button barber-button-light" data-copy-code="${esc(result.barberClaimCode)}">نسخ الكود</button><p>الكود صالح لمدة 30 يومًا ويستخدم مرة واحدة. ابعته للحلاق فقط.</p>`;
    showNotice('تمت إضافة الحلاق. أرسل له كود الربط ليحدد مواعيده بنفسه.');
    await loadManagedBarbers();
    if ($('managedBarberShopSelect').value === shopId) await loadShopManagement(shopId);
  } catch (error) { showNotice(error.message, 'error'); }
});

$('barberClaimCodeForm').addEventListener('submit', async event => {
  event.preventDefault();
  const shopId = $('claimShopSelect').value;
  const barberId = $('claimBarberSelect').value;
  if (!shopId || !barberId) return showNotice('اختار الصالون والحلاق أولًا.', 'warn');
  try {
    const result = await api(`/api/barbershops/${encodeURIComponent(shopId)}/barbers/${encodeURIComponent(barberId)}/claim-code`, { method: 'POST', body: {} });
    $('existingBarberClaimCode').hidden = false;
    $('existingBarberClaimCode').innerHTML = `<strong>كود ربط ${esc(result.barberName)}:</strong><code>${esc(result.barberClaimCode)}</code><button type="button" class="barber-button barber-button-light" data-copy-code="${esc(result.barberClaimCode)}">نسخ الكود</button><p>الكود صالح لمدة 30 يومًا ويستخدم مرة واحدة.</p>`;
    await loadManagedBarbers();
    showNotice('تم إنشاء كود الربط. أرسله للحلاق ليضبط مواعيده من حسابه.');
  } catch (error) { showNotice(error.message, 'error'); }
});

for (const id of ['newShopClaimCode', 'newBarberClaimCode', 'existingBarberClaimCode']) $(id).addEventListener('click', async event => {
  const button = event.target.closest('[data-copy-code]');
  if (!button) return;
  try { await navigator.clipboard.writeText(button.dataset.copyCode); showNotice('تم نسخ كود الربط.'); }
  catch { showNotice(`انسخ الكود يدويًا: ${button.dataset.copyCode}`, 'warn'); }
});
$('updateScheduleForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const shopId = $('scheduleShopSelect').value;
  if (!shopId) return showNotice('اختار الصالون أولًا.', 'warn');
  const data = Object.fromEntries(new FormData(form).entries());
  data.closedDays = [...form.querySelectorAll('input[name="closedDays"]:checked')].map(input => Number(input.value));
  try {
    await api(`/api/barbershops/${encodeURIComponent(shopId)}/schedule`, { method: 'POST', body: data });
    showNotice('تم حفظ مواعيد العمل والإجازات. الحجوزات القديمة تظل كما هي.');
    await loadOwnedShops();
  } catch (error) { showNotice(error.message, 'error'); }
});

$('myBookings').addEventListener('submit', async event => {
  const form = event.target.closest('[data-rate-booking]');
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(form).entries());
    await api(`/api/barber-bookings/${encodeURIComponent(form.dataset.rateBooking)}/review`, { method: 'POST', body: { rating: Number(data.rating), comment: String(data.comment || '').trim() } });
    showNotice('شكرًا لك! تم حفظ تقييم الحلاق وتحديث تقييمه العام.');
    await loadMyBookings();
    await loadShops();
  } catch (error) {
    showNotice(error.message, 'error');
    button.disabled = false;
  }
});

onAuthStateChanged(auth, async user => {
  currentUser = user;
  setLoginVisibility(user);
  if (user) {
    await Promise.all([loadOwnedShops(), loadPaymentConfig(), loadMyBookings()]);
    const returnState = new URLSearchParams(location.search).get('payment');
    if (returnState === 'return') showNotice('رجعت من بوابة الدفع. الحالة النهائية ستظهر بعد تأكيد الإشعار الموثوق من بوابة الدفع.', 'warn');
    else if (returnState === 'cancelled') showNotice('لم تكتمل عملية الدفع. يمكنك إعادة المحاولة خلال مهلة الحجز.', 'warn');
    if (new URLSearchParams(location.search).has('booking')) $('myBookingsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    ownedShops = [];
    $('myBookings').innerHTML = '<div class="barber-empty">سجّل الدخول لعرض حجوزاتك.</div>';
    $('bookingPaymentMethod').value = 'onsite';
    $('onlinePaymentOption').disabled = true;
    $('onlinePaymentOption').textContent = 'الدفع أونلاين (سجّل الدخول أولًا)';
  }
});

setFinanceReportPreset('month');
loadShops();
