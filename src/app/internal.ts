import express, { NextFunction, Request, Response } from 'express';
import { lectureManager } from '../lectures/LectureManager';
import { LecturePart } from '../db/parts';

/**
 * What recorder workers (Fargate tasks) talk to. Each worker authenticates with the random token
 * it was started with, which only identifies its own part of its own lecture.
 *
 *   GET  /internal/worker/job         what to record
 *   POST /internal/worker/heartbeat   status every few seconds; the reply says whether to stop
 *   POST /internal/worker/finished    the result when it is done
 */

const router = express.Router();
router.use(express.json({ limit: '1mb' }));

const part = (req: Request): LecturePart => (req as Request & { part: LecturePart }).part;

router.use((req: Request, res: Response, next: NextFunction) => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const found = lectureManager.remote.partForToken(token);
  if (!found) {
    res.status(401).json({ success: false, error: 'Unknown recorder.' });
    return;
  }
  (req as Request & { part: LecturePart }).part = found;
  res.setHeader('Cache-Control', 'no-store');
  next();
});

router.get('/job', (req, res) => {
  const job = lectureManager.remote.job(part(req));
  if (!job) {
    res.status(404).json({ success: false, error: 'Lecture not found.' });
    return;
  }
  res.json({ success: true, data: job });
});

router.post('/heartbeat', (req, res) => {
  res.json({ success: true, data: lectureManager.remote.heartbeat(part(req), req.body ?? {}) });
});

router.post('/finished', (req, res) => {
  lectureManager.remote.finished(part(req), req.body ?? {});
  res.json({ success: true });
});

router.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  console.error('Recorder API error:', error);
  res.status(500).json({ success: false, error: 'Something went wrong on the server.' });
});

export default router;
