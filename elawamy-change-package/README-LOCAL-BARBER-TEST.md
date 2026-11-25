# Local-only barber booking test

This patch keeps the deployed website pointed at the existing production API, but makes pages served from Firebase Hosting Emulator on `localhost:5000` or `127.0.0.1:5000` use `127.0.0.1:3000`. On local origins only, the browser also connects Firebase Auth and Firestore to their emulators. The local API reports `localEmulators: true` only when it was started with both emulator hosts set.

## 1. Start only local emulators

Keep this terminal open:

```bash
cd ~/elawamy || exit 1
firebase emulators:start --project elawamy-8d7e9 --only auth,firestore,hosting
```

This starts local emulators only. Do not run `firebase deploy` during testing. The project ID matches the existing Firebase configuration, but Auth, Firestore and Hosting are directed to local emulator ports.

## 2. Start the local API with XPay disabled

In another terminal, run this exact command. It masks XPay keys for this process so tests cannot create an online checkout session:

```bash
cd ~/elawamy/server || exit 1
NODE_ENV=development \
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
XPAY_SECRET_KEY= \
XPAY_WEBHOOK_SECRET= \
npm start
```

Keep this terminal open too. Do not paste any `.env` file or its contents into chat.

## 3. Run automated local API tests

In a third terminal:

```bash
cd ~/elawamy || exit 1
node scripts/check-barber-booking.cjs
node scripts/test-barber-whatsapp.cjs
node scripts/test-barber-finance.cjs
node scripts/test-barber-closed-dates.cjs
node --check server/server.js
node --check public/js/admin.js
node --check public/js/barbers.js
node scripts/test-barber-booking-local.cjs
# Or, when the local API and emulators are already running:
npm run test:barber:local
```

Run `npm run check` as a separate source-hygiene check; it skips local `.vercel/` and `.firebase/` metadata folders.

The integration test first checks that the API explicitly reports both local emulators enabled and online payments disabled. It stops before creating test data if either safety check fails. Then it creates a temporary Auth Emulator user and a test salon. The test verifies that the salon remains `pending`, is hidden from public list/details, and cannot be reviewed by a non-admin. It then assigns an `admin: true` custom claim through the local Auth Emulator only, signs in again to obtain a fresh token, approves the salon through the admin API, and continues with service/booking checks. It also saves an individual barber holiday, confirms that availability returns no slots on that date, and verifies direct booking is rejected with `409 BARBER_DATE_CLOSED`. Finally it sends two simultaneous requests for the same onsite slot. The expected result is exactly one `201` and one `409 BARBER_SLOT_UNAVAILABLE`.

## 4. Open the local page

Open `http://127.0.0.1:5000/barbers` in the same Android device's browser. Local page requests go to local port 3000, and local login goes to Auth Emulator on port 9099. The production website and production API are unchanged by this patch. Online checkout is deliberately disabled in this test.

The temporary test user, its local-only admin custom claim, and test salon are stored in the local emulators only. They are not production records. No deployment is performed by this patch or test script.
