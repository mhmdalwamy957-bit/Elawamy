import { auth, onAuthStateChanged, getIdTokenResult } from './firebase.js';
onAuthStateChanged(auth, async user => {
  if (!user) return;
  document.querySelectorAll('[data-auth]').forEach(el=>{el.hidden=false;});
  try { const r=await getIdTokenResult(user); if(r.claims.admin===true){ document.querySelectorAll('[data-admin]').forEach(el=>{el.hidden=false;}); } } catch {}
});
