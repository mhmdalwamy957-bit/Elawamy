import {
  auth, db, onAuthStateChanged, collection, query, where, orderBy, getDocs,
  addDoc, doc, getDoc, setDoc, updateDoc, onSnapshot, serverTimestamp
} from './firebase.js';

const listEl = document.getElementById('conversationList');
const headerEl = document.getElementById('conversationHeader');
const messagesEl = document.getElementById('messageList');
const form = document.getElementById('messageForm');
const input = document.getElementById('messageText');
const statusEl = document.getElementById('messageStatus');
const offerForm = document.getElementById('offerForm');
const offerStatus = document.getElementById('offerStatus');
const params = new URLSearchParams(location.search);
let currentConversationId = params.get('conversation') || '';
const initialSellerId = params.get('seller') || '';
const initialServiceId = params.get('service') || '';
const initialRequestId = params.get('request') || '';
let unsubscribe = null;

const esc = (value = '') => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const formatDate = value => { try { const d = value?.toDate ? value.toDate() : new Date(value); return d.toLocaleString('ar-EG'); } catch { return ''; } };
function convoId(buyerId, sellerId, context = '') {
  const buyer = String(buyerId || '');
  const seller = String(sellerId || '');
  const scope = String(context || 'general');
  return [buyer, seller, scope].sort((a, b) => a.localeCompare(b)).join('__');
}

async function ensureConversation(user, sellerId, service = null, context = '') {
  if (!sellerId || sellerId === user.uid) {
    throw new Error('INVALID_SELLER');
  }

  const id = convoId(user.uid, sellerId, context || service?.id || 'general');
  const ref = doc(db, 'conversations', id);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    await setDoc(ref, {
      buyerId: user.uid,
      sellerId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  }

  await updateDoc(ref, {
    ...(service?.id ? { serviceId: String(service.id) } : {}),
    ...(service?.name ? { serviceName: String(service.name).slice(0, 160) } : {}),
    updatedAt: serverTimestamp()
  });

  return id;
}

async function openInitialConversation(user) {
  if (currentConversationId) return;

  if (initialServiceId) {
    const serviceSnap = await getDoc(doc(db, 'services', initialServiceId));
    if (!serviceSnap.exists()) throw new Error('SERVICE_NOT_FOUND');
    const service = { id: serviceSnap.id, ...serviceSnap.data() };
    if (!service.ownerId || service.ownerId === user.uid) {
      throw new Error('INVALID_SELLER');
    }
    currentConversationId = await ensureConversation(user, service.ownerId, service, service.id);
    return;
  }

  if (initialRequestId) {
    const requestSnap = await getDoc(doc(db, 'serviceRequests', initialRequestId));
    if (!requestSnap.exists()) throw new Error('REQUEST_NOT_FOUND');
    const request = requestSnap.data() || {};
    if (request.status && request.status !== 'open' && request.buyerId !== user.uid) {
      throw new Error('REQUEST_CLOSED');
    }
    if (request.buyerId === user.uid) {
      throw new Error('CANNOT_MESSAGE_SELF');
    }

    const sellerId = user.uid;
    const buyerId = String(request.buyerId || '');
    if (!buyerId) throw new Error('REQUEST_BUYER_MISSING');

    currentConversationId = convoId(buyerId, sellerId, `request:${initialRequestId}`);
    const ref = doc(db, 'conversations', currentConversationId);
    const snap = await getDoc(ref);

    if (!snap.exists()) {
      await setDoc(ref, {
        buyerId,
        sellerId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }

    await updateDoc(ref, {
      serviceId: '',
      serviceName: String(request.title || 'طلب خدمة').slice(0, 160),
      updatedAt: serverTimestamp()
    });
    return;
  }

  if (initialSellerId) {
    const service = initialServiceId ? null : {
      id: '',
      name: 'محادثة عامة'
    };
    currentConversationId = await ensureConversation(user, initialSellerId, service, 'general');
  }
}

async function loadConversations(user) {
  try {
    const [buyerSnap, sellerSnap] = await Promise.all([
      getDocs(query(collection(db, 'conversations'), where('buyerId', '==', user.uid), orderBy('updatedAt', 'desc'))),
      getDocs(query(collection(db, 'conversations'), where('sellerId', '==', user.uid), orderBy('updatedAt', 'desc')))
    ]);
    const map = new Map();
    [...buyerSnap.docs, ...sellerSnap.docs].forEach(d => map.set(d.id, { id: d.id, ...d.data() }));
    const items = [...map.values()].sort((a,b) => (b.updatedAt?.toMillis?.()||0) - (a.updatedAt?.toMillis?.()||0));
    if (!items.length) {
      listEl.innerHTML = '<div class="empty">لا توجد محادثات بعد.<br>ابدأ محادثة من صفحة أي خدمة.</div>';
      return;
    }
    listEl.innerHTML = items.map(item => {
      const other = item.buyerId === user.uid ? 'البائع' : 'المشتري';
      return `<button type="button" class="conversation-item ${item.id === currentConversationId ? 'active' : ''}" data-id="${esc(item.id)}"><strong>${esc(other)}</strong><span>${esc(item.serviceName || 'محادثة عامة')}</span><small>${esc(item.lastMessage || '')}</small><em>${esc(formatDate(item.updatedAt))}</em></button>`;
    }).join('');
    listEl.querySelectorAll('[data-id]').forEach(btn => btn.addEventListener('click', () => openConversation(btn.dataset.id, user)));
    if (!currentConversationId) currentConversationId = items[0].id;
  } catch (error) {
    console.error('MESSAGES LIST ERROR:', error);
    listEl.innerHTML = `<div class="empty">تعذر تحميل الرسائل.<br>${esc(error?.message || error)}</div>`;
  }
}

async function openConversation(id, user) {
  currentConversationId = id;
  history.replaceState(null, '', `${location.pathname}?conversation=${encodeURIComponent(id)}`);
  document.querySelectorAll('.conversation-item').forEach(item => item.classList.toggle('active', item.dataset.id === id));
  const ref = doc(db, 'conversations', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    headerEl.innerHTML = '<p class="muted">المحادثة غير موجودة.</p>';
    form.hidden = true;
    return;
  }
  const convo = snap.data() || {};
  const allowed = convo.buyerId === user.uid || convo.sellerId === user.uid;
  if (!allowed) return;
  const other = convo.buyerId === user.uid ? 'البائع' : 'المشتري';
  if (offerForm) offerForm.hidden = !(convo.sellerId === user.uid && convo.buyerId !== user.uid);
  headerEl.innerHTML = `<div><h2>${esc(other)}</h2><p class="muted">${esc(convo.serviceName || 'محادثة')}</p></div>`;
  form.hidden = false;
  if (unsubscribe) unsubscribe();
  unsubscribe = onSnapshot(query(collection(db, 'conversations', id, 'messages'), orderBy('createdAt', 'asc')), snapshot => {
    messagesEl.innerHTML = snapshot.empty ? '<div class="empty">ابدأ المحادثة برسالة.</div>' : snapshot.docs.map(d => {
      const m = d.data() || {}; const mine = m.senderId === user.uid;
      return `<div class="message-bubble ${mine ? 'mine' : ''}"><div>${esc(m.text || '')}</div><small>${esc(formatDate(m.createdAt))}</small></div>`;
    }).join('');
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }, error => { console.error('MESSAGE STREAM ERROR:', error); statusEl.textContent = 'تعذر تحميل الرسائل.'; });
}

form?.addEventListener('submit', async event => {
  event.preventDefault();
  const user = auth.currentUser;
  const text = String(input.value || '').trim();
  if (!user || !currentConversationId || !text) return;
  if (text.length > 3000) return;
  statusEl.textContent = 'جاري الإرسال...';
  try {
    await addDoc(collection(db, 'conversations', currentConversationId, 'messages'), {
      senderId: user.uid, text, createdAt: serverTimestamp()
    });
    await setDoc(doc(db, 'conversations', currentConversationId), {
      lastMessage: text.slice(0, 240), lastSenderId: user.uid, updatedAt: serverTimestamp()
    }, { merge: true });
    input.value = '';
    statusEl.textContent = '';
    await loadConversations(user);
    await openConversation(currentConversationId, user);
  } catch (error) {
    console.error('SEND MESSAGE ERROR:', error);
    statusEl.textContent = 'تعذر إرسال الرسالة: ' + (error?.message || error);
  }
});


offerForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const user=auth.currentUser; if(!user||!currentConversationId) return;
  try {
    const convoSnap=await getDoc(doc(db,'conversations',currentConversationId));
    const convo=convoSnap.exists()?convoSnap.data():null;
    if(!convo || convo.sellerId!==user.uid) throw new Error('هذه المحادثة ليست مع مشتري.');
    const title=document.getElementById('offerTitle')?.value.trim()||'';
    const description=document.getElementById('offerDescription')?.value.trim()||'';
    const price=Number(document.getElementById('offerPrice')?.value);
    const deliveryDays=Number(document.getElementById('offerDelivery')?.value);
    if(!title||description.length<5||!Number.isFinite(price)||price<1||price>100000||!Number.isInteger(deliveryDays)||deliveryDays<1||deliveryDays>90) throw new Error('تحقق من بيانات العرض.');
    offerStatus.textContent='جاري إرسال العرض...';
    await addDoc(collection(db,'customOffers'),{sellerId:user.uid,buyerId:convo.buyerId,serviceId:convo.serviceId||'',serviceName:convo.serviceName||'',title,description,price,deliveryDays,status:'pending',createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
    offerStatus.textContent='✅ تم إرسال العرض.';
    document.getElementById('offerTitle').value=''; document.getElementById('offerDescription').value=''; document.getElementById('offerPrice').value=''; document.getElementById('offerDelivery').value='';
  } catch(e) { offerStatus.textContent='تعذر إرسال العرض: '+(e.message||e); }
});

window.ElaWamyMessages = { ensureConversation };

onAuthStateChanged(auth, async user => {
  if (!user) {
    location.href = `/login?redirect=${encodeURIComponent(location.pathname + location.search)}`;
    return;
  }
  try {
    await openInitialConversation(user);
  } catch (error) {
    console.error('INITIAL CONVERSATION ERROR:', error);
    statusEl.textContent = error.message === 'INVALID_SELLER'
      ? 'لا يمكن بدء محادثة مع هذا المستخدم.'
      : error.message === 'REQUEST_CLOSED'
        ? 'هذا الطلب لم يعد مفتوحًا للتواصل.'
        : error.message === 'CANNOT_MESSAGE_SELF'
          ? 'لا يمكنك مراسلة نفسك.'
          : 'تعذر بدء المحادثة.';
  }

  await loadConversations(user);
  if (currentConversationId) await openConversation(currentConversationId, user);
});
