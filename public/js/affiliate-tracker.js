import {
  auth,
  onAuthStateChanged,
  db,
  collection,
  doc,
  getDocs,
  query,
  where,
  setDoc,
  serverTimestamp
} from './firebase.js';

const REF_STORAGE_KEY = 'elawamy_ref';
const params = new URLSearchParams(window.location.search);
const incomingCode = String(params.get('ref') || '').trim();

if (incomingCode) {
  try {
    window.localStorage.setItem(REF_STORAGE_KEY, incomingCode);
  } catch (error) {
    console.warn('AFFILIATE REF STORAGE UNAVAILABLE:', error);
  }
}

function clearStoredCode(code) {
  try {
    if (window.localStorage.getItem(REF_STORAGE_KEY) === code) {
      window.localStorage.removeItem(REF_STORAGE_KEY);
    }
  } catch (error) {
    console.warn('AFFILIATE REF STORAGE CLEANUP FAILED:', error);
  }
}

onAuthStateChanged(auth, async user => {
  if (!user) return;

  let storedCode = '';
  try {
    storedCode = String(window.localStorage.getItem(REF_STORAGE_KEY) || '').trim();
  } catch (error) {
    console.warn('AFFILIATE REF STORAGE UNAVAILABLE:', error);
    return;
  }
  if (!storedCode) return;

  try {
    const profiles = await getDocs(query(
      collection(db, 'affiliateProfiles'),
      where('code', '==', storedCode)
    ));

    // Never guess which owner to credit if legacy data contains duplicate codes.
    if (profiles.size !== 1) {
      clearStoredCode(storedCode);
      return;
    }

    const referrer = profiles.docs[0].data() || {};
    const referrerId = String(referrer.userId || '');
    if (!referrerId || referrerId === user.uid) {
      clearStoredCode(storedCode);
      return;
    }

    // Respect any existing attribution, including legacy records with random document IDs.
    const existing = await getDocs(query(
      collection(db, 'affiliateReferrals'),
      where('referredId', '==', user.uid)
    ));
    if (!existing.empty) {
      clearStoredCode(storedCode);
      return;
    }

    // The referred user's UID is the document ID, and rules prohibit updating it.
    // This makes new referral records one-per-account, even if multiple tabs race.
    await setDoc(doc(db, 'affiliateReferrals', user.uid), {
      referrerId,
      referredId: user.uid,
      code: storedCode,
      createdAt: serverTimestamp()
    });

    clearStoredCode(storedCode);
  } catch (error) {
    // Preserve the code on transient or permission errors so the issue can be retried.
    console.warn('AFFILIATE TRACK ERROR:', error);
  }
});
