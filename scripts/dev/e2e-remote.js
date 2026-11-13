/**
 * End-to-end test of the pay-per-use design (RECORDER_MODE=ecs): the dashboard starts one recorder
 * task per lecture through the ECS API, recorders stream segments to S3, and lost recorders are
 * replaced. Uses fakes for ECS (local worker processes), S3, YouTube and Google Meet; the recorders
 * are real Chrome.
 *
 *   node scripts/dev/e2e-remote.js
 *
 * Against servers that are already running (the Docker image, see e2e-docker.js):
 *   E2E_BASE_URL, E2E_ADMIN_PASSWORD, E2E_YOUTUBE_URL, E2E_S3_URL, E2E_ECS_URL,
 *   E2E_KILL_CMD / E2E_START_CMD (dashboard restart test), E2E_POSIX_SIGNALS=1 (AWS notice + hang tests),
 *   E2E_HAS_FFMPEG=1 (parts must be joined into one video)
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const EXTERNAL = Boolean(process.env.E2E_BASE_URL);
const PORT = 3071;
const YT_PORT = 4071;
const S3_PORT = 4573;
const ECS_PORT = 4575;
const BASE = process.env.E2E_BASE_URL || `http://localhost:${PORT}`;
const YT_URL = process.env.E2E_YOUTUBE_URL || `http://127.0.0.1:${YT_PORT}`;
const S3_URL = process.env.E2E_S3_URL || `http://127.0.0.1:${S3_PORT}`;
const ECS_URL = process.env.E2E_ECS_URL || `http://127.0.0.1:${ECS_PORT}`;
const POSIX = process.env.E2E_POSIX_SIGNALS === '1' || (!EXTERNAL && process.platform !== 'win32');
const HAS_FFMPEG = process.env.E2E_HAS_FFMPEG === '1' || (!EXTERNAL && (() => {
  try { execSync('ffmpeg -version', { stdio: 'ignore' }); return true; } catch { return false; }
})());
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'meetingbot-remote-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const check = (condition, label) => {
  if (!condition) throw new Error(`FAILED: ${label}`);
  passed += 1;
  console.log(`  ok  ${label}`);
};
const waitFor = async (label, probe, timeoutMs = 120000) => {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) {
      passed += 1;
      console.log(`  ok  ${label} (${Math.round((Date.now() - started) / 1000)}s)`);
      return value;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`TIMEOUT: ${label}`);
    await sleep(1000);
  }
};

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body) {
    const res = await fetch(url.startsWith('http') ? url : BASE + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    let json;
    try { json = JSON.parse(await res.text()); } catch { json = undefined; }
    return { status: res.status, data: json && json.data, error: json && json.error, location: res.headers.get('location') };
  }
  get(url) { return this.req('GET', url); }
  post(url, body) { return this.req('POST', url, body || {}); }
  async lecture(id) { return ((await this.get('/api/lectures?limit=100')).data || []).find((l) => l.id === id); }
  async logs(id) { return ((await this.get(`/api/lectures/${id}/logs`)).data || []).map((e) => e.message).join('\n'); }
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

const chrome = [
  process.env.E2E_BROWSER,
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean).find((p) => fs.existsSync(p));

const adminPassword = process.env.E2E_ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
const common = {
  ...(chrome ? { CHROME_PATH: chrome } : {}),
  BOT_WINDOW_POSITION: 'offscreen',
  ARCHIVE_S3_BUCKET: 'lecture-backups',
  ARCHIVE_S3_ENDPOINT: S3_URL,
  ARCHIVE_S3_FORCE_PATH_STYLE: 'true',
  ARCHIVE_S3_REGION: 'ap-south-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  RECORDER_SEGMENT_SECONDS: '4',
  RECORDER_HEARTBEAT_SECONDS: '2',
};
const serverEnv = {
  ...common,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  PUBLIC_URL: BASE,
  DATA_DIR: path.join(work, 'data'),
  RECORDINGS_DIR: path.join(work, 'recordings'),
  ADMIN_EMAIL: 'admin@test.local',
  ADMIN_PASSWORD: adminPassword,
  MIN_UPLOAD_SECONDS: '0',
  MAX_CONCURRENT_BOTS: '6',
  RECORDER_MODE: 'ecs',
  RECORDER_HEARTBEAT_TIMEOUT_SECONDS: '12',
  ECS_ENDPOINT: ECS_URL,
  ECS_CLUSTER: 'lecture-recorder',
  ECS_TASK_DEFINITION: 'lecture-recorder-task',
  ECS_SUBNETS: 'subnet-aaa,subnet-bbb',
  ECS_SECURITY_GROUPS: 'sg-recorder',
  YOUTUBE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  YOUTUBE_CLIENT_SECRET: 'test-secret-1234',
  YOUTUBE_API_BASE: YT_URL,
  GOOGLE_OAUTH_AUTH_URL: `${YT_URL}/o/oauth2/v2/auth`,
  GOOGLE_OAUTH_TOKEN_URL: `${YT_URL}/token`,
};

let server;
const startServer = () => {
  if (EXTERNAL) {
    if (process.env.E2E_START_CMD) execSync(process.env.E2E_START_CMD, { stdio: 'ignore' });
    return { kill: () => process.env.E2E_KILL_CMD && execSync(process.env.E2E_KILL_CMD, { stdio: 'ignore' }) };
  }
  return startProcess('server', ['node_modules/ts-node/dist/bin.js', 'src/index.ts'], serverEnv);
};
const serverUp = () => waitFor('dashboard is up', async () => {
  try { return (await fetch(`${BASE}/health`)).ok; } catch { return false; }
}, 120000);

const s3 = async () => (await fetch(`${S3_URL}/_state`)).json();
const ecs = async () => (await fetch(`${ECS_URL}/_state`)).json();
const yt = async () => (await fetch(`${YT_URL}/_state`)).json();
const segments = async (id, part) => (await s3()).objects
  .filter((o) => o.key.startsWith(`segments/${id}/part-${String(part).padStart(2, '0')}/`)).length;
const signal = (id, sig) => fetch(`${ECS_URL}/_signal?lecture=${id}&signal=${sig}`, { method: 'POST' });

async function main() {
  console.log(`work dir: ${work}`);
  if (!EXTERNAL) {
    startProcess('youtube', ['scripts/dev/mock-youtube.js', String(YT_PORT)], {});
    startProcess('s3', ['scripts/dev/mock-s3.js', String(S3_PORT)], {});
    startProcess('ecs', ['scripts/dev/mock-ecs.js', String(ECS_PORT)], common);
  }
  server = startServer();
  await serverUp();

  console.log('\nSet-up');
  const admin = new Client();
  check((await admin.post('/api/auth/login', { email: 'admin@test.local', password: adminPassword })).status === 200, 'admin signs in');
  check((await admin.post('/api/auth/password', { currentPassword: adminPassword, newPassword: crypto.randomBytes(12).toString('base64url') })).status === 200, 'admin sets a password');
  const physics = (await admin.post('/api/admin/subjects', { name: 'Physics' })).data.find((s) => s.name === 'Physics');
  const toGoogle = await admin.get('/api/admin/youtube/connect');
  const back = await admin.get(toGoogle.location);
  check((await admin.get(back.location)).location.includes('youtube=connected'), 'YouTube connected');

  const start = async (code, topic) => {
    const res = await admin.post('/api/lectures', { url: code, subjectId: physics.id, topic });
    if (res.status !== 202) throw new Error(`could not start ${code}: ${res.status} ${res.error}`);
    return res.data;
  };
  const savedLecture = (id, timeout) => waitFor(`lecture ${id.slice(0, 8)} is saved`, async () => {
    const l = await admin.lecture(id);
    return l.status === 'saved' ? l : null;
  }, timeout);

  console.log('\nOne recorder per lecture, started through ECS');
  const lecA = await start('aaa-bbbb-ccc', 'Normal lecture');
  check(/1.2 minutes/.test(lecA.detail || ''), 'the dashboard says the recorder takes 1–2 minutes to start');
  const run = await waitFor('RunTask was called for lecture A', async () => (await ecs()).requests
    .find((r) => r.action === 'RunTask' && r.input.overrides.containerOverrides[0].environment.some((e) => e.value === lecA.id)), 20000);
  const net = run.input.networkConfiguration.awsvpcConfiguration;
  check(run.input.launchType === 'FARGATE' && run.input.cluster === 'lecture-recorder' && run.input.taskDefinition === 'lecture-recorder-task',
    'RunTask uses Fargate, the cluster and the task definition');
  check(net.subnets.join() === 'subnet-aaa,subnet-bbb' && net.securityGroups[0] === 'sg-recorder' && net.assignPublicIp === 'ENABLED',
    'RunTask uses the subnets, security group and a public IP (no NAT gateway needed)');
  const env = Object.fromEntries(run.input.overrides.containerOverrides[0].environment.map((e) => [e.name, e.value]));
  check((EXTERNAL ? env.CONTROL_URL.startsWith('http') : env.CONTROL_URL === BASE) && env.PART === '1' && env.WORKER_TOKEN.length >= 40, 'the recorder gets the dashboard address and its own secret');
  check((await fetch(`${BASE}/internal/worker/job`, { headers: { Authorization: 'Bearer wrong' } })).status === 401, 'recorder endpoints reject unknown tokens');

  await waitFor('recorder A is recording', async () => (await admin.lecture(lecA.id)).status === 'recording');
  await waitFor('recorder A uploads segments to S3 while recording', async () => (await segments(lecA.id, 1)) >= 2, 60000);
  check((await admin.lecture(lecA.id)).participants === 2, 'participants are reported through the recorder');
  check((await admin.lecture(lecA.id)).bytesRecorded > 0, 'recorded size is reported');

  console.log('\nRecorder crash: a replacement rejoins');
  const lecC = await start('bbb-cccc-ddd', 'Crash test');
  await waitFor('recorder C is recording with segments in S3', async () => (await admin.lecture(lecC.id)).status === 'recording' && (await segments(lecC.id, 1)) >= 2, 120000);
  const crashAt = Date.now();
  check((await (await signal(lecC.id, 'SIGKILL')).json()).signalled, 'recorder C killed');
  await waitFor('the lost recorder is noticed and a replacement starts', async () => (await admin.lecture(lecC.id)).partCount >= 2, 60000);
  await waitFor('replacement recorder 2 is recording', async () => {
    const l = await admin.lecture(lecC.id);
    return l.status === 'recording' && /recorder 2/.test(l.detail || '') && (await segments(lecC.id, 2)) >= 1;
  }, 120000);
  const resumedAfter = Date.now() - crashAt;
  check(resumedAfter < 5 * 60_000, `recording resumed ${Math.round(resumedAfter / 1000)} s after the crash (limit 5 min)`);

  console.log('\nEnd button and the meeting ending by itself');
  await admin.post(`/api/lectures/${lecA.id}/stop`);
  const savedA = await savedLecture(lecA.id, 90000);
  check(savedA.partCount === 1 && savedA.fileSize > 0 && !savedA.detail, 'A: one part, saved, no notes');
  const lecB = await start('eee-nnnn-ddd', 'Ends by itself');
  const savedB = await savedLecture(lecB.id, 180000);
  check(savedB.partCount === 1, 'B ended by itself with one part');

  await sleep(4000);
  await admin.post(`/api/lectures/${lecC.id}/stop`);
  const savedC = await savedLecture(lecC.id, 120000);
  check(savedC.partCount === 2 && /2 recorders/.test(savedC.detail || ''), `C: saved from 2 parts ("${savedC.detail}")`);
  const missing = Number(((savedC.detail || '').match(/about ([\d.]+) min missing/) || [])[1]);
  check(missing < 5, `C: about ${missing} min missing (limit 5)`);
  if (HAS_FFMPEG) check(!/could not be joined/.test(savedC.detail), 'C: the two parts were joined into one video');
  else check(/could not be joined/.test(savedC.detail), 'C: without ffmpeg the parts are kept as separate files (nothing lost)');

  console.log('\nUpload and backup');
  for (const l of [savedA, savedB, savedC]) {
    await waitFor(`lecture ${l.id.slice(0, 8)} is on YouTube and backed up`, async () => {
      const x = await admin.lecture(l.id);
      return x.uploadStatus === 'done' && x.archiveStatus === 'done';
    }, 120000);
  }
  const videos = (await yt()).videos;
  check(videos.length >= 3 && videos.every((v) => v.bytes > 0), 'all three videos reached YouTube');
  const tasks = (await ecs()).tasks;
  check(tasks.filter((t) => [lecA.id, lecB.id, lecC.id].includes(t.lecture)).every((t) => t.status === 'STOPPED'), 'every recorder task has stopped (nothing left running to pay for)');

  console.log('\nCancel while waiting to be admitted');
  const lecL = await start('lll-oooo-bbb');
  await waitFor('recorder L is waiting in the lobby', async () => (await admin.lecture(lecL.id)).status === 'lobby');
  await admin.post(`/api/lectures/${lecL.id}/stop`);
  await waitFor('L is cancelled', async () => (await admin.lecture(lecL.id)).status === 'cancelled', 60000);

  if (POSIX) {
    console.log('\nAWS reclaims a recorder (notice): the replacement takes over first');
    const lecS = await start('fff-gggg-hhh', 'Spot');
    await waitFor('recorder S is recording', async () => (await admin.lecture(lecS.id)).status === 'recording' && (await segments(lecS.id, 1)) >= 1);
    await signal(lecS.id, 'SIGTERM');
    await waitFor('replacement S2 is recording', async () => (await segments(lecS.id, 2)) >= 1, 150000);
    await sleep(4000);
    await admin.post(`/api/lectures/${lecS.id}/stop`);
    const savedS = await savedLecture(lecS.id, 120000);
    check(savedS.partCount === 2, 'S saved from 2 parts');
    check(/about 0 min missing/.test(savedS.detail || ''), `S: nothing missing thanks to the overlap ("${savedS.detail}")`);

    console.log('\nRecorder hangs: replaced after the heartbeat timeout');
    const lecH = await start('hhh-iiii-jjj', 'Hang');
    await waitFor('recorder H is recording', async () => (await admin.lecture(lecH.id)).status === 'recording' && (await segments(lecH.id, 1)) >= 1);
    await signal(lecH.id, 'SIGSTOP');
    await waitFor('hung recorder replaced', async () => (await admin.lecture(lecH.id)).partCount >= 2, 90000);
    check(/no report for/.test(await admin.logs(lecH.id)), 'the activity log says why');
    await admin.post(`/api/lectures/${lecH.id}/stop`);
    await savedLecture(lecH.id, 180000);
  }

  if (!EXTERNAL || process.env.E2E_KILL_CMD) {
    console.log('\nDashboard restarts during a lecture: the recorder keeps going');
    const lecR = await start('ccc-dddd-eee', 'Restart');
    await waitFor('recorder R is recording', async () => (await admin.lecture(lecR.id)).status === 'recording' && (await segments(lecR.id, 1)) >= 1);
    server.kill('SIGKILL');
    await sleep(5000);
    const before = await segments(lecR.id, 1);
    check(before >= 1, 'recorder R kept uploading while the dashboard was down');
    server = startServer();
    await serverUp();
    await sleep(8000);
    const r = await admin.lecture(lecR.id);
    check(r.status === 'recording' && r.partCount === 1, 'after the restart the same recorder is still recording');
    await admin.post(`/api/lectures/${lecR.id}/stop`);
    const savedR = await savedLecture(lecR.id, 120000);
    check(savedR.partCount === 1, 'R saved in one part');
  }

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
    if (!EXTERNAL) {
      try {
        if (process.platform === 'win32') {
          execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match \'playwright|worker[\\\\/]index\' -and $_.Name -match \'msedge|chrome|node\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"', { stdio: 'ignore' });
        }
      } catch { /* nothing left */ }
    }
    if (!process.exitCode) fs.rmSync(work, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  });
