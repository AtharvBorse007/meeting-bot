import fs from 'fs';
import path from 'path';
import config from '../config';
import { run } from '../db';
import { getLecture, Lecture, nextLectureToArchive, prepareArchiveQueue } from '../db/lectures';
import { getJsonSetting, setJsonSetting } from '../db/settings';
import { lectureManager } from '../lectures/LectureManager';
import { archiveEnabled, dbBackupKey, recordingKey, uploadFile } from './s3';

/**
 * Keeps the S3 backup up to date, in the background and independently of YouTube:
 *   - copies every saved recording to S3 once (retrying with growing pauses when that fails)
 *   - uploads a copy of the database once a day (accounts, subjects, lecture history, YouTube connection)
 * Server copies of recordings are only removed after the S3 copy exists (see UploadWorker).
 */

const RETRY_MINUTES = [1, 5, 15, 60, 180];
const MAX_ATTEMPTS = 15;
const IDLE_POLL_MS = 60_000;
const DB_BACKUP_KEY = 'archive.dbBackup';

export interface DbBackupState {
  lastSuccessAt: number | null;
  lastKey: string | null;
  lastError: string | null;
  lastAttemptAt: number | null;
}

const dayOf = (timestamp: number) => {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const message = (error: unknown) => {
  const err = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  if (err?.$metadata?.httpStatusCode === 403) return 'Access denied by S3 (check the server\'s IAM role and the bucket name).';
  return (err?.message || err?.name || String(error)).split(/\r?\n/)[0].slice(0, 300);
};

export const getDbBackupState = (): DbBackupState =>
  getJsonSetting<DbBackupState>(DB_BACKUP_KEY) ?? { lastSuccessAt: null, lastKey: null, lastError: null, lastAttemptAt: null };

export class ArchiveWorker {
  private busy = false;
  private stopped = false;
  private timer?: NodeJS.Timeout;

  start(): void {
    if (!archiveEnabled()) {
      console.log('S3 backups are off (ARCHIVE_S3_BUCKET is not set).');
      return;
    }
    console.log(`S3 backups go to s3://${config.archive.bucket}${config.archive.prefix ? `/${config.archive.prefix}` : ''}`);
    prepareArchiveQueue();
    lectureManager.on('finished', () => this.wake());
    this.wake();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  wake(): void {
    if (!archiveEnabled() || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    void this.drain();
  }

  /** The "Retry backup" button. */
  retry(id: string): void {
    lectureManager.update(id, { archiveStatus: 'pending', archiveAttempts: 0, archiveError: null, archiveNextAt: null });
    this.wake();
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.wake(), ms);
    this.timer.unref();
  }

  private async drain(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (;;) {
        if (this.stopped) break;
        const lecture = nextLectureToArchive(Date.now());
        if (!lecture) break;
        await this.archive(lecture);
      }
      await this.dailyDbBackup();
    } catch (error) {
      console.error('Archive worker error:', error);
    } finally {
      this.busy = false;
      this.schedule(IDLE_POLL_MS);
    }
  }

  private async archive(lecture: Lecture): Promise<void> {
    const id = lecture.id;
    const file = lectureManager.recordingPath(lecture);
    if (!file || !lecture.fileName) {
      lectureManager.update(id, { archiveStatus: 'failed', archiveError: 'The recording file is no longer on the server.', archiveNextAt: null });
      return;
    }

    const key = lecture.archiveKey ?? recordingKey(lecture.subjectName, lecture.fileName, lecture.recordingStartedAt ?? lecture.createdAt);
    try {
      lectureManager.update(id, { archiveStatus: 'uploading', archiveKey: key, archiveError: null });
      await uploadFile(file, key, {
        contentType: lecture.fileName.toLowerCase().endsWith('.mp4') ? 'video/mp4' : 'video/webm',
        storageClass: config.archive.storageClass,
        metadata: {
          'lecture-id': lecture.id,
          subject: lecture.subjectName,
          instructor: lecture.instructorName,
          ...(lecture.topic ? { topic: lecture.topic } : {}),
          'recorded-at': new Date(lecture.recordingStartedAt ?? lecture.createdAt).toISOString(),
        },
      });
      lectureManager.update(id, { archiveStatus: 'done', archivedAt: Date.now(), archiveError: null, archiveNextAt: null });
      lectureManager.note(id, 'info', `Backup copy saved in S3 (${key})`);
    } catch (error) {
      const current = getLecture(id);
      const attempts = (current?.archiveAttempts ?? 0) + 1;
      const reason = message(error);
      if (attempts >= MAX_ATTEMPTS) {
        lectureManager.update(id, { archiveStatus: 'failed', archiveAttempts: attempts, archiveError: reason, archiveNextAt: null });
        lectureManager.note(id, 'error', `S3 backup gave up after ${attempts} attempts: ${reason}`);
        return;
      }
      const minutes = RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)];
      lectureManager.update(id, {
        archiveStatus: 'retry', archiveAttempts: attempts, archiveError: reason, archiveNextAt: Date.now() + minutes * 60_000,
      });
      lectureManager.note(id, 'warn', `S3 backup failed, trying again in ${minutes} min: ${reason}`);
    }
  }

  /**
   * A consistent copy of the database to S3: right away the first time, then once a day after
   * DB_BACKUP_HOUR. A failed attempt is retried at most once an hour.
   */
  private async dailyDbBackup(): Promise<void> {
    const state = getDbBackupState();
    const now = Date.now();
    if (state.lastSuccessAt) {
      if (dayOf(state.lastSuccessAt) === dayOf(now)) return;
      if (new Date(now).getHours() < config.archive.dbBackupHour) return;
    }
    if (state.lastError && state.lastAttemptAt && now - state.lastAttemptAt < 60 * 60_000) return;

    const tmp = path.join(config.dataDir, 'backup-for-s3.db');
    const key = dbBackupKey(dayOf(now));
    try {
      fs.rmSync(tmp, { force: true });
      run('VACUUM INTO ?', tmp); // consistent even while the app keeps writing
      await uploadFile(tmp, key, { contentType: 'application/vnd.sqlite3', storageClass: 'STANDARD' });
      setJsonSetting(DB_BACKUP_KEY, { lastSuccessAt: Date.now(), lastKey: key, lastError: null, lastAttemptAt: now } satisfies DbBackupState);
      console.log(`Database backup saved in S3 (${key})`);
    } catch (error) {
      setJsonSetting(DB_BACKUP_KEY, { ...state, lastError: message(error), lastAttemptAt: now } satisfies DbBackupState);
      console.error('Database backup to S3 failed:', message(error));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
}

export const archiveWorker = new ArchiveWorker();
