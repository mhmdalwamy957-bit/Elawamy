import { auth, onAuthStateChanged, getIdToken } from './firebase.js';

const API_BASE = 'https://elawamy-file-server.vercel.app';
const authStatus = document.getElementById('teamAuthStatus');
const form = document.getElementById('teamTaskForm');
const taskInput = document.getElementById('teamTaskInput');
const runButton = document.getElementById('teamRunButton');
const refreshButton = document.getElementById('teamRefreshButton');
const tasksList = document.getElementById('teamTasksList');
const newResult = document.getElementById('teamNewResult');
let currentUser = null;
let busy = false;

async function apiRequest(path, options = {}) {
  if (!currentUser) throw new Error('سجّل الدخول بحساب الأدمن أولًا.');
  const token = await getIdToken(currentUser, true);
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 403) throw new Error('هذا الحساب لا يحمل صلاحية الأدمن في Firebase.');
    if (response.status === 401) throw new Error('انتهت جلسة الدخول. سجّل الدخول مرة أخرى.');
    throw new Error(data.message || data.error || 'تعذر تنفيذ الطلب.');
  }
  return data;
}

function statusLabel(status) {
  if (status === 'pending_review') return ['بانتظار قرارك', 'pending'];
  if (status === 'approved_for_manual_implementation') return ['موافق عليه للتنفيذ اليدوي', 'approved'];
  if (status === 'rejected') return ['مرفوض', 'rejected'];
  return [status || 'غير معروف', ''];
}

function makeTaskCard(task) {
  const card = document.createElement('article');
  card.className = 'team-card';
  const title = document.createElement('h3');
  title.textContent = task.task || 'مهمة بدون عنوان';
  const meta = document.createElement('p');
  meta.className = 'team-meta';
  const [label, stateClass] = statusLabel(task.status);
  meta.textContent = `${new Date(task.createdAt || Date.now()).toLocaleString('ar-EG')} · ${task.reviewer || 'لا توجد مراجعة ثانية'}`;
  const chip = document.createElement('span');
  chip.className = `team-chip ${stateClass}`;
  chip.textContent = label;
  const report = document.createElement('div');
  report.className = 'team-report';
  report.textContent = task.report || 'لا يوجد تقرير.';
  card.append(title, meta, chip, report);
  if (task.status === 'pending_review') {
    const actions = document.createElement('div');
    actions.className = 'team-card-actions';
    const approve = document.createElement('button');
    approve.type = 'button'; approve.className = 'team-button'; approve.textContent = 'موافقة على المقترح';
    approve.addEventListener('click', () => decideTask(task.id, 'approve'));
    const reject = document.createElement('button');
    reject.type = 'button'; reject.className = 'team-button reject'; reject.textContent = 'رفض المقترح';
    reject.addEventListener('click', () => decideTask(task.id, 'reject'));
    actions.append(approve, reject);
    card.appendChild(actions);
  }
  if (task.decisionNote) {
    const note = document.createElement('p');
    note.className = 'team-meta';
    note.textContent = `ملاحظة الأدمن: ${task.decisionNote}`;
    card.appendChild(note);
  }
  return card;
}

async function loadTasks() {
  tasksList.textContent = 'جارٍ تحميل التقارير…';
  try {
    const data = await apiRequest('/api/ai/team/tasks');
    tasksList.replaceChildren();
    if (!Array.isArray(data.tasks) || data.tasks.length === 0) {
      tasksList.textContent = 'لا توجد مهام حتى الآن. اكتب أول مهمة للفريق.';
      return;
    }
    for (const task of data.tasks) tasksList.appendChild(makeTaskCard(task));
  } catch (error) {
    tasksList.textContent = error.message || 'تعذر تحميل التقارير.';
  }
}

async function decideTask(taskId, action) {
  let note = '';
  if (action === 'reject') {
    note = window.prompt('اكتب سبب رفض المقترح (4 أحرف على الأقل):') || '';
    if (note.trim().length < 4) return;
  } else if (!window.confirm('هل توافق على اعتماد هذا المقترح للتنفيذ اليدوي؟ لن يتم النشر أو تعديل الموقع تلقائيًا.')) {
    return;
  }
  try {
    await apiRequest(`/api/ai/team/tasks/${encodeURIComponent(taskId)}/decision`, {
      method: 'POST', body: JSON.stringify({ action, note })
    });
    await loadTasks();
  } catch (error) {
    window.alert(error.message || 'تعذر حفظ قرار الأدمن.');
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const task = taskInput.value.trim();
  if (!task || busy) return;
  busy = true;
  runButton.disabled = true;
  refreshButton.disabled = true;
  runButton.textContent = 'الفريق يراجع المهمة…';
  newResult.className = 'team-status';
  newResult.textContent = 'يجهز Gemini تقرير التخصصات، ثم يحاول مراجع ثانٍ تدقيقه.';
  try {
    const data = await apiRequest('/api/ai/team/tasks', {
      method: 'POST', body: JSON.stringify({ task })
    });
    newResult.textContent = `تم إنشاء التقرير وهو الآن بانتظار قرار الأدمن.\nالمراجع: ${data.reviewer || 'غير متاح'}\n\n${data.report || ''}`;
    taskInput.value = '';
    await loadTasks();
  } catch (error) {
    newResult.textContent = error.message || 'تعذر تشغيل الفريق.';
  } finally {
    busy = false;
    runButton.disabled = false;
    refreshButton.disabled = false;
    runButton.textContent = 'شغّل فريق التطوير';
  }
});

refreshButton.addEventListener('click', loadTasks);

onAuthStateChanged(auth, async user => {
  if (!user) {
    authStatus.textContent = 'يجب تسجيل الدخول بحساب الأدمن.';
    window.location.replace('/login?redirect=%2Fai-team-admin.html');
    return;
  }
  currentUser = user;
  try {
    // A protected API call is the authority for admin access; hiding buttons is not security.
    await apiRequest('/api/ai/team/tasks');
    authStatus.textContent = `تم التحقق من صلاحية الأدمن: ${user.email || 'الحساب الحالي'}`;
    taskInput.disabled = false;
    runButton.disabled = false;
    refreshButton.disabled = false;
    await loadTasks();
  } catch (error) {
    authStatus.textContent = error.message || 'لا تملك صلاحية الوصول إلى هذه اللوحة.';
    taskInput.disabled = true;
    runButton.disabled = true;
    refreshButton.disabled = true;
  }
});
