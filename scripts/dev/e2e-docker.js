/**
 * Runs the end-to-end test (e2e.js) against the real Docker image - the same image the server runs -
 * with the fake Google Meet and fake YouTube wired in.
 *
 *   docker build -t lecture-recorder:test .
 *   node scripts/dev/e2e-docker.js [image]
 *
 * Leaves nothing behind (containers, network and data volume are removed) unless E2E_KEEP=1.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { execSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');

const image = process.argv[2] || 'lecture-recorder:test';
const root = path.resolve(__dirname, '..', '..');
const devScripts = path.join(root, 'scripts', 'dev');
const APP_PORT = 3062;
const YT_PORT = 4062;
const S3_PORT = 4563;
const net = 'lr-e2e';
const password = crypto.randomBytes(12).toString('base64url');

const sh = (command, options = {}) => execSync(command, { stdio: options.quiet ? 'ignore' : 'inherit', ...options });
const tryRun = (command) => { try { sh(command, { quiet: true }); } catch { /* already gone */ } };

function cleanup() {
  if (process.env.E2E_KEEP === '1') {
    console.log('E2E_KEEP=1: containers lr-e2e-app / lr-e2e-yt / lr-e2e-s3 left running');
    return;
  }
  tryRun('docker rm -f lr-e2e-app lr-e2e-yt lr-e2e-s3');
  tryRun('docker volume rm lr-e2e-data');
  tryRun(`docker network rm ${net}`);
}

cleanup();
sh(`docker network create ${net}`, { quiet: true });

sh([
  'docker run -d --name lr-e2e-yt', `--network ${net}`, `-p ${YT_PORT}:${YT_PORT}`,
  '-e MOCK_YT_HOST=0.0.0.0', '-e MOCK_YT_FAIL_CHUNKS=2',
  `-v "${devScripts}:/dev-scripts:ro"`, '--entrypoint node', image, `/dev-scripts/mock-youtube.js ${YT_PORT}`,
].join(' '), { quiet: true });

sh([
  'docker run -d --name lr-e2e-s3', `--network ${net}`, `-p ${S3_PORT}:${S3_PORT}`, '-e MOCK_S3_HOST=0.0.0.0',
  `-v "${devScripts}:/dev-scripts:ro"`, '--entrypoint node', image, `/dev-scripts/mock-s3.js ${S3_PORT}`,
].join(' '), { quiet: true });

sh([
  'docker run -d --name lr-e2e-app', `--network ${net}`, `-p ${APP_PORT}:3000`, '--shm-size 2g',
  '-v lr-e2e-data:/app/data',
  `-v "${devScripts}:/dev-scripts:ro"`,
  // The fake Google Meet is loaded into the app process; it needs the app's node_modules
  '-e NODE_PATH=/app/node_modules', '-e NODE_OPTIONS=--require=/dev-scripts/mock-meet-preload.js',
  `-e PUBLIC_URL=http://localhost:${APP_PORT}`,
  '-e ADMIN_EMAIL=admin@test.local', `-e ADMIN_PASSWORD=${password}`,
  '-e MAX_CONCURRENT_BOTS=2', '-e MIN_UPLOAD_SECONDS=0',
  `-e YOUTUBE_API_BASE=http://lr-e2e-yt:${YT_PORT}`,
  `-e GOOGLE_OAUTH_AUTH_URL=http://127.0.0.1:${YT_PORT}/o/oauth2/v2/auth`,
  `-e GOOGLE_OAUTH_TOKEN_URL=http://lr-e2e-yt:${YT_PORT}/token`,
  '-e ARCHIVE_S3_BUCKET=lecture-backups', `-e ARCHIVE_S3_ENDPOINT=http://lr-e2e-s3:${S3_PORT}`,
  '-e ARCHIVE_S3_FORCE_PATH_STYLE=true', '-e ARCHIVE_S3_REGION=ap-south-1',
  '-e AWS_ACCESS_KEY_ID=test', '-e AWS_SECRET_ACCESS_KEY=test',
  '-e LOCAL_RETENTION_DAYS=0.00005', '-e CLEANUP_INTERVAL_SECONDS=3',
  image,
].join(' '), { quiet: true });

const result = spawnSync(process.execPath, [path.join(devScripts, 'e2e.js')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    E2E_BASE_URL: `http://localhost:${APP_PORT}`,
    E2E_ADMIN_PASSWORD: password,
    E2E_YOUTUBE_URL: `http://127.0.0.1:${YT_PORT}`,
    E2E_S3_URL: `http://127.0.0.1:${S3_PORT}`,
    E2E_KILL_CMD: 'docker kill lr-e2e-app',
    E2E_START_CMD: 'docker start lr-e2e-app',
  },
});

if (result.status !== 0) {
  console.log('\n--- app container log (last 60 lines) ---');
  tryRun('docker logs --tail 60 lr-e2e-app');
  spawnSync('docker', ['logs', '--tail', '60', 'lr-e2e-app'], { stdio: 'inherit' });
}
cleanup();
process.exit(result.status ?? 1);
