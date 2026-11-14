import express, { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import config from '../config';
import {
  assertValidPassword, authenticate, clearSessionCookie, createSession, destroySession, destroyUserSessions,
  hashPassword, HttpError, loginLimiter, requireAdmin, requireAuth, sameOriginOnly, setSessionCookie, verifyPassword,
} from '../auth';
import { run } from '../db';
import {
  createUser, getPasswordHash, getUser, getUserWithHash, listUsers, setPassword, setUserSubjects, updateUser, User,
} from '../db/users';
import {
  createSubject, getSubject, getSubjectByName, listSubjects, listSubjectsForUser, updateSubject,
} from '../db/subjects';
import { countArchive, countWaitingUploads, isFinal, listLectures, sumLocalRecordingBytes } from '../db/lectures';
import { archiveEnabled, checkBucket, downloadUrl } from '../archive/s3';
import { archiveWorker, getDbBackupState } from '../archive/ArchiveWorker';
import { lectureManager, LectureView } from '../lectures/LectureManager';
import { uploadWorker } from '../youtube/UploadWorker';
import * as youtube from '../youtube/client';

/**
 * The dashboard's API (ui/ talks to nothing else). Everything except sign-in needs a session;
 * /api/admin/* needs the admin account. Instructors only ever see their own lectures.
 *
 *   POST   /api/auth/login | logout | password        GET /api/auth/me
 *   GET    /api/lectures                              newest first, ?before=<createdAt> pages back
 *   POST   /api/lectures            { url, subjectId, topic? }     start the recorder
 *   POST   /api/lectures/:id/stop                     leave the meeting, save the recording
 *   POST   /api/lectures/:id/retry-upload             send it to YouTube again
 *   GET    /api/lectures/:id/logs | file              activity log, server copy of the recording
 *   GET    /api/events                                live updates (Server-Sent Events)
 *   GET/POST/PATCH /api/admin/users[/:id]             instructor accounts and their subjects
 *   GET/POST/PATCH /api/admin/subjects[/:id]          subjects (one YouTube playlist each)
 *   GET    /api/admin/system                          capacity, disk, YouTube connection
 *   GET    /api/admin/youtube/connect                 start the one-time YouTube sign-in
 *   POST   /api/admin/youtube/disconnect
 */

const router = express.Router();

type Handler = (req: Request, res: Response) => unknown;
const wrap = (handler: Handler) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = handler(req, res);
    if (result instanceof Promise) result.catch(next);
  } catch (error) {
    next(error);
  }
};

const ok = (res: Response, data?: unknown, status = 200) => res.status(status).json({ success: true, data });
const me = (req: Request) => req.user as User;

const text = (value: unknown, label: string, max: number): string => {
  const cleaned = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!cleaned) throw new HttpError(400, `${label} is required.`);
  if (cleaned.length > max) throw new HttpError(400, `${label} is too long (max ${max} characters).`);
  return cleaned;
};

const email = (value: unknown): string => {
  const cleaned = text(value, 'Email', 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) throw new HttpError(400, 'That email address does not look right.');
  return cleaned;
};

const idParam = (req: Request): number => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found.');
  return id;
};

/** Accepts a playlist id or a full youtube.com/playlist?list=... link. */
const playlistId = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim();
  const id = raw.match(/[?&]list=([A-Za-z0-9_-]+)/)?.[1] ?? raw;
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(id)) throw new HttpError(400, 'That does not look like a YouTube playlist link or id.');
  return id;
};

const publicUser = (user: User) => ({
  id: user.id, email: user.email, name: user.name, role: user.role, mustChangePassword: user.mustChangePassword,
});

const systemInfo = () => ({ ...lectureManager.counts(), youtubeConnected: youtube.isConnected() });

router.use(authenticate);
router.use(sameOriginOnly);
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// ------------------------------------------------------------------------ auth

router.post('/auth/login', wrap(async (req, res) => {
  const address = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!address || !password) throw new HttpError(400, 'Enter your email and password.');

  const key = loginLimiter.key(req, address);
  if (loginLimiter.blocked(key)) {
    throw new HttpError(429, 'Too many wrong attempts. Wait 15 minutes and try again.');
  }

  const found = getUserWithHash(address);
  // Always run a hash comparison so a missing account takes as long as a wrong password
  const valid = await verifyPassword(password, found?.passwordHash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
  if (!found || !valid || !found.user.active) {
    loginLimiter.fail(key);
    throw new HttpError(401, found && valid && !found.user.active
      ? 'This account has been switched off. Ask the admin.'
      : 'Wrong email or password.');
  }

  loginLimiter.clear(key);
  setSessionCookie(req, res, createSession(found.user.id));
  ok(res, { user: publicUser(found.user) });
}));

router.post('/auth/logout', wrap((req, res) => {
  if (req.sessionToken) destroySession(req.sessionToken);
  clearSessionCookie(res);
  ok(res);
}));

router.get('/auth/me', requireAuth, wrap((req, res) => {
  ok(res, { user: publicUser(me(req)), subjects: listSubjectsForUser(me(req)), info: systemInfo() });
}));

router.post('/auth/password', requireAuth, wrap(async (req, res) => {
  const user = me(req);
  const current = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
  const next = req.body?.newPassword;
  assertValidPassword(next);
  if (!await verifyPassword(current, getPasswordHash(user.id) ?? '')) {
    throw new HttpError(400, 'The current password is not right.');
  }
  if (next === current) throw new HttpError(400, 'Choose a password that is different from the current one.');

  setPassword(user.id, await hashPassword(next), false);
  destroyUserSessions(user.id, req.sessionToken); // sign out everywhere else
  ok(res, { user: publicUser(getUser(user.id) as User) });
}));

// -------------------------------------------------------------------- lectures

router.get('/lectures', requireAuth, wrap((req, res) => {
  const user = me(req);
  const number = (value: unknown) => (value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : undefined);
  const lectures = listLectures({
    instructorId: user.role === 'admin' ? number(req.query.instructorId) : user.id,
    subjectId: number(req.query.subjectId),
    before: number(req.query.before),
    limit: number(req.query.limit),
  });
  ok(res, lectures.map((lecture) => lectureManager.view(lecture)));
}));

router.post('/lectures', requireAuth, wrap((req, res) => {
  const lecture = lectureManager.create(me(req), {
    url: req.body?.url, subjectId: req.body?.subjectId, topic: req.body?.topic,
  });
  ok(res, lecture, 202);
}));

router.post('/lectures/:id/stop', requireAuth, wrap((req, res) => {
  ok(res, lectureManager.stop(me(req), req.params.id));
}));

router.post('/lectures/:id/retry-upload', requireAuth, wrap((req, res) => {
  const lecture = lectureManager.getFor(me(req), req.params.id);
  if (!isFinal(lecture.status) || !lecture.fileName) throw new HttpError(409, 'There is no recording to upload for this lecture.');
  if (lecture.uploadStatus === 'done') throw new HttpError(409, 'This lecture is already on YouTube.');
  if (lecture.uploadStatus === 'uploading') throw new HttpError(409, 'This lecture is being uploaded right now.');
  if (!lecture.youtubeVideoId && !lectureManager.recordingPath(lecture)) {
    throw new HttpError(409, 'The recording file is no longer on the server.');
  }
  uploadWorker.retry(lecture.id);
  ok(res, lectureManager.view(lectureManager.getFor(me(req), req.params.id)));
}));

router.get('/lectures/:id/logs', requireAuth, wrap((req, res) => {
  const lecture = lectureManager.getFor(me(req), req.params.id);
  ok(res, lectureManager.logsFor(lecture.id));
}));

router.get('/lectures/:id/file', requireAuth, wrap(async (req, res) => {
  const lecture = lectureManager.getFor(me(req), req.params.id);
  const file = lectureManager.recordingPath(lecture);
  if (file) {
    if (req.query.download) res.download(file);
    else res.sendFile(file); // supports Range requests, so a <video> player can seek
    return;
  }
  // The server copy has been cleaned up: hand out a short-lived link to the S3 backup instead
  const view = lectureManager.view(lecture);
  if (view.backupInDeepArchive) {
    throw new HttpError(409, 'The backup copy is in S3 Glacier Deep Archive. Restore it in the S3 console first (up to 12 hours); the video is still on YouTube.');
  }
  if (archiveEnabled() && view.backupAvailable && lecture.archiveKey && lecture.fileName) {
    res.redirect(await downloadUrl(lecture.archiveKey, lecture.fileName.split('/').pop() as string));
    return;
  }
  throw new HttpError(404, 'This recording is no longer stored on the server.');
}));

router.post('/lectures/:id/retry-backup', requireAuth, wrap((req, res) => {
  const lecture = lectureManager.getFor(me(req), req.params.id);
  if (!archiveEnabled()) throw new HttpError(409, 'S3 backups are not switched on.');
  if (lecture.archiveStatus === 'done') throw new HttpError(409, 'This recording is already backed up.');
  if (lecture.archiveStatus === 'uploading') throw new HttpError(409, 'This recording is being backed up right now.');
  if (!lectureManager.recordingPath(lecture)) throw new HttpError(409, 'The recording file is no longer on the server.');
  archiveWorker.retry(lecture.id);
  ok(res, lectureManager.view(lectureManager.getFor(me(req), req.params.id)));
}));

// ---------------------------------------------------------- live event stream

router.get('/events', requireAuth, (req: Request, res: Response) => {
  const user = me(req);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const mine = (instructorId: number) => user.role === 'admin' || instructorId === user.id;

  // Tells a (re)connecting dashboard to reload its lists; after that it only needs the changes
  send('hello', { info: systemInfo() });

  const onLecture = (lecture: LectureView) => {
    if (mine(lecture.instructorId)) send('lecture', { lecture, info: systemInfo() });
  };
  const onLog = (payload: { id: string; instructorId: number; entry: unknown }) => {
    if (mine(payload.instructorId)) send('log', { id: payload.id, entry: payload.entry });
  };
  lectureManager.on('lecture', onLecture);
  lectureManager.on('log', onLog);

  // Keeps proxies and browsers from closing an idle connection
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    lectureManager.off('lecture', onLecture);
    lectureManager.off('log', onLog);
  });
});

// ------------------------------------------------------------- admin: accounts

const adminUsers = () => listUsers().map((user) => ({
  ...publicUser(user), active: user.active, createdAt: user.createdAt, subjectIds: user.subjectIds, lectureCount: user.lectureCount,
}));

const subjectIds = (value: unknown): number[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new HttpError(400, 'subjectIds must be a list.');
  const ids = value.map(Number);
  if (ids.some((id) => !getSubject(id))) throw new HttpError(400, 'One of the chosen subjects does not exist.');
  return ids;
};

router.get('/admin/users', requireAdmin, wrap((req, res) => ok(res, adminUsers())));

router.post('/admin/users', requireAdmin, wrap(async (req, res) => {
  const address = email(req.body?.email);
  const name = text(req.body?.name, 'Name', 80);
  assertValidPassword(req.body?.password);
  const subjects = subjectIds(req.body?.subjectIds) ?? [];
  if (getUserWithHash(address)) throw new HttpError(409, 'An account with this email already exists.');

  const user = createUser({
    email: address, name, role: 'instructor',
    passwordHash: await hashPassword(req.body.password),
    mustChangePassword: true, // the admin chose this password, so the instructor replaces it at first sign-in
  });
  setUserSubjects(user.id, subjects);
  ok(res, adminUsers(), 201);
}));

router.patch('/admin/users/:id', requireAdmin, wrap(async (req, res) => {
  const id = idParam(req);
  const target = getUser(id);
  if (!target) throw new HttpError(404, 'Account not found.');
  const body = req.body ?? {};

  if (body.active === false && id === me(req).id) throw new HttpError(400, 'You cannot switch off your own account.');
  if (body.email !== undefined) {
    const address = email(body.email);
    const other = getUserWithHash(address);
    if (other && other.user.id !== id) throw new HttpError(409, 'An account with this email already exists.');
    updateUser(id, { email: address });
  }
  if (body.name !== undefined) updateUser(id, { name: text(body.name, 'Name', 80) });
  if (typeof body.active === 'boolean') {
    updateUser(id, { active: body.active });
    if (!body.active) destroyUserSessions(id);
  }
  if (body.password !== undefined) {
    assertValidPassword(body.password);
    // A password set by someone else is temporary; the admin's own change is final
    setPassword(id, await hashPassword(body.password), id !== me(req).id);
    destroyUserSessions(id, id === me(req).id ? req.sessionToken : undefined);
  }
  const subjects = subjectIds(body.subjectIds);
  if (subjects && target.role === 'instructor') setUserSubjects(id, subjects);

  ok(res, adminUsers());
}));

// ------------------------------------------------------------- admin: subjects

const adminSubjects = () => listSubjects().map((subject) => ({
  ...subject,
  playlistUrl: subject.playlistId ? `https://www.youtube.com/playlist?list=${subject.playlistId}` : null,
}));

router.get('/subjects', requireAuth, wrap((req, res) => ok(res, listSubjectsForUser(me(req)))));
router.get('/admin/subjects', requireAdmin, wrap((req, res) => ok(res, adminSubjects())));

router.post('/admin/subjects', requireAdmin, wrap(async (req, res) => {
  const name = text(req.body?.name, 'Subject name', 100);
  if (getSubjectByName(name)) throw new HttpError(409, 'A subject with this name already exists.');
  let playlist = playlistId(req.body?.playlistId);

  // Create the playlist now when we can; otherwise it is created with the subject's first upload
  let warning: string | undefined;
  if (!playlist && youtube.isConnected()) {
    try {
      playlist = await youtube.createPlaylist(name);
    } catch (error) {
      warning = `The subject was created, but its YouTube playlist could not be made yet (${(error as Error).message}). It will be created with the first upload.`;
    }
  }
  createSubject(name, playlist);
  res.status(201).json({ success: true, data: adminSubjects(), warning });
}));

router.patch('/admin/subjects/:id', requireAdmin, wrap((req, res) => {
  const id = idParam(req);
  if (!getSubject(id)) throw new HttpError(404, 'Subject not found.');
  const body = req.body ?? {};

  if (body.name !== undefined) {
    const name = text(body.name, 'Subject name', 100);
    const other = getSubjectByName(name);
    if (other && other.id !== id) throw new HttpError(409, 'A subject with this name already exists.');
    updateSubject(id, { name });
  }
  if (typeof body.archived === 'boolean') updateSubject(id, { archived: body.archived });
  if (body.playlistId !== undefined) updateSubject(id, { playlistId: playlistId(body.playlistId) });
  ok(res, adminSubjects());
}));

// --------------------------------------------------------------- admin: system

const diskInfo = () => {
  try {
    fs.mkdirSync(config.recordingsDir, { recursive: true });
    const stats = fs.statfsSync(config.recordingsDir);
    return { freeBytes: Number(stats.bavail) * Number(stats.bsize), totalBytes: Number(stats.blocks) * Number(stats.bsize) };
  } catch {
    return { freeBytes: null, totalBytes: null };
  }
};

router.get('/admin/system', requireAdmin, wrap(async (req, res) => {
  const archive = archiveEnabled()
    ? {
      enabled: true,
      bucket: config.archive.bucket,
      prefix: config.archive.prefix,
      region: config.archive.region,
      storageClass: config.archive.storageClass,
      problem: await checkBucket(),
      ...countArchive(),
      dbBackup: getDbBackupState(),
    }
    : { enabled: false };
  ok(res, {
    ...lectureManager.counts(),
    youtube: youtube.getStatus(),
    archive,
    waitingUploads: countWaitingUploads(),
    disk: { ...diskInfo(), recordingsBytes: sumLocalRecordingBytes() },
    settings: {
      botName: config.botName,
      retentionDays: config.localRetentionDays,
      maxHours: config.lectureMaxHours,
      aloneExitMinutes: config.lectureAloneExitMinutes,
      minUploadSeconds: config.minUploadSeconds,
      publicUrl: config.publicUrl,
    },
  });
}));

// -------------------------------------------------------------- admin: YouTube

router.get('/admin/youtube/connect', requireAdmin, wrap((req, res) => {
  if (!youtube.isConfigured()) {
    throw new HttpError(400, 'Enter the YouTube app client ID and secret under Settings first (see docs/SETUP.md).');
  }
  res.redirect(youtube.buildAuthUrl());
}));

// Google sends the admin's browser back here after the consent screen
router.get('/youtube/callback', requireAdmin, wrap(async (req, res) => {
  const back = (params: Record<string, string>) => res.redirect(`/?${new URLSearchParams(params)}#settings`);
  if (!youtube.consumeState(req.query.state)) {
    back({ youtube_error: 'The sign-in took too long or was started elsewhere. Press Connect YouTube again.' });
    return;
  }
  if (typeof req.query.code !== 'string') {
    back({ youtube_error: req.query.error === 'access_denied' ? 'Access was not granted.' : 'Google did not complete the sign-in.' });
    return;
  }
  try {
    await youtube.completeSignIn(req.query.code);
  } catch (error) {
    back({ youtube_error: (error as Error).message });
    return;
  }
  // Recordings that were waiting for a connection can go now
  run('UPDATE lectures SET upload_next_at = NULL, upload_error = NULL WHERE upload_status = \'pending\'');
  uploadWorker.wake();
  back({ youtube: 'connected' });
}));

// The Google OAuth client (alternative to YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET on the server)
router.put('/admin/youtube/credentials', requireAdmin, wrap((req, res) => {
  if (youtube.getStatus().credentialsSource === 'environment') {
    throw new HttpError(409, 'The YouTube app is set on the server (YOUTUBE_CLIENT_ID), so it cannot be changed here.');
  }
  const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.trim() : '';
  const clientSecret = typeof req.body?.clientSecret === 'string' ? req.body.clientSecret.trim() : '';
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new HttpError(400, 'The client ID should end in .apps.googleusercontent.com (copy it from Google Cloud → Clients).');
  }
  if (clientSecret.length < 10 || clientSecret.length > 200 || /\s/.test(clientSecret)) {
    throw new HttpError(400, 'That client secret does not look right.');
  }
  youtube.saveCredentials(clientId, clientSecret);
  ok(res, youtube.getStatus());
}));

router.post('/admin/youtube/disconnect', requireAdmin, wrap((req, res) => {
  youtube.disconnect();
  ok(res, youtube.getStatus());
}));

// ----------------------------------------------------------------------- errors

router.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found.' });
});

router.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.httpStatus).json({ success: false, error: error.message });
    return;
  }
  if ((error as { type?: string })?.type === 'entity.parse.failed') {
    res.status(400).json({ success: false, error: 'The request was not valid JSON.' });
    return;
  }
  console.error('API error:', error);
  res.status(500).json({ success: false, error: 'Something went wrong on the server.' });
});

export default router;
