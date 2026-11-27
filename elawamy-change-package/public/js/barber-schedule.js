import { auth, onAuthStateChanged } from './firebase.js';
import { createBarberWhatsAppReminderUrl } from './barber-whatsapp.js';

const API_BASE = (() => {
  const localHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const localPort = ['5000', '5001'].includes(window.location.port);
  return localHost && localPort ? 'http://127.0.0.1:3000' : 'https://elawamy-file-server.vercel.app';
})();
const $ = id => document.getElementById(id);
let currentUser = null;
let profile = null;

function esc(value = '') { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function notice(message, type = 'info') { const el = $('scheduleNotice'); el.textContent = message; el.className = `barber-notice${type === 'error' ? ' error' : type === 'warn' ? ' warn' : ''}`; el.hidden = !message; if (message) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
function errorMessage(value) {
  const messages = {
    BARBER_PROFILE_NOT_LINKED: 'حسابك لسه مش مربوط بملف حلاق. استخدم كود الربط اللي أخدته من صاحب الصالون.',
    BARBER_CLAIM_CODE_INVALID: 'كود الربط غير صحيح.',
    BARBER_CLAIM_CODE_EXPIRED: 'انتهت صلاحية كود الربط. اطلب كودًا جديدًا من صاحب الصالون.',
    BARBER_PROFILE_ALREADY_LINKED: 'ملف الحلاق ده مرتبط بحساب آخر بالفعل.',
    BARBER_ACCOUNT_ALREADY_LINKED: 'حسابك مرتبط بملف حلاق بالفعل.',
    BARBER_IMAGE_NOT_FOUND: 'الصورة لم تصل للتخزين. ارفع الصورة مرة ثانية.',
    BARBER_IMAGE_INVALID: 'الصورة غير صالحة أو حجمها أكبر من 8 ميجابايت.',
    BARBER_IMAGE_PATH_INVALID: 'مسار الصورة غير صالح. ارفع الصورة من جديد.',
    BARBER_ATTENDANCE_ALREADY_SET: 'تم تسجيل حالة الحضور لهذا الحجز بالفعل.',
    BARBER_ATTENDANCE_TOO_EARLY: 'يمكن تسجيل الحضور بعد انتهاء الموعد فقط.',
    BARBER_ATTENDANCE_BOOKING_NOT_ACTIVE: 'لا يمكن تغيير الحضور إلا لحجز مؤكد.'
  };
  return messages[value] || value || 'حدث خطأ. حاول مرة أخرى.';
}
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (currentUser) headers.Authorization = `Bearer ${await currentUser.getIdToken()}`;
  let response;
  try { response = await fetch(`${API_BASE}${path}`, { method: options.method || 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }); }
  catch { throw new Error('تعذر الاتصال بخادم العوامي. تحقق من الإنترنت وحاول مرة أخرى.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorMessage(data.error || data.message || `HTTP_${response.status}`));
  return data;
}
function setLoginState(user) {
  document.querySelectorAll('[data-guest]').forEach(el => { el.hidden = Boolean(user); });
  document.querySelectorAll('[data-auth]').forEach(el => { el.hidden = !user; });
  $('signInPrompt').hidden = Boolean(user);
  $('barberUserLabel').textContent = user ? `مرحبًا ${user.displayName || user.email || ''}` : '';
}
function fillSchedule(profileData) {
  profile = profileData;
  $('profileTitle').textContent = `مواعيد ${profile.barberName}`;
  $('openTime').value = profile.openTime || '09:00';
  $('closeTime').value = profile.closeTime || '21:00';
  $('scheduleForm').querySelectorAll('input[name="closedDays"]').forEach(input => { input.checked = (profile.closedDays || []).includes(Number(input.value)); });
  const closedDatesText = $('scheduleForm').elements.namedItem('closedDatesText');
  if (closedDatesText) closedDatesText.value = (profile.closedDates || []).join('\n');
  $('barberProfileSummary').innerHTML = `<div class="barber-profile-identity">${profile.barberImageUrl ? `<img class="barber-profile-avatar" src="${esc(profile.barberImageUrl)}" alt="صورة الحلاق ${esc(profile.barberName)}">` : '<div class="barber-profile-avatar barber-profile-avatar-empty" aria-hidden="true">✂</div>'}<div><strong>${esc(profile.barberName)}</strong><p>${esc(profile.shopName)}</p><p>حالة الصالون: ${profile.shopStatus === 'active' ? 'معتمد ويستقبل الحجوزات' : 'قيد المراجعة أو غير نشط'}</p><p>ساعات الصالون: ${esc(profile.shopOpenTime || profile.openTime)} – ${esc(profile.shopCloseTime || profile.closeTime)}</p>${profile.shopClosedDays?.length ? `<p>إجازة الصالون: ${esc(profile.shopClosedDays.map(dayName).join('، '))}</p>` : ''}</div></div>${profile.imageUrl ? `<img class="barber-shop-photo barber-profile-shop-photo" src="${esc(profile.imageUrl)}" alt="صورة صالون ${esc(profile.shopName)}">` : ''}`;
  const count = Number(profile.ratingCount || 0);
  $('barberRatingSummary').textContent = count ? `★ ${Number(profile.rating || 0).toFixed(1)} من 5 · ${count} تقييم من العملاء` : 'لا توجد تقييمات حتى الآن. بعد المواعيد القادمة، يستطيع العملاء تقييم تجربتهم.';
  renderAppointments(profile.upcomingAppointments || []);
  renderTodayAppointments(profile.todayAppointments || []);
  $('claimPanel').hidden = true;
  $('schedulePanel').hidden = false;
}
function parseClosedDatesText(value) {
  return [...new Set(String(value || '').split(/[\s,،;；]+/).map(item => item.trim()).filter(Boolean))];
}
function dayName(day) {
  return ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'][Number(day)] || '';
}
function formatCreatedAt(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('ar-EG', { timeZone: 'Africa/Cairo', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}
function canRecordAttendance(item) {
  if (item.attendanceStatus) return false;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  if (String(item.localDate || '') < today) return true;
  if (String(item.localDate || '') > today) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const nowMinute = Number(values.hour) * 60 + Number(values.minute);
  const endMinute = Number.isInteger(item.endMinute) ? item.endMinute : (typeof item.endTime === 'string' && /^\d{2}:\d{2}$/.test(item.endTime) ? Number(item.endTime.slice(0, 2)) * 60 + Number(item.endTime.slice(3, 5)) : NaN);
  return Number.isFinite(endMinute) && endMinute <= nowMinute;
}
function renderTodayAppointments(items) {
  $('barberTodayAppointments').innerHTML = items.length ? items.map(item => {
    const status = item.attendanceStatus === 'completed' ? 'تم تنفيذ الخدمة' : item.attendanceStatus === 'no_show' ? 'العميل لم يحضر' : 'موعد مؤكد';
    const attendanceActions = !item.attendanceStatus && canRecordAttendance(item)
      ? `<button type="button" class="barber-button barber-button-primary" data-attendance-action="completed" data-booking-id="${esc(item.id)}">تم تنفيذ الخدمة</button><button type="button" class="barber-button barber-button-light" data-attendance-action="no_show" data-booking-id="${esc(item.id)}">العميل لم يحضر</button>` : '';
    const attendanceHint = !item.attendanceStatus && !canRecordAttendance(item)
      ? '<p class="barber-muted barber-small">تسجيل الحضور يتاح بعد انتهاء الموعد.</p>' : '';
    const reminderUrl = !item.attendanceStatus && !canRecordAttendance(item)
      ? createBarberWhatsAppReminderUrl({ ...item, barberName: profile?.barberName }, profile?.shopName) : '';
    const reminderAction = reminderUrl ? `<a class="barber-button barber-button-whatsapp" href="${esc(reminderUrl)}" target="_blank" rel="noopener noreferrer">تذكير واتساب</a>` : '';
    const actionButtons = [reminderAction, attendanceActions].filter(Boolean).join('');
    const actionRow = `${actionButtons ? `<div class="barber-booking-actions">${actionButtons}</div>` : ''}${attendanceHint}`;
    return `<article class="barber-booking-card"><span class="barber-status">${esc(status)}</span><h3>${esc(item.customerName || 'عميل')} — ${esc(item.serviceName || 'خدمة حلاقة')}</h3><p><strong>الوقت:</strong> ${esc(item.startTime)} – ${esc(item.endTime)}</p>${item.customerPhone ? `<p><strong>هاتف العميل:</strong> <a href="tel:${esc(item.customerPhone)}" dir="ltr">${esc(item.customerPhone)}</a></p>` : ''}<p><strong>السعر:</strong> ${Number(item.price || 0).toLocaleString('ar-EG')} ج.م · ${item.paymentStatus === 'paid' ? 'تم التحصيل' : 'الدفع عند الحضور'}</p>${item.attendanceUpdatedAt ? `<p class="barber-booking-created">تم تسجيل الحالة بواسطة ${esc(item.attendanceUpdatedByLabel || 'مستخدم')} في ${esc(formatCreatedAt(item.attendanceUpdatedAt))}</p>` : ''}${actionRow}</article>`;
  }).join('') : '<div class="barber-empty">لا توجد حجوزات مؤكدة مسجلة لك اليوم.</div>';
}
function renderAppointments(items) {
  $('barberAppointments').innerHTML = items.length ? items.map(item => {
    const reminderUrl = createBarberWhatsAppReminderUrl({ ...item, barberName: profile?.barberName }, profile?.shopName);
    const reminderAction = reminderUrl ? `<a class="barber-button barber-button-whatsapp" href="${esc(reminderUrl)}" target="_blank" rel="noopener noreferrer">تذكير واتساب</a>` : '';
    const cancelAction = item.paymentStatus !== 'paid'
      ? `<button type="button" class="barber-button barber-button-danger" data-cancel-barber-booking="${esc(item.id)}">إلغاء هذا الحجز</button>`
      : '<p class="barber-muted barber-small">الحجز مدفوع؛ تواصل مع صاحب الصالون إذا احتجت تعديلًا.</p>';
    const actions = reminderAction || item.paymentStatus !== 'paid'
      ? `<div class="barber-booking-actions">${reminderAction}${cancelAction}</div>` : cancelAction;
    return `<article class="barber-booking-card"><span class="barber-status">حجز مؤكد</span><h3>${esc(item.customerName || 'عميل')} — ${esc(item.serviceName || 'خدمة حلاقة')}</h3><p><strong>ميعاد الحلاقة:</strong> ${esc(item.localDate)} · من ${esc(item.startTime)} إلى ${esc(item.endTime)}</p>${item.customerPhone ? `<p><strong>رقم العميل:</strong> <a href="tel:${esc(item.customerPhone)}">${esc(item.customerPhone)}</a></p>` : '<p>العميل لم يضف رقم موبايل.</p>'}<p>السعر: ${Number(item.price || 0).toLocaleString('ar-EG')} ج.م · ${item.paymentStatus === 'paid' ? 'مدفوع' : 'الدفع عند الحضور'}</p>${item.createdAt ? `<p class="barber-booking-created">وقت تسجيل الحجز: ${esc(formatCreatedAt(item.createdAt))} بتوقيت مصر</p>` : ''}${actions}</article>`;
  }).join('') : '<div class="barber-empty">مفيش حجوزات قادمة مسجلة على جدولك حاليًا.</div>';
}
async function uploadBarberPhoto(file) {
  if (!file) throw new Error('اختار صورة للحلاق أولًا.');
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) throw new Error('الصورة لازم تكون JPG أو PNG أو WebP.');
  if (file.size < 1 || file.size > 8 * 1024 * 1024) throw new Error('حجم الصورة يجب ألا يتجاوز 8 ميجابايت.');
  if (!currentUser || !profile) throw new Error('سجّل الدخول واربط حساب الحلاق أولًا.');
  const response = await fetch(`${API_BASE}/api/barbershops/photo-upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await currentUser.getIdToken()}` },
    body: JSON.stringify({ purpose: 'barber', shopId: profile.shopId, barberId: profile.barberId, name: file.name, contentType: file.type, size: file.size })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorMessage(result.error || 'تعذر تجهيز رفع الصورة.'));
  const upload = await fetch(result.signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
  if (!upload.ok) throw new Error('فشل رفع صورة الحلاق إلى التخزين.');
  return result.path;
}

async function loadProfile() {
  if (!currentUser) return;
  try {
    const result = await api('/api/barber-schedule/me');
    fillSchedule(result.profile);
  } catch (error) {
    profile = null; $('schedulePanel').hidden = true; $('claimPanel').hidden = false;
    if (error.message.includes('كود الربط') || error.message === 'BARBER_PROFILE_NOT_LINKED' || error.message.includes('حسابك لسه')) notice(error.message, 'warn');
    else notice(error.message, 'error');
  }
}
$('claimForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentUser) return notice('سجّل الدخول أولًا.', 'warn');
  const button = $('claimSubmit'); button.disabled = true;
  try {
    const code = new FormData(event.currentTarget).get('code');
    const result = await api('/api/barbers/claim', { method: 'POST', body: { code } });
    event.currentTarget.reset();
    notice(`تم ربط حسابك بملف الحلاق ${result.profile.barberName} في ${result.profile.shopName}.`);
    await loadProfile();
  } catch (error) { notice(error.message, 'error'); }
  finally { button.disabled = false; }
});
$('scheduleForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!profile) return;
  const button = $('saveSchedule'); button.disabled = true; button.textContent = 'جاري الحفظ...';
  try {
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    data.closedDays = [...form.querySelectorAll('input[name="closedDays"]:checked')].map(input => Number(input.value));
    data.closedDates = parseClosedDatesText(form.elements.namedItem('closedDatesText')?.value);
    const result = await api('/api/barber-schedule/me', { method: 'POST', body: data });
    profile.openTime = result.openTime; profile.closeTime = result.closeTime; profile.closedDays = result.closedDays; profile.closedDates = result.closedDates;
    notice('تم حفظ مواعيدك. المواعيد الجديدة ستظهر للعملاء عند الحجز.');
    await loadProfile();
  } catch (error) { notice(error.message, 'error'); }
  finally { button.disabled = false; button.textContent = 'حفظ مواعيدي'; }
});
$('barberPhotoForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const file = form.querySelector('[name="image"]').files?.[0];
  const button = $('saveBarberPhoto');
  button.disabled = true;
  button.textContent = 'جاري رفع الصورة وحفظها...';
  try {
    const imagePath = await uploadBarberPhoto(file);
    await api('/api/barber-schedule/me/photo', { method: 'POST', body: { imagePath } });
    form.reset();
    notice('تم تحديث صورة الحلاق بنجاح.');
    await loadProfile();
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'حفظ صورة الحلاق';
  }
});
$('barberTodayAppointments').addEventListener('click', async event => {
  const button = event.target.closest('[data-attendance-action]');
  if (!button) return;
  const attendanceStatus = button.dataset.attendanceAction;
  if (attendanceStatus === 'no_show' && !window.confirm('تأكيد تسجيل إن العميل لم يحضر؟ لن يستطيع إرسال تقييم لهذا الحجز.')) return;
  const bookingId = button.dataset.bookingId;
  button.disabled = true;
  try {
    await api('/api/barber-bookings/attendance', { method: 'POST', body: { bookingId, attendanceStatus } });
    notice(attendanceStatus === 'completed' ? 'تم تسجيل تنفيذ الخدمة.' : 'تم تسجيل عدم حضور العميل.');
    await loadProfile();
  } catch (error) {
    notice(error.message, 'error');
    button.disabled = false;
  }
});
$('reloadTodayAppointments').addEventListener('click', loadProfile);

$('barberAppointments').addEventListener('click', async event => {
  const button = event.target.closest('[data-cancel-barber-booking]');
  if (!button) return;
  if (!window.confirm('متأكد إنك عايز تلغي حجز العميل؟ هيتحرر الموعد للناس التانية.')) return;
  button.disabled = true;
  try {
    await api('/api/barber-bookings/cancel', { method: 'POST', body: { bookingId: button.dataset.cancelBarberBooking } });
    notice('تم إلغاء الحجز وتحرير الموعد.');
    await loadProfile();
  } catch (error) {
    notice(error.message, 'error');
    button.disabled = false;
  }
});
$('reloadSchedule').addEventListener('click', loadProfile);
onAuthStateChanged(auth, async user => {
  currentUser = user; setLoginState(user);
  if (!user) { $('claimPanel').hidden = true; $('schedulePanel').hidden = true; return; }
  await loadProfile();
});
