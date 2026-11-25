import { createService } from './firestore-services.js';
import { requireUser } from './guard.js';

requireUser(() => {
  const saveBtn = document.getElementById('save');
  const message = document.getElementById('message');

  const requirementsList =
    document.getElementById('requirementsList');

  const extrasList =
    document.getElementById('extrasList');

  const faqList =
    document.getElementById('faqList');

  function addRequirementRow() {
    const row = document.createElement('div');

    row.className = 'form-grid';

    row.innerHTML = `
      <input
        class="requirement-question"
        maxlength="300"
        placeholder="ما المعلومة المطلوبة من المشتري؟"
      >

      <select class="requirement-required">
        <option value="true">مطلوب</option>
        <option value="false">اختياري</option>
      </select>

      <button type="button" class="btn remove-row">
        حذف
      </button>
    `;

    row.querySelector('.remove-row').onclick = () => {
      row.remove();
    };

    requirementsList.appendChild(row);
  }

  function addExtraRow() {
    const row = document.createElement('div');

    row.className = 'box';

    row.innerHTML = `
      <input
        class="extra-title"
        maxlength="100"
        placeholder="اسم الإضافة"
      >

      <textarea
        class="extra-description"
        maxlength="500"
        placeholder="وصف الإضافة"
      ></textarea>

      <div class="form-grid">
        <input
          class="extra-price"
          type="number"
          min="1"
          max="100000"
          step="1"
          placeholder="سعر الإضافة"
        >

        <input
          class="extra-delivery"
          type="number"
          min="1"
          max="90"
          step="1"
          placeholder="أيام إضافية"
        >
      </div>

      <button type="button" class="btn remove-row">
        حذف
      </button>
    `;

    row.querySelector('.remove-row').onclick = () => {
      row.remove();
    };

    extrasList.appendChild(row);
  }

  function addFaqRow() {
    const row = document.createElement('div');

    row.className = 'box';

    row.innerHTML = `
      <input
        class="faq-question"
        maxlength="300"
        placeholder="السؤال"
      >

      <textarea
        class="faq-answer"
        maxlength="1000"
        placeholder="الإجابة"
      ></textarea>

      <button type="button" class="btn remove-row">
        حذف
      </button>
    `;

    row.querySelector('.remove-row').onclick = () => {
      row.remove();
    };

    faqList.appendChild(row);
  }

  document.getElementById('addRequirement').onclick =
    addRequirementRow;

  document.getElementById('addExtra').onclick =
    addExtraRow;

  document.getElementById('addFaq').onclick =
    addFaqRow;

  saveBtn.onclick = async () => {
    const name =
      document.getElementById('name').value.trim();

    const description =
      document.getElementById('description').value.trim();

    const category =
      document.getElementById('category').value.trim();

    const price =
      Number(document.getElementById('price').value);

    const deliveryDays =
      Number(
        document.getElementById('deliveryDays').value
      );

    const imageUrl =
      document.getElementById('imageUrl').value.trim();

    const instructions =
      document.getElementById('instructions').value.trim();

    const tags = document
      .getElementById('tags')
      .value
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean)
      .slice(0, 10);

    const requirements = [
      ...requirementsList.querySelectorAll('.form-grid')
    ]
      .map(row => ({
        question:
          row
            .querySelector('.requirement-question')
            ?.value
            .trim() || '',

        required:
          row.querySelector('.requirement-required')
            ?.value !== 'false'
      }))
      .filter(item => item.question)
      .slice(0, 20);

    const extras = [
      ...extrasList.querySelectorAll('.box')
    ]
      .map(row => ({
        title:
          row.querySelector('.extra-title')
            ?.value
            .trim() || '',

        description:
          row.querySelector('.extra-description')
            ?.value
            .trim() || '',

        price:
          Number(
            row.querySelector('.extra-price')?.value
          ),

        deliveryDays:
          Number(
            row.querySelector('.extra-delivery')?.value
          )
      }))
      .filter(
        item =>
          item.title &&
          Number.isFinite(item.price) &&
          item.price >= 1 &&
          item.price <= 100000 &&
          Number.isInteger(item.deliveryDays) &&
          item.deliveryDays >= 1 &&
          item.deliveryDays <= 90
      )
      .slice(0, 10);

    const faq = [
      ...faqList.querySelectorAll('.box')
    ]
      .map(row => ({
        question:
          row.querySelector('.faq-question')
            ?.value
            .trim() || '',

        answer:
          row.querySelector('.faq-answer')
            ?.value
            .trim() || ''
      }))
      .filter(item => item.question && item.answer)
      .slice(0, 20);

    message.textContent = '';

    if (
      name.length < 3 ||
      description.length < 10 ||
      !category ||
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

    if (
      tags.some(tag => tag.length > 30)
    ) {
      message.textContent =
        'الكلمة المفتاحية يجب ألا تتجاوز 30 حرفًا.';
      return;
    }

    if (instructions.length > 2000) {
      message.textContent =
        'تعليمات المشتري طويلة جدًا.';
      return;
    }

    if (imageUrl) {
      try {
        const url =
          new URL(imageUrl, location.origin);

        const allowed =
          url.protocol === 'https:' ||
          (
            url.protocol === 'http:' &&
            location.hostname === 'localhost'
          );

        if (!allowed) {
          message.textContent =
            'رابط الصورة يجب أن يبدأ بـ https://';
          return;
        }
      } catch {
        message.textContent =
          'رابط الصورة غير صالح.';
        return;
      }
    }

    saveBtn.disabled = true;
    message.textContent =
      'جاري إرسال الخدمة للمراجعة...';

    try {
      const serviceId = await createService({
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
        instructions
      });

      console.log(
        'SERVICE CREATED:',
        serviceId
      );

      message.textContent =
        '✅ تم إرسال الخدمة للمراجعة بنجاح';

      setTimeout(() => {
        location.replace('/');
      }, 800);

    } catch (error) {
      console.error(
        'CREATE SERVICE ERROR:',
        error
      );

      saveBtn.disabled = false;

      message.textContent =
        '❌ تعذر نشر الخدمة: ' +
        (error?.message ||
          'حدث خطأ غير معروف');
    }
  };
});
