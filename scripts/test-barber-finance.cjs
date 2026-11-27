#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');

(async () => {
  const { summarizeBarberFinance } = await import('../public/js/barber-finance.js');
  const bookings = [
    { id: 'paid-done', localDate: '2026-10-01', startTime: '10:00', barberName: 'أحمد', serviceName: 'قص شعر', price: 80, status: 'confirmed', attendanceStatus: 'completed', paymentStatus: 'paid' },
    { id: 'unpaid-done', localDate: '2026-10-01', startTime: '11:00', barberName: 'أحمد', serviceName: 'قص شعر', price: 120, status: 'confirmed', attendanceStatus: 'completed', paymentStatus: 'unpaid' },
    { id: 'future', localDate: '2026-10-02', startTime: '12:00', barberName: 'محمود', serviceName: 'ذقن', price: 90, status: 'confirmed', attendanceStatus: '', paymentStatus: 'unpaid' },
    { id: 'cancelled', localDate: '2026-10-02', startTime: '13:00', barberName: 'أحمد', serviceName: 'ذقن', price: 50, status: 'cancelled', attendanceStatus: '', paymentStatus: 'paid' },
    { id: 'no-show', localDate: '2026-10-03', startTime: '14:00', barberName: 'أحمد', serviceName: 'قص شعر', price: 30, status: 'confirmed', attendanceStatus: 'no_show', paymentStatus: 'paid' },
    { id: 'bad-price', localDate: '2026-10-03', startTime: '15:00', barberName: 'محمود', serviceName: 'ذقن', price: 'not-number', status: 'confirmed', attendanceStatus: 'completed', paymentStatus: 'unpaid' }
  ];

  const result = summarizeBarberFinance(bookings);
  assert.equal(result.bookingCount, 6);
  assert.equal(result.completedCount, 3);
  assert.equal(result.cancelledCount, 1);
  assert.equal(result.noShowCount, 1);
  assert.equal(result.pendingAttendanceCount, 1);
  assert.equal(result.serviceValue, 200);
  assert.equal(result.collected, 110);
  assert.equal(result.outstanding, 120);
  assert.equal(result.outstandingCount, 1);
  assert.deepEqual(result.dayTotals.map(item => item.date), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.equal(result.barberTotals.find(item => item.name === 'أحمد').serviceValue, 200);
  assert.equal(result.serviceTotals.find(item => item.name === 'قص شعر').completedCount, 2);
  assert.equal(summarizeBarberFinance(null).bookingCount, 0);
  console.log('Barber finance report checks passed: completed value, collected amounts, outstanding amounts, grouped totals, and invalid prices.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
