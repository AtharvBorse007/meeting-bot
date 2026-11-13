import { all, get, run, transaction } from './index';

export type Role = 'admin' | 'instructor';

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  active: boolean;
  createdAt: number;
}

interface UserRow {
  id: number;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  must_change_password: number;
  active: number;
  created_at: number;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  mustChangePassword: row.must_change_password === 1,
  active: row.active === 1,
  createdAt: row.created_at,
});

export const countUsers = (): number =>
  get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0;

export const getUser = (id: number): User | undefined => {
  const row = get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  return row ? toUser(row) : undefined;
};

/** For login only: the account together with its password hash. */
export const getUserWithHash = (email: string): { user: User; passwordHash: string } | undefined => {
  const row = get<UserRow>('SELECT * FROM users WHERE email = ?', email.trim());
  return row ? { user: toUser(row), passwordHash: row.password_hash } : undefined;
};

export const getPasswordHash = (id: number): string | undefined =>
  get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', id)?.password_hash;

export const listUsers = (): Array<User & { subjectIds: number[]; lectureCount: number }> => {
  const assignments = all<{ user_id: number; subject_id: number }>('SELECT user_id, subject_id FROM instructor_subjects');
  const counts = all<{ instructor_id: number; n: number }>('SELECT instructor_id, COUNT(*) AS n FROM lectures GROUP BY instructor_id');
  return all<UserRow>('SELECT * FROM users ORDER BY role, name COLLATE NOCASE').map((row) => ({
    ...toUser(row),
    subjectIds: assignments.filter((a) => a.user_id === row.id).map((a) => a.subject_id),
    lectureCount: counts.find((c) => c.instructor_id === row.id)?.n ?? 0,
  }));
};

export const createUser = (input: {
  email: string;
  name: string;
  role: Role;
  passwordHash: string;
  mustChangePassword: boolean;
}): User => {
  const result = run(
    'INSERT INTO users (email, name, role, password_hash, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    input.email.trim(), input.name.trim(), input.role, input.passwordHash, input.mustChangePassword ? 1 : 0, Date.now(),
  );
  return getUser(Number(result.lastInsertRowid)) as User;
};

export const updateUser = (id: number, patch: { name?: string; email?: string; active?: boolean }): void => {
  if (patch.name !== undefined) run('UPDATE users SET name = ? WHERE id = ?', patch.name.trim(), id);
  if (patch.email !== undefined) run('UPDATE users SET email = ? WHERE id = ?', patch.email.trim(), id);
  if (patch.active !== undefined) run('UPDATE users SET active = ? WHERE id = ?', patch.active ? 1 : 0, id);
};

export const setPassword = (id: number, passwordHash: string, mustChangePassword: boolean): void => {
  run('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?', passwordHash, mustChangePassword ? 1 : 0, id);
};

/** Replace the set of subjects an instructor may record for. */
export const setUserSubjects = (userId: number, subjectIds: number[]): void => {
  transaction(() => {
    run('DELETE FROM instructor_subjects WHERE user_id = ?', userId);
    for (const subjectId of new Set(subjectIds)) {
      run('INSERT INTO instructor_subjects (user_id, subject_id) VALUES (?, ?)', userId, subjectId);
    }
  });
};
