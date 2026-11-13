import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { NextFunction, Request, Response } from 'express';
import config from '../config';
import { get, run } from '../db';
import { countUsers, createUser, getUser, User } from '../db/users';

/**
 * Accounts and sign-in for the dashboard: scrypt password hashes, and a random session token kept
 * in an HttpOnly cookie (only its SHA-256 is stored). Nothing here needs an external service.
 */

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
    sessionToken?: string;
  }
}

export class HttpError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message);
  }
}

// ------------------------------------------------------------------ passwords

const scrypt = promisify(crypto.scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
export const MIN_PASSWORD_LENGTH = 8;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function assertValidPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `The password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  }
  if (password.length > 200) throw new HttpError(400, 'That password is too long.');
}

export const generatePassword = (): string => crypto.randomBytes(9).toString('base64url');

// ------------------------------------------------------------------- sessions

const COOKIE = 'mb_session';
const SESSION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  run('INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    hashToken(token), userId, now, now + SESSION_DAYS * DAY_MS);
  return token;
}

export function destroySession(token: string): void {
  run('DELETE FROM auth_sessions WHERE token_hash = ?', hashToken(token));
}

/** Sign a user out everywhere (after a password change or when the account is switched off). */
export function destroyUserSessions(userId: number, exceptToken?: string): void {
  if (exceptToken) {
    run('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash <> ?', userId, hashToken(exceptToken));
  } else {
    run('DELETE FROM auth_sessions WHERE user_id = ?', userId);
  }
}

function userForToken(token: string): User | undefined {
  const now = Date.now();
  const row = get<{ user_id: number; expires_at: number }>(
    'SELECT user_id, expires_at FROM auth_sessions WHERE token_hash = ?', hashToken(token));
  if (!row || row.expires_at < now) return undefined;

  // Keep active users signed in: push the expiry forward at most once a day
  if (row.expires_at - now < (SESSION_DAYS - 1) * DAY_MS) {
    run('UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?', now + SESSION_DAYS * DAY_MS, hashToken(token));
  }
  const user = getUser(row.user_id);
  return user?.active ? user : undefined;
}

export function purgeExpiredSessions(): void {
  run('DELETE FROM auth_sessions WHERE expires_at < ?', Date.now());
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return undefined;
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_DAYS * DAY_MS,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE, { path: '/' });
}

// ----------------------------------------------------------------- middleware

/** Attaches req.user when the request carries a valid session cookie. */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const token = readCookie(req, COOKIE);
  if (token) {
    const user = userForToken(token);
    if (user) {
      req.user = user;
      req.sessionToken = token;
    }
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Please sign in.' });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Please sign in.' });
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Only the admin can do this.' });
    return;
  }
  next();
}

/**
 * Cross-site request protection for the cookie session: a request that changes something must
 * come from the dashboard's own origin. (The cookie is SameSite=Lax as well.)
 */
export function sameOriginOnly(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }
  const origin = req.headers.origin;
  if (origin) {
    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = undefined;
    }
    if (originHost !== req.headers.host) {
      res.status(403).json({ success: false, error: 'Request blocked: it did not come from this dashboard.' });
      return;
    }
  }
  next();
}

// ------------------------------------------------------ sign-in attempt limit

const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const failures = new Map<string, number[]>();

const recentFailures = (key: string): number[] => {
  const cutoff = Date.now() - FAILURE_WINDOW_MS;
  const recent = (failures.get(key) ?? []).filter((t) => t > cutoff);
  if (recent.length) failures.set(key, recent); else failures.delete(key);
  return recent;
};

export const loginLimiter = {
  key: (req: Request, email: string) => `${req.ip}|${email.trim().toLowerCase()}`,
  blocked: (key: string) => recentFailures(key).length >= MAX_FAILURES,
  fail: (key: string) => { failures.set(key, [...recentFailures(key), Date.now()]); },
  clear: (key: string) => { failures.delete(key); },
};

// --------------------------------------------------------------- first admin

/**
 * Creates the admin account when the database is empty. The password comes from ADMIN_PASSWORD;
 * without it a random one is generated, shown once in the server log and written to
 * data/initial-admin-password.txt. Either way it has to be changed at the first sign-in.
 */
export async function ensureAdminAccount(): Promise<void> {
  if (countUsers() > 0) return;

  const password = config.adminPassword || generatePassword();
  createUser({
    email: config.adminEmail,
    name: 'Admin',
    role: 'admin',
    passwordHash: await hashPassword(password),
    mustChangePassword: true,
  });

  console.log('');
  console.log('================ Admin account created ================');
  console.log(`  Sign in with:  ${config.adminEmail}`);
  if (config.adminPassword) {
    console.log('  Password:      the ADMIN_PASSWORD you configured');
  } else {
    const file = path.join(config.dataDir, 'initial-admin-password.txt');
    fs.writeFileSync(file, `${password}\n`, { mode: 0o600 });
    console.log(`  Password:      ${password}`);
    console.log(`  (also saved in ${file} - delete that file after signing in)`);
  }
  console.log('  You will be asked to choose a new password at the first sign-in.');
  console.log('=======================================================');
  console.log('');
}
