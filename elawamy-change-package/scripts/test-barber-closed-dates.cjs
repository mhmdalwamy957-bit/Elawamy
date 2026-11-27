#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');

(async () => {
  const { normalizeBarberClosedDates, isBarberClosedOnDate } = await import('../server/barber-schedule-rules.js');

  assert.deepEqual(normalizeBarberClosedDates(undefined), []);
  assert.deepEqual(normalizeBarberClosedDates(null), []);
  assert.deepEqual(
    normalizeBarberClosedDates(['2026-12-15', '2026-12-01', '2026-12-15', '  ']),
    ['2026-12-01', '2026-12-15'],
    'Dates should be normalized, de-duplicated, and sorted.'
  );
  assert.throws(() => normalizeBarberClosedDates('2026-12-01'), /BARBER_CLOSED_DATES_INVALID/);
  assert.throws(() => normalizeBarberClosedDates(['2026-02-30']), /BARBER_CLOSED_DATES_INVALID/);
  assert.throws(() => normalizeBarberClosedDates(['12/01/2026']), /BARBER_CLOSED_DATES_INVALID/);
  assert.throws(() => normalizeBarberClosedDates(Array.from({ length: 121 }, (_, i) => {
    const date = new Date(Date.UTC(2027, 0, 1 + i));
    return date.toISOString().slice(0, 10);
  })), /BARBER_CLOSED_DATES_INVALID/);

  const barber = { closedDates: ['2026-12-01', '2026-12-15'] };
  assert.equal(isBarberClosedOnDate(barber, '2026-12-01'), true);
  assert.equal(isBarberClosedOnDate(barber, '2026-12-02'), false);
  assert.equal(isBarberClosedOnDate({}, '2026-12-01'), false);
  assert.equal(isBarberClosedOnDate(null, '2026-12-01'), false);

  console.log('Barber closed-date checks passed: valid calendar dates, deduplication, stable sort, max limit, and booking-day closure lookup.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
