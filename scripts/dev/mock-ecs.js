/**
 * Dev/test helper - NOT used in normal operation.
 *
 * A stand-in for Amazon ECS (RunTask / DescribeTasks / StopTask, AWS JSON 1.1 protocol). Each
 * RunTask starts a recorder worker as a local process with the environment overrides from the
 * request - exactly what Fargate would run - so the dashboard's real ECS code path is exercised.
 *
 *   node scripts/dev/mock-ecs.js 4565
 *
 * The workers inherit this process's environment (S3 settings, CHROME_PATH ...). Set
 * MOCK_ECS_WORKER="node dist/worker/index.js" to run the compiled worker (default: ts-node + the
 * fake Google Meet preload).
 *
 * Test hooks:  GET /_state                               requests received and task states
 *              POST /_signal?lecture=<id>&signal=SIGKILL  crash (SIGKILL), AWS notice (SIGTERM),
 *                                                         hang (SIGSTOP) the lecture's newest worker
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const port = Number(process.argv[2]) || 4565;
const root = path.resolve(__dirname, '..', '..');
const tasks = new Map(); // arn -> { child, env, status, stoppedReason, startedAt }
const requests = [];
let counter = 0;

const workerCommand = () => {
  if (process.env.MOCK_ECS_WORKER) {
    const [cmd, ...args] = process.env.MOCK_ECS_WORKER.split(' ');
    return [cmd === 'node' ? process.execPath : cmd, args];
  }
  return [process.execPath, ['-r', './scripts/dev/mock-meet-preload.js', 'node_modules/ts-node/dist/bin.js', 'src/worker/index.ts']];
};

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString()));
});

const reply = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/x-amz-json-1.1' });
  res.end(JSON.stringify(body));
};

function runTask(input) {
  const override = input.overrides?.containerOverrides?.[0] ?? {};
  const env = Object.fromEntries((override.environment ?? []).map((e) => [e.name, e.value]));
  const arn = `arn:aws:ecs:ap-south-1:000000000000:task/mock/${(++counter).toString(16).padStart(8, '0')}`;
  const [cmd, args] = workerCommand();
  // Simulate Fargate's start-up delay a little
  const task = { env, status: 'PROVISIONING', stoppedReason: null, startedAt: Date.now(), child: null };
  tasks.set(arn, task);
  setTimeout(() => {
    if (task.status === 'STOPPED') return;
    task.child = spawn(cmd, args, { cwd: process.env.MOCK_ECS_CWD || root, env: { ...process.env, ...env, APP_ROLE: 'recorder' }, stdio: ['ignore', 'inherit', 'inherit'] });
    task.status = 'RUNNING';
    task.child.on('exit', (code, signal) => {
      task.status = 'STOPPED';
      task.stoppedReason = task.stoppedReason || (signal ? `Essential container exited (signal ${signal})` : `Essential container exited (code ${code})`);
    });
  }, Number(process.env.MOCK_ECS_START_DELAY_MS ?? 1500));
  return { tasks: [{ taskArn: arn, lastStatus: 'PROVISIONING', clusterArn: input.cluster }], failures: [] };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/_state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      requests,
      tasks: [...tasks.entries()].map(([arn, t]) => ({ arn, status: t.status, lecture: t.env.LECTURE_ID, part: t.env.PART, stoppedReason: t.stoppedReason })),
    }));
    return;
  }
  if (url.pathname === '/_signal' && req.method === 'POST') {
    const lecture = url.searchParams.get('lecture');
    const signal = url.searchParams.get('signal') || 'SIGKILL';
    const match = [...tasks.values()].filter((t) => t.env.LECTURE_ID === lecture && t.child && t.status === 'RUNNING').pop();
    if (match) {
      if (signal === 'SIGKILL') match.stoppedReason = 'Simulated crash';
      match.child.kill(signal);
    }
    res.writeHead(match ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ signalled: Boolean(match) }));
    return;
  }

  const body = await readBody(req);
  const target = String(req.headers['x-amz-target'] || '').split('.').pop();
  let input = {};
  try { input = JSON.parse(body || '{}'); } catch { /* empty */ }
  requests.push({ action: target, input });

  if (target === 'RunTask') {
    reply(res, 200, runTask(input));
  } else if (target === 'DescribeTasks') {
    const found = [];
    const failures = [];
    for (const arn of input.tasks ?? []) {
      const task = tasks.get(arn);
      if (task) found.push({ taskArn: arn, lastStatus: task.status, stoppedReason: task.stoppedReason ?? undefined });
      else failures.push({ arn, reason: 'MISSING' });
    }
    reply(res, 200, { tasks: found, failures });
  } else if (target === 'StopTask') {
    const task = tasks.get(input.task);
    if (task) {
      task.stoppedReason = input.reason || 'Stopped by user';
      if (task.child && task.status === 'RUNNING') task.child.kill('SIGKILL');
      task.status = 'STOPPED';
    }
    reply(res, 200, { task: { taskArn: input.task, lastStatus: 'STOPPED' } });
  } else {
    reply(res, 400, { __type: 'InvalidParameterException', message: `Mock ECS has no ${target}` });
  }
});

const bindHost = process.env.MOCK_ECS_HOST || '127.0.0.1';
server.listen(port, bindHost, () => console.log(`[mock-ecs] listening on http://${bindHost}:${port}`));
process.on('SIGTERM', () => { for (const t of tasks.values()) t.child?.kill('SIGKILL'); process.exit(0); });
