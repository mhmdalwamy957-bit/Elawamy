import { auth, getIdToken } from './firebase.js';

const API_BASE =
  'https://elawamy-file-server.vercel.app';

function money(value) {
  const amount = Number(value);

  return Number.isFinite(amount)
    ? amount.toLocaleString('ar-EG')
    : '0';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function openOrderCheckout(service) {
  const requirements = Array.isArray(service?.requirements)
    ? service.requirements
    : [];

  const extras = Array.isArray(service?.extras)
    ? service.extras
    : [];

  const modal = document.createElement('div');

  modal.className = 'order-checkout-modal';

  modal.innerHTML = `
    <div class="order-checkout-backdrop"></div>

    <div class="order-checkout-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="orderCheckoutTitle">

      <button
        type="button"
        class="order-checkout-close"
        aria-label="إغلاق">×</button>

      <div class="order-checkout-content">

        <h2 id="orderCheckoutTitle">
          طلب الخدمة
        </h2>

        <p class="order-checkout-service">
          ${escapeHtml(service?.name || 'خدمة')}
        </p>

        ${
          requirements.length
            ? `
              <section class="checkout-section">
                <h3>متطلبات تنفيذ الخدمة</h3>

                <div class="checkout-requirements">
                  ${requirements.map((item, index) => `
                    <label class="checkout-field">
                      <span>
                        ${escapeHtml(item.question)}
                        ${
                          item.required !== false
                            ? '<b>*</b>'
                            : '<small>اختياري</small>'
                        }
                      </span>

                      <textarea
                        class="checkout-requirement"
                        data-index="${index}"
                        rows="3"
                        placeholder="اكتب إجابتك هنا..."></textarea>
                    </label>
                  `).join('')}
                </div>
              </section>
            `
            : ''
        }

        ${
          extras.length
            ? `
              <section class="checkout-section">
                <h3>إضافات الخدمة</h3>

                <div class="checkout-extras">
                  ${extras.map((extra, index) => `
                    <label class="checkout-extra">
                      <input
                        type="checkbox"
                        class="checkout-extra-input"
                        data-index="${index}">

                      <span class="checkout-extra-info">
                        <strong>
                          ${escapeHtml(extra.title)}
                        </strong>

                        ${
                          extra.description
                            ? `<small>${escapeHtml(extra.description)}</small>`
                            : ''
                        }
                      </span>

                      <strong class="checkout-extra-price">
                        +${money(extra.price)} ج.م
                      </strong>
                    </label>
                  `).join('')}
                </div>
              </section>
            `
            : ''
        }

        <section class="checkout-summary">
          <div>
            <span>سعر الخدمة</span>
            <strong id="checkoutBasePrice">
              ${money(service?.price)} ج.م
            </strong>
          </div>

          <div>
            <span>الإضافات</span>
            <strong id="checkoutExtrasPrice">
              0 ج.م
            </strong>
          </div>

          <div>
            <span>مدة التنفيذ</span>
            <strong id="checkoutDeliveryDays">
              ${Number(service?.deliveryDays || 0)} يوم
            </strong>
          </div>

          <div class="checkout-total">
            <span>الإجمالي</span>
            <strong id="checkoutTotalPrice">
              ${money(service?.price)} ج.م
            </strong>
          </div>
        </section>

        <p
          class="order-checkout-message"
          id="orderCheckoutMessage"></p>

        <button
          type="button"
          class="btn order-checkout-submit"
          id="orderCheckoutSubmit">
          تأكيد الطلب
        </button>

      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const close = () => modal.remove();

  modal
    .querySelector('.order-checkout-close')
    ?.addEventListener('click', close);

  modal
    .querySelector('.order-checkout-backdrop')
    ?.addEventListener('click', close);

  const basePrice = Number(service?.price || 0);
  const baseDeliveryDays =
    Number(service?.deliveryDays || 0);

  const extraInputs = [
    ...modal.querySelectorAll('.checkout-extra-input')
  ];

  function getSelectedExtras() {
    return extraInputs
      .filter(input => input.checked)
      .map(input => Number(input.dataset.index));
  }

  function calculatePreview() {
    const selected = getSelectedExtras();

    const extrasTotal = selected.reduce(
      (sum, index) =>
        sum + Number(extras[index]?.price || 0),
      0
    );

    const extrasDays = selected.reduce(
      (sum, index) =>
        sum + Number(extras[index]?.deliveryDays || 0),
      0
    );

    return {
      extrasTotal,
      deliveryDays: baseDeliveryDays + extrasDays
    };
  }

  function updateTotal() {
    const preview = calculatePreview();

    modal.querySelector('#checkoutExtrasPrice')
      .textContent =
      `${money(preview.extrasTotal)} ج.م`;

    modal.querySelector('#checkoutTotalPrice')
      .textContent =
      `${money(basePrice + preview.extrasTotal)} ج.م`;

    modal.querySelector('#checkoutDeliveryDays')
      .textContent =
      `${preview.deliveryDays} يوم`;
  }

  extraInputs.forEach(input => {
    input.addEventListener('change', updateTotal);
  });

  modal
    .querySelector('#orderCheckoutSubmit')
    ?.addEventListener('click', async () => {
      const button =
        modal.querySelector('#orderCheckoutSubmit');

      const message =
        modal.querySelector('#orderCheckoutMessage');

      const user = auth.currentUser;

      if (!user) {
        message.textContent =
          'يجب تسجيل الدخول أولًا.';
        return;
      }

      const answers = [
        ...modal.querySelectorAll('.checkout-requirement')
      ].map(input => ({
        questionIndex: Number(input.dataset.index),
        answer: input.value.trim()
      }));

      const missingRequired = requirements.some(
        (item, index) =>
          item.required !== false &&
          !answers[index]?.answer
      );

      if (missingRequired) {
        message.textContent =
          'من فضلك أكمل المتطلبات المطلوبة أولًا.';
        return;
      }

      const selectedExtras = getSelectedExtras();

      button.disabled = true;
      button.textContent =
        'جاري إنشاء الطلب...';

      message.textContent = '';

      try {
        const token =
          await getIdToken(user, true);

        const response = await fetch(
          `${API_BASE}/api/orders/create`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
              serviceId: service.id,
              answers,
              selectedExtras
            })
          }
        );

        const result =
          await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(
            result.error ||
            'تعذر إنشاء الطلب'
          );
        }

        message.textContent =
          'تم إنشاء الطلب. افتح صفحة الطلبات لإكمال الدفع، وبعد تأكيد الدفع يستطيع البائع قبول الطلب.';

        button.textContent =
          'تم إنشاء الطلب ✓';

        setTimeout(() => {
          location.href = `/orders?order=${encodeURIComponent(result.orderId || '')}`;
        }, 1200);

      } catch (error) {
        console.error(
          'CREATE ORDER CHECKOUT ERROR:',
          error
        );

        message.textContent =
          error.message === 'MISSING_REQUIRED_REQUIREMENT'
            ? 'أكمل المتطلبات المطلوبة.'
            : 'تعذر إنشاء الطلب. حاول مرة أخرى.';

        button.disabled = false;
        button.textContent =
          'تأكيد الطلب';
      }
    });

  updateTotal();
}
