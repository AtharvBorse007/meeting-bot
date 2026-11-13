import { get, run } from './index';

/** Key/value store for the few things that are neither a user, a subject nor a lecture. */

export const getSetting = (key: string): string | undefined =>
  get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value;

export const setSetting = (key: string, value: string): void => {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
};

export const deleteSetting = (key: string): void => {
  run('DELETE FROM settings WHERE key = ?', key);
};

export const getJsonSetting = <T>(key: string): T | undefined => {
  const raw = getSetting(key);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
};

export const setJsonSetting = (key: string, value: unknown): void => setSetting(key, JSON.stringify(value));
