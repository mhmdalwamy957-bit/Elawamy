import {
  auth,
  db,
  onAuthStateChanged,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  query,
  where,
  orderBy,
  serverTimestamp
} from './firebase.js';

const page = document.getElementById('disputesPage');
const list = document.getElementById('disputesList');
const newBox = document.getElementById('newDisputeBox');
const form = document.getElementById('disputeForm');
const message = document.getElementById('disputeFormMessage');
const params = new URLSearchParams(location.search);
const orderIdParam = params.get('order');

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));

const statusText = {
  open: 'مفتوح',
  in_review: 'قيد المراجعة',
  resolved_buyer: 'تم الحل لصالح المشتري',
  resolved_seller: 'تم الحل لصالح البائع',
  closed: 'مغلق'
};

function timeValue(value) {
  return value?.toMillis?.() ?? (value?.seconds ? value.seconds * 1000 : 0);
}

function dateText(value) {
  const t = timeValue(value);
  return t ? new Date(t).toLocaleString('ar-EG') : '-';
}

function roleText(role) {
  return role === 'seller' ? 'بائع' : 'مشتري';
}

async function loadOrderForNewDispute(user) {
  if (!orderIdParam) return null;
  const snap = await getDoc(doc(db, 'orders', orderIdParam));
  if (!snap.exists()) {
    document.getElementById('disputeOrderSummary').textContent = 'الطلب غير موجود.';
    return null;
  }

  const order = { id: snap.id, ...snap.data() };
  const isBuyer = order.userId === user.uid;
  const isSeller = order.sellerId === user.uid;
  const paid = order.paymentStatus === 'paid';
  const allowedStatus = order.status !== 'cancelled';

  if ((!isBuyer && !isSeller) || !paid || !allowedStatus) {
    document.getElementById('disputeOrderSummary').textContent = 'هذا الطلب غير متاح لفتح نزاع منه.';
    return null;
  }

  const role = isBuyer ? 'buyer' : 'seller';
  const roleSelect = document.getElementById('disputeRole');
  roleSelect.value = role;
  roleSelect.disabled = true;

  document.getElementById('disputeOrderSummary').textContent =
    `الطلب: ${order.serviceName || 'خدمة'} — ${Number(order.price || order.totalPrice || 0).toLocaleString('ar-EG')} ج.م — حالته: ${statusText[order.status] || order.status}`;

  newBox.hidden = false;
  return order;
}

async function loadDisputes(user) {
  list.innerHTML = '<p class="muted">جاري تحميل النزاعات...</p>';

  try {
    const [buyerSnap, sellerSnap] = await Promise.all([
      getDocs(query(collection(db, 'disputes'), where('buyerId', '==', user.uid), orderBy('createdAt', 'desc'))),
      getDocs(query(collection(db, 'disputes'), where('sellerId', '==', user.uid), orderBy('createdAt', 'desc')))
    ]);

    const map = new Map();
    [...buyerSnap.docs, ...sellerSnap.docs].forEach(d => map.set(d.id, { id: d.id, ...d.data() }));
    const disputes = [...map.values()].sort((a,b) => timeValue(b.createdAt) - timeValue(a.createdAt));

    if (!disputes.length) {
      list.innerHTML = '<div class="empty">لا توجد نزاعات حتى الآن.</div>';
      return;
    }

    list.innerHTML = disputes.map(dispute => `
      <article class="support-ticket dispute-card" data-dispute-id="${esc(dispute.id)}">
        <div class="support-ticket-head">
          <div>
            <strong>${esc(dispute.reason || 'نزاع')}</strong>
            <div class="muted">الطلب: ${esc(dispute.orderId)} · ${roleText(dispute.role)} · ${dateText(dispute.createdAt)}</div>
          </div>
          <span class="status">${esc(statusText[dispute.status] || dispute.status || '-')}</span>
        </div>
        <p>${esc(dispute.description || '')}</p>
        ${dispute.evidence ? `<div class="notice"><strong>الأدلة:</strong><br>${esc(dispute.evidence)}</div>` : ''}
        ${dispute.resolution ? `<div class="support-reply"><strong>قرار الإدارة:</strong><br>${esc(dispute.resolution)}</div>` : ''}
        <div class="dispute-messages" data-dispute-messages="${esc(dispute.id)}"><span class="muted">جاري تحميل الرسائل...</span></div>
        <div class="chat-form">
          <input type="text" maxlength="3000" placeholder="اكتب رسالة مرتبطة بالنزاع..." data-dispute-input="${esc(dispute.id)}">
          <button class="btn small" type="button" data-dispute-send="${esc(dispute.id)}">إرسال</button>
        </div>
      </article>
    `).join('');

    await Promise.all(disputes.map(loadMessages));

    list.querySelectorAll('[data-dispute-send]').forEach(button => {
      button.addEventListener('click', async () => {
        const disputeId = button.dataset.disputeSend;
        const input = list.querySelector(`[data-dispute-input="${CSS.escape(disputeId)}"]`);
        const text = input?.value.trim();
        if (!text) return;
        button.disabled = true;
        try {
          await addDoc(collection(db, 'disputes', disputeId, 'messages'), {
            senderId: user.uid,
            text,
            createdAt: serverTimestamp()
          });
          input.value = '';
          await loadMessages({ id: disputeId });
        } catch (error) {
          alert('تعذر إرسال رسالة النزاع: ' + (error?.message || error));
        } finally {
          button.disabled = false;
        }
      });
    });
  } catch (error) {
    console.error('DISPUTES LOAD ERROR:', error);
    list.innerHTML = `<div class="empty">تعذر تحميل النزاعات: ${esc(error?.message || 'خطأ غير معروف')}</div>`;
  }
}

async function loadMessages(dispute) {
  const box = list.querySelector(`[data-dispute-messages="${CSS.escape(dispute.id)}"]`);
  if (!box) return;
  try {
    const snap = await getDocs(query(collection(db, 'disputes', dispute.id, 'messages'), orderBy('createdAt', 'asc')));
    if (!snap.docs.length) {
      box.innerHTML = '<span class="muted">لا توجد رسائل في النزاع.</span>';
      return;
    }
    box.innerHTML = snap.docs.map(d => {
      const item = d.data();
      return `<div class="chat-message theirs"><div>${esc(item.text || '')}</div><small class="muted">${esc(dateText(item.createdAt))}</small></div>`;
    }).join('');
  } catch (error) {
    console.error('DISPUTE MESSAGES ERROR:', error);
    box.innerHTML = '<span class="muted">تعذر تحميل رسائل النزاع.</span>';
  }
}

async function init(user) {
  if (!user) {
    location.replace(`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`);
    return;
  }

  await loadOrderForNewDispute(user);
  await loadDisputes(user);
}

form?.addEventListener('submit', async event => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!user || !orderIdParam) return;

  const role = document.getElementById('disputeRole').value;
  const reason = document.getElementById('disputeReason').value.trim();
  const description = document.getElementById('disputeDescription').value.trim();
  const evidence = document.getElementById('disputeEvidence').value.trim();

  if (!role || !reason || description.length < 10) {
    message.textContent = 'اختر السبب واكتب شرحًا واضحًا للمشكلة.';
    return;
  }

  message.textContent = 'جاري فتح النزاع...';
  const disputeId = `${orderIdParam}__${user.uid}`;

  try {
    const orderSnap = await getDoc(doc(db, 'orders', orderIdParam));
    if (!orderSnap.exists()) throw new Error('الطلب غير موجود');
    const order = orderSnap.data();

    await setDoc(doc(db, 'disputes', disputeId), {
      orderId: orderIdParam,
      buyerId: order.userId,
      sellerId: order.sellerId,
      openedBy: user.uid,
      role,
      reason,
      description,
      evidence,
      status: 'open',
      resolution: '',
      assignedTo: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    message.textContent = '✅ تم فتح النزاع. سيظهر الآن في قائمة النزاعات وسيتم التعامل معه من الإدارة/الدعم.';
    form.reset();
    document.getElementById('disputeRole').value = role;
    await loadDisputes(user);
  } catch (error) {
    console.error('CREATE DISPUTE ERROR:', error);
    if (error?.code === 'permission-denied') {
      message.textContent = '❌ لا يمكن فتح هذا النزاع: تحقق من أن الطلب مدفوع وأنك أحد طرفيه وأنه لم يُلغَ.';
    } else if (error?.code === 'already-exists') {
      message.textContent = 'يوجد نزاع مفتوح/مسجل لهذا الطلب من حسابك بالفعل.';
    } else {
      message.textContent = `❌ ${error?.message || 'تعذر فتح النزاع'}`;
    }
  }
});

document.getElementById('cancelNewDispute')?.addEventListener('click', () => {
  newBox.hidden = true;
});

document.getElementById('refreshDisputes')?.addEventListener('click', () => {
  if (auth.currentUser) loadDisputes(auth.currentUser);
});

onAuthStateChanged(auth, init);
