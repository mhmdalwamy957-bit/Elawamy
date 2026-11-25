const configResponse = await fetch('/__/firebase/init.json', { cache: 'no-store' });
const firebaseConfig = configResponse.ok
  ? await configResponse.json()
  : await (await fetch('/firebase-config.generated.json', { cache: 'no-store' })).json();

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut, getIdToken, getIdTokenResult, GoogleAuthProvider, signInWithPopup, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc, query, where, orderBy, limit, startAfter, onSnapshot, serverTimestamp, writeBatch, Timestamp, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Connect only when the page is served by the local Firebase Hosting Emulator.
// Production site origins never enter this branch.
const isLocalHostingEmulator =
  ['localhost', '127.0.0.1'].includes(window.location.hostname) &&
  ['5000', '5001'].includes(window.location.port);
if (isLocalHostingEmulator) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

export { GoogleAuthProvider, signInWithPopup, app, auth, db, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut, getIdToken, getIdTokenResult, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc, query, where, orderBy, limit, startAfter, onSnapshot, serverTimestamp, writeBatch, Timestamp };
