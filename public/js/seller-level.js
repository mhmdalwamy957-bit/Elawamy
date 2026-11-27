import {auth,onAuthStateChanged,db,collection,getDocs,query,where,orderBy,limit,doc,getDoc} from './firebase.js';

const panel = document.getElementById('sellerDashboard');
const LEVEL_LABELS = {
  new: 'بائع جديد',
  bronze: 'بائع نشط',
  silver: 'بائع موثوق',
  gold: 'بائع مميز',
  platinum: 'بائع محترف'
};

function levelFromCompletedOrders(value) {
  const raw = Number(value ?? 0);
  const count = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  if (count >= 100) return 'platinum';
  if (count >= 40) return 'gold';
  if (count >= 15) return 'silver';
  if (count >= 5) return 'bronze';
  return 'new';
}

async function run() {
  const user = auth.currentUser;
  if (!user || !panel) return;

  try {
    const [ordersSnap, profileSnap] = await Promise.all([
      getDocs(query(
        collection(db, 'orders'),
        where('sellerId', '==', user.uid),
        orderBy('createdAt', 'desc'),
        limit(200)
      )),
      getDoc(doc(db, 'sellerProfiles', user.uid))
    ]);

    const orders = ordersSnap.docs.map(item => item.data() || {});
    const recentCompleted = orders.filter(order => order.status === 'completed').length;
    const recentCancelled = orders.filter(order => order.status === 'cancelled').length;
    const profile = profileSnap.exists() ? (profileSnap.data() || {}) : {};
    const savedCount = Number(profile.completedOrders);
    const lifetimeCompleted = Number.isFinite(savedCount) && savedCount >= 0
      ? Math.floor(savedCount)
      : recentCompleted;
    const levelKey = levelFromCompletedOrders(lifetimeCompleted);
    const name = LEVEL_LABELS[levelKey];
    const totalClosed = recentCompleted + recentCancelled;
    const completionRate = totalClosed
      ? Math.round((recentCompleted / totalClosed) * 100)
      : 100;

    panel.querySelector('[data-seller-level]')?.remove();
    const badge = document.createElement('div');
    badge.className = 'card';
    badge.dataset.sellerLevel = 'true';
    badge.style = 'padding:18px;margin-top:16px';
    badge.innerHTML = `<h2>مستوى البائع</h2><p><strong>${name}</strong> · معدل الإكمال ${completionRate}%</p><p class="muted">آخر ${orders.length} طلبًا في لوحة الحساب الحالية.</p>`;
    panel.appendChild(badge);

    if (profile.verified && !panel.querySelector('[data-seller-verified]')) {
      const verified = document.createElement('p');
      verified.dataset.sellerVerified = 'true';
      verified.textContent = '✅ حساب موثق';
      panel.prepend(verified);
    }
  } catch (error) {
    console.warn('SELLER LEVEL ERROR:', error);
  }
}

onAuthStateChanged(auth, run);
