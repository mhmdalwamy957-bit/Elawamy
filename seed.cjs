const fs = require('fs');
const { Firestore } = require('@google-cloud/firestore');

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

if (!keyPath) {
  console.error('❌ GOOGLE_APPLICATION_CREDENTIALS غير مضبوط.');
  process.exit(1);
}

if (!fs.existsSync(keyPath)) {
  console.error('❌ ملف Service Account غير موجود.');
  process.exit(1);
}

const serviceAccount = require(keyPath);

const db = new Firestore({
  projectId: serviceAccount.project_id,
  credentials: {
    client_email: serviceAccount.client_email,
    private_key: serviceAccount.private_key
  }
});

async function seed() {
  console.log('🚀 بدء اختبار Firestore...');

  const testRef = db.collection('_system_tests').doc('firestore');

  await testRef.set({
    status: 'ok',
    testedAt: new Date()
  });

  console.log('✅ Firestore يعمل بنجاح.');

  await testRef.delete();

  console.log('🧹 تم حذف مستند الاختبار.');
  console.log('✅ اختبار Firestore انتهى بنجاح.');
}

seed().catch((error) => {
  console.error('❌ حدث خطأ:');
  console.error(error.message);
  process.exit(1);
});
