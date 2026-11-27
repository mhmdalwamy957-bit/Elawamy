# ElaWamy AI — المرحلة الأولى

هذه الحزمة تضيف مساعدًا ذكيًا إلى موقع العوامي، وسيظهر تلقائيًا داخل تطبيق Android الحالي لأنه يفتح الموقع نفسه في WebView.

## ما الذي تضيفه؟

- رابط «العوامي AI» في قائمة الموقع للمستخدم المسجّل دخوله.
- صفحة محادثة عربية متوافقة مع الهاتف.
- إرسال الطلبات إلى API الحالي على Vercel بعد التحقق من Firebase ID Token.
- استخدام Gemini Interactions API مع `store: false`؛ يحتفظ المتصفح بسياق المحادثة في ذاكرة الصفحة فقط.
- حفظ مسودة خدمة خاصة بالمستخدم داخل Firestore عند طلبه صراحةً. المسودة لا تُنشر ولا تُضاف إلى كتالوج الخدمات.
- صفحة تعرض آخر 20 مسودة محفوظة للحساب.
- حد استخدام: 8 طلبات في الدقيقة و30 طلبًا خلال 24 ساعة لكل حساب.
- لا توجد مكتبات جديدة مطلوبة.

## الملفات الموجودة في الحزمة

- `public/ai.html`
- `public/js/ai-assistant.js`
- `public/js/site-nav.js` (نسخة معدّلة)
- `public/css/ai-assistant.css`
- `server/server.js` (نسخة معدّلة كاملة)

## تطبيق الملفات على Termux

قبل الاستبدال، اعمل نسخة احتياطية:

```bash
cd ~/projects/Elawamy
mkdir -p ~/elawamy-ai-backup
cp server/server.js ~/elawamy-ai-backup/server.js.before-ai
cp public/js/site-nav.js ~/elawamy-ai-backup/site-nav.js.before-ai
```

انقل ملف ZIP إلى مجلد Downloads في الهاتف، ثم نفّذ:

```bash
unzip -o ~/storage/downloads/Elawamy-AI-phase1-patch.zip -d ~/projects/Elawamy
```

ثم افحص الصياغة:

```bash
node --check ~/projects/Elawamy/server/server.js
node --check ~/projects/Elawamy/public/js/site-nav.js
node --check ~/projects/Elawamy/public/js/ai-assistant.js
```

لا تنشر قبل نجاح الأوامر الثلاثة.

## إعداد مفتاح Gemini على Vercel

1. افتح Google AI Studio من الرابط:
   https://aistudio.google.com/app/apikey
2. أنشئ مفتاح Gemini API ضمن الطبقة المجانية إذا كانت متاحة لحسابك ومشروعك.
3. افتح لوحة Vercel واختر مشروع الخادم الذي يخدم:
   `https://elawamy-file-server.vercel.app`
4. من Settings ثم Environment Variables أضف:
   - الاسم: `GEMINI_API_KEY`
   - القيمة: المفتاح الذي أنشأته في Google AI Studio
   - البيئة: Production، ويمكن إضافة Preview وDevelopment عند الحاجة.
5. احفظ المتغير ثم أعد نشر مشروع الخادم.
6. اختياريًا أضف:
   - الاسم: `GEMINI_MODEL`
   - القيمة: `gemini-3.8-flash`

لا تضع المفتاح داخل `public/` أو `firebase-config.generated.json` أو ملفات التطبيق، ولا ترسله في المحادثة.

## النشر

انشر الخادم المعدّل إلى مشروع Vercel الحالي بالطريقة نفسها التي تستخدمها حاليًا لنشر مجلد `server/`.

بعد نجاح نشر الخادم، انشر موقع Firebase Hosting:

```bash
cd ~/projects/Elawamy
npm run check
npx firebase-tools@latest deploy --only hosting --project elawamy-8d7e9
```

إذا كان النشر الحالي للـAPI من مستودع Git متصل بـVercel، ادفع التعديلات إلى نفس المستودع/الفرع بدل إنشاء مشروع Vercel جديد.

## اختبار

1. سجّل الدخول في موقع العوامي.
2. افتح `/ai` أو اضغط «العوامي AI» في القائمة.
3. جرّب طلبًا مثل: «اكتب وصفًا لخدمة تصميم شعار».
4. بعد استكمال بيانات الخدمة، اطلب صراحةً: «احفظها كمسودة».
5. يجب أن تظهر المسودة في صندوق «مسودات الخدمات المحفوظة».

## حدود النسخة الأولى

هذه بداية عملية وليست وكيلًا حرًّا لإدارة كل شيء. المساعد يستطيع المحادثة وإنتاج المحتوى وحفظ مسودات الخدمات فقط. لا يقرأ طلبات أو أرصدة أو معلومات العملاء، ولا ينشر الخدمات، ولا يغيّر الطلبات أو المدفوعات أو حسابات المستخدمين. إضافة كل عملية أخرى تتطلب أداة خادم منفصلة وصلاحيات واختبارات وموافقة مناسبة.

## الخصوصية والتكلفة

- مفتاح Gemini محفوظ على الخادم فقط.
- المحادثة لا تُحفظ في Firestore ولا في المتصفح بعد إغلاق/تحديث الصفحة؛ يرسل العميل سجل التفاعل مع `store: false`.
- مع ذلك، محتوى الرسائل يُرسل إلى Google Gemini لمعالجة الطلب. سياسة الطبقة المجانية قد تسمح باستخدام المحتوى لتحسين منتجات Google؛ لذلك لا ترسل بيانات شخصية حساسة أو كلمات مرور أو رموز تحقق أو بيانات دفع.
- الطبقة المجانية لها حدود حصة واستخدام قد تتغير. لا تفعّل الفوترة المدفوعة ولا تضف وسيلة دفع ما دام هدفك إبقاء الخدمة مجانية.
