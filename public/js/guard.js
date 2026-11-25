import { auth, onAuthStateChanged } from './firebase.js';

const publicPages = new Set(['/login', '/login.html']);
const path = location.pathname.replace(/\/$/, '') || '/';

if (!publicPages.has(path)) {
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      const redirect = location.pathname + location.search;
      location.replace(`/login?redirect=${encodeURIComponent(redirect)}`);
    } else document.documentElement.classList.add('authenticated');
  });
}

export function requireUser(callback) {
  return onAuthStateChanged(auth, (user) => {
    if (!user) {
      const redirect = location.pathname + location.search;
      location.replace(`/login?redirect=${encodeURIComponent(redirect)}`);
    } else callback(user);
  });
}
