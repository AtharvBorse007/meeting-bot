/**
 * Runs e2e-remote.js (the pay-per-use design) against the real Docker image: the dashboard
 * container in RECORDER_MODE=ecs, a fake ECS container that runs each recorder "task" with the
 * image's own worker (dist/worker/index.js, real Chromium, Xvfb, PulseAudio, ffmpeg), and fake
 * S3 / YouTube containers.
 *
 *   docker build -t lecture-recorder:test .
 *   node scripts/dev/e2e-docker-remote.js [image]
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { execSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');

const image = process.argv[2] || 'lecture-recorder:test';
const devScripts = path.join(path.resolve(__dirname, '..', '..'), 'scripts', 'dev');
const net = 'lr-remote';
const PORTS = { app: 3072, yt: 4072, s3: 4574, ecs: 4576 };
const password = crypto.randomBytes(12).toString('base64url');
const names = ['lr-r-app', 'lr-r-yt', 'lr-r-s3', 'lr-r-ecs'];

const sh = (command) => execSync(command, { stdio: 'ignore' });
const tryRun = (command) => { try { sh(command); } catch { /* already gone */ } };
const cleanup = () => {
  if (process.env.E2E_KEEP === '1') return;
  tryRun(`docker rm -f ${names.join(' ')}`);
  tryRun('docker volume rm lr-r-data');
  tryRun(`docker network rm ${net}`);
};

const s3Env = [
  '-e ARCHIVE_S3_BUCKET=lecture-backups', `-e ARCHIVE_S3_ENDPOINT=http://lr-r-s3:${PORTS.s3}`,
  '-e ARCHIVE_S3_FORCE_PATH_STYLE=true', '-e ARCHIVE_S3_REGION=ap-south-1',
  '-e AWS_ACCESS_KEY_ID=test', '-e AWS_SECRET_ACCESS_KEY=test',
  '-e RECORDER_SEGMENT_SECONDS=4', '-e RECORDER_HEARTBEAT_SECONDS=2',
];
const mount = `-v "${devScripts}:/dev-scripts:ro"`;

cleanup();
sh(`docker network create ${net}`);
sh(`docker run -d --name lr-r-yt --network ${net} -p ${PORTS.yt}:${PORTS.yt} -e MOCK_YT_HOST=0.0.0.0 ${mount} --entrypoint node ${image} /dev-scripts/mock-youtube.js ${PORTS.yt}`);
sh(`docker run -d --name lr-r-s3 --network ${net} -p ${PORTS.s3}:${PORTS.s3} -e MOCK_S3_HOST=0.0.0.0 ${mount} --entrypoint node ${image} /dev-scripts/mock-s3.js ${PORTS.s3}`);
// The fake ECS runs recorder "tasks" with the image's worker; APP_ROLE=recorder gives it the virtual screen and audio
sh([
  `docker run -d --name lr-r-ecs --network ${net} -p ${PORTS.ecs}:${PORTS.ecs} --shm-size 2g`, mount,
  '-e APP_ROLE=recorder', '-e MOCK_ECS_HOST=0.0.0.0', '-e MOCK_ECS_CWD=/app', '-e "MOCK_ECS_WORKER=node dist/worker/index.js"',
  '-e NODE_PATH=/app/node_modules', '-e NODE_OPTIONS=--require=/dev-scripts/mock-meet-preload.js',
  ...s3Env, image, 'node', `/dev-scripts/mock-ecs.js ${PORTS.ecs}`,
].join(' '));
sh([
  `docker run -d --name lr-r-app --network ${net} -p ${PORTS.app}:3000 -v lr-r-data:/app/data`,
  `-e PUBLIC_URL=http://localhost:${PORTS.app}`, '-e CONTROL_URL=http://lr-r-app:3000',
  '-e ADMIN_EMAIL=admin@test.local', `-e ADMIN_PASSWORD=${password}`,
  '-e MIN_UPLOAD_SECONDS=0', '-e MAX_CONCURRENT_BOTS=6', '-e RECORDER_HEARTBEAT_TIMEOUT_SECONDS=12',
  '-e RECORDER_MODE=ecs', `-e ECS_ENDPOINT=http://lr-r-ecs:${PORTS.ecs}`, '-e ECS_CLUSTER=lecture-recorder',
  '-e ECS_TASK_DEFINITION=lecture-recorder-task', '-e ECS_SUBNETS=subnet-aaa,subnet-bbb', '-e ECS_SECURITY_GROUPS=sg-recorder',
  '-e YOUTUBE_CLIENT_ID=test-client.apps.googleusercontent.com', '-e YOUTUBE_CLIENT_SECRET=test-secret-1234',
  `-e YOUTUBE_API_BASE=http://lr-r-yt:${PORTS.yt}`, `-e GOOGLE_OAUTH_AUTH_URL=http://127.0.0.1:${PORTS.yt}/o/oauth2/v2/auth`,
  `-e GOOGLE_OAUTH_TOKEN_URL=http://lr-r-yt:${PORTS.yt}/token`,
  ...s3Env, image,
].join(' '));

const result = spawnSync(process.execPath, [path.join(devScripts, 'e2e-remote.js')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    E2E_BASE_URL: `http://localhost:${PORTS.app}`,
    E2E_ADMIN_PASSWORD: password,
    E2E_YOUTUBE_URL: `http://127.0.0.1:${PORTS.yt}`,
    E2E_S3_URL: `http://127.0.0.1:${PORTS.s3}`,
    E2E_ECS_URL: `http://127.0.0.1:${PORTS.ecs}`,
    E2E_KILL_CMD: 'docker kill lr-r-app',
    E2E_START_CMD: 'docker start lr-r-app',
    E2E_POSIX_SIGNALS: '1',
    E2E_HAS_FFMPEG: '1',
  },
});
if (result.status !== 0) {
  for (const name of ['lr-r-app', 'lr-r-ecs']) {
    console.log(`\n--- ${name} (last 40 lines) ---`);
    spawnSync('docker', ['logs', '--tail', '40', name], { stdio: 'inherit' });
  }
}
cleanup();
process.exit(result.status ?? 1);
