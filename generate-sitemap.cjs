const { getFirestore } = require('firebase-admin/firestore');
const admin = require('firebase-admin');
const fs = require('fs');

require('./server/node_modules/dotenv').config({
  path: process.env.HOME + '/elawamy-secrets/.env'
});

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT is not configured');
}

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
  credential: admin.cert(serviceAccount)
});

const db = getFirestore();
const BASE = 'https://elawamy-8d7e9.web.app';

const xmlEscape = value =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const encodePathQuery = value =>
  encodeURIComponent(String(value));

(async () => {
  const servicesSnap = await db.collection('services').get();

  const approvedServices = servicesSnap.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(service => service.status === 'approved');

  const ownerIds = [
    ...new Set(
      approvedServices
        .map(service => String(service.ownerId || '').trim())
        .filter(Boolean)
    )
  ];

  const urls = new Map();

  const add = (loc, lastmod = null) => {
    if (!urls.has(loc)) urls.set(loc, lastmod);
  };

  add(`${BASE}/`);
  add(`${BASE}/category`);

  const categories = [
    'تصميم',
    'برمجة',
    'كتابة وترجمة',
    'تسويق',
    'فيديو وصوت',
    'أعمال',
    'تعليم وتدريب'
  ];

  for (const category of categories) {
    add(`${BASE}/category?category=${encodePathQuery(category)}`);
  }

  for (const service of approvedServices) {
    const lastmod =
      service.updatedAt?.toDate?.() ||
      service.createdAt?.toDate?.() ||
      null;

    add(
      `${BASE}/service?id=${encodePathQuery(service.id)}`,
      lastmod
    );
  }

  for (const uid of ownerIds) {
    add(`${BASE}/seller?uid=${encodePathQuery(uid)}`);
  }

  const body = [...urls.entries()].map(([loc, lastmod]) => {
    const date = lastmod
      ? `<lastmod>${lastmod.toISOString()}</lastmod>`
      : '';

    return `<url><loc>${xmlEscape(loc)}</loc>${date}</url>`;
  }).join('\n  ');

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${body}
</urlset>
`;

  fs.writeFileSync(
    'public/sitemap.xml',
    sitemap,
    'utf8'
  );

  console.log(`SITEMAP GENERATED: ${urls.size} URLs`);
  console.log(`APPROVED SERVICES: ${approvedServices.length}`);
  console.log(`SELLERS: ${ownerIds.length}`);
})();
