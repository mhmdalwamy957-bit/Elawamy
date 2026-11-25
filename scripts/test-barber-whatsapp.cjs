#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');

async function main() {
  const {
    normalizeBarberWhatsAppPhone,
    createBarberWhatsAppReminderUrl
  } = await import('../public/js/barber-whatsapp.js');

  assert.equal(normalizeBarberWhatsAppPhone('01012345678'), '201012345678');
  assert.equal(normalizeBarberWhatsAppPhone('+20 10 1234 5678'), '201012345678');
  assert.equal(normalizeBarberWhatsAppPhone('00201012345678'), '201012345678');
  assert.equal(normalizeBarberWhatsAppPhone('١٠١٢٣٤٥٦٧٨'), '201012345678');
  assert.equal(normalizeBarberWhatsAppPhone('1012345678'), '201012345678');
  assert.equal(normalizeBarberWhatsAppPhone('12345'), '');
  assert.equal(normalizeBarberWhatsAppPhone('966501234567'), '', 'Ambiguous international numbers must not be guessed.');

  const booking = {
    customerName: 'أحمد', customerPhone: '01012345678', serviceName: 'قص شعر',
    barberName: 'محمود', localDate: '2026-11-02', startTime: '17:30', endTime: '18:00',
    price: 120, status: 'confirmed', attendanceStatus: ''
  };
  const reminderUrl = createBarberWhatsAppReminderUrl(booking, 'صالون العوامي');
  assert.ok(reminderUrl.startsWith('https://wa.me/201012345678?text='));
  const message = decodeURIComponent(new URL(reminderUrl).searchParams.get('text') || '');
  assert.match(message, /أحمد/);
  assert.match(message, /صالون العوامي/);
  assert.match(message, /02\/11\/2026/);
  assert.match(message, /17:30 إلى 18:00/);
  assert.match(message, /قص شعر/);
  assert.match(message, /120 جنيه/);
  assert.equal(createBarberWhatsAppReminderUrl({ ...booking, attendanceStatus: 'completed' }, 'صالون'), '');
  assert.equal(createBarberWhatsAppReminderUrl({ ...booking, status: 'cancelled' }, 'صالون'), '');
  assert.equal(createBarberWhatsAppReminderUrl({ ...booking, customerPhone: '12345' }, 'صالون'), '');

  console.log('Barber WhatsApp reminder checks passed: Egyptian phone normalization, Arabic digits, message fields, and ineligible bookings.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
