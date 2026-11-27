import {
  auth,
  db,
  onAuthStateChanged,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  updateDoc,
  doc
} from './firebase.js';

const TYPE_LABELS = {
  new_order: 'طلب جديد',
  order_accepted: 'تم قبول الطلب',
  order_delivered: 'تم تسليم الطلب',
  revision_requested: 'طلب تعديل',
  order_redelivered: 'إعادة التسليم',
  order_completed: 'اكتمل الطلب',
  new_message: 'رسالة جديدة',
  new_review: 'تقييم جديد'
};

let unsubscribe = null;
let notifications = [];

function esc(value = '') {
  const div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
}

function timeValue(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value?.seconds) return Number(value.seconds) * 1000;
  const n = new Date(value).getTime();
  return Number.isFinite(n) ? n : 0;
}

function relativeTime(value) {
  const t = timeValue(value);
  if (!t) return 'الآن';

  const diff = Math.max(0, Date.now() - t);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'الآن';
  if (minutes < 60) return `منذ ${minutes} دقيقة`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `منذ ${hours} ساعة`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `منذ ${days} يوم`;

  return new Date(t).toLocaleDateString('ar-EG');
}

function ensureUI() {
  const nav = document.querySelector('.site-header nav, header nav');
  if (!nav || document.getElementById('notificationBell')) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'notifications-wrap';
  wrapper.innerHTML = `
    <button
      id="notificationBell"
      class="notification-bell"
      type="button"
      aria-label="الإشعارات"
      aria-expanded="false"
    >
      <span class="notification-icon">🔔</span>
      <span id="notificationCount" class="notification-count" hidden>0</span>
    </button>

    <div id="notificationPanel" class="notification-panel" hidden>
      <div class="notification-panel-head">
        <strong>الإشعارات</strong>
        <button id="markAllNotifications" type="button">تحديد الكل كمقروء</button>
      </div>
      <div id="notificationList" class="notification-list">
        <div class="notification-empty">جاري تحميل الإشعارات...</div>
      </div>
    </div>
  `;

  const logout = nav.querySelector('#logout');
  if (logout) nav.insertBefore(wrapper, logout);
  else nav.appendChild(wrapper);

  const bell = wrapper.querySelector('#notificationBell');
  const panel = wrapper.querySelector('#notificationPanel');

  bell.addEventListener('click', event => {
    event.stopPropagation();
    const open = panel.hidden;
    panel.hidden = !open;
    bell.setAttribute('aria-expanded', String(open));
  });

  document.addEventListener('click', event => {
    if (!wrapper.contains(event.target)) {
      panel.hidden = true;
      bell.setAttribute('aria-expanded', 'false');
    }
  });

  wrapper.querySelector('#markAllNotifications')?.addEventListener('click', async () => {
    const unread = notifications.filter(n => n.read === false);
    await Promise.allSettled(
      unread.map(n => updateDoc(doc(db, 'notifications', n.id), { read: true }))
    );
  });
}

function render() {
  const list = document.getElementById('notificationList');
  const count = document.getElementById('notificationCount');
  if (!list || !count) return;

  const unread = notifications.filter(n => n.read === false).length;
  count.textContent = unread > 99 ? '99+' : String(unread);
  count.hidden = unread === 0;

  if (!notifications.length) {
    list.innerHTML = '<div class="notification-empty">لا توجد إشعارات حتى الآن.</div>';
    return;
  }

  list.innerHTML = notifications.map(n => `
    <button
      class="notification-item ${n.read ? '' : 'unread'}"
      type="button"
      data-notification-id="${esc(n.id)}"
      data-order-id="${esc(n.orderId || '')}"
    >
      <span class="notification-dot" aria-hidden="true"></span>
      <span class="notification-content">
        <strong>${esc(n.title || TYPE_LABELS[n.type] || 'إشعار')}</strong>
        <span>${esc(n.body || '')}</span>
        <small>${relativeTime(n.createdAt)}</small>
      </span>
    </button>
  `).join('');

  list.querySelectorAll('[data-notification-id]').forEach(item => {
    item.addEventListener('click', async () => {
      const id = item.dataset.notificationId;
      const orderId = item.dataset.orderId;

      try {
        const current = notifications.find(n => n.id === id);
        if (current && !current.read) {
          await updateDoc(doc(db, 'notifications', id), { read: true });
        }
      } catch (error) {
        console.error('MARK NOTIFICATION READ ERROR:', error);
      }

      if (orderId) {
        location.href = `/orders?order=${encodeURIComponent(orderId)}`;
      }
    });
  });
}

function start(user) {
  ensureUI();

  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }

  if (!user) {
    notifications = [];
    const wrap = document.querySelector('.notifications-wrap');
    if (wrap) wrap.hidden = true;
    return;
  }

  const wrap = document.querySelector('.notifications-wrap');
  if (wrap) wrap.hidden = false;

  unsubscribe = onSnapshot(
    query(
      collection(db, 'notifications'),
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc'),
      limit(30)
    ),
    snapshot => {
      notifications = snapshot.docs
        .map(d => ({ id: d.id, ...d.data() }));
      render();
    },
    error => {
      console.error('NOTIFICATIONS REALTIME ERROR:', error);
      const list = document.getElementById('notificationList');
      if (list) list.innerHTML = '<div class="notification-empty">تعذر تحميل الإشعارات.</div>';
    }
  );
}

onAuthStateChanged(auth, start);
