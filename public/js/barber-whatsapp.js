/**
 * Shared WhatsApp helpers for the barber booking system.
 * Messages are prepared in the user's WhatsApp client; this does not send automatically.
 */
export function normalizeBarberWhatsAppPhone(value) {
  const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
  const persianDigits = '۰۱۲۳۴۵۶۷۸۹';
  const raw = String(value ?? '').trim()
    .replace(/[٠-٩]/g, digit => String(arabicDigits.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String(persianDigits.indexOf(digit)));
  let digits = raw.replace(/\D/g, '');

  if (raw.startsWith('+')) {
    return /^\d{8,15}$/.test(digits) ? digits : '';
  }
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('20')) {
    // Already using Egypt's country code.
  } else if (digits.startsWith('0')) {
    // Egyptian local format, e.g. 01012345678 -> 201012345678.
    digits = `20${digits.slice(1)}`;
  } else if (/^1\d{9}$/.test(digits)) {
    // Egyptian mobile number entered without its leading zero.
    digits = `20${digits}`;
  } else {
    // Don't guess the country for an ambiguous national number.
    return '';
  }

  return /^\d{10,15}$/.test(digits) ? digits : '';
}

function cleanMessagePart(value, max = 160) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function displayBookingDate(value) {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : cleanMessagePart(value, 20);
}

export function createBarberWhatsAppReminderUrl(booking, shopName = 'صالون الحلاقة') {
  if (!booking || booking.status === 'cancelled' || booking.attendanceStatus) return '';
  const phone = normalizeBarberWhatsAppPhone(booking.customerPhone);
  if (!phone) return '';

  const customer = cleanMessagePart(booking.customerName, 100) || 'أهلًا بيك';
  const shop = cleanMessagePart(shopName, 100) || 'صالون الحلاقة';
  const service = cleanMessagePart(booking.serviceName, 100) || 'خدمة حلاقة';
  const barber = cleanMessagePart(booking.barberName, 80);
  const date = displayBookingDate(booking.localDate);
  const time = [cleanMessagePart(booking.startTime, 5), cleanMessagePart(booking.endTime, 5)].filter(Boolean).join(' إلى ');
  const price = Number(booking.price);
  const lines = [
    `أهلًا ${customer}، ده تذكير بميعادك في ${shop}.`,
    date ? `📅 التاريخ: ${date}` : '',
    time ? `🕒 الوقت: ${time}` : '',
    `✂️ الخدمة: ${service}`,
    barber ? `الحلاق: ${barber}` : '',
    Number.isFinite(price) && price > 0 ? `💵 السعر: ${price.toLocaleString('en-US')} جنيه` : '',
    'لو محتاج تعدّل الموعد، تواصل مع الصالون قبل الميعاد.',
    'شكرًا لاختيارك ElaWamy.'
  ].filter(Boolean);
  return `https://wa.me/${phone}?text=${encodeURIComponent(lines.join('\n'))}`;
}
