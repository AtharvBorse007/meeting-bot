import fs from 'fs';
import config from '../config';
import { getLecture, Lecture, listLecturesPastRetention, listUploadedLocalCopies, nextLectureToUpload, resetInterruptedUploads } from '../db/lectures';
import { getSubject, updateSubject } from '../db/subjects';
import { freeDiskBytes, lectureManager } from '../lectures/LectureManager';
import { addToPlaylist, createPlaylist, isConnected, uploadVideo, YouTubeError } from './client';
import { archiveEnabled } from '../archive/s3';

/**
 * Sends finished recordings to YouTube, one at a time, in the background:
 *   upload the video (unlisted) -> add it to the subject's playlist -> remember the link.
 * Failures are retried with growing pauses; the server copy is only removed, weeks later, once
 * the video is on YouTube and in its playlist.
 */

const RETRY_MINUTES = [1, 5, 15, 60, 180];
const MAX_ATTEMPTS = 15;
const IDLE_POLL_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;

const formatDate = (timestamp: number) =>
  new Date(timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const formatTime = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });

/** "Physics – Kinematics – 12 Nov 2026 – A. Sharma" */
export const videoTitle = (lecture: Lecture): string => {
  const date = formatDate(lecture.recordingStartedAt ?? lecture.createdAt);
  return [lecture.subjectName, lecture.topic, date, lecture.instructorName].filter(Boolean).join(' – ');
};

const videoDescription = (lecture: Lecture): string => {
  const started = lecture.recordingStartedAt ?? lecture.createdAt;
  return [
    `Subject: ${lecture.subjectName}`,
    lecture.topic ? `Topic: ${lecture.topic}` : null,
    `Instructor: ${lecture.instructorName}`,
    `Recorded: ${formatDate(started)}, ${formatTime(started)}`,
  ].filter(Boolean).join('\n');
};

export class UploadWorker {
  private busy = false;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;

  start(): void {
    resetInterruptedUploads();
    lectureManager.on('finished', () => this.wake());
    this.wake();
    this.cleanupTimer = setInterval(() => this.removeOldLocalCopies(), config.cleanupIntervalSeconds * 1000);
    this.cleanupTimer.unref();
    this.removeOldLocalCopies();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  /** Look for work now (called when a recording finishes, YouTube gets connected, or a retry is requested). */
  wake(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    void this.drain();
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
      while (!this.stopped) {
        if (!isConnected()) break; // recordings simply wait until the admin connects YouTube
        const lecture = nextLectureToUpload(Date.now());
        if (!lecture) break;
        await this.process(lecture);
      }
    } catch (error) {
      console.error('Upload worker error:', error);
    } finally {
      this.busy = false;
      this.schedule(IDLE_POLL_MS);
    }
  }

  private async process(lecture: Lecture): Promise<void> {
    const id = lecture.id;
    try {
      let videoId = lecture.youtubeVideoId;

      if (!videoId) {
        const file = lectureManager.recordingPath(lecture);
        if (!file) {
          lectureManager.update(id, { uploadStatus: 'failed', uploadError: 'The recording file is no longer on the server.', uploadNextAt: null }, null);
          return;
        }
        lectureManager.update(id, { uploadStatus: 'uploading', uploadError: null }, 0);
        lectureManager.note(id, 'info', `Uploading to YouTube (attempt ${lecture.uploadAttempts + 1})`);

        videoId = await uploadVideo(file, { title: videoTitle(lecture), description: videoDescription(lecture) },
          (fraction) => lectureManager.setUploadProgress(id, fraction));
        // Remember the video straight away: if the playlist step fails, a retry must not upload it twice
        lectureManager.update(id, { youtubeVideoId: videoId, uploadedAt: Date.now() }, null);
        lectureManager.note(id, 'info', `Video is on YouTube: https://www.youtube.com/watch?v=${videoId}`);
      }

      if (!lecture.inPlaylist) {
        const subject = getSubject(lecture.subjectId);
        let playlistId = subject?.playlistId ?? null;
        if (subject && !playlistId) {
          playlistId = await createPlaylist(subject.name);
          updateSubject(subject.id, { playlistId });
          lectureManager.note(id, 'info', `Created the YouTube playlist "${subject.name}"`);
        }
        if (playlistId) {
          await addToPlaylist(playlistId, videoId);
          lectureManager.note(id, 'info', 'Added to the subject playlist');
        }
      }

      lectureManager.update(id, { uploadStatus: 'done', inPlaylist: true, uploadError: null, uploadNextAt: null }, null);
      this.removeOldLocalCopies(); // a full disk can be relieved as soon as something is safely on YouTube
    } catch (error) {
      this.handleFailure(id, error);
    }
  }

  private handleFailure(id: string, error: unknown): void {
    const lecture = getLecture(id);
    if (!lecture) return;
    const message = error instanceof Error ? error.message.split(/\r?\n/)[0].slice(0, 300) : String(error);

    if (error instanceof YouTubeError && error.kind === 'auth') {
      // Not this recording's fault: wait (without using up attempts) until YouTube is connected again
      lectureManager.update(id, { uploadStatus: 'pending', uploadError: 'Waiting for YouTube to be reconnected.', uploadNextAt: Date.now() + 10 * 60 * 1000 }, null);
      lectureManager.note(id, 'warn', `Upload paused: ${message}`);
      return;
    }

    const attempts = lecture.uploadAttempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      lectureManager.update(id, { uploadStatus: 'failed', uploadAttempts: attempts, uploadError: message, uploadNextAt: null }, null);
      lectureManager.note(id, 'error', `Upload gave up after ${attempts} attempts: ${message}`);
      return;
    }

    const quota = error instanceof YouTubeError && error.kind === 'quota';
    const minutes = quota ? 180 : RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)];
    lectureManager.update(id, {
      uploadStatus: 'retry',
      uploadAttempts: attempts,
      uploadError: quota ? `YouTube's daily limit was reached. ${message}` : message,
      uploadNextAt: Date.now() + minutes * 60 * 1000,
    }, null);
    lectureManager.note(id, 'warn', `Upload failed, trying again in ${minutes} min: ${message}`);
  }

  /** Put a recording back in the line by hand (the "Retry upload" button). */
  retry(id: string): void {
    lectureManager.update(id, { uploadStatus: 'pending', uploadAttempts: 0, uploadError: null, uploadNextAt: null }, null);
    this.wake();
  }

  /** Free disk space: drop the server copy of recordings that have been safely on YouTube for LOCAL_RETENTION_DAYS. */
  private removeOldLocalCopies(): void {
    try {
      const cutoff = Date.now() - config.localRetentionDays * 24 * HOUR_MS;
      for (const lecture of listLecturesPastRetention(cutoff, archiveEnabled())) {
        const file = lectureManager.recordingPath(lecture);
        if (file) fs.rmSync(file, { force: true });
        lectureManager.update(lecture.id, { localDeletedAt: Date.now() });
        lectureManager.note(lecture.id, 'info', `Server copy removed after ${config.localRetentionDays} days (the video stays on YouTube)`);
      }

      // Disk getting full: remove more server copies (oldest first), but only ones already safely on YouTube
      const lowDisk = config.lowDiskGb * 1024 ** 3;
      let free = freeDiskBytes();
      if (free !== null && free < lowDisk) {
        for (const lecture of listUploadedLocalCopies(archiveEnabled())) {
          const file = lectureManager.recordingPath(lecture);
          if (file) fs.rmSync(file, { force: true });
          lectureManager.update(lecture.id, { localDeletedAt: Date.now() });
          lectureManager.note(lecture.id, 'info', 'Server copy removed early because the disk is filling up (the video stays on YouTube)');
          free = freeDiskBytes();
          if (free === null || free >= lowDisk) break;
        }
      }
    } catch (error) {
      console.error('Clean-up of old recordings failed:', error);
    }
  }
}

export const uploadWorker = new UploadWorker();
