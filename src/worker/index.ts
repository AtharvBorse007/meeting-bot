/**
 * Recorder worker: records ONE lecture (one "part") and exits. Runs as an AWS Fargate task, or as a
 * local process in development. Everything it needs comes from the dashboard:
 *
 *   env  CONTROL_URL   the dashboard (e.g. https://recorder.example.com)
 *        WORKER_TOKEN  secret for this part only
 *        ARCHIVE_S3_*  where to upload the recording segments
 *
 * While recording it uploads a segment to S3 every RECORDER_SEGMENT_SECONDS and reports to the
 * dashboard every few seconds (status, people in the call, logs); the reply says whether End was
 * pressed. When AWS stops the task (Spot reclaim, maintenance - SIGTERM with ~2 minutes' notice) it
 * tells the dashboard at once, so a replacement can join, and keeps recording until that replacement
 * is in the meeting.
 */
import os from 'os';
import { GoogleMeetBot } from '../bots/GoogleMeetBot';
import { BotReporter, RecordingRules } from '../bots/AbstractMeetBot';
import { MeetingCancelledError } from '../error';
import { createLectureLogger, describeFailure, LectureLogEntry } from '../lectures/shared';
import { SegmentUploader } from './SegmentUploader';

interface Job {
  lectureId: string;
  part: number;
  url: string;
  botName: string;
  rules: RecordingRules;
  segmentSeconds: number;
  heartbeatSeconds: number;
  stop: boolean;
}

interface HeartbeatReply {
  stop: boolean;
  /** A replacement is recording, so an interrupted worker can leave now */
  handoverDone: boolean;
}

const CONTROL_URL = (process.env.CONTROL_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.WORKER_TOKEN || '';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(`${CONTROL_URL}/internal/worker${path}`, {
        method,
        headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      const json = await response.json().catch(() => ({})) as { success?: boolean; data?: T; error?: string };
      if (response.status === 401 || response.status === 404) throw Object.assign(new Error(json.error || 'Unknown recorder'), { fatal: true });
      if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
      return json.data as T;
    } catch (error) {
      lastError = error;
      if ((error as { fatal?: boolean }).fatal) break;
      if (attempt < attempts) await sleep(Math.min(10_000, 1000 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function main(): Promise<number> {
  if (!CONTROL_URL || !TOKEN) {
    console.error('CONTROL_URL and WORKER_TOKEN must be set.');
    return 2;
  }

  // The dashboard may be restarting: keep asking for the job for a few minutes
  const job = await call<Job>('GET', '/job', undefined, 12);
  if (job.stop) {
    await call('POST', '/finished', { result: 'cancelled', error: null, segments: 0, bytes: 0 }).catch(() => undefined);
    return 0;
  }

  const logs: LectureLogEntry[] = [];
  const log = (entry: LectureLogEntry) => {
    logs.push(entry);
    if (logs.length > 200) logs.splice(0, logs.length - 200);
  };
  const logger = createLectureLogger(`${job.lectureId.slice(0, 8)}#${job.part}`, log);
  logger.info(`Recorder part ${job.part} started on ${os.hostname()} (${os.cpus().length} CPU, ${Math.round(os.totalmem() / 1024 ** 3)} GB)`);

  const uploader = new SegmentUploader(job.lectureId, job.part, job.segmentSeconds, (message) => logger.warn(message));
  const state = {
    phase: 'launching' as string,
    detail: 'Starting the browser' as string | null,
    participants: null as number | null,
    recordingStartedAt: null as number | null,
    interrupted: false,
    stopRequested: false,
  };

  const bot = new GoogleMeetBot(logger, `${job.lectureId}-${job.part}`);
  const reporter: BotReporter = {
    phase: (phase, detail) => {
      state.phase = phase;
      state.detail = detail ?? null;
      if (phase === 'recording' && !state.recordingStartedAt) state.recordingStartedAt = Date.now();
    },
    participants: (count) => {
      state.participants = count;
    },
  };

  let interruptDeadline: number | null = null;
  const requestStop = (reason: string) => {
    if (state.stopRequested) return;
    state.stopRequested = true;
    logger.info(`Leaving the meeting (${reason})`);
    bot.stop().catch(() => undefined);
  };

  const heartbeat = async () => {
    const reply = await call<HeartbeatReply>('POST', '/heartbeat', {
      phase: state.phase,
      detail: state.detail,
      participants: state.participants,
      recordingStartedAt: state.recordingStartedAt,
      receivedBytes: uploader.receivedBytes,
      uploadedBytes: uploader.uploadedBytes,
      segments: uploader.uploadedSegments,
      lastSegmentAt: uploader.lastUploadAt,
      interrupted: state.interrupted,
      // Load per CPU: above ~1.5 the recorder is overloaded and the video may stutter
      load: os.loadavg()[0] / Math.max(1, os.cpus().length),
      logs: logs.splice(0, logs.length),
    }, 1);
    if (reply?.stop) requestStop('End was pressed');
    if (state.interrupted && (reply?.handoverDone || (interruptDeadline && Date.now() > interruptDeadline))) {
      requestStop(reply?.handoverDone ? 'the replacement recorder has taken over' : 'the server is being shut down');
    }
  };
  const beat = setInterval(() => { heartbeat().catch(() => undefined); }, job.heartbeatSeconds * 1000);

  // AWS stops a task with SIGTERM and kills it ~2 minutes later: hand over to a replacement
  const onTerminate = () => {
    if (state.interrupted) return;
    state.interrupted = true;
    interruptDeadline = Date.now() + 100_000;
    logger.warn('This recorder is being shut down by AWS; a replacement is joining (recording continues meanwhile)');
    heartbeat().catch(() => undefined);
  };
  process.on('SIGTERM', onTerminate);
  process.on('SIGINT', onTerminate);

  let result: string;
  let error: string | null = null;
  try {
    await bot.join({
      url: job.url,
      name: job.botName,
      bearerToken: 'worker',
      teamId: 'worker',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      userId: 'worker',
      botId: `${job.lectureId}-${job.part}`,
      uploader,
      reporter,
      rules: job.rules,
    });
    result = state.interrupted ? 'interrupted'
      : state.stopRequested ? 'stopped'
      : bot.browserClosedUnexpectedly ? 'crashed' // the meeting goes on: a replacement rejoins
      : 'ended';
    if (result === 'crashed') error = 'The recorder browser closed unexpectedly.';
  } catch (failure) {
    if (failure instanceof MeetingCancelledError) {
      result = 'cancelled';
    } else if (state.recordingStartedAt) {
      result = state.interrupted ? 'interrupted' : 'crashed';
      error = describeFailure(failure);
    } else {
      result = state.stopRequested ? 'cancelled' : 'join-failed';
      error = describeFailure(failure);
    }
  }

  const complete = await uploader.flush();
  uploader.close();
  clearInterval(beat);
  if (!complete) logger.error(`Some recording segments could not be uploaded: ${uploader.lastError ?? 'unknown error'}`);
  logger.info(`Recorder part ${job.part} finished: ${result}${error ? ` (${error})` : ''}`);

  await call('POST', '/finished', {
    result,
    error,
    segments: uploader.uploadedSegments,
    bytes: uploader.uploadedBytes,
    durationSeconds: uploader.durationSeconds ?? null,
    recordingStartedAt: state.recordingStartedAt,
    logs: logs.splice(0, logs.length),
  }, 8).catch((reportError) => console.error('Could not report the result:', reportError?.message ?? reportError));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('Recorder worker failed:', error?.message ?? error);
    process.exit(1);
  });
