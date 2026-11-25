import {
  db,
  auth,
  onAuthStateChanged,
  doc,
  getDoc,
  updateDoc,
  serverTimestamp
} from './firebase.js';

const params = new URLSearchParams(location.search);
const serviceId = params.get('id');

const nameInput = document.getElementById('name');
const descriptionInput = document.getElementById('description');
const categoryInput = document.getElementById('category');
const priceInput = document.getElementById('price');
const deliveryDaysInput = document.getElementById('deliveryDays');
const imageUrlInput = document.getElementById('imageUrl');
const saveBtn = document.getElementById('save');
const message = document.getElementById('message');

if (!serviceId) {
  message.textContent = '❌ لم يتم تحديد الخدمة.';
  saveBtn.disabled = true;
}

function ensureEditorUI() {
  if (document.getElementById('service2Editor')) {
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.id = 'service2Editor';

  wrapper.innerHTML = `
    <div class="box wide">
      <h2>تفاصيل الخدمة المتقدمة</h2>

      <label>الكلمات المفتاحية</label>
      <div id="tagsRows"></div>
      <button type="button" class="btn small" id="addTagBtn">
        + إضافة كلمة مفتاحية
      </button>

      <hr>

      <h3>متطلبات المشتري</h3>
      <div id="requirementsRows"></div>
      <button type="button" class="btn small" id="addRequirementBtn">
        + إضافة متطلب
      </button>

      <hr>

      <h3>الإضافات</h3>
      <div id="extrasRows"></div>
      <button type="button" class="btn small" id="addExtraBtn">
        + إضافة إضافة
      </button>

      <hr>

      <h3>الأسئلة الشائعة</h3>
      <div id="faqRows"></div>
      <button type="button" class="btn small" id="addFaqBtn">
        + إضافة سؤال
      </button>

      <hr>

      <h3>تعليمات التسليم</h3>
      <textarea
        id="instructions"
        maxlength="2000"
        placeholder="اكتب تعليمات مهمة للمشتري أو طريقة استلام الملفات..."
      ></textarea>
    </div>
  `;

  const anchor = message?.parentElement || document.body;
  anchor.parentElement?.insertBefore(wrapper, anchor);

  document
    .getElementById('addTagBtn')
    ?.addEventListener('click', () => addTagRow());

  document
    .getElementById('addRequirementBtn')
    ?.addEventListener('click', () => addRequirementRow());

  document
    .getElementById('addExtraBtn')
    ?.addEventListener('click', () => addExtraRow());

  document
    .getElementById('addFaqBtn')
    ?.addEventListener('click', () => addFaqRow());
}

function addTagRow(value = '') {
  const box = document.getElementById('tagsRows');
  if (!box) return;

  const row = document.createElement('div');
  row.className = 'service2-row';

  row.innerHTML = `
    <input
      type="text"
      class="tag-input"
      maxlength="30"
      placeholder="مثل: تصميم لوجو"
      value="${escapeAttr(value)}"
    >
    <button type="button" class="btn small danger">حذف</button>
  `;

  row
    .querySelector('button')
    ?.addEventListener('click', () => row.remove());

  box.appendChild(row);
}

function addRequirementRow(item = {}) {
  const box = document.getElementById('requirementsRows');
  if (!box) return;

  const row = document.createElement('div');
  row.className = 'service2-row';

  row.innerHTML = `
    <input
      type="text"
      class="requirement-question"
      maxlength="300"
      placeholder="ما المعلومات التي تحتاجها من المشتري؟"
      value="${escapeAttr(item.question || '')}"
    >

    <label>
      <input
        type="checkbox"
        class="requirement-required"
        ${item.required !== false ? 'checked' : ''}
      >
      مطلوب
    </label>

    <button type="button" class="btn small danger">حذف</button>
  `;

  row
    .querySelector('button')
    ?.addEventListener('click', () => row.remove());

  box.appendChild(row);
}

function addExtraRow(item = {}) {
  const box = document.getElementById('extrasRows');
  if (!box) return;

  const row = document.createElement('div');
  row.className = 'service2-row';

  row.innerHTML = `
    <input
      type="text"
      class="extra-title"
      maxlength="120"
      placeholder="اسم الإضافة"
      value="${escapeAttr(item.title || '')}"
    >

    <input
      type="text"
      class="extra-description"
      maxlength="500"
      placeholder="وصف الإضافة"
      value="${escapeAttr(item.description || '')}"
    >

    <input
      type="number"
      class="extra-price"
      min="1"
      max="100000"
      step="1"
      placeholder="سعر الإضافة"
      value="${item.price ?? ''}"
    >

    <input
      type="number"
      class="extra-days"
      min="1"
      max="90"
      step="1"
      placeholder="أيام إضافية"
      value="${item.deliveryDays ?? ''}"
    >

    <button type="button" class="btn small danger">حذف</button>
  `;

  row
    .querySelector('button')
    ?.addEventListener('click', () => row.remove());

  box.appendChild(row);
}

function addFaqRow(item = {}) {
  const box = document.getElementById('faqRows');
  if (!box) return;

  const row = document.createElement('div');
  row.className = 'service2-row';

  row.innerHTML = `
    <input
      type="text"
      class="faq-question"
      maxlength="300"
      placeholder="السؤال"
      value="${escapeAttr(item.question || '')}"
    >

    <textarea
      class="faq-answer"
      maxlength="1000"
      placeholder="الإجابة"
    >${escapeHtml(item.answer || '')}</textarea>

    <button type="button" class="btn small danger">حذف</button>
  `;

  row
    .querySelector('button')
    ?.addEventListener('click', () => row.remove());

  box.appendChild(row);
}

function escapeHtml(value = '') {
  const div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
}

function escapeAttr(value = '') {
  return escapeHtml(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function collectTags() {
  return [...document.querySelectorAll('.tag-input')]
    .map(input => input.value.trim())
    .filter(Boolean);
}

function collectRequirements() {
  return [...document.querySelectorAll('#requirementsRows .service2-row')]
    .map(row => ({
      question: row.querySelector('.requirement-question')?.value.trim() || '',
      required: row.querySelector('.requirement-required')?.checked !== false
    }))
    .filter(item => item.question);
}

function collectExtras() {
  return [...document.querySelectorAll('#extrasRows .service2-row')]
    .map(row => ({
      title: row.querySelector('.extra-title')?.value.trim() || '',
      description:
        row.querySelector('.extra-description')?.value.trim() || '',
      price: Number(row.querySelector('.extra-price')?.value),
      deliveryDays: Number(row.querySelector('.extra-days')?.value)
    }))
    .filter(item => item.title);
}

function collectFaq() {
  return [...document.querySelectorAll('#faqRows .service2-row')]
    .map(row => ({
      question: row.querySelector('.faq-question')?.value.trim() || '',
      answer: row.querySelector('.faq-answer')?.value.trim() || ''
    }))
    .filter(item => item.question);
}

function validateService2({
  tags,
  requirements,
  extras,
  faq,
  instructions
}) {
  if (tags.length > 10) {
    throw new Error('يمكن إضافة 10 كلمات مفتاحية فقط.');
  }

  if (tags.some(tag => tag.length > 30)) {
    throw new Error('الكلمة المفتاحية يجب ألا تتجاوز 30 حرفًا.');
  }

  if (requirements.length > 20) {
    throw new Error('يمكن إضافة 20 متطلبًا فقط.');
  }

  for (const item of requirements) {
    if (
      !item.question ||
      item.question.length > 300 ||
      typeof item.required !== 'boolean'
    ) {
      throw new Error('يوجد متطلب غير صالح.');
    }
  }

  if (extras.length > 10) {
    throw new Error('يمكن إضافة 10 إضافات فقط.');
  }

  for (const item of extras) {
    if (
      !item.title ||
      item.title.length > 120 ||
      item.description.length > 500 ||
      !Number.isFinite(item.price) ||
      item.price < 1 ||
      item.price > 100000 ||
      !Number.isInteger(item.deliveryDays) ||
      item.deliveryDays < 1 ||
      item.deliveryDays > 90
    ) {
      throw new Error('راجع بيانات الإضافات.');
    }
  }

  if (faq.length > 20) {
    throw new Error('يمكن إضافة 20 سؤالًا فقط.');
  }

  for (const item of faq) {
    if (
      !item.question ||
      item.question.length > 300 ||
      !item.answer ||
      item.answer.length > 1000
    ) {
      throw new Error('راجع بيانات الأسئلة الشائعة.');
    }
  }

  if (instructions.length > 2000) {
    throw new Error('تعليمات التسليم يجب ألا تتجاوز 2000 حرف.');
  }
}

async function loadService(user) {
  if (!user) {
    location.href =
      `/login?redirect=${encodeURIComponent(
        location.pathname + location.search
      )}`;
    return;
  }

  if (!serviceId) return;

  try {
    ensureEditorUI();

    const serviceRef = doc(db, 'services', serviceId);
    const snap = await getDoc(serviceRef);

    if (!snap.exists()) {
      message.textContent = '❌ الخدمة غير موجودة.';
      saveBtn.disabled = true;
      return;
    }

    const service = snap.data();

    if (service.ownerId !== user.uid) {
      message.textContent = '❌ لا يمكنك تعديل هذه الخدمة.';
      saveBtn.disabled = true;
      return;
    }

    nameInput.value = service.name || '';
    descriptionInput.value = service.description || '';
    categoryInput.value = service.category || '';
    priceInput.value = Number(service.price || 0);
    deliveryDaysInput.value = Number(service.deliveryDays || 3);
    imageUrlInput.value = service.imageUrl || '';

    document.getElementById('instructions').value =
      service.instructions || '';

    (Array.isArray(service.tags) ? service.tags : [])
      .forEach(tag => addTagRow(tag));

    (Array.isArray(service.requirements)
      ? service.requirements
      : []
    ).forEach(item => addRequirementRow(item));

    (Array.isArray(service.extras)
      ? service.extras
      : []
    ).forEach(item => addExtraRow(item));

    (Array.isArray(service.faq)
      ? service.faq
      : []
    ).forEach(item => addFaqRow(item));

  } catch (error) {
    console.error('LOAD SERVICE ERROR:', error);
    message.textContent = '❌ تعذر تحميل الخدمة.';
    saveBtn.disabled = true;
  }
}

saveBtn.addEventListener('click', async () => {
  const user = auth.currentUser;

  if (!user) {
    location.href =
      `/login?redirect=${encodeURIComponent(
        location.pathname + location.search
      )}`;
    return;
  }

  const name = nameInput.value.trim();
  const description = descriptionInput.value.trim();
  const category = categoryInput.value.trim();
  const price = Number(priceInput.value);
  const deliveryDays = Number(deliveryDaysInput.value);
  const imageUrl = imageUrlInput.value.trim();

  const tags = collectTags();
  const requirements = collectRequirements();
  const extras = collectExtras();
  const faq = collectFaq();
  const instructions =
    document.getElementById('instructions')?.value.trim() || '';

  message.textContent = '';

  if (
    name.length < 3 ||
    name.length > 80 ||
    description.length < 10 ||
    description.length > 1200 ||
    !category ||
    category.length > 60 ||
    !Number.isFinite(price) ||
    price < 1 ||
    price > 100000 ||
    !Number.isInteger(deliveryDays) ||
    deliveryDays < 1 ||
    deliveryDays > 90
  ) {
    message.textContent =
      'راجع اسم الخدمة والوصف والتصنيف والسعر ومدة التسليم.';
    return;
  }

  if (imageUrl && !/^https:\/\//i.test(imageUrl)) {
    message.textContent =
      'رابط الصورة يجب أن يبدأ بـ https://';
    return;
  }

  try {
    validateService2({
      tags,
      requirements,
      extras,
      faq,
      instructions
    });
  } catch (error) {
    message.textContent = `❌ ${error.message}`;
    return;
  }

  saveBtn.disabled = true;
  message.textContent = 'جاري حفظ التغييرات وإرسال الخدمة للمراجعة...';

  try {
    const serviceRef = doc(db, 'services', serviceId);
    const currentSnap = await getDoc(serviceRef);

    if (!currentSnap.exists()) {
      throw new Error('الخدمة غير موجودة');
    }

    const current = currentSnap.data();

    if (current.ownerId !== user.uid) {
      throw new Error('لا يمكنك تعديل هذه الخدمة');
    }

    await updateDoc(serviceRef, {
      name,
      description,
      category,
      price,
      deliveryDays,
      imageUrl,
      tags,
      requirements,
      extras,
      faq,
      instructions,

      status: 'pending',
      updatedAt: serverTimestamp()
    });

    message.textContent =
      '✅ تم حفظ الخدمة وإرسالها للمراجعة من الإدارة.';

    setTimeout(() => {
      location.href =
        `/service?id=${encodeURIComponent(serviceId)}`;
    }, 900);

  } catch (error) {
    console.error('UPDATE SERVICE ERROR:', error);

    message.textContent =
      '❌ تعذر حفظ الخدمة: ' +
      (error?.message || 'حدث خطأ غير معروف');

    saveBtn.disabled = false;
  }
});

onAuthStateChanged(auth, loadService);
