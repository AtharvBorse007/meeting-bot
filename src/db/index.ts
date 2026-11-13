import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import config from '../config';

/**
 * The app's database: one SQLite file (data/meetingbot.db) using Node's built-in driver, so there
 * is no database server to run or pay for. Schema changes are applied in order at start-up; the
 * position is tracked in PRAGMA user_version.
 */

const MIGRATIONS: string[] = [
  // 1 - accounts, subjects, lectures
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'instructor')),
    password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE subjects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    playlist_id TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE instructor_subjects (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, subject_id)
  );

  CREATE TABLE lectures (
    id TEXT PRIMARY KEY,
    instructor_id INTEGER NOT NULL REFERENCES users(id),
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    topic TEXT,
    url TEXT NOT NULL,
    meeting_code TEXT,
    bot_name TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    recording_started_at INTEGER,
    ended_at INTEGER,
    bytes_recorded INTEGER NOT NULL DEFAULT 0,
    file_name TEXT,
    file_size INTEGER,
    local_deleted_at INTEGER,
    upload_status TEXT NOT NULL DEFAULT 'none',
    upload_attempts INTEGER NOT NULL DEFAULT 0,
    upload_error TEXT,
    upload_next_at INTEGER,
    youtube_video_id TEXT,
    in_playlist INTEGER NOT NULL DEFAULT 0,
    uploaded_at INTEGER
  );
  CREATE INDEX lectures_by_instructor ON lectures (instructor_id, created_at DESC);
  CREATE INDEX lectures_by_created ON lectures (created_at DESC);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 2 - backup copy of each recording in S3
  `
  ALTER TABLE lectures ADD COLUMN archive_status TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE lectures ADD COLUMN archive_key TEXT;
  ALTER TABLE lectures ADD COLUMN archive_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lectures ADD COLUMN archive_error TEXT;
  ALTER TABLE lectures ADD COLUMN archive_next_at INTEGER;
  ALTER TABLE lectures ADD COLUMN archived_at INTEGER;
  `,
  // 3 - recorders that run outside this server (one or more "parts" per lecture)
  `
  CREATE TABLE lecture_parts (
    lecture_id TEXT NOT NULL REFERENCES lectures(id),
    part INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    task_ref TEXT,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    last_heartbeat_at INTEGER,
    recording_started_at INTEGER,
    last_segment_at INTEGER,
    ended_at INTEGER,
    segments INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER,
    result TEXT,
    error TEXT,
    interrupted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (lecture_id, part)
  );
  ALTER TABLE lectures ADD COLUMN stop_requested INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lectures ADD COLUMN part_count INTEGER NOT NULL DEFAULT 0;
  `,
];

let db: DatabaseSync | undefined;

export function getDb(): DatabaseSync {
  if (db) return db;

  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const database = new DatabaseSync(config.dbPath);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  const current = Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  for (let version = current; version < MIGRATIONS.length; version++) {
    database.exec('BEGIN');
    try {
      database.exec(MIGRATIONS[version]);
      database.exec(`PRAGMA user_version = ${version + 1}`);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  db = database;
  return database;
}

export function closeDb(): void {
  db?.close();
  db = undefined;
}

type Param = string | number | null;

/** Small typed helpers over prepared statements. */
export const run = (sql: string, ...params: Param[]) => getDb().prepare(sql).run(...params);
export const get = <T>(sql: string, ...params: Param[]) => getDb().prepare(sql).get(...params) as T | undefined;
export const all = <T>(sql: string, ...params: Param[]) => getDb().prepare(sql).all(...params) as T[];

export function transaction<T>(work: () => T): T {
  const database = getDb();
  database.exec('BEGIN');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
