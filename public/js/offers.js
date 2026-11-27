import { auth, db, onAuthStateChanged, collection, query, where, orderBy, getDocs, addDoc, serverTimestamp } from './firebase.js';
const root = document.getElementById('offersList');
const esc = (value='') => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = v => Number(v||0).toLocaleString('ar-EG');
const fmt = v => { try { const d=v?.toDate?v.toDate():new Date(v); return d.toLocaleString('ar-EG'); } catch { return ''; } };
const API_BASE='https://elawamy-file-server.vercel.app';
async function actionOffer(id, action) {
  const user = auth.currentUser; if (!user) return;
  const token = await user.getIdToken(true);
  const res = await fetch(`${API_BASE}/api/offers/${action}`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`}, body:JSON.stringify({offerId:id}) });
  const data=await res.json().catch(()=>({})); if(!res.ok) throw new Error(data.error||'تعذر تنفيذ العرض');
  return data;
}
async function load(user){
  try{
    const [buyerSnap,sellerSnap]=await Promise.all([
      getDocs(query(collection(db,'customOffers'),where('buyerId','==',user.uid),orderBy('updatedAt','desc'))),
      getDocs(query(collection(db,'customOffers'),where('sellerId','==',user.uid),orderBy('updatedAt','desc')))
    ]);
    const map=new Map(); [...buyerSnap.docs,...sellerSnap.docs].forEach(d=>map.set(d.id,{id:d.id,...d.data()}));
    const items=[...map.values()].sort((a,b)=>(b.updatedAt?.toMillis?.()||0)-(a.updatedAt?.toMillis?.()||0));
    if(!items.length){root.innerHTML='<div class="empty">لا توجد عروض مخصصة بعد.</div>';return;}
    root.innerHTML=items.map(o=>{
      const incoming=o.buyerId===user.uid; const status={pending:'معلّق',accepted:'مقبول',declined:'مرفوض',withdrawn:'مسحوب',expired:'منتهي'}[o.status]||o.status;
      return `<article class="card" style="padding:20px;margin-bottom:14px"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start"><div><span class="badge">${esc(status)}</span><h3>${esc(o.title||o.serviceName||'عرض مخصص')}</h3><p>${esc(o.description||'')}</p><p><strong>السعر:</strong> ${money(o.price)} ج.م &nbsp; <strong>التسليم:</strong> ${esc(o.deliveryDays)} يوم</p><p class="muted">${incoming?'من البائع':'إلى المشتري'} · ${esc(fmt(o.updatedAt||o.createdAt))}</p></div><div>${incoming&&o.status==='pending'?'<button class="btn accept-offer" data-id="'+esc(o.id)+'">قبول وإنشاء طلب</button>':''}${!incoming&&o.status==='pending'?'<button class="btn secondary withdraw-offer" data-id="'+esc(o.id)+'">سحب العرض</button>':''}</div></div></article>`;
    }).join('');
    root.querySelectorAll('.accept-offer').forEach(b=>b.onclick=async()=>{b.disabled=true;try{const r=await actionOffer(b.dataset.id,'accept');location.href=`/orders?order=${encodeURIComponent(r.orderId)}`;}catch(e){alert(e.message);b.disabled=false;}});
    root.querySelectorAll('.withdraw-offer').forEach(b=>b.onclick=async()=>{if(!confirm('سحب هذا العرض؟'))return;b.disabled=true;try{await actionOffer(b.dataset.id,'withdraw');await load(user);}catch(e){alert(e.message);b.disabled=false;}});
  }catch(e){console.error(e);root.innerHTML=`<div class="empty">تعذر تحميل العروض.<br>${esc(e.message||e)}</div>`;}
}
onAuthStateChanged(auth, async user=>{ if(!user){location.href='/login?redirect=%2Foffers';return;} await load(user); });

export async function createCustomOffer(user,{buyerId,serviceId='',serviceName='',title,description,price,deliveryDays}){
  if(!user||!buyerId||user.uid===buyerId) throw new Error('INVALID_PARTICIPANTS');
  const cleanTitle=String(title||'').trim().slice(0,160), cleanDesc=String(description||'').trim().slice(0,2000), p=Number(price), days=Number(deliveryDays);
  if(!cleanTitle||cleanDesc.length<5||!Number.isFinite(p)||p<=0||p>100000||!Number.isInteger(days)||days<1||days>90) throw new Error('INVALID_OFFER');
  const ref=await addDoc(collection(db,'customOffers'),{sellerId:user.uid,buyerId,serviceId:String(serviceId||''),serviceName:String(serviceName||''),title:cleanTitle,description:cleanDesc,price:p,deliveryDays:days,status:'pending',createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
  return ref.id;
}
