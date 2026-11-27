import { auth, onAuthStateChanged, getIdToken } from './firebase.js';

const API_BASE = 'https://elawamy-file-server.vercel.app';
const form = document.getElementById('aiForm');
const input = document.getElementById('aiInput');
const sendButton = document.getElementById('aiSend');
const messages = document.getElementById('aiMessages');
const statusText = document.getElementById('aiStatus');
const newChatButton = document.getElementById('newChat');
const draftsBox = document.getElementById('aiDrafts');
const refreshDraftsButton = document.getElementById('refreshDrafts');

let currentUser = null;
let busy = false;
let conversationSteps = [];

function addMessage(role, text, extraClass = '') {
  const article = document.createElement('article');
  article.className = `ai-message ${role} ${extraClass}`.trim();

  const label = document.createElement('span');
  label.className = 'ai-message-label';
  label.textContent = role === 'user' ? 'أنت' : 'العوامي AI';

  const paragraph = document.createElement('p');
  paragraph.textContent = text;

  article.append(label, paragraph);
  messages.appendChild(article);
  messages.scrollTop = messages.scrollHeight;
  return article;
}

function setBusy(value) {
  busy = value;
  sendButton.disabled = value || !currentUser;
  input.disabled = value || !currentUser;
  document.querySelectorAll('[data-prompt]').forEach(button => {
    button.disabled = value || !currentUser;
  });
  sendButton.textContent = value ? 'يرد…' : 'إرسال';
}

function showError(message) {
  addMessage('assistant', message);
}


function renderDrafts(drafts) {
  draftsBox.replaceChildren();
  if (!drafts.length) {
    const empty = document.createElement('p');
    empty.className = 'ai-drafts-empty';
    empty.textContent = 'لا توجد مسودات محفوظة حتى الآن. اطلب من المساعد حفظ مسودة خدمة بعد تجهيز بياناتها.';
    draftsBox.appendChild(empty);
    return;
  }

  for (const draft of drafts) {
    const card = document.createElement('article');
    card.className = 'ai-draft-item';

    const title = document.createElement('strong');
    title.textContent = draft.title || 'مسودة بدون عنوان';

    const meta = document.createElement('span');
    const price = draft.price === null || draft.price === undefined
      ? 'السعر غير محدد'
      : `${Number(draft.price).toLocaleString('ar-EG')} ج.م`;
    meta.textContent = `${draft.category || 'بدون تصنيف'} · ${price} · ${Number(draft.deliveryDays || 3)} أيام`;

    const description = document.createElement('p');
    description.textContent = draft.description || '';

    const status = document.createElement('small');
    status.textContent = 'مسودة خاصة — لم يتم النشر';

    card.append(title, meta, description, status);
    draftsBox.appendChild(card);
  }
}

async function loadDrafts() {
  if (!currentUser) return;
  draftsBox.textContent = 'جارٍ تحميل المسودات…';
  try {
    const token = await getIdToken(currentUser, true);
    const response = await fetch(`${API_BASE}/api/ai/drafts`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(data.drafts)) {
      throw new Error('تعذر تحميل المسودات الآن.');
    }
    renderDrafts(data.drafts);
  } catch (error) {
    draftsBox.textContent = error.message || 'تعذر تحميل المسودات.';
  }
}

async function sendMessage(rawText) {
  const message = String(rawText || '').trim();
  if (!message || busy || !currentUser) return;

  if (message.length > 2500) {
    showError('الرسالة طويلة جدًا. اختصرها إلى 2500 حرف أو أقل.');
    return;
  }

  if (conversationSteps.length > 38) {
    conversationSteps = [];
    addMessage('assistant', 'بدأت محادثة جديدة تلقائيًا للحفاظ على سرعة المساعد.');
  }

  addMessage('user', message);
  input.value = '';
  setBusy(true);
  const typing = addMessage('assistant', 'جاري التفكير والرد…', 'ai-typing');

  const nextHistory = [
    ...conversationSteps,
    {
      type: 'user_input',
      content: [{ type: 'text', text: message }]
    }
  ];

  try {
    const token = await getIdToken(currentUser, true);
    const response = await fetch(`${API_BASE}/api/ai/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ history: nextHistory })
    });

    const data = await response.json().catch(() => ({}));
    typing.remove();

    if (!response.ok) {
      const friendly = data.message ||
        (response.status === 401 ? 'انتهت جلسة الدخول. سجّل الدخول مرة أخرى.' :
        response.status === 429 ? 'استخدمت الحد المسموح مؤقتًا. حاول لاحقًا.' :
        'تعذر إكمال الطلب الآن.');
      throw new Error(friendly);
    }

    if (!Array.isArray(data.steps) || typeof data.reply !== 'string') {
      throw new Error('وصل رد غير مكتمل من المساعد. حاول مرة أخرى.');
    }

    conversationSteps = [...nextHistory, ...data.steps];
    addMessage('assistant', data.reply, data.reviewedBy === 'OpenRouter free reviewer' ? 'ai-reviewed-openrouter' : 'ai-reviewed-second-pass');
    if (data.savedDraft?.ok) {
      await loadDrafts();
    }
  } catch (error) {
    typing.remove();
    showError(error.message || 'حدث خطأ غير متوقع. حاول مرة أخرى.');
  } finally {
    setBusy(false);
    input.focus();
  }
}

onAuthStateChanged(auth, user => {
  if (!user) {
    statusText.textContent = 'سجّل الدخول لاستخدام المساعد';
    window.location.replace('/login?redirect=%2Fai');
    return;
  }

  currentUser = user;
  statusText.textContent = `تم تسجيل الدخول: ${user.email || 'حسابك'}`;
  setBusy(false);
  input.disabled = false;
  sendButton.disabled = false;
  document.querySelectorAll('[data-prompt]').forEach(button => {
    button.disabled = false;
  });
  loadDrafts();
});

form.addEventListener('submit', event => {
  event.preventDefault();
  sendMessage(input.value);
});

document.querySelectorAll('[data-prompt]').forEach(button => {
  button.addEventListener('click', () => sendMessage(button.dataset.prompt || ''));
});

newChatButton.addEventListener('click', () => {
  if (busy) return;
  conversationSteps = [];
  messages.replaceChildren();
  addMessage('assistant', 'بدأنا محادثة جديدة. اكتب المهمة التي تريد المساعدة فيها.');
  input.focus();
});

refreshDraftsButton.addEventListener('click', loadDrafts);
