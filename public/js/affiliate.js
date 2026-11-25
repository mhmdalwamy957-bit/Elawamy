import {
  auth,
  onAuthStateChanged,
  db,
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  query,
  where,
  serverTimestamp
} from './firebase.js';

const box = document.getElementById('affiliateBox');
const msg = document.getElementById('message');

function makeTextElement(tag, text, className = '') {
  const element = document.createElement(tag);
  element.textContent = String(text ?? '');
  if (className) element.className = className;
  return element;
}

async function load() {
  if (!box) return;

  const user = auth.currentUser;
  if (!user) {
    box.replaceChildren(makeTextElement('div', 'سجّل الدخول أولًا.', 'empty'));
    return;
  }

  try {
    const profileRef = doc(db, 'affiliateProfiles', user.uid);
    let profileSnap = await getDoc(profileRef);

    if (!profileSnap.exists()) {
      // The full UID prevents collisions caused by using only the first 8 UID characters.
      const code = `ELA-${user.uid}`;
      await setDoc(profileRef, {
        userId: user.uid,
        code,
        clicks: 0,
        referrals: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      profileSnap = await getDoc(profileRef);
    }

    if (!profileSnap.exists()) {
      throw new Error('Affiliate profile was not created or could not be loaded.');
    }

    const profile = profileSnap.data() || {};
    const code = String(profile.code || '');
    if (!code) throw new Error('Affiliate code is missing from profile.');

    // The profile counter is not client-writable, so derive referrals from protected records.
    const referralSnap = await getDocs(query(
      collection(db, 'affiliateReferrals'),
      where('referrerId', '==', user.uid)
    ));
    const referredIds = new Set(
      referralSnap.docs
        .map(referralDoc => String(referralDoc.data()?.referredId || '').trim())
        .filter(Boolean)
    );
    const referralCount = referredIds.size;

    const linkUrl = new URL('/', window.location.origin);
    linkUrl.searchParams.set('ref', code);
    const link = linkUrl.toString();

    const card = document.createElement('div');
    card.className = 'card';
    card.style.padding = '18px';

    const linkLabel = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = 'رابطك:';
    linkLabel.append(strong);

    const linkInput = document.createElement('input');
    linkInput.value = link;
    linkInput.readOnly = true;
    linkInput.style.width = '100%';
    linkInput.setAttribute('aria-label', 'رابط الإحالة');

    const stats = makeTextElement('p', `الإحالات: ${referralCount}`);
    const clickTrackingNote = makeTextElement('p', 'قياس نقرات الرابط غير مفعّل حاليًا.');
    const copyButton = makeTextElement('button', 'نسخ الرابط', 'btn');
    copyButton.type = 'button';

    copyButton.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link);
        if (msg) msg.textContent = '✅ تم نسخ الرابط';
      } catch (error) {
        linkInput.focus();
        linkInput.select();
        if (msg) msg.textContent = 'حدد الرابط وانسخه يدويًا.';
      }
    });

    card.append(linkLabel, linkInput, stats, clickTrackingNote, copyButton);
    box.replaceChildren(card);
  } catch (error) {
    console.error('AFFILIATE PROFILE LOAD ERROR:', error);
    box.replaceChildren(makeTextElement('div', 'تعذر تحميل رابط الإحالة. حاول مرة أخرى.', 'empty'));
  }
}

onAuthStateChanged(auth, load);
