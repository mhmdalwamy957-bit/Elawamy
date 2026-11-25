import {
  auth,
  db,
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  serverTimestamp
} from './firebase.js';

const favoritesCollection = (uid) =>
  collection(db, 'favorites', uid, 'services');

export async function loadFavoriteIds(user = auth.currentUser) {
  if (!user) return new Set();

  const snapshot = await getDocs(favoritesCollection(user.uid));
  return new Set(snapshot.docs.map((item) => item.id));
}

export function isFavorite(serviceId, favoriteIds) {
  return favoriteIds instanceof Set && favoriteIds.has(serviceId);
}

export async function addFavorite(serviceId, user = auth.currentUser) {
  if (!user) throw new Error('AUTH_REQUIRED');

  await setDoc(doc(db, 'favorites', user.uid, 'services', serviceId), {
    serviceId,
    createdAt: serverTimestamp()
  });
}

export async function removeFavorite(serviceId, user = auth.currentUser) {
  if (!user) throw new Error('AUTH_REQUIRED');

  await deleteDoc(doc(db, 'favorites', user.uid, 'services', serviceId));
}

export async function toggleFavorite(serviceId, favoriteIds, user = auth.currentUser) {
  if (!user) throw new Error('AUTH_REQUIRED');

  if (favoriteIds.has(serviceId)) {
    await removeFavorite(serviceId, user);
    favoriteIds.delete(serviceId);
    return false;
  }

  await addFavorite(serviceId, user);
  favoriteIds.add(serviceId);
  return true;
}
