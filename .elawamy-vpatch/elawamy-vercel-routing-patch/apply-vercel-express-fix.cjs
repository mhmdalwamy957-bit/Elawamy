#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = process.cwd();
const serverDir = path.join(root, 'server');
const configPath = path.join(serverDir, 'vercel.json');
const appPath = path.join(serverDir, 'server.js');
const entryPath = path.join(serverDir, 'index.js');
const legacyApiPath = path.join(serverDir, 'api', 'index.js');

function fail(message) {
  console.error(`PATCH STOPPED: ${message}`);
  process.exit(1);
}
function exists(file) { return fs.existsSync(file); }
function uniqueBackup(file, suffix) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let target = `${file}.${suffix}-${stamp}`;
  let n = 1;
  while (exists(target)) target = `${file}.${suffix}-${stamp}-${n++}`;
  return target;
}

if (!exists(configPath) || !exists(appPath) || !exists(entryPath)) {
  fail('Run this script from the ElaWamy project root, and make sure server/vercel.json, server/server.js, and server/index.js exist.');
}
const appSource = fs.readFileSync(appPath, 'utf8');
const entrySource = fs.readFileSync(entryPath, 'utf8');
const configSource = fs.readFileSync(configPath, 'utf8');
if (!/export\s+default\s+app\s*;?/.test(appSource) || !/export\s+default\s+app\s*;?/.test(entrySource)) {
  fail('The expected Express default exports were not found. No files were changed.');
}
let config;
try { config = JSON.parse(configSource); } catch { fail('server/vercel.json is not valid JSON. No files were changed.'); }
if (!Array.isArray(config.rewrites) || !config.rewrites.some(r => r.source === '/api/:path*' && r.destination === '/api/index.js')) {
  fail('The expected legacy /api/* rewrite was not found. No files were changed; inspect the current Vercel config first.');
}

const configBackup = uniqueBackup(configPath, 'before-express-fix');
fs.copyFileSync(configPath, configBackup);
let apiBackup = null;
try {
  const updatedConfig = {
    "$schema": "https://openapi.vercel.sh/vercel.json",
    "framework": "express"
  };
  fs.writeFileSync(configPath, `${JSON.stringify(updatedConfig, null, 2)}\n`);

  // A root Express app handles API routes itself; disable the old duplicate API function
  // without deleting it so it can be restored if necessary.
  if (exists(legacyApiPath)) {
    apiBackup = uniqueBackup(legacyApiPath, 'before-express-fix');
    fs.renameSync(legacyApiPath, apiBackup);
  }

  const checks = [
    ['server/server.js', ['--check', appPath]],
    ['public/js/barbers.js', ['--check', path.join(root, 'public', 'js', 'barbers.js')]],
    ['public/js/admin.js', ['--check', path.join(root, 'public', 'js', 'admin.js')]],
    ['booking static checks', [path.join(root, 'scripts', 'check-barber-booking.cjs')]]
  ];
  for (const [label, args] of checks) {
    const commandArgs = label === 'booking static checks' ? args : args;
    const result = spawnSync(process.execPath, commandArgs, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) {
      console.error(result.stdout || '');
      console.error(result.stderr || '');
      throw new Error(`Validation failed: ${label}`);
    }
    if (label === 'booking static checks') console.log((result.stdout || '').trim());
    else console.log(`PASS ${label}`);
  }

  console.log('\nPATCH APPLIED LOCALLY ONLY. Nothing was deployed.');
  console.log(`Config backup: ${path.relative(root, configBackup)}`);
  if (apiBackup) console.log(`Legacy API handler backup: ${path.relative(root, apiBackup)}`);
  console.log('Next: review the changed files and run the local emulator test instructions in README-LOCAL-BARBER-TEST.md.');
} catch (error) {
  // Roll back this script's edits on validation failure.
  fs.copyFileSync(configBackup, configPath);
  if (apiBackup && exists(apiBackup)) fs.renameSync(apiBackup, legacyApiPath);
  console.error(`PATCH ROLLED BACK: ${error.message}`);
  process.exit(1);
}
