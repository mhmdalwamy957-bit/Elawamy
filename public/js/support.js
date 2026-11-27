import {
  auth,
  db,
  onAuthStateChanged,
  collection,
  addDoc,
  query,
  where,
  orderBy,
  getDocs,
  serverTimestamp
} from './firebase.js';

const form = document.getElementById('supportForm');
const category = document.getElementById('category');
const subject = document.getElementById('subject');
const message = document.getElementById('message');
const formStatus = document.getElementById('formStatus');
const tickets = document.getElementById('tickets');

const labels = {
  account: 'الحساب',
  order: 'طلب أو خدمة',
  payment: 'الدفع',
  technical: 'مشكلة تقنية',
  other: 'أخرى'
};

const statuses = {
  open: 'مفتوحة',
  pending: 'قيد المتابعة',
  answered: 'تم الرد',
  closed: 'مغلقة'
};

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[c]));

let currentUser = null;

async function loadTickets() {
  if (!currentUser) return;

  tickets.innerHTML = '<p class="muted">جاري تحميل التذاكر...</p>';

  try {
    const q = query(
      collection(db, 'supportTickets'),
      where('userId', '==', currentUser.uid),
      orderBy('createdAt', 'desc')
    );

    const snap = await getDocs(q);

    if (snap.empty) {
      tickets.innerHTML = '<div class="empty">لا توجد تذاكر دعم حتى الآن.</div>';
      return;
    }

    tickets.innerHTML = snap.docs.map(item => {
      const t = item.data();

      return `
        <div class="support-ticket">
          <div class="support-ticket-head">
            <strong>${esc(t.subject)}</strong>
            <span class="status">${esc(statuses[t.status] || t.status || 'مفتوحة')}</span>
          </div>

          <div class="muted">
            النوع: ${esc(labels[t.category] || t.category || 'أخرى')}
          </div>

          <p>${esc(t.message)}</p>

          ${
            t.reply
              ? `<div class="support-reply">
                   <strong>رد الدعم:</strong>
                   <p>${esc(t.reply)}</p>
                 </div>`
              : '<div class="muted">لم يتم الرد على التذكرة بعد.</div>'
          }
        </div>
      `;
    }).join('');
  } catch (error) {
    console.error(error);
    tickets.innerHTML =
      '<p>تعذر تحميل التذاكر حاليًا. تأكد من نشر Firestore Index إذا طلب Firebase ذلك.</p>';
  }
}

onAuthStateChanged(auth, async user => {
  currentUser = user;

  if (!user) {
    formStatus.textContent = 'يجب تسجيل الدخول أولًا لاستخدام الدعم الفني.';
    form.querySelector('button').disabled = true;
    tickets.innerHTML = '<p class="muted">سجّل الدخول لعرض تذاكر الدعم.</p>';
    return;
  }

  form.querySelector('button').disabled = false;
  await loadTickets();
});

form.addEventListener('submit', async event => {
  event.preventDefault();

  if (!currentUser) {
    formStatus.textContent = 'يجب تسجيل الدخول أولًا.';
    return;
  }

  const categoryValue = category.value.trim();
  const subjectValue = subject.value.trim();
  const messageValue = message.value.trim();

  if (!categoryValue || !subjectValue || !messageValue) {
    formStatus.textContent = 'من فضلك أكمل جميع البيانات.';
    return;
  }

  if (subjectValue.length > 120 || messageValue.length > 2000) {
    formStatus.textContent = 'البيانات أطول من الحد المسموح.';
    return;
  }

  const button = form.querySelector('button');
  button.disabled = true;
  formStatus.textContent = 'جاري إرسال التذكرة...';

  try {
    await addDoc(collection(db, 'supportTickets'), {
      userId: currentUser.uid,
      userEmail: currentUser.email || '',
      category: categoryValue,
      subject: subjectValue,
      message: messageValue,
      status: 'open',
      reply: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    form.reset();
    formStatus.textContent = 'تم إرسال التذكرة بنجاح ✅';
    await loadTickets();
  } catch (error) {
    console.error(error);
    formStatus.textContent = 'حدث خطأ أثناء إرسال التذكرة.';
  } finally {
    button.disabled = false;
  }
});
