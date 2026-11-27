import { auth, onAuthStateChanged, signOut } from './firebase.js';
import { loadFavoriteIds, toggleFavorite } from './favorites.js';
import { getDoc, doc, db } from './firebase.js';

const page = document.getElementById('favoritesPage');
const mobileMenu = document.getElementById('mobileMenu');
const mainNav = document.getElementById('mainNav');
let favoriteIds = new Set();
let currentUser = null;

const esc = (value = '') => {
  const div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
};

const money = (value) => Number(value || 0).toLocaleString('ar-EG');
const safeImage = (value) => {
  try {
    const url = new URL(String(value || ''), location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
};
const delivery = (value) => {
  const days = Number(value || 3);
  if (days === 1) return 'يوم واحد';
  if (days === 2) return 'يومان';
  if (days <= 10) return `${days} أيام`;
  return `${days} يومًا`;
};

function card(service) {
  const image = safeImage(service.imageUrl)
    ? `<img class="service-image" src="${esc(safeImage(service.imageUrl))}" alt="${esc(service.name || 'الخدمة')}" loading="lazy">`
    : `<div class="service-image placeholder"><span>ElaWamy</span></div>`;

  return `<article class="card service-card">
    <a class="service-media" href="/service?id=${encodeURIComponent(service.id)}">${image}</a>
    <div class="card-body">
      <div class="service-top"><span class="badge">${esc(service.category || 'عام')}</span><span class="delivery">⏱ ${delivery(service.deliveryDays)}</span></div>
      <h2 class="service-title"><a href="/service?id=${encodeURIComponent(service.id)}">${esc(service.name || 'خدمة بدون اسم')}</a></h2>
      <p class="service-description">${esc(service.description || '')}</p>
      <div class="card-foot favorite-card-foot">
        <div class="price-box"><small>يبدأ من</small><strong>${money(service.price)} <span>ج.م</span></strong></div>
        <button class="favorite-detail-btn is-favorite" type="button" data-remove-favorite="${esc(service.id)}">♥ إزالة</button>
      </div>
    </div>
  </article>`;
}

async function render() {
  if (!currentUser) return;
  try {
    favoriteIds = await loadFavoriteIds(currentUser);
    const services = [];
    for (const id of favoriteIds) {
      const snap = await getDoc(doc(db, 'services', id));
      if (snap.exists() && snap.data().status === 'approved') {
        services.push({ id: snap.id, ...snap.data() });
      }
    }

    if (!services.length) {
      page.innerHTML = `<div class="empty"><div class="empty-icon">♡</div><strong>لا توجد خدمات في المفضلة</strong><p>اضغط على ♡ في أي خدمة لحفظها هنا.</p><a class="btn small" href="/">تصفح الخدمات</a></div>`;
      return;
    }

    page.innerHTML = `<div class="services-grid">${services.map(card).join('')}</div>`;
    page.querySelectorAll('[data-remove-favorite]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (button.disabled) return;
        button.disabled = true;
        try {
          await toggleFavorite(button.dataset.removeFavorite, favoriteIds, currentUser);
          await render();
        } catch (error) {
          console.error('REMOVE FAVORITE ERROR:', error);
          button.disabled = false;
        }
      });
    });
  } catch (error) {
    console.error('FAVORITES PAGE ERROR:', error);
    page.innerHTML = `<div class="empty"><strong>تعذر تحميل المفضلة</strong><p>حاول تحديث الصفحة مرة أخرى.</p></div>`;
  }
}

onAuthStateChanged(auth, async (user) => {
  currentUser = user || null;
  if (!currentUser) {
    location.replace('/login?redirect=%2Ffavorites');
    return;
  }
  await render();
});

document.getElementById('logout')?.addEventListener('click', async () => {
  await signOut(auth);
  location.replace('/');
});

mobileMenu?.addEventListener('click', () => {
  const open = mainNav.classList.toggle('mobile-open');
  mobileMenu.setAttribute('aria-expanded', String(open));
});
