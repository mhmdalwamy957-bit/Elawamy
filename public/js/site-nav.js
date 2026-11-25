import { auth, onAuthStateChanged, getIdTokenResult } from './firebase.js';

function addLink(nav, href, text, key) {
  if (!nav || nav.querySelector(`[data-nav-key="${key}"]`)) return;
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  a.dataset.navKey = key;
  nav.appendChild(a);
}

function injectNav(user, isAdmin = false) {
  document.querySelectorAll('header nav').forEach(nav => {
    addLink(nav, '/category', 'التصنيفات', 'categories');
    addLink(nav, '/messages', 'الرسائل', 'messages');
    addLink(nav, '/offers', 'العروض', 'offers');
    addLink(nav, '/community', 'المجتمع', 'community');
    addLink(nav, '/service-requests', 'طلبات الخدمات', 'requests');
    addLink(nav, '/cart', '🛒 السلة', 'cart');
    if (user) {
      addLink(nav, '/ai', '🤖 العوامي AI', 'ai');
      addLink(nav, '/favorites', 'المفضلة', 'favorites');
      addLink(nav, '/favorite-groups', 'مجموعات المفضلة', 'groups');
      addLink(nav, '/notification-settings', 'الإشعارات', 'notification-settings');
      addLink(nav, '/verification', 'توثيق الحساب', 'verification');
      addLink(nav, '/affiliate', 'التسويق بالعمولة', 'affiliate');
      addLink(nav, '/portfolio', 'معرض أعمالي', 'portfolio');
      addLink(nav, '/wallet', 'أرباحي', 'wallet');
    }
    if (isAdmin) addLink(nav, '/admin', '⚙️ الإدارة', 'admin');
  });
}

onAuthStateChanged(auth, async user => {
  let isAdmin = false;
  if (user) {
    try {
      const token = await getIdTokenResult(user);
      isAdmin = token.claims?.admin === true;
    } catch (error) {
      console.warn('NAV ADMIN CLAIM ERROR:', error);
    }
  }
  injectNav(user, isAdmin);
});
