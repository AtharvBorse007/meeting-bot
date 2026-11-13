import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import moment from 'moment-timezone';
import config from '../config';
import { getLecture, isFinal, Lecture, LecturePatch, listUnfinishedLectures } from '../db/lectures';
import {
  getPart, getPartByToken, insertPart, isStopRequested, LecturePart, listParts, PartResult, updatePart,
} from '../db/parts';
import { appendObjectTo, archiveEnabled, listKeys, segmentPrefix } from '../archive/s3';
import { writeWebmDurationMetadata } from '../lib/webmDuration';
import { lectureRules, LectureLogEntry, safeFileName } from '../lectures/shared';
import { getLauncher } from './launchers';

/**
 * Runs lecture recorders OUTSIDE the dashboard server (RECORDER_MODE=ecs or process):
 *
 *   - Join starts one worker for the lecture (an AWS Fargate task: paid only while it runs).
 *   - The worker reports every few seconds and uploads its recording to S3 every 30 seconds.
 *   - If a worker crashes, disappears or stops reporting, a replacement rejoins the meeting and
 *     records the next part. When AWS gives notice (Spot), the replacement starts while the old
 *     worker is still recording, so nothing is missed.
 *   - When the lecture is over, the parts are downloaded from S3, joined into one video, and handed
 *     to the normal YouTube upload and backup.
 *
 * The state lives in the database (lecture_parts), so a dashboard restart doesn't disturb the
 * recorders: they keep going and are picked up again.
 */

const execFileAsync = promisify(execFile);
const WATCHDOG_MS = 10_000;
const TASK_CHECK_MS = 30_000;

export interface RemoteHost {
  setStatus(id: string, patch: LecturePatch): void;
  update(id: string, patch: LecturePatch): void;
  addLog(id: string, level: LectureLogEntry['level'], message: string): void;
  setParticipants(id: string, count: number | null, bytesRecorded: number): void;
  /** The lecture reached a final state: drop live state, wake the uploaders. */
  done(id: string): void;
}

export interface HeartbeatBody {
  phase?: string;
  detail?: string | null;
  participants?: number | null;
  recordingStartedAt?: number | null;
  receivedBytes?: number;
  uploadedBytes?: number;
  segments?: number;
  lastSegmentAt?: number | null;
  interrupted?: boolean;
  load?: number;
  logs?: LectureLogEntry[];
}

export interface FinishedBody {
  result?: string;
  error?: string | null;
  segments?: number;
  bytes?: number;
  durationSeconds?: number | null;
  recordingStartedAt?: number | null;
  logs?: LectureLogEntry[];
}

const RESULTS: PartResult[] = ['ended', 'stopped', 'interrupted', 'crashed', 'join-failed', 'cancelled'];
const LIVE_PHASES = ['launching', 'joining', 'lobby', 'recording', 'leaving', 'saving'];
const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000 * 10) / 10);

export class RemoteRecorders {
  private watchdog?: NodeJS.Timeout;
  private lastTaskCheck = 0;
  private finalizing = new Set<string>();
  private loadWarned = new Set<string>();

  constructor(private readonly host: RemoteHost) {}

  start(): void {
    this.watchdog = setInterval(() => { this.tick().catch((error) => console.error('Recorder watchdog error:', error)); }, WATCHDOG_MS);
    this.watchdog.unref();
  }

  stop(): void {
    if (this.watchdog) clearInterval(this.watchdog);
  }

  /** Can recordings run at all in this mode? (They are streamed to S3.) */
  problem(): string | null {
    if (!archiveEnabled()) return 'Recorders that run on AWS need the S3 bucket (ARCHIVE_S3_BUCKET) to be set.';
    if (config.recorderMode === 'ecs' && (!config.ecs.cluster || !config.ecs.taskDefinition || config.ecs.subnets.length === 0)) {
      return 'The ECS settings (ECS_CLUSTER, ECS_TASK_DEFINITION, ECS_SUBNETS) are missing.';
    }
    return null;
  }

  // ------------------------------------------------------------- lifecycle

  async startLecture(id: string): Promise<void> {
    await this.launchPart(id, 1);
  }

  /** End was pressed: workers learn it from their next heartbeat reply (within seconds). */
  async onStopRequested(id: string): Promise<void> {
    // Workers that haven't even reported yet are simply stopped
    for (const part of listParts(id)) {
      if (part.status === 'starting' && part.taskRef) {
        await getLauncher().terminate(part.taskRef).catch(() => undefined);
        this.markLost(part, 'stopped before it started', 'cancelled');
      }
    }
    this.evaluate(id);
  }

  /** After a dashboard restart: lectures in progress continue; joining that was cut off is redone. */
  resume(lecture: Lecture): void {
    const parts = listParts(lecture.id);
    if (parts.length === 0) {
      this.launchPart(lecture.id, 1).catch(() => undefined);
    } else if (lecture.status === 'saving') {
      this.finalize(lecture.id);
    } else {
      this.evaluate(lecture.id);
    }
  }

  private async launchPart(id: string, part: number): Promise<void> {
    const token = crypto.randomBytes(32).toString('base64url');
    insertPart(id, part, hash(token));
    try {
      const ref = await getLauncher().launch({ lectureId: id, part, token });
      updatePart(id, part, { taskRef: ref });
      this.host.addLog(id, 'info', part === 1
        ? 'Recorder starting (about 1–2 minutes)'
        : `Replacement recorder ${part} starting (about 1–2 minutes)`);
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      this.host.addLog(id, 'error', `Could not start recorder ${part}: ${message}`);
      updatePart(id, part, { status: 'lost', result: 'lost', error: message, endedAt: Date.now() });
      // A short pause before trying again, so a capacity problem isn't hammered
      setTimeout(() => this.evaluate(id), 15_000).unref();
    }
  }

  // ------------------------------------------------------- worker messages

  /** A worker authenticates with its token; returns its part, or undefined. */
  partForToken(token: string): LecturePart | undefined {
    return token ? getPartByToken(hash(token)) : undefined;
  }

  job(part: LecturePart) {
    const lecture = getLecture(part.lectureId);
    if (!lecture) return undefined;
    return {
      lectureId: lecture.id,
      part: part.part,
      url: lecture.url,
      botName: lecture.botName,
      rules: lectureRules(),
      segmentSeconds: config.recorder.segmentSeconds,
      heartbeatSeconds: config.recorder.heartbeatSeconds,
      stop: isStopRequested(lecture.id) || isFinal(lecture.status) || part.status === 'lost',
    };
  }

  heartbeat(part: LecturePart, body: HeartbeatBody): { stop: boolean; handoverDone: boolean } {
    const id = part.lectureId;
    const lecture = getLecture(id);
    const now = Date.now();
    if (!lecture || isFinal(lecture.status) || part.status === 'lost' || part.status === 'finished') {
      return { stop: true, handoverDone: true };
    }

    this.writeLogs(part, body.logs);
    const firstRecording = !part.recordingStartedAt && body.recordingStartedAt;
    updatePart(id, part.part, {
      status: 'running',
      lastHeartbeatAt: now,
      recordingStartedAt: body.recordingStartedAt ?? part.recordingStartedAt,
      lastSegmentAt: body.lastSegmentAt ?? part.lastSegmentAt,
      segments: Math.max(part.segments, body.segments ?? 0),
      bytes: Math.max(part.bytes, body.uploadedBytes ?? 0),
    });

    // What the dashboard shows comes from the newest part that is working
    const parts = listParts(id);
    const newest = parts.filter((p) => p.status === 'starting' || p.status === 'running').pop();
    if (!newest || newest.part === part.part || (body.phase === 'recording' && !this.isRecording(newest))) {
      const phase = LIVE_PHASES.includes(body.phase ?? '') ? body.phase as LecturePatch['status'] : undefined;
      if (phase && phase !== 'saving') {
        const patch: LecturePatch = { status: phase, detail: body.detail ?? null };
        if (phase === 'recording' && !lecture.recordingStartedAt) patch.recordingStartedAt = body.recordingStartedAt ?? now;
        if (phase === 'recording' && part.part > 1) patch.detail = `Recording (recorder ${part.part})`;
        this.host.setStatus(id, patch);
      }
      const earlier = parts.filter((p) => p.part < part.part).reduce((sum, p) => sum + p.bytes, 0);
      this.host.setParticipants(id, body.participants ?? null, earlier + (body.receivedBytes ?? 0));
    }

    if (firstRecording && part.part > 1) {
      const previous = parts.filter((p) => p.part < part.part && p.recordingStartedAt).pop();
      const previousEnd = previous ? (previous.status === 'running' ? now : previous.lastSegmentAt ?? previous.endedAt ?? now) : now;
      const gap = Math.max(0, (body.recordingStartedAt ?? now) - previousEnd);
      this.host.addLog(id, 'info', gap > 0
        ? `Replacement recorder ${part.part} is recording (about ${minutes(gap)} min missing)`
        : `Replacement recorder ${part.part} is recording (no gap)`);
    }

    // AWS gave notice: start the replacement now, while this one keeps recording
    if (body.interrupted && !part.interrupted) {
      updatePart(id, part.part, { interrupted: true });
      const hasSuccessor = parts.some((p) => p.part > part.part);
      if (!hasSuccessor && !isStopRequested(id)) {
        this.host.addLog(id, 'warn', `AWS is reclaiming recorder ${part.part}; starting a replacement now`);
        this.launchPart(id, Math.max(...parts.map((p) => p.part)) + 1).catch(() => undefined);
      }
    }

    if (typeof body.load === 'number' && body.load > 1.5 && !this.loadWarned.has(`${id}-${part.part}`)) {
      this.loadWarned.add(`${id}-${part.part}`);
      this.host.addLog(id, 'warn', `Recorder ${part.part} is very busy (load ${body.load.toFixed(1)}); the video may stutter. A bigger recorder size may be needed.`);
    }

    const successor = parts.find((p) => p.part > part.part);
    return {
      stop: isStopRequested(id),
      handoverDone: Boolean(part.interrupted || body.interrupted) && Boolean(successor && this.isRecording(getPart(id, successor.part))),
    };
  }

  finished(part: LecturePart, body: FinishedBody): void {
    const id = part.lectureId;
    this.writeLogs(part, body.logs);
    if (part.status === 'finished') return;
    const result = RESULTS.includes(body.result as PartResult) ? body.result as PartResult : 'crashed';
    updatePart(id, part.part, {
      status: 'finished',
      result,
      error: body.error ?? null,
      endedAt: Date.now(),
      segments: Math.max(part.segments, body.segments ?? 0),
      bytes: Math.max(part.bytes, body.bytes ?? 0),
      durationSeconds: body.durationSeconds ?? null,
      recordingStartedAt: body.recordingStartedAt ?? part.recordingStartedAt,
    });
    this.evaluate(id);
  }

  // -------------------------------------------------------------- decisions

  private isRecording(part?: LecturePart): boolean {
    return Boolean(part && part.recordingStartedAt && (part.status === 'running' || part.status === 'starting'));
  }

  private markLost(part: LecturePart, reason: string, result: PartResult = 'lost'): void {
    updatePart(part.lectureId, part.part, { status: 'lost', result, error: reason, endedAt: Date.now() });
    if (result === 'lost') this.host.addLog(part.lectureId, 'warn', `Recorder ${part.part} lost: ${reason}`);
  }

  /** Decide what happens next once no worker of the lecture is active. */
  private evaluate(id: string): void {
    const lecture = getLecture(id);
    if (!lecture || isFinal(lecture.status) || this.finalizing.has(id)) return;
    const parts = listParts(id);
    if (parts.some((p) => p.status === 'starting' || p.status === 'running')) return;

    const last = parts[parts.length - 1];
    const recorded = parts.some((p) => p.segments > 0);
    if (!last || isStopRequested(id)) {
      this.finalize(id);
      return;
    }

    const retry = (why: string) => {
      if (parts.length >= config.recorder.maxParts) {
        this.host.addLog(id, 'error', `Recorder ${last.part} failed (${why}) and the limit of ${config.recorder.maxParts} recorders for one lecture is reached.`);
        this.finalize(id, `The recorder failed ${parts.length} times; recording stopped.`);
        return;
      }
      if (last.result !== 'lost') this.host.addLog(id, 'warn', `Recorder ${last.part} stopped (${why}); starting a replacement that rejoins the meeting`);
      this.launchPart(id, last.part + 1).catch(() => undefined);
    };

    switch (last.result) {
      case 'ended':
      case 'stopped':
      case 'cancelled':
        this.finalize(id);
        return;
      case 'interrupted':
      case 'crashed':
      case 'lost':
        retry(last.error || last.result);
        return;
      case 'join-failed':
        // The first recorder could not get in (denied, timed out, sign-in only): nothing to retry.
        // A replacement that can't get back in usually means the meeting has ended.
        if (!recorded && last.part === 1) this.finalize(id, last.error || 'The recorder could not join the meeting.');
        else if (!recorded) retry(last.error || 'could not rejoin');
        else this.finalize(id);
        return;
      default:
        retry('unknown result');
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const lectures = listUnfinishedLectures().filter((l) => l.status !== 'saving' || !this.finalizing.has(l.id));
    const active: LecturePart[] = [];

    for (const lecture of lectures) {
      if (lecture.status === 'saving' && !this.finalizing.has(lecture.id)) {
        this.finalize(lecture.id);
        continue;
      }
      for (const part of listParts(lecture.id)) {
        if (part.status !== 'starting' && part.status !== 'running') continue;
        if (part.status === 'starting' && now - part.startedAt > config.recorder.startTimeoutSeconds * 1000) {
          if (part.taskRef) await getLauncher().terminate(part.taskRef).catch(() => undefined);
          this.markLost(part, `did not start within ${Math.round(config.recorder.startTimeoutSeconds / 60)} minutes`);
          this.evaluate(lecture.id);
        } else if (part.status === 'running' && part.lastHeartbeatAt
          && now - part.lastHeartbeatAt > config.recorder.heartbeatTimeoutSeconds * 1000) {
          if (part.taskRef) await getLauncher().terminate(part.taskRef).catch(() => undefined);
          this.markLost(part, `no report for ${config.recorder.heartbeatTimeoutSeconds} seconds`);
          this.evaluate(lecture.id);
        } else if (part.taskRef) {
          active.push(part);
        }
      }
    }

    // A task that stopped without reporting (out of memory, AWS problem) is noticed within ~30 s
    if (active.length > 0 && now - this.lastTaskCheck > TASK_CHECK_MS) {
      this.lastTaskCheck = now;
      const statuses = await getLauncher().status(active.map((p) => p.taskRef as string)).catch(() => new Map<string, true | string>());
      for (const part of active) {
        const status = statuses.get(part.taskRef as string);
        if (typeof status !== 'string') continue;
        const fresh = getPart(part.lectureId, part.part);
        // Give its final report a moment to arrive
        if (fresh && (fresh.status === 'starting' || fresh.status === 'running') && now - (fresh.lastHeartbeatAt ?? fresh.startedAt) > 15_000) {
          this.markLost(fresh, status);
          this.evaluate(part.lectureId);
        }
      }
    }
  }

  // ------------------------------------------------------------ the result

  /** Collect the parts from S3, join them into one video, and hand it to the uploaders. */
  private finalize(id: string, failure?: string): void {
    if (this.finalizing.has(id)) return;
    this.finalizing.add(id);
    this.assemble(id, failure)
      .catch((error) => {
        console.error('Assembling the recording failed:', error);
        this.host.addLog(id, 'error', `Joining the recording failed: ${(error as Error)?.message ?? error}. The segments stay in S3.`);
        this.host.update(id, { status: 'failed', detail: null, error: 'The recording could not be put together. Its pieces are kept in S3; ask the admin.', endedAt: Date.now() });
      })
      .finally(() => {
        this.finalizing.delete(id);
        this.host.done(id);
      });
  }

  private async assemble(id: string, failure?: string): Promise<void> {
    const lecture = getLecture(id) as Lecture;
    const parts = listParts(id).filter((p) => p.segments > 0 || p.recordingStartedAt);
    const stopped = isStopRequested(id);

    if (parts.length === 0) {
      this.host.update(id, failure && !stopped
        ? { status: 'failed', detail: null, error: failure, endedAt: Date.now() }
        : { status: 'cancelled', detail: 'Stopped before the recording started.', error: null, endedAt: Date.now() });
      this.host.addLog(id, failure && !stopped ? 'error' : 'info', failure && !stopped ? `Failed: ${failure}` : 'Cancelled');
      return;
    }

    this.host.setStatus(id, { status: 'saving', detail: 'Putting the recording together' });
    const work = path.join(config.tempVideoDir, 'assemble', id);
    fs.mkdirSync(work, { recursive: true });

    // 1. Each part: its segments, in order, make one WebM file
    const files: Array<{ part: LecturePart; file: string; seconds: number }> = [];
    for (const part of parts) {
      const keys = await listKeys(segmentPrefix(id, part.part));
      if (keys.length === 0) continue;
      const file = path.join(work, `part-${String(part.part).padStart(2, '0')}.webm`);
      const out = fs.createWriteStream(file);
      for (const key of keys) await appendObjectTo(key, out);
      await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
      const end = part.lastSegmentAt ?? part.endedAt ?? Date.now();
      const seconds = part.durationSeconds ?? Math.max(1, Math.round((end - (part.recordingStartedAt ?? end)) / 1000));
      await writeWebmDurationMetadata(file, seconds).catch(() => undefined);
      files.push({ part, file, seconds });
    }
    if (files.length === 0) throw new Error('no recording segments were found in S3');

    // 2. Several parts: join them into one video (no re-encoding)
    let final = files[0].file;
    let joinProblem: string | null = null;
    if (files.length > 1) {
      const list = path.join(work, 'parts.txt');
      fs.writeFileSync(list, files.map((f) => `file '${f.file.replace(/\\/g, '/').replace(/'/g, '\'\\\'\'')}'`).join('\n'));
      const joined = path.join(work, 'joined.webm');
      try {
        await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined],
          { timeout: 30 * 60_000, maxBuffer: 10 * 1024 * 1024 });
        final = joined;
        const total = files.reduce((sum, f) => sum + f.seconds, 0);
        await writeWebmDurationMetadata(final, total).catch(() => undefined);
      } catch (error) {
        joinProblem = (error as Error)?.message?.split(/\r?\n/)[0] ?? String(error);
      }
    }

    // 3. Into the recordings folder, under the usual name
    fs.mkdirSync(config.recordingsDir, { recursive: true });
    const started = parts[0].recordingStartedAt ?? lecture.createdAt;
    const stamp = moment(started).tz(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC').format('h-mma MMM DD YYYY');
    const base = safeFileName(`${lecture.subjectName} - ${lecture.meetingCode ?? 'meeting'} - ${stamp}`);
    const target = (suffix: string) => {
      let name = `${base}${suffix}${config.uploaderFileExtension}`;
      for (let n = 2; fs.existsSync(path.join(config.recordingsDir, name)); n++) name = `${base}${suffix} (${n})${config.uploaderFileExtension}`;
      return name;
    };
    const fileName = target('');
    fs.renameSync(final, path.join(config.recordingsDir, fileName));
    const kept: string[] = [];
    if (joinProblem) {
      // Couldn't join: keep every part as its own file so nothing is lost
      for (const extra of files.slice(1)) {
        const name = target(` (part ${extra.part.part})`);
        fs.renameSync(extra.file, path.join(config.recordingsDir, name));
        kept.push(name);
      }
    }
    fs.rmSync(work, { recursive: true, force: true });

    // 4. What was missed between parts
    let missingMs = 0;
    for (let i = 1; i < parts.length; i++) {
      const previousEnd = parts[i - 1].lastSegmentAt ?? parts[i - 1].endedAt;
      const nextStart = parts[i].recordingStartedAt;
      if (previousEnd && nextStart) missingMs += Math.max(0, nextStart - previousEnd);
    }
    const seconds = files.reduce((sum, f) => sum + f.seconds, 0);
    const size = fs.statSync(path.join(config.recordingsDir, fileName)).size;
    const tooShort = seconds < config.minUploadSeconds;
    const notes: string[] = [];
    if (parts.length > 1) notes.push(`Recorded by ${parts.length} recorders (a recorder was replaced); about ${minutes(missingMs)} min missing between parts.`);
    if (joinProblem) notes.push(`The parts could not be joined automatically, so only part 1 goes to YouTube; the other parts are kept on the server: ${kept.join(', ')}.`);
    if (tooShort) notes.push(`Under ${config.minUploadSeconds} seconds long, so it was not sent to YouTube.`);

    const patch: LecturePatch = {
      status: 'saved',
      detail: notes.join(' ') || null,
      error: failure ? `${failure} The part that was recorded has been saved.` : null,
      endedAt: Date.now(),
      recordingStartedAt: lecture.recordingStartedAt ?? parts[0].recordingStartedAt,
      bytesRecorded: size,
      fileName,
      fileSize: size,
      uploadStatus: tooShort ? 'none' : 'pending',
      archiveStatus: archiveEnabled() ? 'pending' : 'none',
    };
    this.host.update(id, patch);
    this.host.addLog(id, 'info', `Recording saved (${Math.round(size / 1024 / 1024 * 10) / 10} MB, ${Math.round(seconds / 60)} min${parts.length > 1 ? `, ${parts.length} parts` : ''})`);
  }

  private writeLogs(part: LecturePart, logs?: LectureLogEntry[]): void {
    for (const entry of (logs ?? []).slice(-200)) {
      if (!entry || typeof entry.message !== 'string') continue;
      const level = entry.level === 'error' || entry.level === 'warn' ? entry.level : 'info';
      const prefix = part.part > 1 ? `[recorder ${part.part}] ` : '';
      this.host.addLog(part.lectureId, level, `${prefix}${entry.message.slice(0, 400)}`);
    }
  }
}
