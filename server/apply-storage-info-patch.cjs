const fs = require('node:fs');

const file = 'server.js';
const source = fs.readFileSync(file, 'utf8');

const helperCount =
  (source.match(/async function storageObjectExists\(path\)/g) || []).length;

if (helperCount !== 1) {
  console.error('STOP: عدد دوال storageObjectExists غير المتوقع.');
  process.exit(1);
}

const routePattern =
  /if\s*\(\s*!\s*\(\s*await\s+storageObjectExists\(path\)\s*\)\s*\)\s*\{[\s\S]*?\}\s*await\s+orderRef\s*\.collection\(['"]files['"]\)\s*\.doc\(fileId\)\s*\.set\(\s*\{[\s\S]*?\}\s*\)\s*;/g;

const routeMatches = [...source.matchAll(routePattern)];

if (routeMatches.length !== 1) {
  console.error('STOP: لم يتم العثور على جزء التأكيد المتوقع مرة واحدة.');
  console.error('لم يتم تعديل server.js.');
  process.exit(1);
}

const newHelper = `async function storageObjectInfo(path) {
  if (!path || typeof path !== 'string') {
    return null;
  }

  try {
    const { data, error } = await supabase
      .storage
      .from(BUCKET)
      .info(path);

    if (error) {
      console.error('STORAGE FILE INFO ERROR:', error.message);
      return null;
    }

    return data || null;
  } catch (error) {
    console.error(
      'STORAGE FILE INFO ERROR:',
      error?.message || 'Unknown error'
    );
    return null;
  }
}`;

const newRoute = `const storageInfo = await storageObjectInfo(path);

        if (!storageInfo) {
          return res.status(409).json({
            error: 'Uploaded file was not found in storage'
          });
        }

        const actualSize = Number(storageInfo.size);
        const actualContentType =
          typeof storageInfo.contentType === 'string'
            ? storageInfo.contentType.trim()
            : '';

        if (
          !Number.isSafeInteger(actualSize) ||
          actualSize < 1 ||
          actualSize > 50 * 1024 * 1024
        ) {
          return res.status(413).json({
            error: 'Uploaded file size is invalid or exceeds 50 MB'
          });
        }

        if (!actualContentType || actualContentType.length > 120) {
          return res.status(415).json({
            error: 'Uploaded file content type is invalid'
          });
        }

        await orderRef
          .collection('files')
          .doc(fileId)
          .set({
            fileId,
            orderId,
            uploaderId: req.user.uid,
            role,
            path,
            name,
            contentType: actualContentType,
            size: actualSize,
            createdAt:
              admin.firestore.FieldValue.serverTimestamp()
          });`;

let updated = source.replace(
  /^async function storageObjectExists\(path\) \{[\s\S]*?^\}/m,
  newHelper
);

updated = updated.replace(routePattern, newRoute);

if (
  updated === source ||
  updated.includes('storageObjectExists(path)') ||
  !updated.includes('storageObjectInfo(path)')
) {
  console.error('STOP: فشل التحقق النهائي؛ لم يُحفظ التعديل.');
  process.exit(1);
}

const backup = `${file}.before-storage-info-${Date.now()}`;

fs.copyFileSync(file, backup);
fs.writeFileSync(file, updated);

console.log('تم تحديث فحص بيانات الملفات.');
console.log('النسخة الاحتياطية:', backup);
