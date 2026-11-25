import {
  auth,
  db,
  onAuthStateChanged,
  collection,
  query,
  orderBy,
  getDocs,
  doc,
  updateDoc,
  serverTimestamp
} from './firebase.js';

const agentStatus = document.getElementById('agentStatus');
const agentPanel = document.getElementById('agentPanel');

const SUPPORT_EMAIL = 'mhmdalwamy957@gmail.com';

const esc = value =>
  String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[c]));

const money = value =>
  Number(value || 0).toLocaleString('ar-EG');

const dateText = value => {
  if (!value) return '-';

  try {
    const date = value?.toDate
      ? value.toDate()
      : new Date(value);

    return date.toLocaleString('ar-EG');
  } catch {
    return '-';
  }
};

const getCollection = async name => {
  const snap = await getDocs(collection(db, name));
  return snap.docs.map(item => ({
    id: item.id,
    ...item.data()
  }));
};

function showSection(id) {
  document.querySelectorAll('.admin-section').forEach(section => {
    section.hidden = section.id !== id;
  });

  document.querySelectorAll('[data-admin-section]').forEach(button => {
    button.classList.toggle(
      'active',
      button.dataset.adminSection === id
    );
  });
}

function renderStats({
  users,
  services,
  orders,
  reviews,
  tickets
}) {
  const usersCount = document.getElementById('statUsers');
  const servicesCount = document.getElementById('statServices');
  const ordersCount = document.getElementById('statOrders');
  const reviewsCount = document.getElementById('statReviews');
  const ticketsCount = document.getElementById('statTickets');

  if (usersCount) usersCount.textContent = users.length;
  if (servicesCount) servicesCount.textContent = services.length;
  if (ordersCount) ordersCount.textContent = orders.length;
  if (reviewsCount) reviewsCount.textContent = reviews.length;
  if (ticketsCount) ticketsCount.textContent = tickets.length;
}

function renderUsers(users) {
  const box =
    document.getElementById('adminUsersList') ||
    document.getElementById('usersList');

  if (!box) return;

  if (!users.length) {
    box.innerHTML = '<p class="muted">لا يوجد مستخدمون.</p>';
    return;
  }

  box.innerHTML = users.map(user => `
    <div class="card admin-item">
      <div>
        <strong>${esc(user.name || user.displayName || 'بدون اسم')}</strong>
        <p class="muted">${esc(user.email || '-')}</p>
        <small>UID: ${esc(user.id)}</small>
      </div>
    </div>
  `).join('');
}

function renderServices(services) {
  const box =
    document.getElementById('adminServicesList') ||
    document.getElementById('servicesList');

  if (!box) return;

  if (!services.length) {
    box.innerHTML = '<p class="muted">لا توجد خدمات.</p>';
    return;
  }

  box.innerHTML = services.map(service => `
    <div class="card admin-item">
      <div>
        <strong>${esc(service.title || service.name || 'بدون عنوان')}</strong>
        <p>${esc(service.description || '')}</p>
        <small>
          السعر: ${money(service.price)} ج.م
          • البائع: ${esc(service.ownerId || '-')}
        </small>
      </div>
    </div>
  `).join('');
}

function renderOrders(orders) {
  const box =
    document.getElementById('adminOrdersList') ||
    document.getElementById('ordersList');

  if (!box) return;

  if (!orders.length) {
    box.innerHTML = '<p class="muted">لا توجد طلبات.</p>';
    return;
  }

  box.innerHTML = orders.map(order => `
    <div class="card admin-item">
      <div>
        <strong>طلب ${esc(order.id)}</strong>
        <p>
          الحالة:
          <strong>${esc(order.status || 'غير محدد')}</strong>
        </p>
        <small>
          المشتري: ${esc(order.buyerId || '-')}
          <br>
          البائع: ${esc(order.sellerId || '-')}
          <br>
          السعر: ${money(order.price)} ج.م
          <br>
          التاريخ: ${dateText(order.createdAt)}
        </small>
      </div>
    </div>
  `).join('');
}

function renderReviews(reviews) {
  const box =
    document.getElementById('adminReviewsList') ||
    document.getElementById('reviewsList');

  if (!box) return;

  if (!reviews.length) {
    box.innerHTML = '<p class="muted">لا توجد تقييمات.</p>';
    return;
  }

  box.innerHTML = reviews.map(review => `
    <div class="card admin-item">
      <div>
        <strong>
          ${'★'.repeat(Number(review.rating || 0))}
          ${'☆'.repeat(Math.max(0, 5 - Number(review.rating || 0)))}
        </strong>
        <p>${esc(review.text || 'بدون تعليق')}</p>
        <small>
          الخدمة: ${esc(review.serviceId || '-')}
          <br>
          المشتري: ${esc(review.buyerId || '-')}
          <br>
          التاريخ: ${dateText(review.createdAt)}
        </small>
      </div>
    </div>
  `).join('');
}

function renderTickets(tickets) {
  const box =
    document.getElementById('adminTicketsList') ||
    document.getElementById('agentTickets');

  if (!box) return;

  if (!tickets.length) {
    box.innerHTML = '<p class="muted">لا توجد تذاكر دعم.</p>';
    return;
  }

  box.innerHTML = tickets.map(ticket => `
    <article class="card agent-ticket">
      <h3>${esc(ticket.subject || 'تذكرة دعم')}</h3>

      <p>
        <strong>العميل:</strong>
        ${esc(ticket.email || ticket.userEmail || ticket.userId || '-')}
      </p>

      <p>
        <strong>التصنيف:</strong>
        ${esc(ticket.category || '-')}
      </p>

      <p>
        <strong>الحالة:</strong>
        ${esc(ticket.status || 'open')}
      </p>

      <div class="box">
        ${esc(ticket.message || '')}
      </div>

      ${
        ticket.reply
          ? `
            <div class="box">
              <strong>رد الدعم:</strong>
              <p>${esc(ticket.reply)}</p>
            </div>
          `
          : ''
      }

      <form class="agent-reply-form" data-ticket-id="${esc(ticket.id)}">
        <textarea
          name="reply"
          maxlength="2000"
          placeholder="اكتب رد الدعم..."
          required
        ></textarea>

        <select name="status">
          <option value="answered" ${ticket.status === 'answered' ? 'selected' : ''}>
            تمت الإجابة
          </option>
          <option value="pending" ${ticket.status === 'pending' ? 'selected' : ''}>
            قيد المتابعة
          </option>
          <option value="closed" ${ticket.status === 'closed' ? 'selected' : ''}>
            مغلقة
          </option>
        </select>

        <button class="btn" type="submit">
          حفظ الرد
        </button>
      </form>
    </article>
  `).join('');

  box.querySelectorAll('.agent-reply-form').forEach(form => {
    form.addEventListener('submit', handleReply);
  });
}

async function handleReply(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const ticketId = form.dataset.ticketId;

  const reply = String(
    form.elements.reply?.value || ''
  ).trim();

  const status =
    form.elements.status?.value || 'answered';

  if (!reply) {
    alert('اكتب الرد أولًا.');
    return;
  }

  try {
    await updateDoc(
      doc(db, 'supportTickets', ticketId),
      {
        reply,
        status,
        assignedTo: SUPPORT_EMAIL,
        updatedAt: serverTimestamp()
      }
    );

    alert('تم حفظ الرد بنجاح.');

    await loadAll();
  } catch (error) {
    console.error(error);
    alert('حدث خطأ أثناء حفظ الرد.');
  }
}

async function loadAll() {
  agentStatus.textContent = 'جاري تحميل بيانات لوحة الإدارة...';

  const [
    users,
    services,
    orders,
    reviews,
    tickets
  ] = await Promise.all([
    getCollection('users'),
    getCollection('services'),
    getCollection('orders'),
    getCollection('reviews'),
    getCollection('supportTickets')
  ]);

  renderStats({
    users,
    services,
    orders,
    reviews,
    tickets
  });

  renderUsers(users);
  renderServices(services);
  renderOrders(orders);

  const recentOrders = document.getElementById('recentOrders');

  if (recentOrders) {
    const latest = [...orders]
      .sort((a, b) => {
        const ad = a.createdAt?.toDate
          ? a.createdAt.toDate()
          : new Date(a.createdAt || 0);

        const bd = b.createdAt?.toDate
          ? b.createdAt.toDate()
          : new Date(b.createdAt || 0);

        return bd - ad;
      })
      .slice(0, 5);

    recentOrders.innerHTML = latest.length
      ? latest.map(order => `
          <div class="card admin-item">
            <strong>طلب ${esc(order.id)}</strong>
            <p>
              الحالة:
              <strong>${esc(order.status || '-')}</strong>
            </p>
            <small>
              ${money(order.price)} ج.م
              • ${dateText(order.createdAt)}
            </small>
          </div>
        `).join('')
      : '<p class="muted">لا توجد طلبات حتى الآن.</p>';
  }

  renderReviews(reviews);
  renderTickets(tickets);
  setupAdminFilters();

  agentStatus.textContent =
    `تم تحميل البيانات: ${users.length} مستخدم • ${services.length} خدمة • ${orders.length} طلب • ${reviews.length} تقييم • ${tickets.length} تذكرة`;

  agentPanel.hidden = false;
}


function setupAdminFilters() {
  const usersSearch = document.getElementById('usersSearch');
  const servicesSearch = document.getElementById('servicesSearch');
  const ordersSearch = document.getElementById('ordersSearch');
  const ordersStatusFilter = document.getElementById('ordersStatusFilter');
  const reviewsSearch = document.getElementById('reviewsSearch');

  usersSearch?.addEventListener('input', () => {
    const q = usersSearch.value.trim().toLowerCase();
    document.querySelectorAll('#usersList .admin-item').forEach(item => {
      item.hidden = q && !item.textContent.toLowerCase().includes(q);
    });
  });

  servicesSearch?.addEventListener('input', () => {
    const q = servicesSearch.value.trim().toLowerCase();
    document.querySelectorAll('#servicesList .admin-item').forEach(item => {
      item.hidden = q && !item.textContent.toLowerCase().includes(q);
    });
  });

  function filterOrders() {
    const q = ordersSearch?.value.trim().toLowerCase() || '';
    const status = ordersStatusFilter?.value || '';

    document.querySelectorAll('#ordersList .admin-item').forEach(item => {
      const text = item.textContent.toLowerCase();
      const matchesSearch = !q || text.includes(q);
      const matchesStatus = !status || item.dataset.status === status;
      item.hidden = !(matchesSearch && matchesStatus);
    });
  }

  ordersSearch?.addEventListener('input', filterOrders);
  ordersStatusFilter?.addEventListener('change', filterOrders);

  reviewsSearch?.addEventListener('input', () => {
    const q = reviewsSearch.value.trim().toLowerCase();
    document.querySelectorAll('#reviewsList .admin-item').forEach(item => {
      item.hidden = q && !item.textContent.toLowerCase().includes(q);
    });
  });
}

function setupNavigation() {
  document
    .querySelectorAll('[data-section]')
    .forEach(button => {
      button.addEventListener('click', () => {
        const section = button.dataset.section;
        const id = `admin-${section}`;

        showSection(id);

        document
          .querySelectorAll('.admin-tab')
          .forEach(tab => {
            tab.classList.toggle(
              'active',
              tab.dataset.section === section
            );
          });
      });
    });
}


onAuthStateChanged(auth, async user => {
  try {
    if (!user) {
      agentStatus.textContent =
        'يجب تسجيل الدخول بحساب الدعم.';
      agentPanel.hidden = true;
      return;
    }

    const tokenResult = await user.getIdTokenResult(true);

    if (tokenResult.claims.supportAgent !== true) {
      agentStatus.textContent =
        'ليس لديك صلاحية الوصول إلى لوحة الإدارة.';
      agentPanel.hidden = true;
      return;
    }

    setupNavigation();
    showSection('admin-dashboard');

    await loadAll();

  } catch (error) {
    console.error(error);

    agentStatus.textContent =
      `حدث خطأ أثناء تحميل لوحة الإدارة: ${error.message}`;

    agentPanel.hidden = false;
  }
});
