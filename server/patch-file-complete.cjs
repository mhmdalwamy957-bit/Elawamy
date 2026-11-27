const fs = require('node:fs');

const file = 'server.js';
const source = fs.readFileSync(file, 'utf8');

const helperPattern =
  /async function storageObjectExists\(path\) \{[\s\S]*?\n\}/g;

const oldCheck =
`      if (!(await storageObjectExists(path))) {
        return res.status(409).json({
          error: 'Uploaded file was not found in storage'
        });
      }`;

const oldSave =
`          .doc(fileId)
          .set({
            fileId,
            orderId,
            uploaderId: req.user.uid,
            role,
            path,
            name,
            contentType,
            size,
            createdAt:
              admin.firestore.FieldValue.serverTimestamp()
          });`;

if ([...source.matchAll(helperPattern)].length !== 1) {
  console.error('STOP: لم أجد دالة الفحص مرة واحدة بالضبط.');
  process.exit(1);
}

if (source.split(oldCheck).length - 1 !== 1) {
  console.error('STOP: لم أجد شرط فحص الملف المتوقع مرة واحدة.');
  process.exit(1);
}

if (source.split(oldSave).length - 1 !== 1) {
  console.error('STOP: لم أجد حفظ بيانات الملف المتوقع مرة واحدة.');
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

const newCheck = `      const storageInfo = await storageObjectInfo(path);

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

      if (
        !actualContentType ||
        actualContentType.length > 120
      ) {
        return res.status(415).json({
          error: 'Uploaded file content type is invalid'
        });
      }`;

const newSave = `          .doc(fileId)
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

let updated = source
  .replace(helperPattern, newHelper)
  .replace(oldCheck, newCheck)
  .replace(oldSave, newSave);

if (updated === source || updated.includes('storageObjectExists(path)')) {
  console.error('STOP: لم يكتمل التعديل المتوقع.');
  process.exit(1);
}

const backup = `${file}.before-storage-info-${Date.now()}`;
fs.copyFileSync(file, backup);
fs.writeFileSync(file, updated);

console.log('تم تحديث فحص بيانات الملفات.');
console.log('تم حفظ نسخة احتياطية:', backup);
