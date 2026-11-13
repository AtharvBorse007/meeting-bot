#!/usr/bin/env node
/**
 * One-step launcher for Meeting Bot (Windows, macOS, Linux). Used by the start scripts in the
 * project root; can also be run directly:  node scripts/launch.js
 *
 *   1. checks Node.js
 *   2. installs dependencies on the first run (and again whenever package-lock.json changes)
 *   3. finds Chrome / Edge / Chromium on this computer (or downloads one as a last resort)
 *   4. starts the server and opens the dashboard at http://localhost:3000
 *
 * Plain CommonJS with no dependencies on purpose: it has to run before `npm install`.
 */
/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-empty-function */
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
process.chdir(root);

const say = (msg = '') => console.log(msg);
const step = (msg) => console.log(`\n==> ${msg}`);

// ---------------------------------------------------------------- .env (tiny reader)

function readDotEnv() {
  const values = {};
  try {
    for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    // no .env - fine
  }
  return values;
}

const dotenv = readDotEnv();
const setting = (name, fallback) => process.env[name] ?? dotenv[name] ?? fallback;
const port = Number(setting('PORT', '3000')) || 3000;

// ---------------------------------------------------------------------- helpers

function fail(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  // shell:true so `npm` / `npx` resolve to npm.cmd on Windows
  return spawnSync(command, args, { stdio: 'inherit', shell: true, cwd: root, ...options });
}

function openUrl(url) {
  try {
    const [cmd, args] =
      process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] :
      process.platform === 'darwin' ? ['open', [url]] :
      ['xdg-open', [url]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // the URL is printed anyway
  }
}

function probe(portNumber) {
  // 'free' | 'meeting-bot' | 'other'
  return new Promise((resolve) => {
    const socket = net.connect({ port: portNumber, host: '127.0.0.1' });
    socket.setTimeout(1500);
    socket.on('error', () => resolve('free'));
    socket.on('timeout', () => { socket.destroy(); resolve('other'); });
    socket.on('connect', () => {
      socket.destroy();
      const req = http.get({ host: '127.0.0.1', port: portNumber, path: '/api/info', timeout: 2500 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body).success === true ? 'meeting-bot' : 'other'); } catch { resolve('other'); }
        });
      });
      req.on('error', () => resolve('other'));
      req.on('timeout', () => { req.destroy(); resolve('other'); });
    });
  });
}

// ------------------------------------------------------------------ 1. Node.js

// The app keeps its data in Node's built-in SQLite, available without flags from 22.13
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  fail(`Node.js 22.13 or newer is required (this is ${process.versions.node}). Install the current LTS version from https://nodejs.org and run this again.`);
}

// --------------------------------------------------------------- 2. dependencies

function lockHash() {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(path.join(root, 'package-lock.json'))).digest('hex');
  } catch {
    return crypto.createHash('sha1').update(fs.readFileSync(path.join(root, 'package.json'))).digest('hex');
  }
}

function ensureDependencies() {
  const marker = path.join(root, 'node_modules', '.meetingbot-installed');
  const wanted = lockHash();
  let installed = '';
  try { installed = fs.readFileSync(marker, 'utf8').trim(); } catch { /* first run */ }

  const complete = fs.existsSync(path.join(root, 'node_modules', 'ts-node', 'dist', 'bin.js'));
  if (installed === wanted && complete) return;

  step('Installing dependencies (first run only, needs internet - a few minutes)...');
  const result = run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    // puppeteer would otherwise download its own Chrome (~170 MB) which this app never uses
    env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true', PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'true' },
  });
  if (result.status !== 0) {
    fail('Installing dependencies failed. Check your internet connection and run this again.');
  }
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, wanted);
}

// ----------------------------------------------------------------- 3. browser

function browserCandidates() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const bases = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean);
    const rel = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'Chromium\\Application\\chrome.exe',
    ];
    return rel.flatMap((r) => bases.map((b) => path.join(b, r)));
  }
  if (process.platform === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Chromium.app/Contents/MacOS/Chromium',
    ];
    return apps.flatMap((a) => [path.join('/Applications', a), path.join(home, 'Applications', a)]);
  }
  return [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
    '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
}

function findBrowser() {
  // An explicit CHROME_PATH wins, but only if it exists on THIS computer (a .env copied from
  // another machine often points at a path that isn't here)
  const configured = setting('CHROME_PATH', '');
  if (configured && fs.existsSync(configured)) return { path: configured, source: 'CHROME_PATH' };
  if (configured) say(`Note: CHROME_PATH (${configured}) does not exist on this computer - looking for a browser instead.`);

  const found = browserCandidates().find((p) => fs.existsSync(p));
  return found ? { path: found, source: 'detected' } : null;
}

function ensureBrowser() {
  const browser = findBrowser();
  if (browser) {
    say(`Browser for the bot: ${browser.path}`);
    return browser.path;
  }

  step('No Chrome/Edge found - downloading a browser for the bot (one time, ~150 MB)...');
  const result = run('npx', ['--no-install', 'playwright', 'install', 'chromium']);
  if (result.status !== 0) {
    fail('Could not set up a browser. Install Google Chrome (https://www.google.com/chrome) and run this again.');
  }
  say('Note: the bundled Chromium is more likely to be blocked by Google Meet than Chrome. Installing Chrome is recommended.');
  return ''; // empty -> Playwright uses its own Chromium
}

// ------------------------------------------------------------------- 4. start

async function main() {
  say('Meeting Bot');
  say('===========');

  const state = await probe(port);
  if (state === 'meeting-bot') {
    say(`\nMeeting Bot is already running - opening http://localhost:${port}`);
    openUrl(`http://localhost:${port}`);
    return 0;
  }
  if (state === 'other') {
    fail(`Port ${port} is used by another program. Close it, or start with a different port:\n  PORT=3001 node scripts/launch.js`);
  }

  ensureDependencies();
  const chromePath = ensureBrowser();

  step('Starting...');
  const env = {
    ...process.env,
    PORT: String(port),
    CHROME_PATH: chromePath,
    OPEN_BROWSER: process.env.OPEN_BROWSER ?? 'true',
    UPLOADER_TYPE: process.env.UPLOADER_TYPE ?? 'local',
    NODE_ENV: process.env.NODE_ENV ?? 'production',
  };

  const tsNode = path.join(root, 'node_modules', 'ts-node', 'dist', 'bin.js');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', tsNode, 'src/index.ts'], { cwd: root, env, stdio: 'inherit' });

  say(`\nDashboard: http://localhost:${port}   (opens automatically)`);
  say('The first start prints the admin sign-in below. Leave this window open while recording.');
  say('Press Ctrl+C to stop - recordings in progress are saved first.\n');

  // Ctrl+C reaches the server directly (same console); just wait for it to finish saving.
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGHUP', () => child.kill('SIGTERM'));

  return new Promise((resolve) => {
    child.on('error', (error) => fail(`Could not start the server: ${error.message}`));
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

main().then((code) => process.exit(code ?? 0)).catch((error) => fail(error && error.message ? error.message : String(error)));
