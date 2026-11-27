import {
  auth,
  db,
  doc,
  setDoc,
  serverTimestamp,
  writeBatch,
  Timestamp,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  onAuthStateChanged,
  getDoc,
  GoogleAuthProvider,
  signInWithPopup
} from './firebase.js';


const email = document.getElementById('email');
const password = document.getElementById('password');

const msg = document.getElementById('message');

const loginBtn = document.getElementById('loginBtn');
const registerBtn = document.getElementById('registerBtn');
const googleBtn = document.getElementById('googleSignInBtn');

const forgotPassword =
  document.getElementById('forgotPassword');

const togglePassword =
  document.getElementById('togglePassword');
const authSubtitle = document.getElementById('authSubtitle');
const registrationFields = document.getElementById('registrationFields');
const displayNameInput = document.getElementById('displayName');
const fullNameInput = document.getElementById('fullName');
const birthDateInput = document.getElementById('birthDate');
const paymentMethodInput = document.getElementById('paymentMethod');

let registrationMode = false;
let registrationInProgress = false;
let registrationNeedsCompletion = false;

function localDateISO() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

if (birthDateInput) {
  birthDateInput.max = localDateISO();
}

function setRegistrationMode(enabled) {
  registrationMode = enabled;
  if (registrationFields) registrationFields.hidden = !enabled;
  if (forgotPassword) forgotPassword.hidden = enabled;
  if (loginBtn) {
    loginBtn.textContent = enabled
      ? 'العودة إلى تسجيل الدخول'
      : 'تسجيل الدخول';
  }
  if (registerBtn) {
    registerBtn.textContent = enabled
      ? 'تأكيد إنشاء الحساب'
      : 'إنشاء حساب جديد';
  }
  if (password) {
    password.autocomplete = enabled ? 'new-password' : 'current-password';
  }
  if (authSubtitle) {
    authSubtitle.textContent = enabled
      ? 'أكمل بياناتك لإنشاء حساب جديد على ElaWamy'
      : 'سجّل دخولك للوصول إلى حسابك وطلباتك وخدماتك';
  }
  show('');
  if (enabled) displayNameInput?.focus();
}


/*
 * الحفاظ على redirect الآمن
 */
const redirectParam =
  new URLSearchParams(location.search).get('redirect') || '/';

let redirect = '/';

try {
  const url = new URL(
    redirectParam,
    location.origin
  );

  if (url.origin === location.origin) {
    redirect =
      url.pathname +
      url.search +
      url.hash;
  }
} catch {
  redirect = '/';
}


/*
 * رسائل Firebase بالعربي
 */
function firebaseMessage(error) {
  const code = error?.code || '';

  const messages = {
    'auth/invalid-email':
      'البريد الإلكتروني غير صالح.',

    'auth/invalid-credential':
      'البريد الإلكتروني أو كلمة المرور غير صحيحة.',

    'auth/user-not-found':
      'لا يوجد حساب بهذا البريد الإلكتروني.',

    'auth/wrong-password':
      'كلمة المرور غير صحيحة.',

    'auth/email-already-in-use':
      'هذا البريد الإلكتروني مستخدم بالفعل.',

    'auth/weak-password':
      'كلمة المرور ضعيفة. استخدم 6 أحرف على الأقل.',

    'auth/too-many-requests':
      'تمت محاولات كثيرة. حاول مرة أخرى بعد قليل.',

    'auth/network-request-failed':
      'تعذر الاتصال بالإنترنت.',

    'auth/user-disabled':
      'هذا الحساب تم تعطيله.',

    'auth/operation-not-allowed':
      'طريقة تسجيل الدخول هذه غير مفعلة حاليًا.'
  };

  return (
    messages[code] ||
    'حدث خطأ غير متوقع. حاول مرة أخرى.'
  );
}


/*
 * عرض رسالة
 */
function show(message) {
  if (msg) {
    msg.textContent = message;
  }
}


/*
 * حالة الأزرار
 */
function setBusy(busy, text = 'جاري التنفيذ...') {
  if (loginBtn) {
    loginBtn.disabled = busy;

    if (busy) {
      loginBtn.dataset.originalText =
        loginBtn.textContent;

      loginBtn.textContent = text;
    } else {
      loginBtn.textContent =
        loginBtn.dataset.originalText ||
        'تسجيل الدخول';
    }
  }

  if (registerBtn) {
    registerBtn.disabled = busy;
  }

  if (googleBtn) googleBtn.disabled = busy;

  if (forgotPassword) {
    forgotPassword.disabled = busy;
  }
}


/*
 * لو المستخدم مسجل بالفعل
 */
onAuthStateChanged(auth, (user) => {
  if (user && !registrationInProgress && !registrationNeedsCompletion) {
    location.replace(redirect);
  }
});


/*
 * إظهار / إخفاء كلمة المرور
 */
togglePassword?.addEventListener(
  'click',
  () => {
    if (!password) return;

    const hidden =
      password.type === 'password';

    password.type =
      hidden ? 'text' : 'password';

    togglePassword.textContent =
      hidden ? '🙈' : '👁️';

    togglePassword.setAttribute(
      'aria-label',
      hidden
        ? 'إخفاء كلمة المرور'
        : 'إظهار كلمة المرور'
    );
  }
);


/*
 * تسجيل الدخول
 */
async function login() {
  const emailValue =
    email?.value.trim().toLowerCase() || '';

  const passwordValue =
    password?.value || '';

  if (!emailValue) {
    show('اكتب البريد الإلكتروني.');
    email?.focus();
    return;
  }

  if (!passwordValue) {
    show('اكتب كلمة المرور.');
    password?.focus();
    return;
  }

  try {
    setBusy(true, 'جاري تسجيل الدخول...');
    show('جاري تسجيل الدخول...');

    await signInWithEmailAndPassword(
      auth,
      emailValue,
      passwordValue
    );

    show('تم تسجيل الدخول بنجاح ✓');

    location.replace(redirect);

  } catch (error) {
    console.error(
      'LOGIN ERROR:',
      error
    );

    show(firebaseMessage(error));

  } finally {
    setBusy(false);
  }
}


loginBtn?.addEventListener('click', () => {
  if (registrationMode) {
    setRegistrationMode(false);
    return;
  }
  login();
});


/*
 * Enter = تسجيل الدخول
 */
[email, password].forEach((input) => {
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (registrationMode) registerBtn?.click();
      else login();
    }
  });
});

registrationFields?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && registrationMode) {
    event.preventDefault();
    registerBtn?.click();
  }
});


/*
 * إنشاء حساب: عرض حقول التسجيل أولًا، ثم حفظ البيانات بعد التحقق منها.
 */
registerBtn?.addEventListener('click', async () => {
  if (!registrationMode) {
    setRegistrationMode(true);
    show('أكمل الاسم والبريد وكلمة المرور وباقي البيانات، ثم اضغط تأكيد إنشاء الحساب.');
    return;
  }

  const emailValue = email?.value.trim().toLowerCase() || '';
  const passwordValue = password?.value || '';
  const displayNameValue = displayNameInput?.value.trim().replace(/\s+/g, ' ') || '';
  const fullNameValue = fullNameInput?.value.trim().replace(/\s+/g, ' ') || '';
  const birthDateValue = birthDateInput?.value || '';
  const paymentMethodValue = paymentMethodInput?.value || '';

  if (!emailValue) {
    show('اكتب البريد الإلكتروني.');
    email?.focus();
    return;
  }
  if (!passwordValue) {
    show('اكتب كلمة المرور.');
    password?.focus();
    return;
  }
  if (passwordValue.length < 6) {
    show('كلمة المرور يجب أن تكون 6 أحرف على الأقل.');
    password?.focus();
    return;
  }
  if (displayNameValue.length < 2 || displayNameValue.length > 60) {
    show('اكتب الاسم الظاهر على الموقع، من حرفين إلى 60 حرفًا.');
    displayNameInput?.focus();
    return;
  }
  if (fullNameValue.length < 8 || fullNameValue.length > 160 || fullNameValue.split(' ').filter(Boolean).length < 4) {
    show('اكتب الاسم الرباعي كاملًا: الاسم الأول واسم الأب والجد والعائلة.');
    fullNameInput?.focus();
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDateValue) || birthDateValue > localDateISO()) {
    show('اختر تاريخ ميلاد ميلاديًا صحيحًا، وليس تاريخًا في المستقبل.');
    birthDateInput?.focus();
    return;
  }
  const parsedBirthDate = new Date(`${birthDateValue}T00:00:00.000Z`);
  if (Number.isNaN(parsedBirthDate.getTime()) || parsedBirthDate.toISOString().slice(0, 10) !== birthDateValue) {
    show('تاريخ الميلاد غير صحيح. اختره من التقويم الميلادي.');
    birthDateInput?.focus();
    return;
  }
  if (!['vodafone_cash', 'instapay', 'ewallet', 'bank'].includes(paymentMethodValue)) {
    show('اختر وسيلة الدفع المفضلة.');
    paymentMethodInput?.focus();
    return;
  }

  try {
    registrationInProgress = true;
    registrationNeedsCompletion = false;
    setBusy(true, 'جاري حفظ بيانات التسجيل...');
    show('جاري إنشاء الحساب وحفظ بياناتك بأمان...');

    let user = auth.currentUser;
    if (!user || (user.email || '').toLowerCase() !== emailValue) {
      const result = await createUserWithEmailAndPassword(auth, emailValue, passwordValue);
      user = result.user;
    }

    const batch = writeBatch(db);
    batch.set(doc(db, 'users', user.uid), {
      email: user.email || emailValue,
      name: displayNameValue,
      bio: '',
      updatedAt: serverTimestamp()
    }, { merge: true });

    batch.set(doc(db, 'sellerProfiles', user.uid), {
      name: displayNameValue,
      bio: '',
      updatedAt: serverTimestamp()
    }, { merge: true });

    batch.set(doc(db, 'privateUserDetails', user.uid), {
      fullName: fullNameValue,
      birthDate: birthDateValue,
      preferredPaymentMethod: paymentMethodValue,
      updatedAt: serverTimestamp()
    }, { merge: true });

    await batch.commit();
    registrationNeedsCompletion = false;
    show('تم إنشاء الحساب وحفظ بيانات التسجيل بنجاح ✓');
    location.replace(redirect);
  } catch (error) {
    console.error('REGISTER ERROR:', error);
    const currentEmail = (auth.currentUser?.email || '').toLowerCase();
    if (currentEmail && currentEmail === emailValue) {
      registrationNeedsCompletion = true;
      show('تم إنشاء حساب الدخول، لكن تعذر حفظ جميع البيانات. تحقق من الاتصال وقواعد Firestore ثم اضغط «تأكيد إنشاء الحساب» مرة أخرى لإكمال الحفظ دون إنشاء حساب جديد.');
    } else {
      registrationNeedsCompletion = false;
      show(firebaseMessage(error));
    }
  } finally {
    registrationInProgress = false;
    setBusy(false);
  }
});


/* GOOGLE SIGN-IN: تسجيل الدخول أو إنشاء الملف الأساسي لأول مرة */
googleBtn?.addEventListener('click', async () => {
  if (registrationInProgress) return;

  try {
    registrationInProgress = true;
    registrationNeedsCompletion = false;
    setBusy(true, 'جاري المتابعة مع Google...');
    show('جاري فتح نافذة تسجيل الدخول باستخدام Google...');

    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const result = await signInWithPopup(auth, provider);
    const user = result.user;
    const safeName = (user.displayName || user.email?.split('@')[0] || 'مستخدم جديد')
      .trim().replace(/\s+/g, ' ').slice(0, 60) || 'مستخدم جديد';

    const userRef = doc(db, 'users', user.uid);
    const sellerRef = doc(db, 'sellerProfiles', user.uid);
    const [userSnap, sellerSnap] = await Promise.all([
      getDoc(userRef),
      getDoc(sellerRef)
    ]);
    const batch = writeBatch(db);

    if (!userSnap.exists()) {
      batch.set(userRef, {
        email: user.email || '',
        name: safeName,
        bio: '',
        updatedAt: serverTimestamp()
      });
    }
    if (!sellerSnap.exists()) {
      batch.set(sellerRef, {
        name: safeName,
        bio: '',
        updatedAt: serverTimestamp()
      });
    }

    if (!userSnap.exists() || !sellerSnap.exists()) await batch.commit();

    show('تم تسجيل الدخول باستخدام Google بنجاح ✓');
    location.replace(redirect);
  } catch (error) {
    console.error('GOOGLE SIGN-IN ERROR:', error);
    const code = error?.code || '';
    const googleMessages = {
      'auth/popup-closed-by-user': 'أغلقت نافذة Google قبل إكمال تسجيل الدخول.',
      'auth/popup-blocked': 'المتصفح منع نافذة Google. اسمح بالنوافذ المنبثقة ثم حاول مرة أخرى.',
      'auth/cancelled-popup-request': 'هناك محاولة تسجيل دخول أخرى قيد التنفيذ؛ حاول مرة أخرى.',
      'auth/account-exists-with-different-credential': 'هذا البريد مسجل بطريقة أخرى. سجّل الدخول بالطريقة الأصلية أولًا.',
      'auth/unauthorized-domain': 'نطاق الموقع غير مضاف إلى النطاقات المسموح بها في Firebase Authentication.',
      'auth/operation-not-allowed': 'فعّل مزود Google من Firebase Authentication ثم أعد المحاولة.',
      'auth/network-request-failed': 'تعذر الاتصال بالإنترنت. تحقق من الاتصال وحاول مرة أخرى.'
    };
    show(googleMessages[code] || firebaseMessage(error));
    if (auth.currentUser) registrationNeedsCompletion = true;
  } finally {
    registrationInProgress = false;
    setBusy(false);
  }
});

/*
 * نسيت كلمة المرور
 */
forgotPassword?.addEventListener(
  'click',
  async () => {

    const emailValue =
      email?.value.trim().toLowerCase() || '';

    if (!emailValue) {
      show(
        'اكتب بريدك الإلكتروني أولًا ثم اضغط «نسيت كلمة المرور؟».'
      );
      email?.focus();
      return;
    }

    try {
      setBusy(true);
      show(
        'جاري إرسال رابط استعادة كلمة المرور...'
      );

      await sendPasswordResetEmail(
        auth,
        emailValue
      );

      show(
        'تم إرسال رابط استعادة كلمة المرور إلى بريدك الإلكتروني.'
      );

    } catch (error) {
      console.error(
        'PASSWORD RESET ERROR:',
        error
      );

      show(firebaseMessage(error));

    } finally {
      setBusy(false);
    }
  }
);
