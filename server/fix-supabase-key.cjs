const fs = require('fs');
const readline = require('readline');

const file = `${process.env.HOME}/elawamy-secrets/.env`;

if (!fs.existsSync(file)) {
  console.error('ملف .env غير موجود');
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('الصق مفتاح Secret الجديد: ', key => {
  rl.close();
  key = key.trim();

  if (!key.startsWith('sb_secret_') || key.length < 20) {
    console.error('المفتاح غير صالح؛ لم يتم تعديل الملف');
    return;
  }

  const old = fs.readFileSync(file, 'utf8');
  const line = `SUPABASE_SERVICE_ROLE_KEY=${JSON.stringify(key)}`;
  const pattern = /^[ \t]*(?:export[ \t]+)?SUPABASE_SERVICE_ROLE_KEY[ \t]*=.*$/m;

  const updated = pattern.test(old)
    ? old.replace(pattern, line)
    : old.trimEnd() + '\n' + line + '\n';

  fs.copyFileSync(file, file + '.backup-' + Date.now());
  fs.writeFileSync(file, updated, { mode: 0o600 });

  console.log('تم تحديث الإعدادات بنجاح');
});
