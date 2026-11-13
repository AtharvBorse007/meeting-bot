import { all, get, run } from './index';
import { User } from './users';

export interface Subject {
  id: number;
  name: string;
  playlistId: string | null;
  archived: boolean;
  createdAt: number;
}

interface SubjectRow {
  id: number;
  name: string;
  playlist_id: string | null;
  archived: number;
  created_at: number;
}

const toSubject = (row: SubjectRow): Subject => ({
  id: row.id,
  name: row.name,
  playlistId: row.playlist_id,
  archived: row.archived === 1,
  createdAt: row.created_at,
});

export const getSubject = (id: number): Subject | undefined => {
  const row = get<SubjectRow>('SELECT * FROM subjects WHERE id = ?', id);
  return row ? toSubject(row) : undefined;
};

export const getSubjectByName = (name: string): Subject | undefined => {
  const row = get<SubjectRow>('SELECT * FROM subjects WHERE name = ?', name.trim());
  return row ? toSubject(row) : undefined;
};

/** Every subject, for the admin screens. */
export const listSubjects = (): Array<Subject & { lectureCount: number; instructorIds: number[] }> => {
  const counts = all<{ subject_id: number; n: number }>('SELECT subject_id, COUNT(*) AS n FROM lectures GROUP BY subject_id');
  const assignments = all<{ user_id: number; subject_id: number }>('SELECT user_id, subject_id FROM instructor_subjects');
  return all<SubjectRow>('SELECT * FROM subjects ORDER BY archived, name COLLATE NOCASE').map((row) => ({
    ...toSubject(row),
    lectureCount: counts.find((c) => c.subject_id === row.id)?.n ?? 0,
    instructorIds: assignments.filter((a) => a.subject_id === row.id).map((a) => a.user_id),
  }));
};

/** The subjects a user may start a recording for: all of them for the admin, the assigned ones for an instructor. */
export const listSubjectsForUser = (user: User): Subject[] => {
  const rows = user.role === 'admin'
    ? all<SubjectRow>('SELECT * FROM subjects WHERE archived = 0 ORDER BY name COLLATE NOCASE')
    : all<SubjectRow>(
      `SELECT s.* FROM subjects s JOIN instructor_subjects i ON i.subject_id = s.id
       WHERE i.user_id = ? AND s.archived = 0 ORDER BY s.name COLLATE NOCASE`, user.id);
  return rows.map(toSubject);
};

export const createSubject = (name: string, playlistId?: string | null): Subject => {
  const result = run('INSERT INTO subjects (name, playlist_id, created_at) VALUES (?, ?, ?)', name.trim(), playlistId || null, Date.now());
  return getSubject(Number(result.lastInsertRowid)) as Subject;
};

export const updateSubject = (id: number, patch: { name?: string; archived?: boolean; playlistId?: string | null }): void => {
  if (patch.name !== undefined) run('UPDATE subjects SET name = ? WHERE id = ?', patch.name.trim(), id);
  if (patch.archived !== undefined) run('UPDATE subjects SET archived = ? WHERE id = ?', patch.archived ? 1 : 0, id);
  if (patch.playlistId !== undefined) run('UPDATE subjects SET playlist_id = ? WHERE id = ?', patch.playlistId || null, id);
};
