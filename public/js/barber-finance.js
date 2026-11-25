function numericAmount(value) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0;
}

function byName(items, field) {
  const groups = new Map();
  for (const item of items) {
    const name = String(item[field] || (field === 'barberName' ? 'حلاق غير محدد' : 'خدمة غير محددة'));
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  return [...groups.entries()].map(([name, records]) => ({ name, records }));
}

function isCompletedService(item) {
  return item.status === 'confirmed' && item.attendanceStatus === 'completed';
}

function isCollectedBooking(item) {
  return item.status !== 'cancelled' && item.paymentStatus === 'paid';
}

export function summarizeBarberFinance(bookings = []) {
  const items = Array.isArray(bookings) ? bookings : [];
  const completed = items.filter(isCompletedService);
  const cancelled = items.filter(item => item.status === 'cancelled');
  const noShow = items.filter(item => item.status === 'confirmed' && item.attendanceStatus === 'no_show');
  const pendingAttendance = items.filter(item => item.status === 'confirmed' && !item.attendanceStatus);
  const collectedItems = items.filter(isCollectedBooking);
  const outstandingItems = completed.filter(item => item.paymentStatus !== 'paid' && numericAmount(item.price) > 0);

  const summarizeGroup = (name, records) => {
    const services = records.filter(isCompletedService);
    const collected = records.filter(isCollectedBooking);
    const outstanding = services.filter(item => item.paymentStatus !== 'paid' && numericAmount(item.price) > 0);
    return {
      name,
      bookingCount: records.filter(item => item.status !== 'cancelled').length,
      completedCount: services.length,
      serviceValue: services.reduce((sum, item) => sum + numericAmount(item.price), 0),
      collected: collected.reduce((sum, item) => sum + numericAmount(item.price), 0),
      outstanding: outstanding.reduce((sum, item) => sum + numericAmount(item.price), 0)
    };
  };

  const barberTotals = byName(items, 'barberName').map(({ name, records }) => summarizeGroup(name, records))
    .sort((a, b) => b.serviceValue - a.serviceValue || a.name.localeCompare(b.name, 'ar'));
  const serviceTotals = byName(items, 'serviceName').map(({ name, records }) => summarizeGroup(name, records))
    .sort((a, b) => b.serviceValue - a.serviceValue || a.name.localeCompare(b.name, 'ar'));
  const dayTotals = byName(items, 'localDate').map(({ name, records }) => ({ ...summarizeGroup(name, records), date: name }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    bookingCount: items.length,
    completedCount: completed.length,
    cancelledCount: cancelled.length,
    noShowCount: noShow.length,
    pendingAttendanceCount: pendingAttendance.length,
    serviceValue: completed.reduce((sum, item) => sum + numericAmount(item.price), 0),
    collected: collectedItems.reduce((sum, item) => sum + numericAmount(item.price), 0),
    outstanding: outstandingItems.reduce((sum, item) => sum + numericAmount(item.price), 0),
    outstandingCount: outstandingItems.length,
    barberTotals,
    serviceTotals,
    dayTotals
  };
}
