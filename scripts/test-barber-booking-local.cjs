#!/usr/bin/env node
'use strict';

const { randomUUID } = require('node:crypto');
const net = require('node:net');

const API_BASE = process.env.BARBER_TEST_API_BASE || 'http://127.0.0.1:3000';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';

if (!/^http:\/\/(127\.0\.0\.1|localhost):3000$/.test(API_BASE)) {
  console.error('Safety stop: this test only permits a local API on port 3000.');
  process.exit(2);
}
if (!/^(127\.0\.0\.1|localhost):9099$/.test(AUTH_HOST)) {
  console.error('Safety stop: this test only permits a local Auth Emulator on port 9099.');
  process.exit(2);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertLocalPort(address, label) {
  const match = /^(127\.0\.0\.1|localhost):(\d+)$/.exec(address);
  if (!match) throw new Error(`Safety stop: unexpected local endpoint for ${label}.`);
  const host = match[1];
  const port = Number(match[2]);
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timeout = setTimeout(() => socket.destroy(new Error('connection timed out')), 1500);
    socket.once('connect', () => { clearTimeout(timeout); socket.destroy(); resolve(); });
    socket.once('error', error => { clearTimeout(timeout); reject(new Error(`${label} is not listening at ${address} (${error.code || error.message}). Start the local emulators as described in README-LOCAL-BARBER-TEST.md.`)); });
  });
}

async function promoteLocalTestUserToAdmin(uid) {
  // This helper must only run against Auth Emulator, never a real Firebase project.
  if (!/^(127\.0\.0\.1|localhost):9099$/.test(AUTH_HOST)) {
    throw new Error('Safety stop: admin-claim setup is permitted only against the local Auth Emulator.');
  }
  const firebaseAdminApp = await import('firebase-admin/app');
  const firebaseAdminAuth = await import('firebase-admin/auth');
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || 'elawamy-8d7e9';
  const appName = `barber-local-test-admin-${process.pid}`;
  const adminApp = firebaseAdminApp.initializeApp({ projectId }, appName);
  try {
    await firebaseAdminAuth.getAuth(adminApp).setCustomUserClaims(uid, { admin: true });
  } finally {
    await adminApp.delete();
  }
}

async function jsonRequest(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(5000) });
  } catch (error) {
    const host = new URL(url).host;
    const code = error?.cause?.code ? ` (${error.cause.code})` : '';
    const nextStep = host.endsWith(':3000')
      ? 'شغّل خادم الـAPI المحلي من server/ بالأمر npm start بعد تشغيل محاكيات Firebase.'
      : 'شغّل محاكي Firebase المطلوب محليًا وتأكد من المنفذ المذكور.';
    throw new Error(`تعذر الاتصال بالخدمة المحلية ${host}${code}. ${nextStep} راجع README-LOCAL-BARBER-TEST.md.`);
  }
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  return { status: response.status, data };
}

async function api(path, { token, method = 'GET', body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return jsonRequest(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function dateInCairo(offsetDays) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const date = new Date(`${value.year}-${value.month}-${value.day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

async function main() {
  await assertLocalPort(AUTH_HOST, 'Firebase Auth Emulator');
  await assertLocalPort('127.0.0.1:8080', 'Firestore Emulator');
  const health = await api('/health');
  assert(health.status === 200 && health.data.ok === true, 'Local API health check failed. Start the local server first.');
  assert(health.data.localEmulators === true,
    'Safety stop: the server does not confirm local Auth + Firestore Emulators. Restart it with the safe command in README-LOCAL-BARBER-TEST.md. No fixture was created.');

  const unauth = await api('/api/barber-bookings', { method: 'POST', body: {} });
  assert(unauth.status === 401, `Expected an unauthenticated booking to return 401, got ${unauth.status}.`);
  console.log('PASS: booking creation without a Firebase token is rejected (401).');

  const random = randomUUID();
  const email = `barber-local-${Date.now()}-${random.slice(0, 8)}@example.test`;
  const password = `T9!${random}test`;
  const signup = await jsonRequest(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  assert(signup.status === 200 && signup.data.idToken && signup.data.localId,
    `Auth Emulator signup failed (${signup.status}). Check that Auth Emulator is running on ${AUTH_HOST}.`);
  const token = signup.data.idToken;

  const config = await api('/api/barber-bookings/payment-config', { token });
  assert(config.status === 200 && config.data.onlineAvailable === false,
    'Safety stop: online payment is not confirmed disabled. Restart the local server with XPAY_SECRET_KEY= and XPAY_WEBHOOK_SECRET=; no shop was created.');
  console.log('PASS: local test server confirms online payment is disabled.');

  const shopResult = await api('/api/barbershops', {
    token, method: 'POST',
    body: {
      name: `صالون اختبار محلي ${random.slice(0, 6)}`,
      phone: '+201234567890', city: 'اختبار محلي', address: 'عنوان تجريبي محلي',
      description: 'بيانات اختبار داخل Firebase Emulators فقط',
      openTime: '08:00', closeTime: '22:00', barberName: 'حلاق تجريبي', closedDays: []
    }
  });
  assert(shopResult.status === 201 && shopResult.data.shop?.id && shopResult.data.shop?.status === 'pending',
    `New test shop must be created pending admin approval (${shopResult.status}): ${shopResult.data.error || JSON.stringify(shopResult.data)}`);
  const shopId = shopResult.data.shop.id;
  const barberClaimCode = shopResult.data.barberClaimCode;
  assert(/^[a-f0-9]{24}$/.test(barberClaimCode || ''), 'Shop creation must return a one-time claim code for the first barber.');

  const publicBeforeApproval = await api('/api/barbershops');
  assert(publicBeforeApproval.status === 200 && !publicBeforeApproval.data.shops.some(shop => shop.id === shopId),
    'A pending shop must not appear in the public shops list.');
  const detailsBeforeApproval = await api(`/api/barbershops/${encodeURIComponent(shopId)}`);
  assert(detailsBeforeApproval.status === 404, 'A pending shop must not be exposed by the public details route.');
  const nonAdminReview = await api(`/api/admin/barbershops/${encodeURIComponent(shopId)}/review`, {
    token, method: 'POST', body: { action: 'approve' }
  });
  assert(nonAdminReview.status === 403, `A non-admin must be forbidden from approving a shop, got ${nonAdminReview.status}.`);
  const pendingQueueAsNonAdmin = await api('/api/admin/barbershops/pending', { token });
  assert(pendingQueueAsNonAdmin.status === 403, `A non-admin must be forbidden from reading the admin queue, got ${pendingQueueAsNonAdmin.status}.`);
  console.log('PASS: new shops stay pending, hidden from public routes, and review APIs reject non-admin users.');

  await promoteLocalTestUserToAdmin(signup.data.localId);
  const adminSignIn = await jsonRequest(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  assert(adminSignIn.status === 200 && adminSignIn.data.idToken,
    `Auth Emulator could not issue a fresh token with admin claim (${adminSignIn.status}).`);
  const adminToken = adminSignIn.data.idToken;
  const pendingQueue = await api('/api/admin/barbershops/pending', { token: adminToken });
  assert(pendingQueue.status === 200 && pendingQueue.data.shops.some(shop => shop.id === shopId),
    'Admin should see the pending test shop in the review queue.');
  const approved = await api(`/api/admin/barbershops/${encodeURIComponent(shopId)}/review`, {
    token: adminToken, method: 'POST', body: { action: 'approve' }
  });
  assert(approved.status === 200 && approved.data.status === 'active',
    `Admin approval failed (${approved.status}): ${approved.data.error || JSON.stringify(approved.data)}`);
  console.log('PASS: verified admin claim can approve a pending shop.');

  const barberEmail = `barber-profile-${Date.now()}-${random.slice(0, 8)}@example.test`;
  const barberPassword = `B9!${random}barber`;
  const barberSignup = await jsonRequest(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: barberEmail, password: barberPassword, returnSecureToken: true })
  });
  assert(barberSignup.status === 200 && barberSignup.data.idToken, `Auth Emulator could not create barber account (${barberSignup.status}).`);
  const barberToken = barberSignup.data.idToken;
  const linked = await api('/api/barbers/claim', { token: barberToken, method: 'POST', body: { code: barberClaimCode } });
  assert(linked.status === 200 && linked.data.profile?.barberId, `Barber claim code did not link the account (${linked.status}): ${linked.data.error || ''}`);
  const savedSchedule = await api('/api/barber-schedule/me', { token: barberToken, method: 'POST', body: { openTime: '10:00', closeTime: '20:00', closedDays: [] } });
  assert(savedSchedule.status === 200 && savedSchedule.data.openTime === '10:00' && savedSchedule.data.closeTime === '20:00',
    `Barber-specific schedule was not saved (${savedSchedule.status}): ${savedSchedule.data.error || ''}`);
  const profile = await api('/api/barber-schedule/me', { token: barberToken });
  assert(profile.status === 200 && profile.data.profile?.barberName === 'حلاق تجريبي', 'Linked barber should be able to load their own profile.');
  console.log('PASS: one-time claim code links a barber account; personal work hours save and reload.');

  const serviceResult = await api(`/api/barbershops/${encodeURIComponent(shopId)}/services`, {
    token: adminToken, method: 'POST', body: { name: 'قص شعر تجريبي', durationMinutes: 30, price: 100 }
  });
  assert(serviceResult.status === 201 && serviceResult.data.service?.id,
    `Could not create test service (${serviceResult.status}): ${serviceResult.data.error || 'unexpected response'}`);
  const serviceId = serviceResult.data.service.id;

  const detail = await api(`/api/barbershops/${encodeURIComponent(shopId)}`);
  assert(detail.status === 200 && detail.data.barbers?.[0]?.id,
    `Could not read test shop and barber (${detail.status}): ${detail.data.error || 'unexpected response'}`);
  const barberId = detail.data.barbers[0].id;
  const date = dateInCairo(1);
  const startTime = '10:00';
  const closedDate = dateInCairo(2);
  const barberHoliday = await api(`/api/barbershops/${encodeURIComponent(shopId)}/barbers/${encodeURIComponent(barberId)}/settings`, {
    token: adminToken, method: 'POST',
    body: { name: 'حلاق تجريبي', openTime: '10:00', closeTime: '20:00', closedDays: [], closedDates: [closedDate], active: true }
  });
  assert(barberHoliday.status === 200 && barberHoliday.data.barber?.closedDates?.includes(closedDate),
    `Owner could not save a one-off barber holiday (${barberHoliday.status}): ${barberHoliday.data.error || ''}`);
  const holidayQuery = new URLSearchParams({ serviceId, barberId, date: closedDate });
  const holidayAvailability = await api(`/api/barbershops/${encodeURIComponent(shopId)}/availability?${holidayQuery}`);
  assert(holidayAvailability.status === 200 && Array.isArray(holidayAvailability.data.slots) && holidayAvailability.data.slots.length === 0,
    'A date-specific barber holiday must suppress all available slots.');
  const holidayBooking = await api('/api/barber-bookings', {
    token: adminToken, method: 'POST',
    body: { shopId, serviceId, barberId, date: closedDate, startTime, paymentMethod: 'onsite', customerName: 'عميل اختبار إجازة', customerPhone: '' }
  });
  assert(holidayBooking.status === 409 && holidayBooking.data.error === 'BARBER_DATE_CLOSED',
    `The API must reject a direct booking on an individual holiday (got ${holidayBooking.status}:${holidayBooking.data.error || 'ok'}).`);
  const profileWithHoliday = await api('/api/barber-schedule/me', { token: barberToken });
  assert(profileWithHoliday.status === 200 && profileWithHoliday.data.profile?.closedDates?.includes(closedDate),
    'The assigned barber should see their saved one-off holidays.');
  console.log(`PASS: one-off barber holiday ${closedDate} is saved, hidden from available slots, and rejected by direct booking.`);
  const weeklyBarberOffDate = dateInCairo(5);
  const weeklyBarberOffDay = new Date(`${weeklyBarberOffDate}T12:00:00Z`).getUTCDay();
  const weeklyOffSaved = await api(`/api/barbershops/${encodeURIComponent(shopId)}/barbers/${encodeURIComponent(barberId)}/settings`, {
    token: adminToken, method: 'POST',
    body: { name: 'حلاق تجريبي', openTime: '10:00', closeTime: '20:00', closedDays: [weeklyBarberOffDay], closedDates: [], active: true }
  });
  assert(weeklyOffSaved.status === 200, `Could not save weekly barber day off (${weeklyOffSaved.status}).`);
  const weeklyOffQuery = new URLSearchParams({ serviceId, barberId, date: weeklyBarberOffDate });
  const weeklyOffAvailability = await api(`/api/barbershops/${encodeURIComponent(shopId)}/availability?${weeklyOffQuery}`);
  assert(weeklyOffAvailability.status === 200 && weeklyOffAvailability.data.closureReason === 'BARBER_WEEKLY_DAY_OFF',
    'A barber-only weekly closure must be identified as BARBER_WEEKLY_DAY_OFF while the shop is open.');
  const weeklyOffBooking = await api('/api/barber-bookings', {
    token: adminToken, method: 'POST',
    body: { shopId, serviceId, barberId, date: weeklyBarberOffDate, startTime, paymentMethod: 'onsite', customerName: 'عميل اختبار الإجازة الأسبوعية', customerPhone: '' }
  });
  assert(weeklyOffBooking.status === 409 && weeklyOffBooking.data.error === 'BARBER_WEEKLY_DAY_OFF',
    'A direct booking on the barber weekly day off must be rejected with its own reason.');
  console.log('PASS: barber-only weekly day off has its own availability and booking error while the salon stays open.');
  const weeklyOffReset = await api(`/api/barbershops/${encodeURIComponent(shopId)}/barbers/${encodeURIComponent(barberId)}/settings`, {
    token: adminToken, method: 'POST',
    body: { name: 'حلاق تجريبي', openTime: '10:00', closeTime: '20:00', closedDays: [], closedDates: [], active: true }
  });
  assert(weeklyOffReset.status === 200, 'Could not reset barber weekly closed days for the remaining integration tests.');

  const shopHoliday = dateInCairo(3);
  const savedShopSchedule = await api(`/api/barbershops/${encodeURIComponent(shopId)}/schedule`, {
    token: adminToken, method: 'POST',
    body: { openTime: '08:00', closeTime: '22:00', closedDays: [], closedDates: [shopHoliday] }
  });
  assert(savedShopSchedule.status === 200 && savedShopSchedule.data.closedDates?.includes(shopHoliday),
    `Owner could not save a whole-salon holiday (${savedShopSchedule.status}): ${savedShopSchedule.data.error || ''}`);
  const shopHolidayQuery = new URLSearchParams({ serviceId, barberId, date: shopHoliday });
  const shopHolidayAvailability = await api(`/api/barbershops/${encodeURIComponent(shopId)}/availability?${shopHolidayQuery}`);
  assert(shopHolidayAvailability.status === 200 && shopHolidayAvailability.data.closed === true && shopHolidayAvailability.data.closureReason === 'BARBER_SHOP_DATE_CLOSED' && shopHolidayAvailability.data.slots.length === 0,
    'A whole-salon holiday must suppress availability and identify the closure reason.');
  const shopHolidayBooking = await api('/api/barber-bookings', {
    token: adminToken, method: 'POST',
    body: { shopId, serviceId, barberId, date: shopHoliday, startTime, paymentMethod: 'onsite', customerName: 'عميل اختبار إجازة الصالون', customerPhone: '' }
  });
  assert(shopHolidayBooking.status === 409 && shopHolidayBooking.data.error === 'BARBER_SHOP_DATE_CLOSED',
    `The API must reject a direct booking on a whole-salon holiday (got ${shopHolidayBooking.status}:${shopHolidayBooking.data.error || 'ok'}).`);
  console.log(`PASS: whole-salon holiday ${shopHoliday} is saved, availability is empty, and direct booking is rejected.`);

  const query = new URLSearchParams({ serviceId, barberId, date });
  const availability = await api(`/api/barbershops/${encodeURIComponent(shopId)}/availability?${query}`);
  assert(availability.status === 200 && Array.isArray(availability.data.slots) && availability.data.slots.includes(startTime) && !availability.data.slots.includes('09:00'),
    `Personal hours should include ${startTime} and exclude 09:00. Response: ${availability.data.error || availability.status}`);
  console.log(`PASS: test shop/service/barber ready; ${date} ${startTime} is available in Cairo time.`);

  const bookingBody = {
    shopId, serviceId, barberId, date, startTime,
    paymentMethod: 'onsite', customerName: 'عميل اختبار محلي', customerPhone: ''
  };
  const results = await Promise.all([
    api('/api/barber-bookings', { token: adminToken, method: 'POST', body: bookingBody }),
    api('/api/barber-bookings', { token: adminToken, method: 'POST', body: bookingBody })
  ]);
  const successes = results.filter(result => result.status === 201 && result.data.booking?.id);
  const conflicts = results.filter(result => result.status === 409 && result.data.error === 'BARBER_SLOT_UNAVAILABLE');
  assert(successes.length === 1 && conflicts.length === 1,
    `Duplicate-booking protection did not produce exactly one 201 and one 409. Actual: ${results.map(result => `${result.status}:${result.data.error || 'ok'}`).join(', ')}`);
  console.log('PASS: two simultaneous requests for the same slot produced one confirmed booking and one 409 BARBER_SLOT_UNAVAILABLE.');

  const mine = await api('/api/barber-bookings/mine', { token: adminToken });
  assert(mine.status === 200 && Array.isArray(mine.data.bookings), `Could not read test bookings (${mine.status}).`);
  const matches = mine.data.bookings.filter(booking => booking.shopId === shopId && booking.localDate === date && booking.startTime === startTime);
  assert(matches.length === 1 && matches[0].status === 'confirmed' && matches[0].paymentStatus === 'unpaid',
    `Expected exactly one onsite confirmed/unpaid booking, found ${matches.length}.`);

  console.log('PASS: one onsite booking persisted as confirmed/unpaid.');
  const newDate = dateInCairo(4);
  const forbiddenReschedule = await api(`/api/barber-bookings/${encodeURIComponent(matches[0].id)}/reschedule`, {
    token: barberToken, method: 'POST', body: { date: newDate, startTime: '10:30' }
  });
  assert(forbiddenReschedule.status === 403 && forbiddenReschedule.data.error === 'BARBER_RESCHEDULE_FORBIDDEN',
    'A linked barber must not reschedule a customer-owned booking through the customer route.');
  const rescheduled = await api(`/api/barber-bookings/${encodeURIComponent(matches[0].id)}/reschedule`, {
    token: adminToken, method: 'POST', body: { date: newDate, startTime: '10:30' }
  });
  assert(rescheduled.status === 200 && rescheduled.data.booking?.localDate === newDate && rescheduled.data.booking?.startTime === '10:30',
    `Customer reschedule failed (${rescheduled.status}): ${rescheduled.data.error || JSON.stringify(rescheduled.data)}`);
  const afterReschedule = await api('/api/barber-bookings/mine', { token: adminToken });
  const movedBooking = afterReschedule.data.bookings.find(booking => booking.id === matches[0].id);
  assert(movedBooking?.localDate === newDate && movedBooking.startTime === '10:30' && movedBooking.rescheduleCount === 1,
    'Rescheduling must persist the new appointment date/time and increment its audit counter.');
  const oldAvailabilityQuery = new URLSearchParams({ serviceId, barberId, date });
  const oldAvailability = await api(`/api/barbershops/${encodeURIComponent(shopId)}/availability?${oldAvailabilityQuery}`);
  assert(oldAvailability.status === 200 && oldAvailability.data.slots.includes(startTime),
    'Rescheduling must release the old appointment locks.');
  const newAvailabilityQuery = new URLSearchParams({ serviceId, barberId, date: newDate });
  const newAvailability = await api(`/api/barbershops/${encodeURIComponent(shopId)}/availability?${newAvailabilityQuery}`);
  assert(newAvailability.status === 200 && !newAvailability.data.slots.includes('10:30'),
    'Rescheduling must lock the new appointment time.');
  const barberScheduleAfterBooking = await api('/api/barber-schedule/me', { token: barberToken });
  assert(barberScheduleAfterBooking.status === 200 && barberScheduleAfterBooking.data.profile.upcomingAppointments.some(item => item.customerName === 'عميل اختبار محلي' && item.localDate === newDate && item.startTime === '10:30'),
    'The linked barber should see the rescheduled customer appointment.');
  console.log('PASS: customers can reschedule an upcoming unpaid booking transactionally, old locks are released, and the barber sees the new time.');
  const barberCancelledBooking = await api('/api/barber-bookings/cancel', { token: barberToken, method: 'POST', body: { bookingId: matches[0].id } });
  assert(barberCancelledBooking.status === 200 && barberCancelledBooking.data.ok === true,
    `The assigned barber should be able to cancel an unpaid upcoming booking (${barberCancelledBooking.status}): ${barberCancelledBooking.data.error || ''}`);
  console.log('PASS: the assigned barber can cancel their own unpaid booking, which releases its time slot.');
  const retryAfterCancel = await api('/api/barber-bookings', { token: adminToken, method: 'POST', body: bookingBody });
  assert(retryAfterCancel.status === 201 && retryAfterCancel.data.booking?.id,
    `Cancelling the latest unpaid booking must release the seven-day restriction (${retryAfterCancel.status}:${retryAfterCancel.data.error || ''}).`);
  const cleanupRetry = await api('/api/barber-bookings/cancel', { token: barberToken, method: 'POST', body: { bookingId: retryAfterCancel.data.booking.id } });
  assert(cleanupRetry.status === 200, 'Could not cancel the retry booking created by the cooldown regression test.');
  console.log('PASS: cancelling the most recent booking releases the one-booking-per-week restriction safely.');
  console.log('LOCAL BARBER BOOKING TESTS PASSED. Test records exist only in the configured local emulators.');
}

main().catch(error => {
  console.error(`LOCAL BARBER BOOKING TEST FAILED: ${error?.message || error}`);
  process.exitCode = 1;
});
