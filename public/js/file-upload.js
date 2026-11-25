import { auth, getIdToken } from './firebase.js';

const API_BASE = 'https://elawamy-file-server.vercel.app';

export async function uploadOrderFile({ orderId, role, file }) {
  if (!auth.currentUser) {
    throw new Error('يجب تسجيل الدخول أولًا');
  }

  if (!file) {
    throw new Error('لم يتم اختيار ملف');
  }

  const contentType = file.type || 'application/octet-stream';
  const token = await getIdToken(auth.currentUser, true);

  // 1. الحصول على رابط رفع آمن
  const response = await fetch(`${API_BASE}/api/files/upload-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      orderId,
      role,
      name: file.name,
      contentType,
      size: file.size
    })
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || 'تعذر إنشاء رابط الرفع');
  }

  // 2. رفع الملف إلى Supabase Storage
  const uploadResponse = await fetch(result.signedUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType
    },
    body: file
  });

  if (!uploadResponse.ok) {
    throw new Error('فشل رفع الملف إلى التخزين');
  }

  // 3. تسجيل الملف في Firestore
  const completeResponse = await fetch(`${API_BASE}/api/files/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      orderId,
      role,
      path: result.path,
      name: file.name,
      contentType,
      size: file.size
    })
  });

  const completeResult = await completeResponse.json();

  if (!completeResponse.ok) {
    throw new Error(
      completeResult.error || 'تم رفع الملف ولكن تعذر تسجيله'
    );
  }

  return {
    fileId: completeResult.fileId,
    path: result.path,
    name: file.name,
    contentType,
    size: file.size
  };
}
