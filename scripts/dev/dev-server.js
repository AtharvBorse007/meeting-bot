/**
 * Dev helper: run the dashboard against a fake Google Meet and a fake YouTube, so the whole flow
 * can be clicked through on a laptop without a real meeting or channel.
 *
 *   node scripts/dev/dev-server.js            (http://localhost:3055)
 *
 * Its data lives in data/dev-mock (separate from real data). The first start prints the admin
 * sign-in. In Settings, enter any client ID ending in .apps.googleusercontent.com (and any secret)
 * as the YouTube app; backups go to a fake S3. Meeting codes the fake Meet understands:
 *   aaa-bbbb-ccc (or any other code)  stays in the call until End is pressed
 *   eee-nnnn-ddd                      the meeting ends by itself after ~25 seconds
 *   lll-oooo-bbb                      never admitted (stuck waiting) - for trying Cancel
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const port = Number(process.env.PORT) || 3055;
const ytPort = port + 1000;
const s3Port = port + 1500;
const dataDir = path.join(root, 'data', 'dev-mock');

const chrome = [
  process.env.CHROME_PATH_DEV,
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((candidate) => fs.existsSync(candidate));

const env = {
  ...process.env,
  ...(chrome ? { CHROME_PATH: chrome } : {}),
  PORT: String(port),
  PUBLIC_URL: `http://localhost:${port}`,
  DATA_DIR: dataDir,
  RECORDINGS_DIR: path.join(dataDir, 'recordings'),
  UPLOADER_TYPE: 'local',
  ADMIN_EMAIL: 'admin@dev.local',
  MIN_UPLOAD_SECONDS: '0',
  BOT_WINDOW_POSITION: process.env.BOT_WINDOW_POSITION || 'offscreen',
  YOUTUBE_API_BASE: `http://127.0.0.1:${ytPort}`,
  GOOGLE_OAUTH_AUTH_URL: `http://127.0.0.1:${ytPort}/o/oauth2/v2/auth`,
  GOOGLE_OAUTH_TOKEN_URL: `http://127.0.0.1:${ytPort}/token`,
  ARCHIVE_S3_BUCKET: 'dev-lecture-backups',
  ARCHIVE_S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
  ARCHIVE_S3_FORCE_PATH_STYLE: 'true',
  AWS_ACCESS_KEY_ID: 'dev',
  AWS_SECRET_ACCESS_KEY: 'dev',
};
// The fake YouTube app is entered in Settings, like on a real server
delete env.YOUTUBE_CLIENT_ID;
delete env.YOUTUBE_CLIENT_SECRET;

const children = [
  spawn(process.execPath, ['scripts/dev/mock-youtube.js', String(ytPort)], { cwd: root, env, stdio: 'inherit' }),
  spawn(process.execPath, ['scripts/dev/mock-s3.js', String(s3Port)], { cwd: root, env, stdio: 'inherit' }),
  spawn(process.execPath, ['-r', './scripts/dev/mock-meet-preload.js', 'node_modules/ts-node/dist/bin.js', 'src/index.ts'], { cwd: root, env, stdio: 'inherit' }),
];

const stop = () => children.forEach((child) => child.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
children[2].on('exit', (code) => { stop(); process.exit(code ?? 0); });
