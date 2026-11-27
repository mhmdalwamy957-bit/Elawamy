const list = document.getElementById('cartList');
const summary = document.getElementById('cartSummary');
const money = n => Number(n || 0).toLocaleString('ar-EG');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function read() { try { return JSON.parse(localStorage.getItem('elawamy_cart') || '[]'); } catch { return []; } }
function write(v) { localStorage.setItem('elawamy_cart', JSON.stringify(v)); }
function render() {
  const items = read();
  if (!items.length) { list.innerHTML = '<div class="empty">السلة فارغة حاليًا.</div>'; summary.innerHTML=''; return; }
  list.innerHTML = items.map((item,i)=>`<article class="card dashboard-service" style="padding:16px"><div><strong>${esc(item.name)}</strong><div>${money(item.price)} ج.م</div></div><div class="dashboard-service-actions"><a class="btn" href="/service?id=${encodeURIComponent(item.id)}">فتح الخدمة</a><button class="btn secondary remove-cart" data-index="${i}">حذف</button></div></article>`).join('');
  const total = items.reduce((s,i)=>s+Number(i.price||0),0);
  summary.innerHTML = `<div class="card" style="padding:20px;margin-top:16px"><strong>إجمالي أسعار الخدمات: ${money(total)} ج.م</strong><p class="muted">الدفع الحقيقي سيُربط لاحقًا بعد اختيار مزود الدفع. حاليًا استخدم زر فتح الخدمة لإتمام الطلب التجريبي.</p></div>`;
  list.querySelectorAll('.remove-cart').forEach(btn=>btn.onclick=()=>{const arr=read();arr.splice(Number(btn.dataset.index),1);write(arr);render();});
}
render();
