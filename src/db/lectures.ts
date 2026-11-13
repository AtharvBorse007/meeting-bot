import { all, get, run } from './index';

/** Where the bot is with a lecture. The last three are final. */
export type LectureStatus =
  | 'launching' | 'joining' | 'lobby' | 'recording' | 'leaving' | 'saving'
  | 'saved' | 'failed' | 'cancelled';

/** Where the recording is on its way to YouTube. */
export type UploadStatus =
  | 'none'       // nothing to upload (no recording was made)
  | 'pending'    // waiting for its turn (or for YouTube to be connected)
  | 'uploading'
  | 'retry'      // an attempt failed; another one is scheduled
  | 'done'
  | 'failed';    // gave up after many attempts; can be retried by hand

/** Where the backup copy in S3 is (same states as the YouTube upload). 'none' = backups are off or nothing to back up. */
export type ArchiveStatus = UploadStatus;

export const FINAL_STATUSES: LectureStatus[] = ['saved', 'failed', 'cancelled'];
export const isFinal = (status: LectureStatus) => FINAL_STATUSES.includes(status);

export interface Lecture {
  id: string;
  instructorId: number;
  instructorName: string;
  subjectId: number;
  subjectName: string;
  playlistId: string | null;
  topic: string | null;
  url: string;
  meetingCode: string | null;
  botName: string;
  status: LectureStatus;
  detail: string | null;
  error: string | null;
  createdAt: number;
  recordingStartedAt: number | null;
  endedAt: number | null;
  bytesRecorded: number;
  fileName: string | null;
  fileSize: number | null;
  localDeletedAt: number | null;
  uploadStatus: UploadStatus;
  uploadAttempts: number;
  uploadError: string | null;
  uploadNextAt: number | null;
  youtubeVideoId: string | null;
  inPlaylist: boolean;
  uploadedAt: number | null;
  archiveStatus: ArchiveStatus;
  archiveKey: string | null;
  archiveAttempts: number;
  archiveError: string | null;
  archiveNextAt: number | null;
  archivedAt: number | null;
  /** How many recorders worked on it (more than 1 = a recorder was replaced mid-lecture) */
  partCount: number;
}

interface LectureRow {
  id: string;
  instructor_id: number;
  instructor_name: string;
  subject_id: number;
  subject_name: string;
  playlist_id: string | null;
  topic: string | null;
  url: string;
  meeting_code: string | null;
  bot_name: string;
  status: LectureStatus;
  detail: string | null;
  error: string | null;
  created_at: number;
  recording_started_at: number | null;
  ended_at: number | null;
  bytes_recorded: number;
  file_name: string | null;
  file_size: number | null;
  local_deleted_at: number | null;
  upload_status: UploadStatus;
  upload_attempts: number;
  upload_error: string | null;
  upload_next_at: number | null;
  youtube_video_id: string | null;
  in_playlist: number;
  uploaded_at: number | null;
  archive_status: ArchiveStatus;
  archive_key: string | null;
  archive_attempts: number;
  archive_error: string | null;
  archive_next_at: number | null;
  archived_at: number | null;
  part_count: number;
}

const SELECT = `
  SELECT l.*, u.name AS instructor_name, s.name AS subject_name, s.playlist_id AS playlist_id
  FROM lectures l
  JOIN users u ON u.id = l.instructor_id
  JOIN subjects s ON s.id = l.subject_id`;

const toLecture = (row: LectureRow): Lecture => ({
  id: row.id,
  instructorId: row.instructor_id,
  instructorName: row.instructor_name,
  subjectId: row.subject_id,
  subjectName: row.subject_name,
  playlistId: row.playlist_id,
  topic: row.topic,
  url: row.url,
  meetingCode: row.meeting_code,
  botName: row.bot_name,
  status: row.status,
  detail: row.detail,
  error: row.error,
  createdAt: row.created_at,
  recordingStartedAt: row.recording_started_at,
  endedAt: row.ended_at,
  bytesRecorded: row.bytes_recorded,
  fileName: row.file_name,
  fileSize: row.file_size,
  localDeletedAt: row.local_deleted_at,
  uploadStatus: row.upload_status,
  uploadAttempts: row.upload_attempts,
  uploadError: row.upload_error,
  uploadNextAt: row.upload_next_at,
  youtubeVideoId: row.youtube_video_id,
  inPlaylist: row.in_playlist === 1,
  uploadedAt: row.uploaded_at,
  archiveStatus: row.archive_status,
  archiveKey: row.archive_key,
  archiveAttempts: row.archive_attempts,
  archiveError: row.archive_error,
  archiveNextAt: row.archive_next_at,
  archivedAt: row.archived_at,
  partCount: row.part_count ?? 0,
});

export const insertLecture = (input: {
  id: string;
  instructorId: number;
  subjectId: number;
  topic: string | null;
  url: string;
  meetingCode: string | null;
  botName: string;
  status: LectureStatus;
  detail: string | null;
}): Lecture => {
  run(
    `INSERT INTO lectures (id, instructor_id, subject_id, topic, url, meeting_code, bot_name, status, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.id, input.instructorId, input.subjectId, input.topic, input.url, input.meetingCode, input.botName,
    input.status, input.detail, Date.now(),
  );
  return getLecture(input.id) as Lecture;
};

export const getLecture = (id: string): Lecture | undefined => {
  const row = get<LectureRow>(`${SELECT} WHERE l.id = ?`, id);
  return row ? toLecture(row) : undefined;
};

/** The columns that change after a lecture is created. */
export type LecturePatch = Partial<Pick<Lecture,
  'status' | 'detail' | 'error' | 'recordingStartedAt' | 'endedAt' | 'bytesRecorded' | 'fileName' | 'fileSize' |
  'localDeletedAt' | 'uploadStatus' | 'uploadAttempts' | 'uploadError' | 'uploadNextAt' | 'youtubeVideoId' |
  'inPlaylist' | 'uploadedAt' | 'archiveStatus' | 'archiveKey' | 'archiveAttempts' | 'archiveError' |
  'archiveNextAt' | 'archivedAt'>>;

const COLUMNS: Record<keyof LecturePatch, string> = {
  status: 'status',
  detail: 'detail',
  error: 'error',
  recordingStartedAt: 'recording_started_at',
  endedAt: 'ended_at',
  bytesRecorded: 'bytes_recorded',
  fileName: 'file_name',
  fileSize: 'file_size',
  localDeletedAt: 'local_deleted_at',
  uploadStatus: 'upload_status',
  uploadAttempts: 'upload_attempts',
  uploadError: 'upload_error',
  uploadNextAt: 'upload_next_at',
  youtubeVideoId: 'youtube_video_id',
  inPlaylist: 'in_playlist',
  uploadedAt: 'uploaded_at',
  archiveStatus: 'archive_status',
  archiveKey: 'archive_key',
  archiveAttempts: 'archive_attempts',
  archiveError: 'archive_error',
  archiveNextAt: 'archive_next_at',
  archivedAt: 'archived_at',
};

export const updateLecture = (id: string, patch: LecturePatch): void => {
  const keys = (Object.keys(patch) as Array<keyof LecturePatch>).filter((key) => patch[key] !== undefined);
  if (keys.length === 0) return;
  const values = keys.map((key) => {
    const value = patch[key];
    return typeof value === 'boolean' ? (value ? 1 : 0) : (value as string | number | null);
  });
  run(`UPDATE lectures SET ${keys.map((key) => `${COLUMNS[key]} = ?`).join(', ')} WHERE id = ?`, ...values, id);
};

/** Newest first. `before` (a createdAt value) pages further back. */
export const listLectures = (filter: { instructorId?: number; subjectId?: number; before?: number; limit?: number }): Lecture[] => {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.instructorId !== undefined) { where.push('l.instructor_id = ?'); params.push(filter.instructorId); }
  if (filter.subjectId !== undefined) { where.push('l.subject_id = ?'); params.push(filter.subjectId); }
  if (filter.before !== undefined) { where.push('l.created_at < ?'); params.push(filter.before); }
  const limit = Math.min(Math.max(filter.limit ?? 30, 1), 100);
  return all<LectureRow>(
    `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.created_at DESC LIMIT ${limit}`,
    ...params,
  ).map(toLecture);
};

/** Lectures the bot is still working on. */
export const listUnfinishedLectures = (): Lecture[] =>
  all<LectureRow>(`${SELECT} WHERE l.status NOT IN ('saved', 'failed', 'cancelled')`).map(toLecture);

/** The next recording that should go to YouTube, oldest first. */
export const nextLectureToUpload = (now: number): Lecture | undefined => {
  const row = get<LectureRow>(
    `${SELECT} WHERE l.upload_status IN ('pending', 'retry') AND (l.upload_next_at IS NULL OR l.upload_next_at <= ?)
     ORDER BY l.created_at LIMIT 1`, now);
  return row ? toLecture(row) : undefined;
};

export const countWaitingUploads = (): number =>
  get<{ n: number }>('SELECT COUNT(*) AS n FROM lectures WHERE upload_status IN (\'pending\', \'retry\', \'uploading\')')?.n ?? 0;

/** Uploads interrupted by a restart go back in the line. */
export const resetInterruptedUploads = (): void => {
  run('UPDATE lectures SET upload_status = \'pending\', upload_next_at = NULL WHERE upload_status = \'uploading\'');
};

/** Recordings that reached YouTube long enough ago for the server copy to be removed. */
/** With S3 backups on, a server copy may only go once the backup exists as well. */
const safelyStored = (requireArchive: boolean) =>
  `l.upload_status = 'done' AND l.in_playlist = 1 ${requireArchive ? 'AND l.archive_status = \'done\'' : ''}`;

export const listLecturesPastRetention = (uploadedBefore: number, requireArchive: boolean): Lecture[] =>
  all<LectureRow>(
    `${SELECT} WHERE ${safelyStored(requireArchive)} AND l.uploaded_at < ?
     AND l.file_name IS NOT NULL AND l.local_deleted_at IS NULL`, uploadedBefore).map(toLecture);

/** Server copies that are safely stored elsewhere, oldest first (deleted first when disk runs low). */
export const listUploadedLocalCopies = (requireArchive: boolean): Lecture[] =>
  all<LectureRow>(
    `${SELECT} WHERE ${safelyStored(requireArchive)}
     AND l.file_name IS NOT NULL AND l.local_deleted_at IS NULL ORDER BY l.uploaded_at`).map(toLecture);

/** The next recording to copy to S3, oldest first. */
export const nextLectureToArchive = (now: number): Lecture | undefined => {
  const row = get<LectureRow>(
    `${SELECT} WHERE l.archive_status IN ('pending', 'retry') AND (l.archive_next_at IS NULL OR l.archive_next_at <= ?)
     ORDER BY l.created_at LIMIT 1`, now);
  return row ? toLecture(row) : undefined;
};

/** Backups interrupted by a restart go back in the line; recordings made while backups were off are added. */
export const prepareArchiveQueue = (): void => {
  run('UPDATE lectures SET archive_status = \'pending\', archive_next_at = NULL WHERE archive_status = \'uploading\'');
  run(`UPDATE lectures SET archive_status = 'pending' WHERE archive_status = 'none'
       AND file_name IS NOT NULL AND local_deleted_at IS NULL`);
};

export const countArchive = (): { waiting: number; failed: number; done: number } => ({
  waiting: get<{ n: number }>('SELECT COUNT(*) AS n FROM lectures WHERE archive_status IN (\'pending\', \'retry\', \'uploading\')')?.n ?? 0,
  failed: get<{ n: number }>('SELECT COUNT(*) AS n FROM lectures WHERE archive_status = \'failed\'')?.n ?? 0,
  done: get<{ n: number }>('SELECT COUNT(*) AS n FROM lectures WHERE archive_status = \'done\'')?.n ?? 0,
});

export const sumLocalRecordingBytes = (): number =>
  get<{ n: number | null }>('SELECT SUM(file_size) AS n FROM lectures WHERE file_name IS NOT NULL AND local_deleted_at IS NULL')?.n ?? 0;
