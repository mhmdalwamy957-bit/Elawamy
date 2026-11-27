import { db, doc, getDoc, auth } from './firebase.js';

function getCart() {
  try { return JSON.parse(localStorage.getItem('elawamy_cart') || '[]'); }
  catch { return []; }
}
function setCart(items) { localStorage.setItem('elawamy_cart', JSON.stringify(items)); }

async function initCartButton() {
  if (!location.pathname.endsWith('/service') && !location.pathname.endsWith('/service.html')) return;
  const id = new URLSearchParams(location.search).get('id');
  if (!id) return;
  const card = await new Promise(resolve => {
    const timer = setInterval(() => {
      const el = document.getElementById('orderService');
      if (el) { clearInterval(timer); resolve(el.closest('.order-card') || el.parentElement); }
    }, 100);
    setTimeout(() => { clearInterval(timer); resolve(null); }, 6000);
  });
  if (!card || card.querySelector('#addToCartService')) return;
  const serviceSnap = await getDoc(doc(db, 'services', id));
  if (!serviceSnap.exists()) return;
  const service = { id, ...serviceSnap.data() };
  if (service.status !== 'approved') return;
  const button = document.createElement('button');
  button.id = 'addToCartService';
  button.className = 'btn secondary';
  button.type = 'button';
  button.textContent = '🛒 أضف إلى السلة';
  button.addEventListener('click', () => {
    if (auth.currentUser && service.ownerId === auth.currentUser.uid) {
      alert('لا يمكنك إضافة خدمتك الخاصة إلى السلة.');
      return;
    }
    const cart = getCart().filter(item => item.id !== service.id);
    cart.push({ id: service.id, name: service.name, price: Number(service.price || 0), imageUrl: service.imageUrl || '' });
    setCart(cart);
    button.textContent = '✓ تمت الإضافة للسلة';
    setTimeout(() => { button.textContent = '🛒 أضف إلى السلة'; }, 1400);
  });
  card.appendChild(button);
}

initCartButton();
