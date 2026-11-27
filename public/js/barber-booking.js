import { auth, onAuthStateChanged } from './firebase.js';

const API_BASE = (() => {
  const localHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const localPort = ['5000', '5001'].includes(window.location.port);
  return localHost && localPort ? 'http://127.0.0.1:3000' : 'https://elawamy-file-server.vercel.app';
})();
const $ = id => document.getElementById(id);
let currentUser = null;
let shops = [];
let selectedShop = null;
let details = null;
let selectedTime = '';

function esc(value = '') { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function money(value) { const n = Number(value); return Number.isFinite(n) ? n.toLocaleString('ar-EG', { maximumFractionDigits: 2 }) : '0'; }
function ratingLabel(barber) { const count = Number(barber?.ratingCount || 0); const rating = Number(barber?.rating || 0); return count ? `★ ${rating.toFixed(1)} (${count} تقييم)` : 'لا توجد تقييمات بعد'; }
function notice(message, type = 'info') { const el = $('bookingNotice'); el.textContent = message; el.className = `barber-notice${type === 'error' ? ' error' : type === 'warn' ? ' warn' : ''}`; el.hidden = !message; if (message) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (currentUser) headers.Authorization = `Bearer ${await currentUser.getIdToken()}`;
  let response;
  try { response = await fetch(`${API_BASE}${path}`, { method: options.method || 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }); }
  catch { throw new Error('تعذر الاتصال بخادم الحجز. تحقق من الإنترنت وحاول مرة أخرى.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (data.error === 'BARBER_BOOKING_COOLDOWN' && data.nextBookingAllowedAt) {
      const allowedAt = new Date(data.nextBookingAllowedAt).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'short' });
      throw new Error(`لا يمكنك حجز موعد آخر قبل مرور 7 أيام. تقدر تحجز مرة أخرى بعد ${allowedAt}.`);
    }
    const messages = {
      BARBER_BOOKING_COOLDOWN: 'لا يمكنك حجز موعد آخر قبل مرور 7 أيام على آخر حجز لك.',
      BARBER_SLOT_UNAVAILABLE: 'الموعد اتحجز للتو. اختار موعدًا آخر.',
      BARBER_SHOP_DATE_CLOSED: 'الصالون كله إجازة في التاريخ المختار. اختار يومًا آخر.',
      BARBER_SHOP_CLOSED: 'الصالون إجازة في اليوم المختار. اختار يومًا آخر.',
      BARBER_DATE_CLOSED: 'الحلاق إجازة في التاريخ المختار. اختار حلاقًا أو يومًا آخر.',
      BARBER_WEEKLY_DAY_OFF: 'هذا يوم الإجازة الأسبوعية للحلاق. اختار يومًا آخر.',
      BARBER_BOOKING_NOT_CANCELLABLE: 'لا يمكن إلغاء الحجز في حالته الحالية.'
    };
    throw new Error(data.message || messages[data.error] || data.error || `HTTP_${response.status}`);
  }
  return data;
}
function cairoToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function dateInDays(days) { const date = new Date(`${cairoToday()}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function fillOptions(select, items, placeholder, label) { select.innerHTML = `<option value="">${esc(placeholder)}</option>` + items.map(item => `<option value="${esc(item.id)}">${esc(label(item))}</option>`).join(''); select.disabled = items.length === 0; }
function renderSelectedBarberPreview() {
  const preview = $('bookingBarberPreview');
  if (!preview) return;
  const barber = details?.barbers?.find(item => item.id === $('bookingBarber').value);
  if (!barber) { preview.hidden = true; preview.innerHTML = ''; return; }
  preview.innerHTML = `${barber.imageUrl ? `<img class="barber-profile-avatar" src="${esc(barber.imageUrl)}" alt="صورة ${esc(barber.name)}">` : '<div class="barber-profile-avatar barber-profile-avatar-empty" aria-hidden="true">✂</div>'}<div><strong>${esc(barber.name)}</strong><p>${esc(ratingLabel(barber))}</p><p>اختار اليوم لعرض المواعيد المتاحة للحلاق.</p></div>`;
  preview.hidden = false;
}
function setLoginState(user) {
  document.querySelectorAll('[data-guest]').forEach(el => { el.hidden = Boolean(user); });
  document.querySelectorAll('[data-auth]').forEach(el => { el.hidden = !user; });
  $('signInPrompt').hidden = Boolean(user);
  $('bookingSigninHint').hidden = Boolean(user);
  $('barberUserLabel').textContent = user ? `مرحبًا ${user.displayName || user.email || ''}` : '';
}
async function loadShops() {
  try {
    const result = await api('/api/barbershops');
    shops = result.shops || [];
    fillOptions($('bookingShop'), shops, 'اختار صالون الحلاقة', shop => `${shop.name} — ${shop.city}`);
    const requested = new URLSearchParams(location.search).get('shop');
    if (requested && shops.some(shop => shop.id === requested)) $('bookingShop').value = requested;
    await loadShopDetails();
  } catch (error) { $('bookingShop').innerHTML = `<option value="">${esc(error.message)}</option>`; notice(error.message, 'error'); }
}
async function loadShopDetails() {
  const shopId = $('bookingShop').value;
  selectedShop = shops.find(shop => shop.id === shopId) || null;
  details = null; selectedTime = ''; $('bookingStartTime').value = ''; $('bookingSlots').innerHTML = '<p class="barber-muted">جاري تحميل الخدمات والحلاقين...</p>'; $('bookingSummary').hidden = true; $('submitBooking').disabled = true;
  $('bookingService').disabled = true; $('bookingBarber').disabled = true;
  if (!selectedShop) {
    $('selectedShopSummary').hidden = true;
    $('bookingService').innerHTML = '<option value="">اختار الصالون أولًا</option>';
    $('bookingBarber').innerHTML = '<option value="">اختار الصالون أولًا</option>';
    $('bookingSlots').innerHTML = '<p class="barber-muted">اختار الصالون لعرض المواعيد المتاحة.</p>';
    $('slotsMeta').textContent = 'اختار الصالون أولًا.';
    return;
  }
  try {
    const result = await api(`/api/barbershops/${encodeURIComponent(shopId)}`);
    details = result;
    const shop = result.shop || selectedShop;
    $('selectedShopSummary').hidden = false;
    $('selectedShopSummary').innerHTML = `${shop.imageUrl ? `<img src="${esc(shop.imageUrl)}" alt="صورة ${esc(shop.name)}" class="barber-shop-photo">` : ''}<div><strong>${esc(shop.name)}</strong><p>📍 ${esc(shop.city)} · ${esc(shop.address)}</p><p>${esc(shop.description || '')}</p><p>مواعيد الصالون الافتراضية ${esc(shop.openTime)} – ${esc(shop.closeTime)}. قد تختلف مواعيد كل حلاق.</p></div>`;
    fillOptions($('bookingService'), result.services || [], 'اختار الخدمة', item => `${item.name} — ${money(item.price)} ج.م / ${item.durationMinutes} دقيقة`);
    fillOptions($('bookingBarber'), result.barbers || [], 'اختار الحلاق', item => `${item.name} — ${ratingLabel(item)}`);
    renderSelectedBarberPreview();
    if (!(result.services || []).length || !(result.barbers || []).length) {
      $('bookingSlots').innerHTML = '<p class="barber-muted">الصالون لم يجهّز الخدمات أو الحلاقين للحجز بعد.</p>';
      $('slotsMeta').textContent = 'لا توجد بيانات حجز مكتملة.';
      return;
    }
    await loadSlots();
  } catch (error) {
    $('bookingSlots').innerHTML = `<p class="barber-muted">${esc(error.message)}</p>`;
    notice(error.message, 'error');
  }
}
async function loadSlots() {
  selectedTime = ''; $('bookingStartTime').value = ''; $('bookingSummary').hidden = true; $('submitBooking').disabled = true;
  const serviceId = $('bookingService').value; const barberId = $('bookingBarber').value; const date = $('bookingDate').value;
  if (!selectedShop || !serviceId || !barberId || !date) {
    $('bookingSlots').innerHTML = '<p class="barber-muted">اختار الخدمة والحلاق واليوم لعرض المواعيد.</p>'; $('slotsMeta').textContent = 'اختار تفاصيل الحجز أولًا.'; return;
  }
  $('bookingSlots').innerHTML = '<p class="barber-muted">جاري البحث عن المواعيد...</p>'; $('slotsMeta').textContent = 'جاري تحديث المواعيد';
  try {
    const query = new URLSearchParams({ serviceId, barberId, date });
    const result = await api(`/api/barbershops/${encodeURIComponent(selectedShop.id)}/availability?${query}`);
    if (!result.slots?.length) {
      const closureMessage = result.closureReason === 'BARBER_SHOP_DATE_CLOSED'
        ? 'الصالون كله إجازة في التاريخ ده. اختار يومًا آخر.'
        : result.closureReason === 'BARBER_DATE_CLOSED'
          ? 'الحلاق إجازة في التاريخ ده. اختار يومًا آخر.'
          : result.closureReason === 'BARBER_SHOP_CLOSED'
            ? 'الصالون إجازة في اليوم ده من الأسبوع. اختار يومًا آخر.'
            : result.closureReason === 'BARBER_WEEKLY_DAY_OFF'
              ? 'ده يوم الإجازة الأسبوعية للحلاق. اختار يومًا آخر.'
              : 'لا توجد أوقات متاحة في اليوم ده. اختار يومًا آخر.';
      $('bookingSlots').innerHTML = `<p class="barber-muted">${esc(closureMessage)}</p>`; $('slotsMeta').textContent = 'لا توجد مواعيد';
    } else { $('bookingSlots').innerHTML = result.slots.map(time => `<button class="barber-slot" type="button" data-slot="${esc(time)}" aria-pressed="false">${esc(time)}</button>`).join(''); $('slotsMeta').textContent = `${result.slots.length} موعد متاح للحلاق المختار`; }
  } catch (error) { $('bookingSlots').innerHTML = `<p class="barber-muted">${esc(error.message)}</p>`; $('slotsMeta').textContent = 'تعذر تحميل المواعيد'; }
}
function updateSummary() {
  const service = details?.services?.find(item => item.id === $('bookingService').value);
  const barber = details?.barbers?.find(item => item.id === $('bookingBarber').value);
  const date = $('bookingDate').value;
  if (!service || !barber || !date || !selectedTime) { $('bookingSummary').hidden = true; $('submitBooking').disabled = true; return; }
  $('bookingSummary').innerHTML = `الحجز: <strong>${esc(selectedShop.name)}</strong> · <strong>${esc(service.name)}</strong> مع <strong>${esc(barber.name)}</strong> يوم <strong>${esc(date)}</strong> الساعة <strong>${esc(selectedTime)}</strong> · السعر <strong>${money(service.price)} ج.م</strong> · تقييم الحلاق <strong>${esc(ratingLabel(barber))}</strong>`;
  $('bookingSummary').hidden = false; $('submitBooking').disabled = !currentUser; $('submitBooking').textContent = currentUser ? 'أكد الحجز النقدي' : 'سجّل الدخول لإتمام الحجز';
}
$('bookingShop').addEventListener('change', async () => { const url = new URL(location.href); if ($('bookingShop').value) url.searchParams.set('shop', $('bookingShop').value); else url.searchParams.delete('shop'); history.replaceState(null, '', url); await loadShopDetails(); });
for (const id of ['bookingService', 'bookingBarber', 'bookingDate']) $(id).addEventListener('change', loadSlots);
$('bookingBarber').addEventListener('change', renderSelectedBarberPreview);
$('bookingSlots').addEventListener('click', event => { const btn = event.target.closest('[data-slot]'); if (!btn) return; selectedTime = btn.dataset.slot; $('bookingStartTime').value = selectedTime; $('bookingSlots').querySelectorAll('[data-slot]').forEach(slot => slot.setAttribute('aria-pressed', String(slot === btn))); updateSummary(); });
function receiptDate(date) {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : new Intl.DateTimeFormat('ar-EG', { timeZone: 'Africa/Cairo', dateStyle: 'full' }).format(d);
}
function renderBookingReceipt(booking, service, barber, customerName, customerPhone, date, startTime, shop) {
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
      <div><dt>اليوم والتاريخ</dt><dd>${esc(receiptDate(date))} (${esc(date)})</dd></div>
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
}
$('printBookingReceipt').addEventListener('click', () => window.print());

$('bookingForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentUser) { notice('سجّل الدخول أولًا لتأكيد الحجز.', 'warn'); return; }
  if (!selectedShop || !selectedTime) { notice('اختار موعدًا متاحًا أولًا.', 'warn'); return; }
  const button = $('submitBooking'); button.disabled = true; button.textContent = 'جاري تأكيد الموعد...';
  try {
    const result = await api('/api/barber-bookings', { method: 'POST', body: {
      shopId: selectedShop.id, serviceId: $('bookingService').value, barberId: $('bookingBarber').value,
      date: $('bookingDate').value, startTime: selectedTime, paymentMethod: 'onsite',
      customerName: $('bookingCustomerName').value.trim(), customerPhone: $('bookingCustomerPhone').value.trim()
    }});
    const service = details.services.find(item => item.id === $('bookingService').value);
    const barber = details.barbers.find(item => item.id === $('bookingBarber').value);
    const bookingDate = $('bookingDate').value;
    const customerName = $('bookingCustomerName').value.trim();
    const customerPhone = $('bookingCustomerPhone').value.trim();
    $('bookingSuccessText').textContent = `تم حجز ${service.name} مع ${barber.name} يوم ${bookingDate} الساعة ${selectedTime}. ادفع ${money(service.price)} جنيه نقدًا داخل الصالون عند الحضور.`;
    renderBookingReceipt(result.booking || {}, service, barber, customerName, customerPhone, bookingDate, selectedTime, details.shop || selectedShop);
    $('bookingSuccess').hidden = false; $('bookingSuccess').scrollIntoView({ behavior: 'smooth', block: 'start' });
    notice('تم تأكيد الحجز. جاري فتح شاشة الطباعة؛ يمكنك اختيار حفظ PDF إذا لم تتوفر طابعة.');
    await loadSlots();
    window.setTimeout(() => { try { window.print(); } catch {} }, 250);
  } catch (error) { notice(error.message, 'error'); await loadSlots(); }
  finally { button.textContent = currentUser ? 'أكد الحجز النقدي' : 'سجّل الدخول لإتمام الحجز'; updateSummary(); }
});
$('bookingDate').min = cairoToday(); $('bookingDate').max = dateInDays(90); $('bookingDate').value = cairoToday();
$('bookingCustomerName').addEventListener('input', updateSummary);
onAuthStateChanged(auth, async user => { currentUser = user; setLoginState(user); if (user) $('bookingCustomerName').value = user.displayName || ''; updateSummary(); });
loadShops();
