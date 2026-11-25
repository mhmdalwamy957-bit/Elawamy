# ElaWamy Marketplace — Termux

هذا مشروع سوق خدمات عربي: تصفح الخدمات، ملفات البائعين، الطلبات، المحادثات، التسليم والتعديلات، التقييمات، المفضلة، العروض المخصصة، النزاعات، الدعم، المحفظة ولوحة الإدارة.

## فحص الملفات قبل النشر

```bash
cd ~/elawamy-firebase-market
npm run check
```

يفحص الأمر صياغة JavaScript في الواجهة وملفات API الفعلية، ويتحقق من ملفات JSON الأساسية. كما يرفض ملفات الاعتماد الخاصة وملفات البيئة المحلية وبيانات ربط Vercel المحلية داخل مجلد المشروع.

## إعداد Firebase ونشر الواجهة

```bash
firebase use elawamy-8d7e9
firebase projects:list
npm run check
firebase deploy --only firestore:rules,firestore:indexes,hosting
```

لا تنفذ النشر إلى الإنتاج قبل مراجعة تقرير `KHAMSAT-READINESS-REPORT.md` وتجربة دورة الطلب والدفع والتسليم والاسترجاع على بيئة اختبار.

## نشر API على Vercel

يُنشر مجلد `server/` كتطبيق API مستقل. اربط المشروع من حساب Vercel الصحيح باستخدام CLI في Termux، ثم اضبط متغيرات البيئة في Vercel قبل النشر. لا تُدرج مفاتيح Firebase Admin أو Supabase أو XPay في الملفات الثابتة أو في ZIP.

## حفظ الاعتمادات الخاصة بأمان

- لا تضع `firebase-service-account.json` داخل مجلد المشروع أو أي ZIP.
- خزّن أي مفتاح خدمة تم تدويره خارج المشروع، مثل `~/elawamy-secrets/ROTATED-service-account.json`، واضبط `GOOGLE_APPLICATION_CREDENTIALS` عند الحاجة إلى تشغيل أدوات صيانة محلية.
- خزّن `FIREBASE_SERVICE_ACCOUNT` و`SUPABASE_SERVICE_ROLE_KEY` و`XPAY_SECRET_KEY` و`XPAY_WEBHOOK_SECRET` كمتغيرات بيئة على الخادم فقط.
- لا ترفع ملف `.env` ولا مجلد `.vercel/` ولا النسخ الاحتياطية إلى حزمة الإصدار.

## وضع الدفع

وجود كود XPay لا يعني أن المدفوعات الحقيقية مفعّلة. يجب ضبط بيانات التاجر ومفاتيح الاختبار والويب هوك على الخادم، ثم اختبار نجاح الدفع وفشله وانتهاء جلسة الدفع والاسترداد وتكرار إشعار الويب هوك. وضع التحويل المباشر إلى البائع ليس ضمان دفع محتجزًا داخل المنصة، لذلك لا تعتبره بديلًا عن تدفق دفع محمي ومراجع.
