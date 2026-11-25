import {
  auth,
  db,
  onAuthStateChanged,
  getIdToken,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit
} from './firebase.js';

const API_BASE = 'https://elawamy-file-server.vercel.app';
const page = document.getElementById('walletPage');
const money = value => Number(value || 0).toLocaleString('ar-EG', { maximumFractionDigits: 2 });
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

function dateText(value) {
  const t = value?.toMillis?.() ?? value?.seconds * 1000 ?? 0;
  return t ? new Date(t).toLocaleString('ar-EG') : '-';
}

function txnLabel(type) {
  return ({
    order_payment: 'دفع طلب',
    sale_hold: 'مبلغ معلق من بيع',
    sale_release: 'تحويل ربح إلى الرصيد',
    sale_reversal: 'عكس عملية بيع',
    order_refund: 'رد مبلغ',
    direct_sale: 'بيع مباشر — المبلغ دُفع للبائع',
    platform_fee_due: 'عمولة مستحقة للعوامي',
    platform_fee_payment: 'سداد عمولة العوامي',
    withdrawal_hold: 'طلب سحب',
    withdrawal_paid: 'سحب مدفوع',
    withdrawal_reversal: 'إرجاع سحب'
  }[type] || type || 'عملية');
}

async function load(user) {
  if (!user) {
    location.replace(`/login?redirect=${encodeURIComponent('/wallet')}`);
    return;
  }

  try {
    const walletSnap = await getDoc(doc(db, 'wallets', user.uid));
    const wallet = walletSnap.exists() ? walletSnap.data() : {};

    const [txSnap, withdrawalSnap, configResponse, paymentProfileResponse] = await Promise.all([
      getDocs(query(
        collection(db, 'transactions'),
        where('userId', '==', user.uid),
        orderBy('createdAt', 'desc'),
        limit(30)
      )),
      getDocs(query(
        collection(db, 'withdrawals'),
        where('sellerId', '==', user.uid),
        orderBy('createdAt', 'desc'),
        limit(20)
      )),
      fetch(`${API_BASE}/api/finance/config`, {
        headers: { Authorization: `Bearer ${await getIdToken(user, true)}` }
      }).catch(() => null),
      fetch(`${API_BASE}/api/seller/direct-payment-profile`, {
        headers: { Authorization: `Bearer ${await getIdToken(user, true)}` }
      }).catch(() => null)
    ]);

    const config = configResponse?.ok
      ? await configResponse.json().catch(() => ({ provider: 'unconfigured', mode: 'unavailable', configured: false }))
      : { provider: 'unconfigured', mode: 'unavailable', configured: false, feePercent: 7, minWithdrawal: 100, directPaymentMethod: null };

    const paymentProfile = paymentProfileResponse?.ok
      ? await paymentProfileResponse.json().catch(() => ({}))
      : { configured: false, method: 'vodafone_cash', account: '', accountName: '' };

    const transactions = txSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const withdrawals = withdrawalSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    page.innerHTML = `
      <section class="dashboard-header">
        <div>
          <span class="muted">الحساب المالي للبائع</span>
          <h1>الأرباح والمحفظة</h1>
          <p class="muted">الوضع الحالي: <strong>${esc(config.mode === 'demo' ? 'تجريبي' : config.configured === false ? 'غير متاح' : config.mode === 'live' ? 'فعلي' : 'يدوي')}</strong> — عمولة المنصة ${money(config.feePercent)}%</p>
        </div>
        <a class="btn" href="/seller-dashboard">لوحة البائع</a>
      </section>

      <div class="dashboard-stats">
        <div class="dashboard-stat"><span>الرصيد المتاح</span><strong>${money(wallet.availableBalance)} <small>ج.م</small></strong></div>
        <div class="dashboard-stat"><span>أرباح معلقة</span><strong>${money(wallet.pendingBalance)} <small>ج.م</small></strong></div>
        <div class="dashboard-stat"><span>سحوبات معلقة</span><strong>${money(wallet.lockedBalance)} <small>ج.م</small></strong></div>
        <div class="dashboard-stat"><span>صافي الأرباح التاريخية</span><strong>${money(wallet.lifetimeNet)} <small>ج.م</small></strong></div>
        <div class="dashboard-stat"><span>عمولة العوامي المستحقة</span><strong>${money(wallet.platformFeeDue)} <small>ج.م</small></strong></div>
      </div>

      ${config.provider === 'direct_transfer' ? `
      <section class="dashboard-section">
        <div class="dashboard-section-head">
          <h2>بيانات استلام المدفوعات المباشرة</h2>
          <span class="muted">Vodafone Cash</span>
        </div>
        <p class="muted">هذه البيانات يراها المشتري فقط عند بدء الدفع لهذا الطلب. استخدم رقم محفظتك الحقيقي.</p>
        <form id="directPaymentProfileForm" class="support-form">
          <div class="form-grid">
            <input id="directPaymentAccount" inputmode="numeric" maxlength="11" required placeholder="رقم Vodafone Cash" value="${esc(paymentProfile.account || '')}">
            <input id="directPaymentAccountName" maxlength="100" required placeholder="اسم صاحب المحفظة" value="${esc(paymentProfile.accountName || '')}">
          </div>
          <button class="btn" type="submit">حفظ بيانات الدفع المباشر</button>
          <p id="directPaymentProfileMessage" class="muted"></p>
        </form>
      </section>
      ` : ''}

      <section class="dashboard-section">
        <div class="dashboard-section-head">
          <h2>طلب سحب</h2>
          <span class="muted">الحد الأدنى ${money(config.minWithdrawal || 100)} ج.م</span>
        </div>
        <form id="withdrawForm" class="support-form">
          <div class="form-grid">
            <select id="withdrawMethod" required>
              <option value="">طريقة السحب</option>
              <option value="instapay">InstaPay</option>
              <option value="ewallet">محفظة إلكترونية</option>
              <option value="bank">حساب بنكي</option>
            </select>
            <input id="withdrawAccount" maxlength="120" required placeholder="رقم الحساب / الهاتف / بيانات السحب">
          </div>
          <div class="form-grid">
            <input id="withdrawAmount" type="number" min="${Number(config.minWithdrawal || 100)}" step="0.01" required placeholder="المبلغ بالجنيه">
            <button class="btn" type="submit">طلب سحب</button>
          </div>
          <p id="withdrawMessage" class="muted"></p>
        </form>
      </section>

      <section class="dashboard-section">
        <div class="dashboard-section-head"><h2>طلبات السحب</h2></div>
        ${withdrawals.length ? `
          <div class="dashboard-orders">
            ${withdrawals.map(item => `
              <div class="dashboard-order">
                <div>
                  <strong>${money(item.amount)} ج.م — ${esc(item.method || '-')}</strong>
                  <span class="muted">${esc(item.account || '')} · ${dateText(item.createdAt)}</span>
                </div>
                <span class="order-status ${esc(item.status || '')}">${esc(item.status || '-')}</span>
              </div>
            `).join('')}
          </div>
        ` : '<div class="empty">لا توجد طلبات سحب حتى الآن.</div>'}
      </section>

      <section class="dashboard-section">
        <div class="dashboard-section-head"><h2>آخر الحركات المالية</h2></div>
        ${transactions.length ? `
          <div class="dashboard-orders">
            ${transactions.map(tx => `
              <div class="dashboard-order">
                <div>
                  <strong>${esc(txnLabel(tx.type))}</strong>
                  <span class="muted">${dateText(tx.createdAt)}</span>
                </div>
                <div class="dashboard-order-side">
                  <strong>${tx.direction === 'debit' ? '-' : '+'}${money(tx.amount)} ج.م</strong>
                  <span class="muted">${esc(tx.status || '-')}</span>
                </div>
              </div>
            `).join('')}
          </div>
        ` : '<div class="empty">لا توجد حركات مالية بعد.</div>'}
      </section>

      <div class="notice-box">
        <strong>${config.configured === false ? 'الدفع غير متاح مؤقتًا' : config.provider === 'xpay' ? 'الدفع عبر XPay' : config.provider === 'direct_transfer' ? 'الدفع المباشر للبائع' : 'الدفع التجريبي'}</strong>
        <p>${config.configured === false ? 'تعذر تأكيد إعدادات الدفع. لم يتم تحويلك إلى وسيلة دفع بديلة تلقائيًا. حاول لاحقًا أو تواصل مع الدعم.' : config.provider === 'xpay' ? 'المدفوعات تمر عبر XPay.' : config.provider === 'direct_transfer' ? 'المشتري يحول قيمة الطلب مباشرة إلى Vodafone Cash الخاصة بالبائع. عمولة العوامي 7% تسجل كرسوم مستحقة على البائع ويتم تسويتها يدويًا مع الإدارة. لا تحتفظ ElaWamy بأموال العميل في هذه المرحلة.' : 'المحفظة والعمولات والسحب تعمل داخليًا للاختبار. لا يتم تحويل أموال حقيقية في الوضع التجريبي.'}</p>
      </div>
    `;

    document.getElementById('directPaymentProfileForm')?.addEventListener('submit', async event => {
      event.preventDefault();
      const button = event.currentTarget.querySelector('button');
      const message = document.getElementById('directPaymentProfileMessage');
      button.disabled = true;
      message.textContent = 'جاري حفظ بيانات المحفظة...';
      try {
        const token = await getIdToken(user, true);
        const response = await fetch(`${API_BASE}/api/seller/direct-payment-profile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            method: 'vodafone_cash',
            account: document.getElementById('directPaymentAccount').value.trim(),
            accountName: document.getElementById('directPaymentAccountName').value.trim()
          })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'تعذر حفظ بيانات المحفظة');
        message.textContent = '✅ تم حفظ بيانات Vodafone Cash.';
      } catch (error) {
        message.textContent = `❌ ${error.message}`;
      } finally {
        button.disabled = false;
      }
    });

    document.getElementById('withdrawForm').addEventListener('submit', async event => {
      event.preventDefault();
      const button = event.currentTarget.querySelector('button');
      const message = document.getElementById('withdrawMessage');
      button.disabled = true;
      message.textContent = 'جاري إرسال طلب السحب...';

      try {
        const token = await getIdToken(user, true);
        const response = await fetch(`${API_BASE}/api/wallet/withdraw`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            method: document.getElementById('withdrawMethod').value,
            account: document.getElementById('withdrawAccount').value.trim(),
            amount: Number(document.getElementById('withdrawAmount').value)
          })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'تعذر إنشاء طلب السحب');
        message.textContent = '✅ تم إنشاء طلب السحب، وسينتظر مراجعة الإدارة.';
        setTimeout(() => load(user), 500);
      } catch (error) {
        message.textContent = `❌ ${error.message}`;
        button.disabled = false;
      }
    });
  } catch (error) {
    console.error('WALLET ERROR:', error);
    page.innerHTML = `<div class="empty"><strong>تعذر تحميل المحفظة</strong><p>${esc(error?.message || 'حاول مرة أخرى.')}</p></div>`;
  }
}

onAuthStateChanged(auth, load);
