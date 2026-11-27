const MAX_BARBER_CLOSED_DATES = 120;

/**
 * Validate and normalize one-off barber holidays stored as YYYY-MM-DD strings.
 * Throws a stable error code so the API can return a client-safe 400 response.
 */
export function normalizeBarberClosedDates(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('BARBER_CLOSED_DATES_INVALID');

  const dates = [...new Set(value.map(item => String(item ?? '').trim()).filter(Boolean))];
  if (dates.length > MAX_BARBER_CLOSED_DATES) throw new Error('BARBER_CLOSED_DATES_INVALID');

  for (const date of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('BARBER_CLOSED_DATES_INVALID');
    const parsed = Date.parse(`${date}T12:00:00Z`);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) {
      throw new Error('BARBER_CLOSED_DATES_INVALID');
    }
  }

  return dates.sort((a, b) => a.localeCompare(b));
}

export function isBarberClosedOnDate(barber, date) {
  return Array.isArray(barber?.closedDates) && barber.closedDates.includes(String(date || ''));
}


/**
 * Resolve why a date is unavailable. Whole-salon closures take priority over
 * personal barber closures; weekly closed days remain enforced for both.
 */
export function getBarberClosureReason(shop, barber, date, dayOfWeek) {
  if (isBarberClosedOnDate(shop, date)) return 'BARBER_SHOP_DATE_CLOSED';
  if (isBarberClosedOnDate(barber, date)) return 'BARBER_DATE_CLOSED';
  const shopClosedDays = Array.isArray(shop?.closedDays) ? shop.closedDays : [];
  const barberClosedDays = Array.isArray(barber?.closedDays) ? barber.closedDays : [];
  if (shopClosedDays.includes(dayOfWeek)) return 'BARBER_SHOP_CLOSED';
  if (barberClosedDays.includes(dayOfWeek)) return 'BARBER_WEEKLY_DAY_OFF';
  return null;
}
