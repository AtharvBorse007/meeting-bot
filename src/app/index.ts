import express, { NextFunction, Request, Response } from 'express';
import client from 'prom-client';
import config, { NODE_ENV } from '../config';
import mainDebug from '../test/debug';
import googleRouter from './google';
import microsoftRouter from './microsoft';
import zoomRouter from './zoom';
import apiRouter from './api';
import internalRouter from './internal';
import { globalJobStore } from '../lib/globalJobStore';
import { RedisConsumerService } from '../connect/RedisConsumerService';

const app = express();

// Behind the HTTPS proxy (Caddy) the real client address and scheme arrive in X-Forwarded-* headers
if (config.trustProxy) {
  app.set('trust proxy', 1);
}
app.disable('x-powered-by');

// Recorder workers (own body parser: their status reports carry log lines)
app.use('/internal/worker', internalRouter);

app.use(express.json({ limit: '100kb' }));

// Initialize Redis consumer service
export const redisConsumerService = new RedisConsumerService();

let isbusy = 0;
let gracefulShutdown = 0;

app.get('/health', async (req, res) => {
  // Simple health check endpoint for Docker
  return res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

/**
 * The original service-to-service routes (join by POST, busy flags, metrics). They have no login,
 * so they stay off unless LEGACY_API_ENABLED=true - never enable that on a public address.
 */
if (config.legacyApiEnabled) {
  app.get('/isbusy', async (req, res) => {
    // Use the job store's isBusy status
    const jobStoreBusy = globalJobStore.isBusy() ? 1 : 0;
    return res.status(200).json({ success: true, data: jobStoreBusy });
  });

  // Create a Gauge metric for busy status (0 or 1)
  const busyStatus = new client.Gauge({
    name: 'isbusy',
    help: 'busy status of the pod (1 = busy, 0 = available)'
  });

  const isavailable = new client.Gauge({
    name: 'isavailable',
    help: 'available status of the pod (1 = available, 0 = busy)'
  });

  app.get('/metrics', async (req, res) => {
    // Use the job store's isBusy status for metrics
    const jobStoreBusy = globalJobStore.isBusy() ? 1 : 0;
    busyStatus.set(jobStoreBusy);
    isavailable.set(1 - jobStoreBusy);
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  });

  app.get('/debug', async (req, res, next) => {
    if (NODE_ENV === 'development') {
      next();
    }
    else {
      res.status(500).send({});
    }
  }, async (req, res) => {
    await mainDebug('baf14', 'https://www.github.com');
    res.status(200).send({});
  });

  app.use('/google', googleRouter);
  app.use('/microsoft', microsoftRouter);
  app.use('/zoom', zoomRouter);

  // Capacity: how many meetings are being recorded right now
  app.get('/status', async (req, res) => {
    return res.json({
      success: true,
      data: { active: globalJobStore.isBusy(), running: globalJobStore.activeCount(), capacity: globalJobStore.capacity },
    });
  });
}

// Dashboard: JSON/SSE API and the static UI
app.use('/api', apiRouter);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    'default-src \'self\'; img-src \'self\' data:; style-src \'self\' \'unsafe-inline\'; frame-ancestors \'none\'; base-uri \'self\'; form-action \'self\'');
  next();
});
app.use(express.static(config.uiDir, { index: 'index.html', maxAge: 0 }));

// Anything that slipped through (for example a request body that is not valid JSON)
app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const status = Number((error as { status?: number })?.status) || 500;
  if (status >= 500) console.error('Request failed:', error);
  res.status(status).json({ success: false, error: status === 400 ? 'The request could not be read.' : 'Something went wrong on the server.' });
});

export const setGracefulShutdown = (val: number) =>
  gracefulShutdown = val;

export const getGracefulShutdown = () => gracefulShutdown;

export const setIsBusy = (val: number) =>
  isbusy = val;

export const getIsBusy = () => isbusy;

// Start Redis consumer service only if Redis is enabled
if (config.isRedisEnabled) {
  redisConsumerService.start().catch((error) => {
    console.error('Failed to start Redis consumer service:', error);
  });
} else {
  console.info('Redis consumer service not started - Redis is disabled');
}

export default app;
