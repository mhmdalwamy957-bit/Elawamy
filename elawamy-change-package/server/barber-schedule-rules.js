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
