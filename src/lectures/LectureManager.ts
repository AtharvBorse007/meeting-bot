import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import config from '../config';
import { HttpError } from '../auth';
import { globalJobStore } from '../lib/globalJobStore';
import { GoogleMeetBot } from '../bots/GoogleMeetBot';
import { BotReporter } from '../bots/AbstractMeetBot';
import DiskUploader, { IUploader } from '../middleware/disk-uploader';
import { MeetingCancelledError, RecordingUploadFailedError } from '../error';
import { encodeFileNameSafebase64 } from '../util/strings';
import { User } from '../db/users';
import { listSubjectsForUser } from '../db/subjects';
import {
  getLecture, insertLecture, isFinal, Lecture, LecturePatch, listUnfinishedLectures, updateLecture,
} from '../db/lectures';
import { isStopRequested, listParts, setStopRequested } from '../db/parts';
import { normalizeMeetingUrl } from './meetingUrl';
import { archiveEnabled } from '../archive/s3';
import { createLectureLogger, describeFailure, lectureRules, LectureLogEntry, safeFileName } from './shared';
import { RemoteRecorders } from '../recorders/RemoteRecorders';

export type { LectureLogEntry } from './shared';

/**
 * Runs the recorders. One lecture = one recorder (a browser in the meeting). Depending on
 * RECORDER_MODE the browsers run inside this server (inprocess) or as separate workers started per
 * lecture (ecs: AWS Fargate tasks; process: local processes) - see RemoteRecorders. Every state
 * change is written to the database and published as an event, so the dashboards update live and
 * nothing is lost when the server restarts.
 */

/** A lecture as the dashboard sees it: the stored row plus what is only known while it runs. */
export interface LectureView extends Lecture {
  participants: number | null;
  stopping: boolean;
  /** 0..1 while the recording is being sent to YouTube. */
  uploadProgress: number | null;
  youtubeUrl: string | null;
  playlistUrl: string | null;
  localFileAvailable: boolean;
  /** A copy is in the S3 backup and can be downloaded right away. */
  backupAvailable: boolean;
  /** The S3 copy has moved to Glacier Deep Archive: it has to be restored before it can be downloaded. */
  backupInDeepArchive: boolean;
}

interface LiveState {
  instructorId: number;
  bot?: GoogleMeetBot;
  release?: () => void;
  slot: number;
  participants: number | null;
  stopping: boolean;
  bytesRecorded: number;
  logs: LectureLogEntry[];
}

const LOCAL_USER = 'local';
const MAX_LOG_ENTRIES = 300;
const remoteMode = () => config.recorderMode !== 'inprocess';

/** Wraps the real uploader to count the bytes the recorder has delivered so far. */
class TrackingUploader implements IUploader {
  constructor(private readonly inner: IUploader, private readonly onData: (bytes: number) => void) {}

  saveDataToTempFile(data: Buffer) {
    this.onData(data.length);
    return this.inner.saveDataToTempFile(data);
  }

  uploadRecordingToRemoteStorage(options?: { forceUpload?: boolean }) {
    return this.inner.uploadRecordingToRemoteStorage(options);
  }

  setRecordingDuration(durationSeconds: number) {
    this.inner.setRecordingDuration(durationSeconds);
  }

  getSavedRecordingPath() {
    return this.inner.getSavedRecordingPath?.();
  }
}

const tempFileFor = (lectureId: string) => path.join(
  config.tempVideoDir, LOCAL_USER,
  `${encodeFileNameSafebase64(`${LOCAL_USER}${lectureId}0`)}${config.uploaderFileExtension}`,
);

/** Free space where recordings are written, or null if it can't be read. */
export const freeDiskBytes = (): number | null => {
  try {
    fs.mkdirSync(config.recordingsDir, { recursive: true });
    const stats = fs.statfsSync(config.recordingsDir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
};

export class LectureManager extends EventEmitter {
  private live = new Map<string, LiveState>();
  private uploadProgress = new Map<string, number>();
  private pending = new Map<string, NodeJS.Timeout>(); // throttled publishes
  private running = new Set<Promise<void>>();

  /** Recorders outside this server (RECORDER_MODE=ecs/process). */
  readonly remote = new RemoteRecorders({
    setStatus: (id, patch) => this.setStatus(id, patch),
    update: (id, patch) => this.update(id, patch),
    addLog: (id, level, message) => this.addLog(id, level, message),
    setParticipants: (id, count, bytes) => {
      const live = this.live.get(id);
      if (!live) return;
      live.participants = count;
      live.bytesRecorded = bytes;
      this.publishThrottled(id);
    },
    done: (id) => {
      const pending = this.pending.get(id);
      if (pending) clearTimeout(pending);
      this.pending.delete(id);
      this.live.delete(id);
      this.publish(id);
      this.emit('finished', id);
    },
  });

  /** Called once at start-up, after recoverAfterRestart(). */
  startEngine(): void {
    if (!remoteMode()) return;
    const problem = this.remote.problem();
    if (problem) console.error(`Recorders can't start: ${problem}`);
    console.log(`Recorders run ${config.recorderMode === 'ecs' ? 'as AWS Fargate tasks, one per lecture' : 'as local worker processes'}.`);
    this.remote.start();
  }

  // ---------------------------------------------------------------- queries

  view(lecture: Lecture): LectureView {
    const live = this.live.get(lecture.id);
    const archived = lecture.archiveStatus === 'done' && Boolean(lecture.archiveKey);
    const deep = archived && config.archive.deepArchiveDays > 0 && Boolean(lecture.archivedAt)
      && Date.now() - (lecture.archivedAt as number) > config.archive.deepArchiveDays * 24 * 60 * 60 * 1000;
    return {
      ...lecture,
      bytesRecorded: live ? live.bytesRecorded : lecture.bytesRecorded,
      participants: live?.participants ?? null,
      stopping: live?.stopping ?? false,
      uploadProgress: this.uploadProgress.get(lecture.id) ?? null,
      youtubeUrl: lecture.youtubeVideoId ? `https://www.youtube.com/watch?v=${lecture.youtubeVideoId}` : null,
      playlistUrl: lecture.playlistId ? `https://www.youtube.com/playlist?list=${lecture.playlistId}` : null,
      localFileAvailable: Boolean(lecture.fileName && !lecture.localDeletedAt),
      backupAvailable: archived && !deep,
      backupInDeepArchive: deep,
    };
  }

  /** Throws unless the lecture exists and this user may see it (its instructor, or the admin). */
  getFor(user: User, id: string): Lecture {
    const lecture = getLecture(id);
    if (!lecture || (user.role !== 'admin' && lecture.instructorId !== user.id)) {
      throw new HttpError(404, 'Lecture not found.');
    }
    return lecture;
  }

  logsFor(id: string): LectureLogEntry[] {
    const live = this.live.get(id);
    if (live) return live.logs.slice(-150);
    try {
      return fs.readFileSync(path.join(config.lectureLogsDir, `${id}.log`), 'utf8')
        .split('\n').filter(Boolean).slice(-150)
        .map((line) => JSON.parse(line) as LectureLogEntry);
    } catch {
      return [];
    }
  }

  counts() {
    return { active: this.live.size, capacity: config.maxConcurrentBots };
  }

  recordingPath(lecture: Lecture): string | null {
    if (!lecture.fileName || lecture.localDeletedAt) return null;
    const file = path.join(config.recordingsDir, lecture.fileName);
    return fs.existsSync(file) ? file : null;
  }

  // --------------------------------------------------------------- commands

  /** Start a recorder for a meeting. Refuses (rather than queues) when the limit is reached. */
  create(user: User, input: { url: unknown; subjectId: unknown; topic?: unknown }): LectureView {
    const { url, code } = normalizeMeetingUrl(input.url);

    const subject = listSubjectsForUser(user).find((s) => s.id === Number(input.subjectId));
    if (!subject) {
      throw new HttpError(400, 'Choose one of your subjects first.');
    }
    const topic = typeof input.topic === 'string' ? input.topic.replace(/\s+/g, ' ').trim().slice(0, 80) : '';

    const unfinished = listUnfinishedLectures();
    if (unfinished.some((lecture) => lecture.meetingCode === code)) {
      throw new HttpError(409, `The recorder is already in meeting ${code}.`);
    }

    const free = freeDiskBytes();
    if (free !== null && free < (config.lowDiskGb / 4) * 1024 ** 3) {
      throw new HttpError(507, 'The server is almost out of disk space, so a new recording could not be started. Ask the admin.');
    }

    let release: (() => void) | undefined;
    if (remoteMode()) {
      const problem = this.remote.problem();
      if (problem) throw new HttpError(503, `Recording is not set up correctly: ${problem}`);
      if (globalJobStore.isShutdownRequested()) throw new HttpError(503, 'The server is shutting down.');
      if (unfinished.length >= config.maxConcurrentBots) {
        throw new HttpError(409, `${config.maxConcurrentBots} lectures are already being recorded (the configured limit). Ask the admin to raise MAX_CONCURRENT_BOTS.`);
      }
    } else {
      release = globalJobStore.tryAcquire() ?? undefined;
      if (!release) {
        if (globalJobStore.isShutdownRequested()) throw new HttpError(503, 'The server is shutting down.');
        throw new HttpError(409,
          `All ${config.maxConcurrentBots} recorders are busy with other lectures. Try again in a few minutes, or ask the admin.`);
      }
    }

    let lecture: Lecture;
    try {
      lecture = insertLecture({
        id: uuidv4(),
        instructorId: user.id,
        subjectId: subject.id,
        topic: topic || null,
        url,
        meetingCode: code,
        botName: config.botName,
        status: 'launching',
        detail: remoteMode() ? 'Starting a recorder (about 1–2 minutes)' : 'Starting the browser',
      });
    } catch (error) {
      release?.();
      throw error;
    }

    const used = new Set([...this.live.values()].map((l) => l.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    this.live.set(lecture.id, { instructorId: user.id, release, slot, participants: null, stopping: false, bytesRecorded: 0, logs: [] });
    this.addLog(lecture.id, 'info', `Started by ${user.name} for ${subject.name}`);
    this.publish(lecture.id);

    if (remoteMode()) {
      this.remote.startLecture(lecture.id).catch((error) => this.addLog(lecture.id, 'error', `Could not start a recorder: ${error?.message ?? error}`));
      return this.view(lecture);
    }

    const job = this.run(lecture)
      .catch((error) => this.addLog(lecture.id, 'error', `Unexpected error: ${error?.message ?? error}`))
      .finally(() => {
        const live = this.live.get(lecture.id);
        live?.release?.();
        this.live.delete(lecture.id);
        this.running.delete(job);
        this.publish(lecture.id);
        this.emit('finished', lecture.id);
      });
    this.running.add(job);

    return this.view(lecture);
  }

  /** Make the recorder leave. A running recording is stopped and saved; one that is still joining is cancelled. */
  stop(user: User, id: string): LectureView {
    const lecture = this.getFor(user, id);
    const live = this.live.get(id);
    if (isFinal(lecture.status) || !live || lecture.status === 'saving') throw new HttpError(409, 'This lecture has already ended.');
    if (live.stopping) return this.view(lecture);

    live.stopping = true;
    this.addLog(id, 'info', `${user.name} pressed End - ${lecture.status === 'recording' ? 'saving the recording' : 'cancelling'}`);
    this.publish(id);
    if (remoteMode() || listParts(id).length > 0) {
      setStopRequested(id);
      this.remote.onStopRequested(id).catch(() => undefined);
    } else {
      // The bot may not exist yet (still preparing); run() checks the flag as soon as it does
      live.bot?.stop().catch((error) => this.addLog(id, 'error', `Stop failed: ${error?.message ?? error}`));
    }
    return this.view(getLecture(id) as Lecture);
  }

  /** Change a stored lecture and tell the dashboards (used by the uploaders). */
  update(id: string, patch: LecturePatch, uploadProgress?: number | null): void {
    updateLecture(id, patch);
    if (uploadProgress === null) this.uploadProgress.delete(id);
    else if (uploadProgress !== undefined) this.uploadProgress.set(id, uploadProgress);
    this.publish(id);
  }

  setUploadProgress(id: string, fraction: number): void {
    this.uploadProgress.set(id, fraction);
    this.publishThrottled(id);
  }

  note(id: string, level: LectureLogEntry['level'], message: string): void {
    this.addLog(id, level, message);
  }

  /**
   * Server shutdown. Browsers inside this server are stopped and their recordings saved (bounded
   * wait). Remote recorders are left alone: they keep recording and report again after the restart.
   */
  async shutdown(timeoutMs = 90_000): Promise<void> {
    this.remote.stop();
    for (const [id, live] of this.live) {
      if (!live.bot && remoteMode()) continue;
      if (live.stopping) continue;
      live.stopping = true;
      this.addLog(id, 'info', 'The server is shutting down - saving the recording');
      this.publish(id);
      live.bot?.stop().catch(() => undefined);
    }
    await Promise.race([
      Promise.allSettled([...this.running]),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
  }

  /**
   * Called once at start-up. Remote recorders carry on and are picked up again. A browser that ran
   * inside this server can't be resumed, but what it had recorded is still in the temp file: keep it
   * and queue it for upload.
   */
  recoverAfterRestart(): void {
    for (const lecture of listUnfinishedLectures()) {
      if (remoteMode() || listParts(lecture.id).length > 0) {
        this.live.set(lecture.id, {
          instructorId: lecture.instructorId, slot: 0, participants: null,
          stopping: isStopRequested(lecture.id), bytesRecorded: lecture.bytesRecorded, logs: [],
        });
        this.addLog(lecture.id, 'info', 'Dashboard restarted; the recorder keeps going');
        this.remote.resume(lecture);
        continue;
      }

      const temp = tempFileFor(lecture.id);
      let patch: LecturePatch;
      try {
        const size = fs.existsSync(temp) ? fs.statSync(temp).size : 0;
        if (size === 0) throw new Error('nothing recorded');

        fs.mkdirSync(config.recordingsDir, { recursive: true });
        const fileName = safeFileName(
          `${lecture.subjectName} - ${lecture.meetingCode ?? 'meeting'} - recovered ${lecture.id.slice(0, 8)}${config.uploaderFileExtension}`);
        fs.renameSync(temp, path.join(config.recordingsDir, fileName));
        patch = {
          status: 'saved',
          detail: null,
          error: 'The server restarted during this lecture. The part recorded before the restart was saved.',
          endedAt: Date.now(),
          bytesRecorded: size,
          fileName,
          fileSize: size,
          uploadStatus: 'pending',
          archiveStatus: archiveEnabled() ? 'pending' : 'none',
        };
      } catch {
        patch = {
          status: lecture.recordingStartedAt ? 'failed' : 'cancelled',
          detail: null,
          error: 'The server restarted before this lecture could be recorded.',
          endedAt: Date.now(),
        };
      }
      updateLecture(lecture.id, patch);
      this.appendLogFile(lecture.id, { t: Date.now(), level: 'warn', message: `Server restart: ${patch.error}` });
    }
  }

  // ------------------------------------------------- in-process recording

  private async run(lecture: Lecture): Promise<void> {
    const id = lecture.id;
    const live = this.live.get(id) as LiveState;
    const logger = createLectureLogger(lecture.meetingCode ?? id.slice(0, 8), (entry) => this.addLog(id, entry.level, entry.message));
    let uploader: TrackingUploader | undefined;
    let recordingStartedAt: number | undefined;

    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const tempFileId = encodeFileNameSafebase64(`${LOCAL_USER}${id}0`);
      const inner = await DiskUploader.initialize(
        'local', 'local', timezone, LOCAL_USER, id,
        safeFileName(lecture.subjectName), tempFileId, logger, lecture.url,
      );
      uploader = new TrackingUploader(inner, (bytes) => {
        live.bytesRecorded += bytes;
        this.publishThrottled(id);
      });

      const reporter: BotReporter = {
        phase: (phase, detail) => {
          const patch: LecturePatch = { status: phase, detail: detail ?? null };
          if (phase === 'recording') {
            recordingStartedAt = Date.now();
            patch.recordingStartedAt = recordingStartedAt;
          }
          this.setStatus(id, patch);
        },
        participants: (count) => {
          live.participants = count;
          this.publishThrottled(id);
        },
      };

      const bot = new GoogleMeetBot(logger, id);
      live.bot = bot;
      if (live.stopping) throw new MeetingCancelledError();

      await bot.join({
        url: lecture.url,
        name: lecture.botName,
        bearerToken: 'local',
        teamId: 'local',
        timezone,
        userId: LOCAL_USER,
        botId: id,
        uploader,
        reporter,
        windowSlot: live.slot,
        rules: lectureRules(),
      });

      this.finish(id, uploader, recordingStartedAt, null);
    } catch (error) {
      if (error instanceof MeetingCancelledError) {
        this.finish(id, uploader, recordingStartedAt, null, true);
        return;
      }
      const message = error instanceof RecordingUploadFailedError && live.bytesRecorded === 0
        ? 'The recorder joined, but the meeting window closed before anything was captured. Start it again.'
        : describeFailure(error);
      logger.error(`Lecture failed: ${message}`, { error });
      this.finish(id, uploader, recordingStartedAt, message);
    }
  }

  private finish(
    id: string, uploader: TrackingUploader | undefined, recordingStartedAt: number | undefined,
    problem: string | null, cancelled = false,
  ) {
    const live = this.live.get(id);
    const now = Date.now();
    const pending = this.pending.get(id);
    if (pending) {
      clearTimeout(pending);
      this.pending.delete(id);
    }

    let saved: { fileName: string; fileSize: number } | undefined;
    const file = uploader?.getSavedRecordingPath();
    if (file) {
      try {
        saved = { fileName: path.relative(config.recordingsDir, file).split(path.sep).join('/'), fileSize: fs.statSync(file).size };
      } catch {
        saved = undefined;
      }
    }

    let patch: LecturePatch;
    if (saved) {
      const seconds = recordingStartedAt ? Math.round((now - recordingStartedAt) / 1000) : 0;
      const tooShort = seconds < config.minUploadSeconds;
      patch = {
        status: 'saved',
        detail: tooShort
          ? `Under ${config.minUploadSeconds} seconds long, so it was not sent to YouTube. The file is kept on the server.`
          : null,
        error: problem ? `${problem} The part that was recorded has been saved.` : null,
        endedAt: now,
        bytesRecorded: live?.bytesRecorded ?? saved.fileSize,
        ...saved,
        uploadStatus: tooShort ? 'none' : 'pending',
        // Every saved recording is backed up, even ones too short for YouTube
        archiveStatus: archiveEnabled() ? 'pending' : 'none',
      };
      this.addLog(id, problem ? 'warn' : 'info', `Recording saved (${Math.round(saved.fileSize / 1024 / 1024 * 10) / 10} MB)`);
    } else if (cancelled || (live?.stopping && (!problem || live.bytesRecorded === 0))) {
      patch = { status: 'cancelled', detail: 'Stopped before the recording started.', error: null, endedAt: now };
      this.addLog(id, 'info', 'Cancelled');
    } else {
      patch = { status: 'failed', detail: null, error: problem ?? 'The recording could not be saved.', endedAt: now };
      this.addLog(id, 'error', `Failed: ${patch.error}`);
    }
    updateLecture(id, patch);
    this.publish(id);
  }

  // ---------------------------------------------------------------- plumbing

  private setStatus(id: string, patch: LecturePatch) {
    const current = getLecture(id);
    if (!current || isFinal(current.status)) return;
    updateLecture(id, patch);
    this.publish(id);
  }

  private addLog(id: string, level: LectureLogEntry['level'], message: string) {
    const entry: LectureLogEntry = { t: Date.now(), level, message };
    const live = this.live.get(id);
    if (live) {
      live.logs.push(entry);
      if (live.logs.length > MAX_LOG_ENTRIES) live.logs.splice(0, live.logs.length - MAX_LOG_ENTRIES);
    }
    this.appendLogFile(id, entry);
    const instructorId = live?.instructorId ?? getLecture(id)?.instructorId;
    if (instructorId !== undefined) this.emit('log', { id, instructorId, entry });
  }

  private appendLogFile(id: string, entry: LectureLogEntry) {
    try {
      fs.mkdirSync(config.lectureLogsDir, { recursive: true });
      fs.appendFileSync(path.join(config.lectureLogsDir, `${id}.log`), `${JSON.stringify(entry)}\n`);
    } catch {
      // the log file is a convenience; never let it break a recording
    }
  }

  private publish(id: string) {
    const timer = this.pending.get(id);
    if (timer) {
      clearTimeout(timer);
      this.pending.delete(id);
    }
    const lecture = getLecture(id);
    if (lecture) this.emit('lecture', this.view(lecture));
  }

  /** For high-frequency changes (recorded bytes, participants, upload progress): at most one update per second. */
  private publishThrottled(id: string) {
    if (this.pending.has(id)) return;
    this.pending.set(id, setTimeout(() => {
      this.pending.delete(id);
      const live = this.live.get(id);
      if (live) updateLecture(id, { bytesRecorded: live.bytesRecorded });
      const lecture = getLecture(id);
      if (lecture) this.emit('lecture', this.view(lecture));
    }, 1000));
  }
}

export const lectureManager = new LectureManager();
