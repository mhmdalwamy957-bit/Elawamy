import { auth, db, doc, getDoc, setDoc, collection, getDocs, query, where, serverTimestamp, deleteDoc, addDoc, orderBy } from './firebase.js';
import { requireUser } from './guard.js';

const name = document.getElementById('name');
const bio = document.getElementById('bio');
const headline = document.getElementById('headline');
const portfolioUrl = document.getElementById('portfolioUrl');
const email = document.getElementById('email');
const msg = document.getElementById('message');
const save = document.getElementById('save');
const list = document.getElementById('myServices');
const portfolioList = document.getElementById('portfolioList');
const portfolioAdd = document.getElementById('portfolioAdd');
const portfolioMessage = document.getElementById('portfolioMessage');


async function loadPortfolio(user) {
  if (!portfolioList) return;
  try {
    const snap = await getDocs(query(collection(db,'sellerProfiles',user.uid,'portfolio'), orderBy('updatedAt','desc')));
    const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    portfolioList.innerHTML = snap.empty ? '<div class="empty">لا توجد نماذج أعمال بعد.</div>' : snap.docs.map(d => { const x=d.data()||{}; return `<div class="mini-service"><strong>${safe(x.title)}</strong><div class="muted">${safe(x.description)}</div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${x.link?`<a href="${safe(x.link)}" target="_blank" rel="noopener">فتح المشروع</a>`:''}<button type="button" class="btn small secondary portfolio-delete" data-id="${safe(d.id)}">حذف</button></div></div>`; }).join('');
    portfolioList.querySelectorAll('.portfolio-delete').forEach(btn=>btn.onclick=async()=>{btn.disabled=true;try{await deleteDoc(doc(db,'sellerProfiles',user.uid,'portfolio',btn.dataset.id));await loadPortfolio(user);}catch(e){alert(e.message||e);btn.disabled=false;}});
  } catch(e){ portfolioList.innerHTML='<div class="empty">تعذر تحميل معرض الأعمال.</div>'; console.error(e); }
}

requireUser(async user => {
  email.value = user.email || '';

  const snap = await getDoc(doc(db, 'users', user.uid));
  if (snap.exists()) {
    name.value = snap.data().name || '';
    const data = snap.data();
    name.value = data.name || '';
    bio.value = data.bio || '';
    if (headline) headline.value = data.headline || '';
    if (portfolioUrl) portfolioUrl.value = data.portfolioUrl || '';
  }

  save.onclick = async () => {
    try {
      const profileData = {
        name: name.value.trim(),
        bio: bio.value.trim(),
        headline: headline?.value.trim() || '',
        portfolioUrl: portfolioUrl?.value.trim() || '',
        updatedAt: serverTimestamp()
      };

      await setDoc(doc(db, 'users', user.uid), {
        ...profileData,
        email: user.email || ''
      }, { merge: true });

      await setDoc(doc(db, 'sellerProfiles', user.uid), profileData, { merge: true });
      msg.textContent = 'تم حفظ الملف الشخصي';
    } catch (e) {
      msg.textContent = 'خطأ: ' + (e.code || e.message);
    }
  };

  await loadPortfolio(user);

  portfolioAdd?.addEventListener('click', async () => {
    const title=document.getElementById('portfolioTitle')?.value.trim()||'';
    const description=document.getElementById('portfolioDescription')?.value.trim()||'';
    const imageUrl=document.getElementById('portfolioImage')?.value.trim()||'';
    const link=document.getElementById('portfolioLink')?.value.trim()||'';
    if(!title || description.length > 1200){ portfolioMessage.textContent='اكتب عنوانًا ووصفًا صالحًا.'; return; }
    if(imageUrl && !/^https:\/\//i.test(imageUrl)){ portfolioMessage.textContent='رابط الصورة يجب أن يبدأ بـ https://'; return; }
    if(link && !/^https:\/\//i.test(link)){ portfolioMessage.textContent='رابط المشروع يجب أن يبدأ بـ https://'; return; }
    portfolioAdd.disabled=true; portfolioMessage.textContent='جاري الإضافة...';
    try { await addDoc(collection(db,'sellerProfiles',user.uid,'portfolio'), {title,description,imageUrl,link,createdAt:serverTimestamp(),updatedAt:serverTimestamp()}); document.getElementById('portfolioTitle').value=''; document.getElementById('portfolioDescription').value=''; document.getElementById('portfolioImage').value=''; document.getElementById('portfolioLink').value=''; portfolioMessage.textContent='تمت إضافة النموذج.'; await loadPortfolio(user); } catch(e){ portfolioMessage.textContent='تعذر الإضافة: '+(e.message||e); } finally { portfolioAdd.disabled=false; }
  });

  if (list) {
    try {
      const services = await getDocs(
        query(collection(db, 'services'), where('ownerId', '==', user.uid))
      );

      list.replaceChildren();

      if (services.empty) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'لم تنشر خدمات بعد.';
        list.appendChild(empty);
      } else {
        services.docs.forEach(serviceDoc => {
          const service = serviceDoc.data();
          const link = document.createElement('a');
          link.className = 'mini-service';
          link.href = '/service?id=' + encodeURIComponent(serviceDoc.id);

          const price = Number(service.price || 0).toLocaleString('ar-EG');
          link.textContent = `${service.name || 'خدمة'} — ${price} ج.م`;
          list.appendChild(link);
        });
      }
    } catch (e) {
      list.textContent = 'تعذر تحميل خدماتك.';
    }
  }
});
