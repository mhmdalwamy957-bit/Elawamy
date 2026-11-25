# إضافة تحميل تطبيق العوامي إلى الموقع

تم تجهيز صفحة تحميل عربية للتطبيق وربطها بالصفحة الرئيسية:

- صفحة التحميل: `/download`
- ملف APK: `public/downloads/elawamy-android.apk`
- رابط الملف بعد النشر: `https://elawamy-8d7e9.web.app/downloads/elawamy-android.apk`
- أضيفت ترويسة `Content-Type` و`Content-Disposition` الخاصة بملفات APK في إعداد Hosting.

## النشر من Termux

1. فك ضغط هذه الحزمة في مجلد مشروعك، أو استبدل مجلد المشروع الحالي بنسخة الحزمة.
2. افتح Termux داخل مجلد المشروع، ثم نفّذ:

```bash
npm run check
npx firebase-tools@latest deploy --only hosting --project elawamy-8d7e9
```

إذا طلب Firebase تسجيل الدخول، نفّذ `npx firebase-tools@latest login` واتبع التعليمات، ثم أعد أمر النشر.

**مهم:** استخدم `--only hosting` فقط لهذا التحديث؛ لا حاجة لنشر Firestore أو API لأن التعديل خاص بملفات الموقع الثابتة.

## التحقق بعد النشر

افتح:

- `https://elawamy-8d7e9.web.app/download`
- `https://elawamy-8d7e9.web.app/downloads/elawamy-android.apk`

يجب أن تعرض الصفحة زر التنزيل، وأن يبدأ الرابط الثاني تنزيل ملف APK.

## تنبيه للمستخدمين

ملف APK هو نسخة تثبيت مباشر، وليس تطبيقًا مستضافًا على Google Play. ينبغي تنزيله وتثبيته فقط من المصدر الموثوق، مع الانتباه إلى تحذيرات Android عند التثبيت من خارج المتجر.
