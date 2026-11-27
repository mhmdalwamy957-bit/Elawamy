#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');

(async () => {
  const { normalizeBarberClosedDates, isBarberClosedOnDate, getBarberClosureReason } = await import('../server/barber-schedule-rules.js');

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

  assert.equal(
    getBarberClosureReason({ closedDates: ['2026-12-01'], closedDays: [] }, { closedDates: [], closedDays: [] }, '2026-12-01', 2),
    'BARBER_SHOP_DATE_CLOSED',
    'A whole-shop holiday must close availability.'
  );
  assert.equal(
    getBarberClosureReason({ closedDates: [], closedDays: [] }, { closedDates: ['2026-12-01'], closedDays: [] }, '2026-12-01', 2),
    'BARBER_DATE_CLOSED',
    'An individual barber holiday must close availability.'
  );
  assert.equal(
    getBarberClosureReason({ closedDates: ['2026-12-01'], closedDays: [] }, { closedDates: ['2026-12-01'], closedDays: [] }, '2026-12-01', 2),
    'BARBER_SHOP_DATE_CLOSED',
    'Whole-shop holiday messaging must take priority over a barber holiday.'
  );
  assert.equal(
    getBarberClosureReason({ closedDates: [], closedDays: [2] }, { closedDates: [], closedDays: [] }, '2026-12-01', 2),
    'BARBER_SHOP_CLOSED',
    'Weekly shop closures must still be enforced.'
  );
  assert.equal(
    getBarberClosureReason({ closedDates: [], closedDays: [] }, { closedDates: [], closedDays: [2] }, '2026-12-01', 2),
    'BARBER_WEEKLY_DAY_OFF',
    'A barber weekly day off must not be misreported as a whole-shop closure.'
  );
  assert.equal(
    getBarberClosureReason({ closedDates: [], closedDays: [2] }, { closedDates: [], closedDays: [2] }, '2026-12-01', 2),
    'BARBER_SHOP_CLOSED',
    'A whole-shop weekly closure must take priority over an individual barber day off.'
  );
  assert.equal(getBarberClosureReason({ closedDates: [], closedDays: [] }, { closedDates: [], closedDays: [] }, '2026-12-01', 2), null);

  console.log('Barber closed-date checks passed: valid calendar dates, deduplication, stable sort, max limit, shop and barber holiday rules, and weekly closure lookup.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
