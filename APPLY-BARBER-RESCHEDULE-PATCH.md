# تطبيق تحديث إعادة جدولة الحلاقة — موقع العوامي

التحديث يضيف خيار «تغيير الموعد» للعميل داخل قائمة «حجوزاتي»، مع تحقق من ملكية الحجز وحالته، فحص ساعات العمل والإجازات، حجز الوقت الجديد وتحرير القديم داخل معاملة Firestore، وتسجيل التغيير في سجل تدقيق الصالون.

## 1. احتفظ بنسخة احتياطية

من Termux:

```bash
cd ~/elawamy || exit 1
mkdir -p ~/elawamy-backup-before-reschedule/{server,public/js,public/css,scripts}
cp server/server.js ~/elawamy-backup-before-reschedule/server/
cp public/js/barbers.js ~/elawamy-backup-before-reschedule/public/js/
cp public/css/barbers.css ~/elawamy-backup-before-reschedule/public/css/
cp scripts/check-barber-booking.cjs scripts/test-barber-booking-local.cjs ~/elawamy-backup-before-reschedule/scripts/
cp README-BARBER-SYSTEM-UPGRADE.md CHANGELOG-AR.md ~/elawamy-backup-before-reschedule/
```

## 2. فكّ حزمة التعديل داخل مجلد المشروع

نزّل ملف `elawamy-barber-reschedule-patch.zip` إلى مجلد التنزيلات في أندرويد، ثم نفّذ (عدّل المسار فقط لو حفظته في مكان مختلف):

```bash
cd ~/elawamy || exit 1
unzip -o ~/storage/downloads/elawamy-barber-reschedule-patch.zip -d ~/elawamy
```

الحزمة تحتوي على الملفات المعدّلة فقط ولا تحتوي على ملف `.env.local` أو قيم أسرار.

## 3. افحص التعديل

```bash
cd ~/elawamy || exit 1
npm run check && npm run test:barber
node --check server/server.js
node --check public/js/barbers.js
```

اختبار التكامل يحتاج Auth Emulator وFirestore Emulator وخادم الـ API المحلي؛ طريقة تشغيله موجودة في `README-LOCAL-BARBER-TEST.md`. **لم يُنفّذ اختبار التكامل في هذه الجلسة**؛ شغّله وتأكد من نجاحه قبل نشر الإنتاج.

## 4. النشر بعد نجاح الاختبارات

لا تنشر قبل نجاح `npm run test:barber` واختبار التكامل المحلي. يجب نشر **الخادم أولًا ثم الواجهة** لأن الميزة تحتاج مسار API جديدًا:

```bash
cd ~/elawamy/server || exit 1
npx vercel --prod
```

بعد التأكد من أن نشر الخادم تم على مشروع Vercel الصحيح:

```bash
cd ~/elawamy || exit 1
npx firebase-tools deploy --only hosting --project elawamy-8d7e9
```

لم يتغير إعداد XPay، ولم يتطلب التحديث نشر قواعد Firestore أو فهارس جديدة. لا تشغّل النشر قبل مراجعة ناتج الاختبارات والتأكد من أن Vercel مرتبط بالمشروع الصحيح.
