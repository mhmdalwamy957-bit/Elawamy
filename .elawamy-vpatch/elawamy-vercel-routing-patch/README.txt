ElaWamy Vercel Express routing patch

Purpose
- Remove the legacy rewrite that sends every /api/* request to /api/index.js.
- Let Vercel route requests through the root Express application (server/index.js -> server/server.js), matching the current Vercel Express deployment model.
- Preserve backups and disable, rather than delete, server/api/index.js.

Safety
- This patch must be extracted into the existing ElaWamy project and run from its project root.
- It does not contact Vercel, deploy, change Firebase, edit Firestore rules, or alter secrets.
- It creates timestamped backups. If validation fails, it attempts to roll back the changes.
- This addresses the suspicious Vercel routing configuration found in the uploaded source; the production API response still needs to be verified after a preview deployment or an intentional production deployment.

Usage in Termux
  cd ~/elawamy-khamsat-ready
  node /path/to/apply-vercel-express-fix.cjs

Extract the file from this ZIP into ~/elawamy-khamsat-ready first, then run:
  cd ~/elawamy-khamsat-ready
  node apply-vercel-express-fix.cjs

After local tests pass, deploy to a Vercel preview first from the server directory:
  cd ~/elawamy-khamsat-ready/server
  vercel

Do not run `vercel --prod` until the preview has passed the API and booking tests.
