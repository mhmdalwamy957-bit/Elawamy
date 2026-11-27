import { auth, db, doc, getDoc, collection, getDocs, query, where, setDoc, deleteDoc, serverTimestamp, onAuthStateChanged } from './firebase.js';

const page = document.getElementById('sellerPage');
const params = new URLSearchParams(location.search);
const uid = params.get('uid');

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;',
  '<':'&lt;',
  '>':'&gt;',
  '"':'&quot;',
  "'":'&#39;'
}[c]));

const money = value => Number(value || 0).toLocaleString('ar-EG');
const levelText = completedOrders => {
  const raw = Number(completedOrders ?? 0);
  const count = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  if (count >= 100) return 'بائع محترف';
  if (count >= 40) return 'بائع مميز';
  if (count >= 15) return 'بائع موثوق';
  if (count >= 5) return 'بائع نشط';
  return 'بائع جديد';
};

if (!uid) {
  page.innerHTML = '<p>لم يتم تحديد البائع.</p>';
} else {
  try {
    const userSnap = await getDoc(doc(db, 'sellerProfiles', uid));

    if (!userSnap.exists()) {
      page.innerHTML = '<p>ملف البائع غير موجود.</p>';
    } else {
      const user = userSnap.data();

      const servicesSnap = await getDocs(
        query(
          collection(db, 'services'),
          where('ownerId', '==', uid),
          where('status', '==', 'approved')
        )
      );

      const services = servicesSnap.docs.map(item => ({
        id: item.id,
        ...item.data()
      }));

      let portfolio = [];
      try {
        const portfolioSnap = await getDocs(collection(db, 'sellerProfiles', uid, 'portfolio'));
        portfolio = portfolioSnap.docs.map(item => ({ id: item.id, ...item.data() }));
      } catch (portfolioError) {
        console.warn('SELLER PORTFOLIO ERROR:', portfolioError);
      }

      const initial = esc(
        String(user.name || user.email || 'بائع').charAt(0).toUpperCase()
      );

      page.innerHTML = `
        <section class="seller-profile">
          <div class="seller-card">
            <div class="avatar seller-avatar">${initial}</div>
            <div class="seller-info">
              <span class="muted">مقدم الخدمة</span>
              <h1>${esc(user.name || 'بائع ElaWamy')}</h1>
              <span class="seller-status">✓ عضو في ElaWamy</span>
            </div>
          </div>

          <div class="seller-stats">
            <div><strong>${services.length}</strong><span>خدمة</span></div>
            <div><strong>${money(user.completedOrders || 0)}</strong><span>طلبًا مكتملًا</span></div>
            <div><strong>${Number(user.rating || 0).toFixed(1)} ★</strong><span>التقييم</span></div>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin:14px 0">
            <span class="badge">${esc(levelText(user.completedOrders))}</span>
            ${user.verified ? '<span class="badge">✓ حساب موثق</span>' : ''}
          </div>

          <div class="seller-bio">
            <h2>نبذة عن البائع</h2>
            <p>${esc(user.headline || '')}</p><p>${esc(user.bio || 'لم يكتب البائع نبذة عنه بعد.')}</p>${user.portfolioUrl ? `<p><a class="market-link" href="${esc(user.portfolioUrl)}" target="_blank" rel="noopener noreferrer">عرض معرض الأعمال</a></p>` : ''}
          </div>

          <div class="seller-bio">
            <h2>نماذج من الأعمال</h2>
            <div class="mini-list">${portfolio.length ? portfolio.map(item => `<article class="mini-service"><strong>${esc(item.title || '')}</strong><p class="muted">${esc(item.description || '')}</p>${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="${esc(item.title || 'عمل')}" loading="lazy" style="max-width:100%;border-radius:12px;margin-top:8px">` : ''}${item.link ? `<p><a href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">فتح المشروع</a></p>` : ''}</article>`).join('') : '<div class="empty">لم يضف البائع نماذج أعمال بعد.</div>'}</div>
          </div>

          <hr>

          <h2>خدمات البائع</h2>

          <div class="mini-list">
            ${
              services.length
                ? services.map(service => `
                  <a class="mini-service" href="/service?id=${encodeURIComponent(service.id)}">
                    <strong>${esc(service.name || 'خدمة')}</strong>
                    — ${money(service.price)} ج.م
                  </a>
                `).join('')
                : '<div class="empty">لا توجد خدمات منشورة حاليًا.</div>'
            }
          </div>
        </section>
      `;
    }

        const followBox = document.createElement('div');
        followBox.id = 'followBox';
        followBox.style.marginTop = '12px';

        const sellerCard = page.querySelector('.seller-card');
        if (sellerCard) sellerCard.appendChild(followBox);
        if (sellerCard) { const contact = document.createElement('a'); contact.className='btn'; contact.href=`/messages?seller=${encodeURIComponent(uid)}`; contact.textContent='💬 مراسلة البائع قبل الشراء'; sellerCard.appendChild(contact); }

        onAuthStateChanged(auth, async currentUser => {
          if (!currentUser || currentUser.uid === uid) return;

          const followRef = doc(db, 'follows', currentUser.uid, 'sellers', uid);

          try {
            const followSnap = await getDoc(followRef);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn secondary';
            button.textContent = followSnap.exists() ? '✓ متابَع' : '+ متابعة البائع';

            button.addEventListener('click', async () => {
              button.disabled = true;
              try {
                const currentFollow = await getDoc(followRef);
                if (currentFollow.exists()) {
                  await deleteDoc(followRef);
                  button.textContent = '+ متابعة البائع';
                } else {
                  await setDoc(followRef, {
                    sellerId: uid,
                    createdAt: serverTimestamp()
                  });
                  button.textContent = '✓ متابَع';
                }
              } catch (error) {
                console.error(error);
                alert('تعذر تحديث المتابعة.');
              } finally {
                button.disabled = false;
              }
            });

            followBox.appendChild(button);
          } catch (error) {
            console.error(error);
          }
        });
  } catch (error) {
    console.error(error);
    page.innerHTML = '<p>حدث خطأ أثناء تحميل ملف البائع.</p>';
  }
}
