import { all, get, run } from './index';

/**
 * A "part" is one recorder (an ECS task or a worker process) working on a lecture. Usually a
 * lecture has one; if a recorder is lost, a replacement rejoins and records the next part.
 */

export type PartStatus =
  | 'starting'   // launched, has not reported yet
  | 'running'    // reporting heartbeats
  | 'finished'   // reported its result
  | 'lost';      // stopped reporting / its task disappeared

/**
 * How a part ended:
 *   ended        the meeting is over (meeting ended, everyone left, time limit)
 *   stopped      End was pressed
 *   interrupted  AWS reclaimed the task; a replacement took over
 *   crashed      the browser failed after recording had started
 *   join-failed  could not get into the meeting
 *   cancelled    End was pressed before recording started
 *   lost         never reported back
 */
export type PartResult = 'ended' | 'stopped' | 'interrupted' | 'crashed' | 'join-failed' | 'cancelled' | 'lost';

export interface LecturePart {
  lectureId: string;
  part: number;
  taskRef: string | null;
  status: PartStatus;
  startedAt: number;
  lastHeartbeatAt: number | null;
  recordingStartedAt: number | null;
  lastSegmentAt: number | null;
  endedAt: number | null;
  segments: number;
  bytes: number;
  durationSeconds: number | null;
  result: PartResult | null;
  error: string | null;
  interrupted: boolean;
}

interface PartRow {
  lecture_id: string;
  part: number;
  task_ref: string | null;
  status: PartStatus;
  started_at: number;
  last_heartbeat_at: number | null;
  recording_started_at: number | null;
  last_segment_at: number | null;
  ended_at: number | null;
  segments: number;
  bytes: number;
  duration_seconds: number | null;
  result: PartResult | null;
  error: string | null;
  interrupted: number;
}

const toPart = (row: PartRow): LecturePart => ({
  lectureId: row.lecture_id,
  part: row.part,
  taskRef: row.task_ref,
  status: row.status,
  startedAt: row.started_at,
  lastHeartbeatAt: row.last_heartbeat_at,
  recordingStartedAt: row.recording_started_at,
  lastSegmentAt: row.last_segment_at,
  endedAt: row.ended_at,
  segments: row.segments,
  bytes: row.bytes,
  durationSeconds: row.duration_seconds,
  result: row.result,
  error: row.error,
  interrupted: row.interrupted === 1,
});

export const insertPart = (lectureId: string, part: number, tokenHash: string): void => {
  run('INSERT INTO lecture_parts (lecture_id, part, token_hash, status, started_at) VALUES (?, ?, ?, ?, ?)',
    lectureId, part, tokenHash, 'starting', Date.now());
  run('UPDATE lectures SET part_count = ? WHERE id = ? AND part_count < ?', part, lectureId, part);
};

export const getPartByToken = (tokenHash: string): LecturePart | undefined => {
  const row = get<PartRow>('SELECT * FROM lecture_parts WHERE token_hash = ?', tokenHash);
  return row ? toPart(row) : undefined;
};

export const getPart = (lectureId: string, part: number): LecturePart | undefined => {
  const row = get<PartRow>('SELECT * FROM lecture_parts WHERE lecture_id = ? AND part = ?', lectureId, part);
  return row ? toPart(row) : undefined;
};

export const listParts = (lectureId: string): LecturePart[] =>
  all<PartRow>('SELECT * FROM lecture_parts WHERE lecture_id = ? ORDER BY part', lectureId).map(toPart);

export type PartPatch = Partial<Pick<LecturePart,
  'taskRef' | 'status' | 'lastHeartbeatAt' | 'recordingStartedAt' | 'lastSegmentAt' | 'endedAt' | 'segments' |
  'bytes' | 'durationSeconds' | 'result' | 'error' | 'interrupted'>>;

const COLUMNS: Record<keyof PartPatch, string> = {
  taskRef: 'task_ref',
  status: 'status',
  lastHeartbeatAt: 'last_heartbeat_at',
  recordingStartedAt: 'recording_started_at',
  lastSegmentAt: 'last_segment_at',
  endedAt: 'ended_at',
  segments: 'segments',
  bytes: 'bytes',
  durationSeconds: 'duration_seconds',
  result: 'result',
  error: 'error',
  interrupted: 'interrupted',
};

export const updatePart = (lectureId: string, part: number, patch: PartPatch): void => {
  const keys = (Object.keys(patch) as Array<keyof PartPatch>).filter((key) => patch[key] !== undefined);
  if (keys.length === 0) return;
  const values = keys.map((key) => {
    const value = patch[key];
    return typeof value === 'boolean' ? (value ? 1 : 0) : (value as string | number | null);
  });
  run(`UPDATE lecture_parts SET ${keys.map((key) => `${COLUMNS[key]} = ?`).join(', ')} WHERE lecture_id = ? AND part = ?`,
    ...values, lectureId, part);
};

export const setStopRequested = (lectureId: string): void => {
  run('UPDATE lectures SET stop_requested = 1 WHERE id = ?', lectureId);
};

export const isStopRequested = (lectureId: string): boolean =>
  (get<{ stop_requested: number }>('SELECT stop_requested FROM lectures WHERE id = ?', lectureId)?.stop_requested ?? 0) === 1;
