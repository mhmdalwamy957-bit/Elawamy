import {
  db,
  auth,
  getIdToken,
  collection,
  getDocs,
  getDoc,
  query,
  where,
  orderBy,
  limit,
  updateDoc,
  doc,
  addDoc,
  serverTimestamp,
  onSnapshot
} from './firebase.js';

import { requireUser } from './guard.js';
import { uploadOrderFile } from './file-upload.js';

const API_BASE = 'https://elawamy-file-server.vercel.app';
let financeConfig = { provider: 'unconfigured', mode: 'unavailable', configured: false, feePercent: 7, directPaymentMethod: null };

const buyer = document.getElementById('buyerOrders');
const seller = document.getElementById('sellerOrders');

const labels = {
  pending: 'قيد الانتظار',
  accepted: 'مقبول',
  delivered: 'تم التسليم',
  revision_requested: 'مطلوب تعديل',
  redelivered: 'تمت إعادة التسليم',
  completed: 'مكتمل',
  cancelled: 'ملغي'
};

function esc(v = '') {
  const d = document.createElement('div');
  d.textContent = String(v);
  return d.innerHTML;
}

function timeValue(v) {
  return v?.toMillis?.() ?? v?.seconds * 1000 ?? 0;
}

function formatOrderDate(v) {
  const ms = timeValue(v);
  if (!ms) return '';

  return new Date(ms).toLocaleString('ar-EG', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

async function getOrderFiles(orderId) {
  try {
    return (
      await getDocs(
        collection(db, 'orders', orderId, 'files')
      )
    ).docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error('ORDER FILES ERROR', orderId, e);
    throw e;
  }
}

const chatUnsubscribers = new Map();

function watchOrderMessages(orderId, uid, box) {
  const oldUnsubscribe = chatUnsubscribers.get(orderId);

  if (oldUnsubscribe) {
    oldUnsubscribe();
    chatUnsubscribers.delete(orderId);
  }

  const unsubscribe = onSnapshot(
    query(
      collection(db, 'orders', orderId, 'messages'),
      orderBy('createdAt', 'desc'),
      limit(50)
    ),
    snapshot => {
      const messages = snapshot.docs
        .map(d => ({
          id: d.id,
          ...d.data()
        }))
        .reverse();

      box.innerHTML = renderMessages(messages, uid);
      box.scrollTop = box.scrollHeight;
    },
    error => {
      console.error('ORDER MESSAGES REALTIME ERROR', orderId, error);
      box.textContent = 'تعذر تحميل الرسائل';
    }
  );

  chatUnsubscribers.set(orderId, unsubscribe);
  return unsubscribe;
}

function renderMessages(messages, uid) {
  if (!messages.length) {
    return '<div class="chat-empty">لا توجد رسائل بعد.</div>';
  }

  return messages.map(m => `
    <div class="chat-message ${m.senderId === uid ? 'mine' : 'theirs'}">
      <div>${esc(m.text)}</div>
    </div>
  `).join('');
}

function formatFileSize(size) {
  const n = Number(size || 0);

  if (n < 1024) return `${n} بايت`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} ك.ب`;
  return `${(n / (1024 * 1024)).toFixed(1)} م.ب`;
}

function row(o, sellerView = false, files = []) {
  let action = '';

  if (sellerView && o.status === 'pending' && o.paymentStatus === 'paid') {
    action = `<button class="btn small" data-status="accepted" data-id="${esc(o.id)}">قبول والبدء</button>`;
  }

  if (sellerView && o.status === 'pending' && o.paymentStatus !== 'paid') {
    if (o.paymentProvider === 'direct_transfer' && o.directPaymentStatus === 'buyer_submitted') {
      action = `
        <div class="notice-box"><strong>تم إرسال إثبات دفع مباشر.</strong><p class="muted">راجع مرجع التحويل ثم أكد الاستلام إذا وصل المبلغ فعلًا.</p></div>
        <button class="btn small" data-status="confirm_direct" data-id="${esc(o.id)}">تأكيد استلام الدفع</button>
        <button class="btn small secondary" data-status="reject_direct" data-id="${esc(o.id)}">رفض إثبات الدفع</button>
      `;
    } else {
      action = `<span class="status pending-payment">في انتظار دفع المشتري</span>`;
    }
  }

  if (!sellerView && o.status === 'pending') {
    if (o.paymentStatus === 'pending') {
      if (o.paymentProvider === 'direct_transfer' && o.directPaymentStatus === 'buyer_submitted') {
        action = `<span class="status pending-payment">تم إرسال مرجع التحويل — بانتظار تأكيد البائع</span>`;
      } else {
        const paymentUnavailable = financeConfig.configured === false
          || !['xpay', 'direct_transfer', 'demo'].includes(financeConfig.provider);
        const payButton = paymentUnavailable
          ? `<button class="btn small" type="button" disabled title="الدفع غير متاح حتى يتم تأكيد الإعدادات">الدفع غير متاح مؤقتًا</button>`
          : financeConfig.provider === 'xpay'
            ? `<button class="btn small" data-status="pay" data-id="${esc(o.id)}">دفع عبر XPay</button>`
            : financeConfig.provider === 'direct_transfer'
              ? `<button class="btn small" data-status="pay" data-id="${esc(o.id)}">الدفع عبر Vodafone Cash</button>`
              : `<button class="btn small" data-status="pay" data-id="${esc(o.id)}">دفع تجريبي</button>`;
        action = `
          ${payButton}
          <button class="btn small secondary" data-status="cancelled" data-id="${esc(o.id)}">إلغاء الطلب</button>
        `;
      }
    } else if (o.paymentStatus === 'paid') {
      action = `<span class="status paid">تم الدفع${o.paymentProvider === 'direct_transfer' ? ' مباشرةً للبائع' : ''}</span>`;
    }
  }

  if (sellerView && o.status === 'accepted') {
    action = `
      <button
        class="btn small"
        data-status="delivered"
        data-id="${esc(o.id)}"
      >
        تسليم العمل
      </button>
    `;
  }

  if (!sellerView && o.status === 'delivered') {
    action = `
      <button class="btn small" data-status="revision_requested" data-id="${esc(o.id)}">طلب تعديل</button>
      <button class="btn small" data-status="completed" data-id="${esc(o.id)}">تأكيد الاستلام</button>
    `;
  }

  if (sellerView && o.status === 'revision_requested') {
    action = `
      <button
        class="btn small"
        data-status="redelivered"
        data-id="${esc(o.id)}"
      >
        إعادة تسليم العمل
      </button>
    `;
  }

  if (!sellerView && o.status === 'redelivered') {
    action = `<button class="btn small" data-status="completed" data-id="${esc(o.id)}">تأكيد الاستلام</button>`;
  }

  const canDispute = o.paymentStatus === 'paid' && !['cancelled'].includes(o.status);
  const disputeButton = canDispute
    ? `<a class="btn small secondary" href="/disputes?order=${encodeURIComponent(o.id)}">⚠️ فتح نزاع</a>`
    : '';

  const canUpload = sellerView
    ? ['accepted', 'revision_requested'].includes(o.status)
    : o.status === 'pending';

  const uploadButton = canUpload ? `
    <div class="order-files">
      <div class="files-title">
        <b>${sellerView ? 'ملفات التسليم' : 'ملفات الطلب'}</b>
      </div>

      <label class="file-drop-zone"
        data-file-drop="${esc(o.id)}"
        data-file-role="${sellerView ? 'seller' : 'buyer'}">

        <input
          type="file"
          class="order-file-input"
          data-file-order="${esc(o.id)}"
          data-file-role="${sellerView ? 'seller' : 'buyer'}"
          multiple
          hidden
        >

        <span class="file-drop-icon">📎</span>
        <strong>اختر الملفات</strong>
        <small>يمكنك اختيار أكثر من ملف</small>
      </label>

      <div
        class="selected-files"
        data-selected-files="${esc(o.id)}"
      ></div>

      <button
        type="button"
        class="btn small upload-file-btn"
        data-upload-order="${esc(o.id)}"
        data-upload-role="${sellerView ? 'seller' : 'buyer'}"
        disabled
      >
        رفع الملفات
      </button>

      <span
        class="upload-status"
        data-upload-status="${esc(o.id)}"
      ></span>
    </div>
  ` : '';

  return `
    <article class="order">
      <div>
        <b>${esc(o.serviceName)}</b>
        <p>${Number(o.price || 0).toLocaleString('ar-EG')} ج.م</p>
      </div>

      <span class="status">
        ${labels[o.status] || esc(o.status)}
      </span>

      ${o.dueAt ? `<span class="order-deadline">التسليم: ${formatOrderDate(o.dueAt)}</span>` : ''}

      ${o.paymentStatus === 'paid' ? '<span class="status paid">مدفوع</span>' : (o.paymentStatus === 'refunded' ? '<span class="status cancelled">مسترد</span>' : '')}
      ${o.paymentProvider === 'direct_transfer' && o.directPaymentStatus === 'buyer_submitted' && o.directPaymentReference ? `<div class="notice-box"><strong>مرجع التحويل:</strong> ${esc(o.directPaymentReference)}</div>` : ''}
      ${o.platformFeeStatus === 'due' && Number(o.platformFee || 0) > 0 ? `<div class="muted">عمولة العوامي المستحقة على هذا الطلب: ${Number(o.platformFee).toLocaleString('ar-EG')} ج.م</div>` : ''}

      ${action}
      ${disputeButton}
      ${
      files.length
        ? `<div class="uploaded-files">
            <b>الملفات المرفوعة:</b>
            ${files.map(f => `
              <div class="uploaded-file">
                <span>${esc(f.name)} (${formatFileSize(f.size)})</span>
                <button
                  type="button"
                  class="btn small download-file-btn"
                  data-download-order="${esc(o.id)}"
                  data-download-file="${esc(f.id)}"
                >
                  تنزيل
                </button>
              </div>
            `).join('')}
          </div>`
        : ''
    }
    ${uploadButton}

    <div class="order-chat">
      <b>المحادثة</b>
      <div class="chat-messages" data-chat-messages="${esc(o.id)}">
        جاري تحميل الرسائل...
      </div>

      <div class="chat-form">
        <input
          type="text"
          class="chat-input"
          data-chat-input="${esc(o.id)}"
          maxlength="2000"
          placeholder="اكتب رسالتك..."
        >
        <button
          type="button"
          class="btn small chat-send-btn"
          data-chat-send="${esc(o.id)}"
        >
          إرسال
        </button>
      </div>
    </div>
    </article>
  `;
}

  /*
   * حذف ملف من قائمة الملفات المختارة قبل الرفع
   * Event delegation لأن أزرار الحذف تُنشأ ديناميكيًا
   */
  [seller, buyer].forEach(container => {
    container.addEventListener('click', event => {
      const removeBtn = event.target.closest('.remove-selected-file');
      if (!removeBtn) return;

      const orderId = removeBtn.dataset.removeFile;
      const role = removeBtn.dataset.removeRole;
      const index = Number(removeBtn.dataset.removeIndex);

      const input = container.querySelector(
        `[data-file-order="${CSS.escape(orderId)}"][data-file-role="${CSS.escape(role)}"]`
      );

      if (!input || !Number.isInteger(index)) return;

      const files = Array.from(input.files || []);
      files.splice(index, 1);

      const dataTransfer = new DataTransfer();
      files.forEach(file => dataTransfer.items.add(file));

      input.files = dataTransfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });

async function load(user) {
  try {
    const token = await getIdToken(user, true);
    const configResponse = await fetch(`${API_BASE}/api/finance/config`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (configResponse.ok) {
      financeConfig = await configResponse.json();
    }
  } catch (e) {
    console.warn('FINANCE CONFIG ERROR:', e);
  }

  for (const unsubscribe of chatUnsubscribers.values()) {
    unsubscribe();
  }

  chatUnsubscribers.clear();


  let a = [];
  let b = [];

  try {
    a = (
      await getDocs(
        query(
          collection(db, 'orders'),
          where('userId', '==', user.uid),
          orderBy('createdAt', 'desc'),
          limit(20)
        )
      )
    ).docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error('BUYER ORDERS ERROR', e);
  }

  try {
    b = (
      await getDocs(
        query(
          collection(db, 'orders'),
          where('sellerId', '==', user.uid),
          orderBy('createdAt', 'desc'),
          limit(20)
        )
      )
    ).docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error('SELLER ORDERS ERROR', e);
  }

  a.sort((x, y) => timeValue(y.createdAt) - timeValue(x.createdAt));
  b.sort((x, y) => timeValue(y.createdAt) - timeValue(x.createdAt));

  const buyerWithFiles = await Promise.all(
    a.map(async o => ({
      order: o,
      files: await getOrderFiles(o.id)
    }))
  );

  const sellerWithFiles = await Promise.all(
    b.map(async o => ({
      order: o,
      files: await getOrderFiles(o.id)
    }))
  );

  buyer.innerHTML = buyerWithFiles.length
    ? buyerWithFiles.map(x => row(x.order, false, x.files)).join('')
    : '<div class="empty">لا توجد طلبات شراء.</div>';

  seller.innerHTML = sellerWithFiles.length
    ? sellerWithFiles.map(x => row(x.order, true, x.files)).join('')
    : '<div class="empty">لا توجد طلبات على خدماتك.</div>';

  /*
   * المحادثات داخل الطلب
   */
  const allOrders = new Map();

  for (const item of buyerWithFiles) {
    allOrders.set(item.order.id, item.order);
  }

  for (const item of sellerWithFiles) {
    allOrders.set(item.order.id, item.order);
  }

  for (const order of allOrders.values()) {
    const box = document.querySelector(
      `[data-chat-messages="${CSS.escape(order.id)}"]`
    );

    if (!box) continue;

    try {
      watchOrderMessages(order.id, user.uid, box);
    } catch (e) {
      console.error('REALTIME CHAT ERROR', order.id, e);
      box.textContent = 'تعذر تحميل الرسائل';
    }
  }

  [...seller.querySelectorAll('.chat-send-btn'), ...buyer.querySelectorAll('.chat-send-btn')]
    .forEach(btn => {
      btn.onclick = async () => {
        const orderId = btn.dataset.chatSend;

        const input = document.querySelector(
          `[data-chat-input="${CSS.escape(orderId)}"]`
        );

        const text = input?.value?.trim();

        if (!text) {
          return;
        }

        try {
          btn.disabled = true;

          await addDoc(
            collection(db, 'orders', orderId, 'messages'),
            {
              senderId: user.uid,
              text,
              createdAt: serverTimestamp()
            }
          );

          const chatOrderSnap = await getDoc(doc(db, 'orders', orderId));
          const chatOrder = chatOrderSnap.exists()
            ? chatOrderSnap.data()
            : null;

          const chatRecipient = chatOrder
            ? (
                chatOrder.userId === user.uid
                  ? chatOrder.sellerId
                  : chatOrder.userId
              )
            : '';

          input.value = '';

          const box = document.querySelector(
            `[data-chat-messages="${CSS.escape(orderId)}"]`
          );

          if (box) {
            box.scrollTop = box.scrollHeight;
          }
        } catch (e) {
          console.error('SEND MESSAGE ERROR', e);
          alert('تعذر إرسال الرسالة: ' + (e.code || e.message));
        } finally {
          btn.disabled = false;
        }
      };
    });

  /*
   * أزرار تغيير حالة الطلب
   */

  [...seller.querySelectorAll('[data-status]'), ...buyer.querySelectorAll('[data-status]')]
    .forEach(btn => {
      btn.onclick = async () => {
        const orderId = btn.dataset.id;
        const nextStatus = btn.dataset.status;

        try {
          if (nextStatus === 'pay') {
            if (financeConfig.configured === false
              || !['xpay', 'direct_transfer', 'demo'].includes(financeConfig.provider)) {
              throw new Error('الدفع غير متاح مؤقتًا لأن إعدادات مزود الدفع غير مؤكدة.');
            }
            btn.disabled = true;
            const token = await getIdToken(user, true);

            if (financeConfig.provider === 'direct_transfer') {
              const startResponse = await fetch(`${API_BASE}/api/payments/direct/start`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ orderId })
              });
              const start = await startResponse.json().catch(() => ({}));
              if (!startResponse.ok) throw new Error(start.error || 'تعذر بدء الدفع المباشر');

              const confirmed = confirm(
                `الدفع عبر Vodafone Cash\n\n` +
                `المستفيد: ${start.accountName}\n` +
                `الرقم: ${start.account}\n` +
                `المبلغ: ${Number(start.totalPrice || 0).toLocaleString('ar-EG')} ج.م\n\n` +
                `حوّل المبلغ كاملًا، ثم اضغط موافق لإدخال مرجع التحويل.`
              );
              if (!confirmed) { btn.disabled = false; return; }

              const reference = prompt('أدخل رقم/مرجع التحويل كما ظهر في رسالة Vodafone Cash:', '') || '';
              if (!reference.trim()) { btn.disabled = false; return; }
              const note = prompt('ملاحظة إضافية (اختياري):', '') || '';

              const submitResponse = await fetch(`${API_BASE}/api/payments/direct/submit`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ orderId, reference: reference.trim(), note: note.trim() })
              });
              const submit = await submitResponse.json().catch(() => ({}));
              if (!submitResponse.ok) throw new Error(submit.error || 'تعذر إرسال مرجع التحويل');
              alert('تم إرسال مرجع التحويل. سينتظر الطلب تأكيد البائع بعد التحقق من وصول المبلغ.');
              await load(user);
              return;
            }

            const endpoint = financeConfig.provider === 'xpay'
              ? `${API_BASE}/api/payments/xpay/checkout`
              : `${API_BASE}/api/payments/demo/confirm`;
            const response = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              },
              body: JSON.stringify({ orderId })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || 'تعذر بدء الدفع');

            if (financeConfig.provider === 'xpay') {
              if (!result.url) throw new Error('لم يتم إنشاء رابط الدفع.');
              window.location.href = result.url;
              return;
            }

            alert(`تم الدفع تجريبيًا بنجاح. عمولة العوامي: ${Number(result.platformFee || 0).toLocaleString('ar-EG')} ج.م`);
            await load(user);
            return;
          }

          if (nextStatus === 'confirm_direct') {
            btn.disabled = true;
            const token = await getIdToken(user, true);
            const response = await fetch(`${API_BASE}/api/payments/direct/confirm`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
              },
              body: JSON.stringify({ orderId })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || 'تعذر تأكيد الدفع المباشر');
            alert(`تم تأكيد الدفع. عمولة العوامي: ${Number(result.platformFee || 0).toLocaleString('ar-EG')} ج.م`);
            await load(user);
            return;
          }

          if (nextStatus === 'reject_direct') {
            const reason = prompt('سبب رفض إثبات الدفع:', 'لم يصل التحويل أو المرجع غير صحيح.') || '';
            if (!reason.trim()) return;
            btn.disabled = true;
            const token = await getIdToken(user, true);
            const response = await fetch(`${API_BASE}/api/payments/direct/reject`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
              },
              body: JSON.stringify({ orderId, reason })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || 'تعذر رفض إثبات الدفع');
            await load(user);
            return;
          }

          if (nextStatus === 'cancelled') {
            const confirmed = confirm(financeConfig.provider === 'xpay' ? 'هل تريد إلغاء الطلب؟ سيتم طلب استرداد المبلغ عبر XPay إذا كان الطلب مدفوعًا.' : financeConfig.provider === 'direct_transfer' ? 'هل تريد إلغاء الطلب؟ بعد الدفع المباشر لا يوجد رد آلي؛ قد تحتاج لفتح نزاع/دعم لاسترداد المبلغ.' : 'هل تريد إلغاء الطلب؟ سيتم رد المبلغ في وضع الدفع التجريبي إذا كان الطلب مدفوعًا.');
            if (!confirmed) return;
            btn.disabled = true;
            const token = await getIdToken(user, true);
            const response = await fetch(`${API_BASE}/api/orders/cancel`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              },
              body: JSON.stringify({ orderId })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || 'تعذر إلغاء الطلب');
            await load(user);
            return;
          }

          if (nextStatus === 'accepted') {
            btn.disabled = true;

            const token = await getIdToken(user, true);
            const response = await fetch(`${API_BASE}/api/orders/accept`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              },
              body: JSON.stringify({ orderId })
            });

            const result = await response.json().catch(() => ({}));

            if (!response.ok) {
              throw new Error(result.error || 'تعذر قبول الطلب');
            }

            await addDoc(
              collection(db, 'orders', orderId, 'messages'),
              {
                senderId: user.uid,
                text: 'تم قبول الطلب والبدء في تنفيذ الخدمة.',
                createdAt: serverTimestamp()
              }
            );

            await load(user);
            return;
          }

          const orderSnap = await getDoc(doc(db, 'orders', orderId));

          if (!orderSnap.exists()) {
            throw new Error('الطلب غير موجود');
          }

          const orderData = orderSnap.data();
          // البائع لا يستطيع التسليم بدون ملف تسليم
          if (
            nextStatus === 'delivered' ||
            nextStatus === 'redelivered'
          ) {
            const files = await getOrderFiles(orderId);

            const sellerFiles = files.filter(
              file => file.role === 'seller'
            );

            if (!sellerFiles.length) {
              alert('لا يمكن تسليم الطلب قبل رفع ملف التسليم.');
              return;
            }
          }

          // طلب تعديل من المشتري
          if (nextStatus === 'revision_requested') {
            const reason = prompt(
              'اكتب التعديلات المطلوبة من البائع:'
            );

            if (reason === null) {
              return;
            }

            const cleanReason = reason.trim();

            if (!cleanReason) {
              alert('اكتب سبب طلب التعديل.');
              return;
            }

            if (cleanReason.length > 2000) {
              alert('رسالة التعديل طويلة جدًا.');
              return;
            }

            btn.disabled = true;

            await updateDoc(
              doc(db, 'orders', orderId),
              {
                status: 'revision_requested'
              }
            );

            await addDoc(
              collection(
                db,
                'orders',
                orderId,
                'messages'
              ),
              {
                senderId: user.uid,
                text: 'طلب تعديل: ' + cleanReason,
                createdAt: serverTimestamp()
              }
            );


          await load(user);
          return;
          }

          // تأكيد إكمال الطلب
          if (nextStatus === 'completed') {
            const confirmed = confirm(
              'هل أنت متأكد من استلام الطلب وإكماله؟'
            );

            if (!confirmed) {
              return;
            }
          }

          btn.disabled = true;

          if (
            nextStatus === 'delivered' ||
            nextStatus === 'redelivered'
          ) {
            const token = await getIdToken(user, true);

            const response = await fetch(
              `${API_BASE}/api/orders/deliver`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                  orderId,
                  status: nextStatus
                })
              }
            );

            const result = await response.json().catch(() => ({}));

            if (!response.ok) {
              throw new Error(
                result.error || 'تعذر تسليم الطلب'
              );
            }
          } else if (nextStatus === 'completed') {
            const token = await getIdToken(user, true);
            const response = await fetch(`${API_BASE}/api/orders/complete`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              },
              body: JSON.stringify({ orderId })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || 'تعذر إكمال الطلب');
          } else {
            await updateDoc(
              doc(db, 'orders', orderId),
              {
                status: nextStatus
              }
            );
          }

          // رسالة تلقائية داخل محادثة الطلب
          let message = '';

          if (nextStatus === 'accepted') {
            message = 'تم قبول الطلب والبدء في تنفيذ الخدمة.';
          }

          if (nextStatus === 'delivered') {
            message = 'تم تسليم الطلب وإرفاق ملفات التسليم.';
          }

          if (nextStatus === 'redelivered') {
            message =
              'تمت إعادة تسليم الطلب بعد تنفيذ التعديلات المطلوبة.';
          }

          if (nextStatus === 'completed') {
            message =
              'تم تأكيد استلام الطلب وإكماله.';
          }

          if (message) {
            await addDoc(
              collection(
                db,
                'orders',
                orderId,
                'messages'
              ),
              {
                senderId: user.uid,
                text: message,
                createdAt: serverTimestamp()
              }
            );
          }


          await load(user);

        } catch (e) {
          console.error(
            'ORDER STATUS ERROR',
            e
          );

          btn.disabled = false;

          const friendly = (e.code || e.message) === 'DIRECT_PAYMENT_REFUND_REQUIRED'
            ? 'الدفع تم مباشرةً للبائع. لا يوجد رد آلي؛ افتح نزاعًا أو تواصل مع الدعم لطلب الاسترداد.'
            : (e.code || e.message);
          alert('تعذر تحديث الطلب: ' + friendly);
        }
      };
    });


  /*
   * اختيار ورفع عدة ملفات
   */
  [...seller.querySelectorAll('.order-file-input'), ...buyer.querySelectorAll('.order-file-input')]
    .forEach(input => {
      input.onchange = () => {
        const orderId = input.dataset.fileOrder;
        const role = input.dataset.fileRole;

        const list = document.querySelector(
          `[data-selected-files="${CSS.escape(orderId)}"]`
        );

        const btn = document.querySelector(
          `[data-upload-order="${CSS.escape(orderId)}"][data-upload-role="${CSS.escape(role)}"]`
        );

        const files = Array.from(input.files || []);

        if (!list || !btn) return;

        list.innerHTML = files.map((file, index) => `
          <div class="selected-file">
            <span>
              ${file.type?.startsWith('image/') ? '🖼️' : '📄'}
              ${esc(file.name)}
              <small>(${formatFileSize(file.size)})</small>
            </span>

            <button
              type="button"
              class="remove-selected-file"
              data-remove-file="${esc(orderId)}"
              data-remove-index="${index}"
              data-remove-role="${esc(role)}"
            >
              ×
            </button>
          </div>
        `).join('');

        btn.disabled = files.length === 0;
      };
    });

  [...seller.querySelectorAll('.upload-file-btn'), ...buyer.querySelectorAll('.upload-file-btn')]
    .forEach(btn => {
      btn.onclick = async () => {
        const orderId = btn.dataset.uploadOrder;
        const role = btn.dataset.uploadRole;

        const input = document.querySelector(
          `[data-file-order="${CSS.escape(orderId)}"][data-file-role="${CSS.escape(role)}"]`
        );

        const status = document.querySelector(
          `[data-upload-status="${CSS.escape(orderId)}"]`
        );

        const files = Array.from(input?.files || []);

        if (!files.length) {
          alert('اختر ملفًا واحدًا على الأقل');
          return;
        }

        try {
          btn.disabled = true;

          for (let i = 0; i < files.length; i++) {
            status.textContent =
              `جاري رفع الملف ${i + 1} من ${files.length}...`;

            await uploadOrderFile({
              orderId,
              role,
              file: files[i]
            });
          }

          status.textContent =
            `تم رفع ${files.length} ملف بنجاح ✓`;

          input.value = '';

          const list = document.querySelector(
            `[data-selected-files="${CSS.escape(orderId)}"]`
          );

          if (list) {
            list.innerHTML = '';
          }

          await load(user);

        } catch (e) {
          console.error('FILE UPLOAD ERROR', e);
          status.textContent = '';
          alert('تعذر رفع الملف: ' + e.message);

        } finally {
          btn.disabled = false;
        }
      };
    });

  /*
   * أزرار تنزيل الملفات
   */
  [...seller.querySelectorAll('.download-file-btn'), ...buyer.querySelectorAll('.download-file-btn')]
    .forEach(btn => {
      btn.onclick = async () => {
        try {
          btn.disabled = true;
          btn.textContent = 'جاري التجهيز...';

          if (!auth.currentUser) {
            throw new Error('يجب تسجيل الدخول أولًا');
          }

          const token = await getIdToken(auth.currentUser, true);
          const orderId = btn.dataset.downloadOrder;
          const fileId = btn.dataset.downloadFile;

          const response = await fetch(
            `https://elawamy-file-server.vercel.app/api/files/download-url?orderId=${encodeURIComponent(orderId)}&fileId=${encodeURIComponent(fileId)}`,
            {
              headers: {
                Authorization: `Bearer ${token}`
              }
            }
          );

          const result = await response.json();

          if (!response.ok) {
            throw new Error(result.error || 'تعذر إنشاء رابط التنزيل');
          }

          window.open(result.url, '_blank', 'noopener');
        } catch (e) {
          console.error('FILE DOWNLOAD ERROR', e);
          alert('تعذر تنزيل الملف: ' + e.message);
        } finally {
          btn.disabled = false;
          btn.textContent = 'تنزيل';
        }
      };
    });
}

requireUser(load);
