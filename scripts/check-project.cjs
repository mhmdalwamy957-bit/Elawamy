#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const skippedDirectoryNames = new Set([
  '.git', '.firebase', '.vercel', 'node_modules', '__pycache__'
]);
const skippedDirectoryPrefixes = ['backup-', 'backup_', 'elawamy_release'];
const skippedFilePatterns = [
  /\.before(?:-|$)/i,
  /\.bak\d*$/i,
  /\.backup(?:-|$)/i,
  /\.orig$/i,
  /\.save$/i
];
const sourceExtensions = new Set(['.js', '.cjs', '.mjs']);
const jsonFiles = [
  '.firebaserc', 'firebase.json', 'firebase-config.generated.json',
  'firestore.indexes.json', 'package.json', 'package-lock.json',
  'seed-services.json', 'server/package.json', 'server/package-lock.json',
  'server/vercel.json', 'vercel.json'
];
const secretFileNames = new Set([
  'firebase-service-account.json', 'service-account.json',
  '.env', '.env.local', '.env.production', '.env.development'
]);

function shouldSkipDirectory(name) {
  return skippedDirectoryNames.has(name)
    || skippedDirectoryPrefixes.some(prefix => name.startsWith(prefix));
}

function walk(directory, output = []) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(entry.name)) walk(path.join(directory, entry.name), output);
      continue;
    }
    if (!entry.isFile() || skippedFilePatterns.some(pattern => pattern.test(entry.name))) continue;
    if (sourceExtensions.has(path.extname(entry.name))) output.push(path.join(directory, entry.name));
  }
  return output;
}

function shouldCheckSource(file) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  return !relative.startsWith('elawamy_release/')
    && !relative.startsWith('backup-')
    && !relative.startsWith('server/server.before');
}

function checkSyntax(file) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ file, status: 1, details: error.message }));
    child.on('close', status => resolve({ file, status: status ?? 1, details: `${stderr}${stdout}`.trim() }));
  });
}

async function runPool(items, worker, concurrency = 8) {
  const results = new Array(items.length);
  let next = 0;
  async function runWorker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
  return results;
}

function findSecretFiles() {
  const found = [];
  const inspect = (directory, relative = '') => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (shouldSkipDirectory(entry.name)) continue;
        inspect(fullPath, childRelative);
      } else if (entry.isFile()) {
        const isPrivateEnvironmentFile = /^\.env(?:\..+)?$/i.test(entry.name)
          && entry.name.toLowerCase() !== '.env.example';
        if (secretFileNames.has(entry.name) || isPrivateEnvironmentFile) found.push(childRelative);
        if (/service-account.*\.json$/i.test(entry.name)) found.push(childRelative);
      }
    }
  };

  // Check the complete project tree (including archived subfolders), excluding local tool caches.
  inspect(root, '');

  return [...new Set(found)];
}
async function main() {
  const sources = [
    path.join(root, 'seed.cjs'), path.join(root, 'generate-sitemap.cjs'),
    ...walk(path.join(root, 'public')),
    ...walk(path.join(root, 'server')),
    ...walk(path.join(root, 'scripts'))
  ].filter((file, index, all) => fs.existsSync(file)
    && shouldCheckSource(file)
    && all.indexOf(file) === index);

  const results = await runPool(sources, checkSyntax, 8);
  let errors = 0;
  for (const result of results) {
    if (result.status !== 0) {
      errors += 1;
      console.error(`FAIL JavaScript syntax: ${path.relative(root, result.file)}`);
      if (result.details) console.error(result.details);
    }
  }

  let checkedJson = 0;
  for (const relative of jsonFiles) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) continue;
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'));
      checkedJson += 1;
    } catch (error) {
      errors += 1;
      console.error(`FAIL JSON: ${relative}: ${error.message}`);
    }
  }

  for (const relative of findSecretFiles()) {
    errors += 1;
    console.error(`FAIL release hygiene: remove private/local file ${relative}`);
  }

  if (errors) {
    console.error(`\nProject check failed: ${errors} issue(s), ${results.length} JavaScript file(s), ${checkedJson} JSON file(s) checked.`);
    process.exit(1);
  }
  console.log(`Project check passed: ${results.length} JavaScript file(s) and ${checkedJson} JSON file(s) checked; no local credential files found.`);
}

main().catch(error => {
  console.error('Project check failed unexpectedly:', error);
  process.exit(1);
});
