/**
 * End-to-end test of the whole product against fakes - no real meeting or YouTube channel needed.
 *
 *   node scripts/dev/e2e.js
 *
 * Starts a fake YouTube (mock-youtube.js) and the real server with a fake Google Meet page
 * (mock-meet-preload.js) in a throw-away data folder, then drives the API the way the dashboard
 * does: accounts, permissions, concurrent recordings, End, YouTube upload + playlists, upload
 * resume, and recovery after the server is killed mid-lecture. The real bot browser is used.
 *
 * Against an already running server (e.g. the Docker image), set:
 *   E2E_BASE_URL         the server, e.g. http://localhost:3062
 *   E2E_ADMIN_PASSWORD   the ADMIN_PASSWORD it was started with (for admin@test.local)
 *   E2E_YOUTUBE_URL      the mock-youtube it talks to, as reachable from here
 *   E2E_KILL_CMD / E2E_START_CMD   shell commands to hard-kill and restart it (restart test)
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const PORT = 3061;
const YT_PORT = 4061;
const EXTERNAL = Boolean(process.env.E2E_BASE_URL);
const BASE = process.env.E2E_BASE_URL || `http://localhost:${PORT}`;
const YT_URL = process.env.E2E_YOUTUBE_URL || `http://127.0.0.1:${YT_PORT}`;
const S3_PORT = 4561;
const S3_URL = process.env.E2E_S3_URL || `http://127.0.0.1:${S3_PORT}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'meetingbot-e2e-'));
const secret = () => crypto.randomBytes(12).toString('base64url'); // test passwords: generated, never printed

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (condition, label) => {
  if (!condition) throw new Error(`FAILED: ${label}`);
  passed += 1;
  console.log(`  ok  ${label}`);
};
const waitFor = async (label, probe, timeoutMs = 90000) => {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) {
      passed += 1;
      console.log(`  ok  ${label} (${Math.round((Date.now() - started) / 1000)}s)`);
      return value;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`TIMEOUT: ${label}`);
    await sleep(700);
  }
};

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, options = {}) {
    const res = await fetch(url.startsWith('http') ? url : BASE + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...(options.headers || {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, data: json && json.data, error: json && json.error, location: res.headers.get('location') };
  }
  get(url) { return this.req('GET', url); }
  post(url, body) { return this.req('POST', url, body || {}); }
  patch(url, body) { return this.req('PATCH', url, body); }
  async login(email, password) { return this.post('/api/auth/login', { email, password }); }
  async lecture(id) {
    const list = (await this.get('/api/lectures?limit=100')).data || [];
    return list.find((l) => l.id === id);
  }
}

const children = [];
const startProcess = (name, args, env) => {
  const log = fs.createWriteStream(path.join(work, `${name}.log`), { flags: 'a' });
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env } });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.push(child);
  return child;
};

const killBotBrowsers = () => {
  if (EXTERNAL) return;
  // A hard-killed server leaves its bot browsers behind
  try {
    if (process.platform === 'win32') {
      execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match \'playwright\' -and $_.Name -match \'msedge|chrome\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"', { stdio: 'ignore' });
    } else {
      execSync('pkill -f playwright || true', { stdio: 'ignore' });
    }
  } catch { /* nothing to kill */ }
};

// Use Chrome when it is installed; otherwise whatever CHROME_PATH / .env says
const chromeCandidates = [
  process.env.E2E_BROWSER,
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const browserPath = chromeCandidates.find((candidate) => fs.existsSync(candidate));

const adminPassword = process.env.E2E_ADMIN_PASSWORD || secret();
const serverEnv = {
  ...(browserPath ? { CHROME_PATH: browserPath } : {}),
  PORT: String(PORT),
  HOST: '127.0.0.1',
  PUBLIC_URL: BASE,
  DATA_DIR: path.join(work, 'data'),
  RECORDINGS_DIR: path.join(work, 'recordings'),
  UPLOADER_TYPE: 'local',
  ADMIN_EMAIL: 'admin@test.local',
  ADMIN_PASSWORD: adminPassword,
  MAX_CONCURRENT_BOTS: '2',
  MIN_UPLOAD_SECONDS: '0',
  BOT_WINDOW_POSITION: 'offscreen',
  OPEN_BROWSER: 'false',
  YOUTUBE_API_BASE: `http://127.0.0.1:${YT_PORT}`,
  GOOGLE_OAUTH_AUTH_URL: `http://127.0.0.1:${YT_PORT}/o/oauth2/v2/auth`,
  GOOGLE_OAUTH_TOKEN_URL: `http://127.0.0.1:${YT_PORT}/token`,
  ARCHIVE_S3_BUCKET: 'lecture-backups',
  ARCHIVE_S3_ENDPOINT: `http://127.0.0.1:${S3_PORT}`,
  ARCHIVE_S3_FORCE_PATH_STYLE: 'true',
  ARCHIVE_S3_REGION: 'ap-south-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  // Remove server copies a few seconds after they are on YouTube and in S3, so that path is tested
  LOCAL_RETENTION_DAYS: '0.00005',
  CLEANUP_INTERVAL_SECONDS: '3',
};
// An external server (E2E_BASE_URL) is killed and restarted with shell commands instead
const externalServer = () => ({
  kill: () => process.env.E2E_KILL_CMD && execSync(process.env.E2E_KILL_CMD, { stdio: 'ignore' }),
});
const startServer = () => {
  if (EXTERNAL) {
    if (process.env.E2E_START_CMD) execSync(process.env.E2E_START_CMD, { stdio: 'ignore' });
    return externalServer();
  }
  return startProcess('server',
    ['-r', './scripts/dev/mock-meet-preload.js', 'node_modules/ts-node/dist/bin.js', 'src/index.ts'], serverEnv);
};
const serverUp = () => waitFor('server is up', async () => {
  try { return (await fetch(`${BASE}/health`)).ok; } catch { return false; }
}, 120000);
const youtubeState = async () => (await fetch(`${YT_URL}/_state`)).json();
const s3State = async () => (await fetch(`${S3_URL}/_state`)).json();

async function main() {
  console.log(`work dir: ${work}`);
  if (!EXTERNAL) {
    startProcess('youtube', ['scripts/dev/mock-youtube.js', String(YT_PORT)], { MOCK_YT_FAIL_CHUNKS: '2' });
    startProcess('s3', ['scripts/dev/mock-s3.js', String(S3_PORT)], {});
  }
  let server = EXTERNAL ? externalServer() : startServer();
  await serverUp();

  console.log('\nAccounts and permissions');
  const anon = new Client();
  check((await anon.get('/api/lectures')).status === 401, 'lectures need a sign-in');
  check((await anon.get('/api/admin/users')).status === 401, 'admin pages need a sign-in');
  check((await anon.login('admin@test.local', 'wrong-password')).status === 401, 'wrong password is refused');
  check((await anon.req('POST', '/api/auth/login', { email: 'admin@test.local', password: adminPassword }, { headers: { Origin: 'https://evil.example' } })).status === 403,
    'requests from another site are blocked');

  const admin = new Client();
  const adminLogin = await admin.login('admin@test.local', adminPassword);
  check(adminLogin.status === 200 && adminLogin.data.user.role === 'admin', 'admin can sign in');
  check(adminLogin.data.user.mustChangePassword === true, 'admin must change the first password');
  const adminNew = secret();
  check((await admin.post('/api/auth/password', { currentPassword: adminPassword, newPassword: 'short' })).status === 400, 'short passwords are refused');
  check((await admin.post('/api/auth/password', { currentPassword: adminPassword, newPassword: adminNew })).status === 200, 'admin changes password');
  check((await new Client().login('admin@test.local', adminPassword)).status === 401, 'old admin password stops working');

  let subjects = (await admin.post('/api/admin/subjects', { name: 'Physics' })).data;
  subjects = (await admin.post('/api/admin/subjects', { name: 'Chemistry' })).data;
  check(subjects.length === 2 && subjects.every((s) => s.playlistId === null), 'two subjects created (no playlists yet: YouTube not connected)');
  check((await admin.post('/api/admin/subjects', { name: 'physics' })).status === 409, 'duplicate subject name is refused');
  const physics = subjects.find((s) => s.name === 'Physics');
  const chemistry = subjects.find((s) => s.name === 'Chemistry');

  const passA = secret();
  const passB = secret();
  check((await admin.post('/api/admin/users', { name: 'Asha', email: 'asha@test.local', password: passA, subjectIds: [physics.id] })).status === 201, 'instructor Asha created');
  check((await admin.post('/api/admin/users', { name: 'Bala', email: 'bala@test.local', password: passB, subjectIds: [chemistry.id] })).status === 201, 'instructor Bala created');
  check((await admin.post('/api/admin/users', { name: 'Dup', email: 'ASHA@test.local', password: passB })).status === 409, 'duplicate email is refused');

  const asha = new Client();
  const bala = new Client();
  check((await asha.login('asha@test.local', passA)).data.user.mustChangePassword === true, 'instructor must replace the temporary password');
  const passA2 = secret();
  await asha.post('/api/auth/password', { currentPassword: passA, newPassword: passA2 });
  await bala.login('bala@test.local', passB);
  const meA = (await asha.get('/api/auth/me')).data;
  check(meA.subjects.length === 1 && meA.subjects[0].name === 'Physics', 'instructor only sees assigned subjects');
  check((await asha.get('/api/admin/users')).status === 403, 'instructor cannot open admin pages');
  check((await asha.post('/api/admin/subjects', { name: 'Hack' })).status === 403, 'instructor cannot create subjects');
  check((await asha.post('/api/lectures', { url: 'aaa-bbbb-ccc', subjectId: chemistry.id })).status === 400, 'instructor cannot record for someone else\'s subject');
  check((await asha.post('/api/lectures', { url: 'https://zoom.us/j/1', subjectId: physics.id })).status === 400, 'non-Meet links are refused');

  console.log('\nRecording two lectures at once');
  const events = { text: '' };
  const stream = await fetch(`${BASE}/api/events`, { headers: { Cookie: asha.cookie } });
  (async () => { for await (const chunk of stream.body) events.text += Buffer.from(chunk).toString(); })().catch(() => undefined);

  const lecA = (await asha.post('/api/lectures', { url: 'https://meet.google.com/aaa-bbbb-ccc?authuser=0', subjectId: physics.id, topic: 'Kinematics' })).data;
  const lecB = (await bala.post('/api/lectures', { url: 'eee-nnnn-ddd', subjectId: chemistry.id })).data;
  check(lecA && lecA.status === 'launching' && lecA.meetingCode === 'aaa-bbbb-ccc', 'Asha\'s recorder started');
  check(lecB && lecB.subjectName === 'Chemistry', 'Bala\'s recorder started');
  check((await asha.post('/api/lectures', { url: 'aaa-bbbb-ccc', subjectId: physics.id })).status === 409, 'same meeting cannot be recorded twice');
  const third = await admin.post('/api/lectures', { url: 'ccc-dddd-eee', subjectId: physics.id });
  check(third.status === 409 && /busy/.test(third.error), 'a third lecture is refused while both recorders are busy');
  check((await bala.post(`/api/lectures/${lecA.id}/stop`)).status === 404, 'an instructor cannot end someone else\'s lecture');
  check(!(await bala.get('/api/lectures')).data.some((l) => l.id === lecA.id), 'an instructor cannot see someone else\'s lecture');
  check((await admin.get('/api/lectures')).data.length === 2, 'admin sees every lecture');

  await waitFor('both lectures are recording', async () =>
    (await asha.lecture(lecA.id)).status === 'recording' && (await bala.lecture(lecB.id)).status === 'recording');
  await waitFor('recorded data is arriving', async () => (await asha.lecture(lecA.id)).bytesRecorded > 100000);
  check((await asha.lecture(lecA.id)).participants === 2, 'participant count is reported');

  console.log('\nEnding and saving');
  check((await asha.post(`/api/lectures/${lecA.id}/stop`)).data.stopping === true, 'End button accepted');
  const savedA = await waitFor('Asha\'s lecture is saved', async () => {
    const l = await asha.lecture(lecA.id);
    return l.status === 'saved' ? l : null;
  });
  check(savedA.fileSize > 100000 && savedA.uploadStatus === 'pending' && savedA.localFileAvailable, 'recording file kept, waiting for YouTube');
  const savedB = await waitFor('Bala\'s lecture ends by itself when the meeting ends', async () => {
    const l = await bala.lecture(lecB.id);
    return l.status === 'saved' ? l : null;
  });
  check(savedB.fileSize > 0, 'Bala\'s recording was saved');
  check((await fetch(`${BASE}/api/lectures/${lecA.id}/file`, { headers: { Cookie: bala.cookie } })).status === 404, 'recording file is private to its instructor');
  const fileRes = await fetch(`${BASE}/api/lectures/${lecA.id}/file`, { headers: { Cookie: asha.cookie, Range: 'bytes=0-3' } });
  check(fileRes.status === 206 && Buffer.from(await fileRes.arrayBuffer()).toString('hex') === '1a45dfa3', 'instructor can fetch the file (valid WebM header)');
  check((await asha.get(`/api/lectures/${lecA.id}/logs`)).data.length > 5, 'activity log is kept after the lecture');
  check(events.text.includes(lecA.id) && !events.text.includes(lecB.id), 'live updates only carry the instructor\'s own lectures');

  console.log('\nYouTube');
  check((await admin.get('/api/admin/youtube/connect')).status === 400, 'Connect needs the YouTube app first');
  const goodApp = { clientId: 'test-client.apps.googleusercontent.com', clientSecret: 'test-secret-1234' };
  check((await asha.req('PUT', '/api/admin/youtube/credentials', goodApp)).status === 403, 'only the admin can set the YouTube app');
  check((await admin.req('PUT', '/api/admin/youtube/credentials', { clientId: 'nope', clientSecret: 'x' })).status === 400, 'a malformed YouTube app is refused');
  const savedApp = await admin.req('PUT', '/api/admin/youtube/credentials', goodApp);
  check(savedApp.status === 200 && savedApp.data.configured && savedApp.data.credentialsSource === 'dashboard', 'admin saves the YouTube app in the dashboard');
  check(!JSON.stringify((await admin.get('/api/admin/system')).data).includes(goodApp.clientSecret), 'the client secret is never sent back');
  check((await asha.get('/api/admin/youtube/connect')).status === 403, 'only the admin can connect YouTube');
  const toGoogle = await admin.get('/api/admin/youtube/connect');
  check(toGoogle.status === 302 && toGoogle.location.includes('access_type=offline'), 'Connect sends the admin to Google');
  const backToApp = await admin.get(toGoogle.location);
  const done = await admin.get(backToApp.location);
  check(done.status === 302 && done.location.includes('youtube=connected'), 'YouTube connected');
  const system = (await admin.get('/api/admin/system')).data;
  check(system.youtube.connected && system.youtube.channelTitle === 'Mock Lecture Channel', 'channel name shown to the admin');

  const upA = await waitFor('Asha\'s lecture reaches YouTube', async () => {
    const l = await asha.lecture(lecA.id);
    return l.uploadStatus === 'done' ? l : null;
  });
  await waitFor('Bala\'s lecture reaches YouTube', async () => (await bala.lecture(lecB.id)).uploadStatus === 'done');
  let yt = await youtubeState();
  const videoA = yt.videos.find((v) => v.id === upA.youtubeVideoId);
  check(videoA && videoA.bytes === upA.fileSize, 'YouTube received the whole file');
  check(videoA.privacy === 'unlisted', 'video is unlisted');
  check(/^Physics – Kinematics – .* – Asha$/.test(videoA.title), `video title is "${videoA.title}"`);
  check(yt.failedChunks === 2, 'upload carried on after two failed chunks');
  check(yt.playlists.length === 2 && yt.playlists.some((p) => p.title === 'Physics') && yt.playlists.some((p) => p.title === 'Chemistry'), 'one playlist per subject was created');
  const physicsPlaylist = yt.playlists.find((p) => p.title === 'Physics');
  check(yt.playlistItems.some((i) => i.playlistId === physicsPlaylist.id && i.videoId === videoA.id), 'video is in its subject playlist');
  check(upA.playlistUrl.endsWith(physicsPlaylist.id) && upA.youtubeUrl.endsWith(videoA.id), 'links are stored on the lecture');
  check((await asha.post(`/api/lectures/${lecA.id}/retry-upload`)).status === 409, 'a finished upload cannot be repeated');

  console.log('\nS3 backup');
  const archivedA = await waitFor('Asha\'s recording is backed up in S3', async () => {
    const l = await asha.lecture(lecA.id);
    return l.archiveStatus === 'done' ? l : null;
  });
  let s3 = await s3State();
  const objectA = s3.objects.find((o) => o.key === archivedA.archiveKey);
  check(objectA && objectA.size === archivedA.fileSize, 'S3 holds the whole recording');
  check(objectA.storageClass === 'STANDARD_IA' && objectA.metadata['lecture-id'] === lecA.id, 'stored as Standard-IA with the lecture id');
  check(/recordings\/\d{4}\/\d{2}\/Physics\//.test(objectA.key), `key is organised by month and subject (${objectA.key})`);
  check(s3.objects.some((o) => /db-backups\/meetingbot-\d{4}-\d{2}-\d{2}\.db$/.test(o.key) && o.size > 0), 'database backup is in S3');
  const backupSystem = (await admin.get('/api/admin/system')).data.archive;
  check(backupSystem.enabled && backupSystem.problem === null && backupSystem.dbBackup.lastSuccessAt, 'admin sees the backup status');
  const cleaned = await waitFor('server copy removed once it is on YouTube and in S3', async () => {
    const l = await asha.lecture(lecA.id);
    return !l.localFileAvailable && l.backupAvailable ? l : null;
  }, 60000);
  check(cleaned.localDeletedAt > 0, 'lecture records when the server copy was removed');
  const fromBackup = await asha.get(`/api/lectures/${lecA.id}/file?download=1`);
  check(fromBackup.status === 302 && /X-Amz-Signature=/.test(fromBackup.location || ''), 'download now goes to a signed S3 link');
  if (!EXTERNAL) {
    const bytes = Buffer.from(await (await fetch(fromBackup.location)).arrayBuffer());
    check(bytes.length === archivedA.fileSize, 'the signed link returns the recording');
  }
  check((await bala.get(`/api/lectures/${lecA.id}/file`)).status === 404, 'other instructors still cannot get it');

  console.log('\nCancel while waiting in the lobby');
  const lecL = (await asha.post('/api/lectures', { url: 'lll-oooo-bbb', subjectId: physics.id })).data;
  await waitFor('recorder is waiting to be admitted', async () => (await asha.lecture(lecL.id)).status === 'lobby');
  await asha.post(`/api/lectures/${lecL.id}/stop`);
  const cancelled = await waitFor('lecture is cancelled', async () => {
    const l = await asha.lecture(lecL.id);
    return l.status === 'cancelled' ? l : null;
  }, 30000);
  check(cancelled.uploadStatus === 'none' && !cancelled.fileName, 'nothing is uploaded for a cancelled lecture');

  if (EXTERNAL && !process.env.E2E_KILL_CMD) {
    console.log(`\nALL ${passed} CHECKS PASSED (restart test skipped)`);
    return;
  }

  console.log('\nServer killed in the middle of a lecture');
  const lecC = (await asha.post('/api/lectures', { url: 'bbb-cccc-ddd', subjectId: physics.id, topic: 'Crash test' })).data;
  await waitFor('third lecture has recorded data', async () => (await asha.lecture(lecC.id)).bytesRecorded > 100000);
  server.kill('SIGKILL');
  await sleep(1500);
  killBotBrowsers();
  server = startServer();
  await serverUp();
  const recovered = await waitFor('partial recording was recovered and uploaded', async () => {
    const l = await asha.lecture(lecC.id);
    return l && l.status === 'saved' && l.uploadStatus === 'done' ? l : null;
  });
  check(/restart/i.test(recovered.error), 'lecture explains that the server restarted');
  yt = await youtubeState();
  check(yt.videos.some((v) => v.id === recovered.youtubeVideoId && v.bytes === recovered.fileSize), 'recovered recording is on YouTube');
  check(yt.playlists.length === 2, 'existing playlist was reused');
  check((await asha.get('/api/auth/me')).status === 200, 'sign-in survives a restart');

  console.log('\nSwitching an account off');
  const users = (await admin.get('/api/admin/users')).data;
  const balaRow = users.find((u) => u.email === 'bala@test.local');
  await admin.patch(`/api/admin/users/${balaRow.id}`, { active: false });
  check((await bala.get('/api/auth/me')).status === 401, 'a switched-off instructor is signed out');
  check((await new Client().login('bala@test.local', passB)).status === 401, 'and cannot sign in again');
  check((await admin.patch(`/api/admin/users/${adminLogin.data.user.id}`, { active: false })).status === 400, 'the admin cannot switch off their own account');

  console.log(`\nALL ${passed} CHECKS PASSED`);
}

main()
  .catch((error) => {
    console.error(`\n${error.message}`);
    console.error(`logs: ${work}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const child of children) child.kill('SIGKILL');
    await sleep(500);
    killBotBrowsers();
    if (!process.exitCode) fs.rmSync(work, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  });
