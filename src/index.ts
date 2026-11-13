// Ensure global Web Crypto API is available (needed by Azure SDK, polyfill for older Node versions)
import './shims/crypto-polyfill';
import http from 'http';
import app, { redisConsumerService, setGracefulShutdown } from './app';
import { globalJobStore } from './lib/globalJobStore';
import messageBroker from './connect/messageBroker';
import config from './config';
import { isPodMarkedForDeletion } from './util/k8sLifecycle';
import { loggerFactory } from './util/logger';
import { lectureManager } from './lectures/LectureManager';
import { uploadWorker } from './youtube/UploadWorker';
import { archiveWorker } from './archive/ArchiveWorker';
import { ensureAdminAccount, purgeExpiredSessions } from './auth';
import { closeDb, getDb } from './db';
import { spawn } from 'child_process';

const port = config.port;

// Create Express server
const server = http.createServer(app);

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Close the other program (or an already running Meeting Bot), or start with a different port: PORT=3001`);
  } else {
    console.error('Server error:', error);
  }
  process.exit(1);
});

// Prepare everything the dashboard needs, then start accepting requests
async function start() {
  getDb(); // opens data/meetingbot.db and applies schema changes
  await ensureAdminAccount();
  purgeExpiredSessions();
  lectureManager.recoverAfterRestart();
  lectureManager.startEngine();
  uploadWorker.start();
  archiveWorker.start();

  server.listen(port, config.host, () => {
    const url = `http://localhost:${port}`;
    console.log(`Server is running on ${url}`);
    if (process.env.OPEN_BROWSER === 'true') {
      openInBrowser(url);
    }
  });
}

start().catch((error) => {
  console.error('Could not start the server:', error);
  process.exit(1);
});

// Open the dashboard in the user's default browser (used by the start scripts)
function openInBrowser(url: string) {
  const [command, args]: [string, string[]] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] :
    process.platform === 'darwin' ? ['open', [url]] :
    ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.log(`Open ${url} in your browser to use the dashboard.`));
  child.unref();
}

// Detect the "SIGTERM lost during ContainerCreating" race: if K8s marked us for deletion
// before the container's PID 1 existed, the SIGTERM was silently dropped. Without this
// check, the bot would run normally for the full terminationGracePeriodSeconds.
//
// 10s delay so kubelet has first chance to deliver SIGTERM via the normal path
// (when it does work) — this check is the fallback for the broken case. Safe even
// if SIGTERM also fires: initiateGracefulShutdown is idempotent (guards on shutdownInProgress).
const startupLogger = loggerFactory('startup', 'system');
setTimeout(() => {
  isPodMarkedForDeletion(startupLogger)
    .then((isDeleted) => {
      if (isDeleted) {
        console.log('Pod marked for deletion at startup — initiating graceful shutdown');
        initiateGracefulShutdown();
      }
    })
    .catch((err) => {
      console.error('Startup pod-deletion check threw (continuing normal startup):', err);
    });
}, 10000);

// Flag to prevent multiple shutdown attempts
let shutdownInProgress = false;

const initiateGracefulShutdown = async () => {
  if (shutdownInProgress) {
    console.log('Shutdown already in progress, ignoring signal');
    return;
  }

  shutdownInProgress = true;
  console.log('Initiating graceful shutdown...');

  try {
    // Set the graceful shutdown flag
    setGracefulShutdown(1);

    // Request shutdown on the job store (prevents new jobs from being accepted)
    globalJobStore.requestShutdown();

    // Meetings started from the dashboard: leave them and save what has been recorded so far
    const { active } = lectureManager.counts();
    if (active > 0) {
      console.log(`Stopping ${active} recording(s) and saving them - press Ctrl+C again to quit immediately.`);
    }
    uploadWorker.stop();
    archiveWorker.stop();
    await lectureManager.shutdown();

    // Wait for ongoing tasks to complete (no timeout - wait indefinitely)
    await globalJobStore.waitForCompletion();

    // Now proceed with application shutdown
    gracefulShutdownApp();
  } catch (error) {
    console.error('Error during graceful shutdown:', error);
    // Force exit if graceful shutdown fails
    process.exit(1);
  }
};

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received. Starting Graceful Shutdown');
  initiateGracefulShutdown();
});

process.on('SIGINT', () => {
  if (shutdownInProgress) {
    console.log('Second Ctrl+C - quitting immediately.');
    process.exit(1);
  }
  console.log('SIGINT signal received. Starting Graceful Shutdown');
  initiateGracefulShutdown();
});

process.on('SIGHUP', () => {
  // The terminal window running the launcher was closed: save recordings before exiting
  console.log('SIGHUP signal received. Starting Graceful Shutdown');
  initiateGracefulShutdown();
});

process.on('SIGABRT', () => {
  console.log('SIGABRT signal received. Starting Graceful Shutdown');
  initiateGracefulShutdown();
});

export const gracefulShutdownApp = () => {
  // Complete existing requests, close database connections, etc.
  // (dashboards hold long-lived event streams open, which would otherwise keep the server alive)
  server.closeAllConnections?.();
  server.close(async () => {
    console.log('HTTP server closed. Exiting application');

    // Only shutdown Redis services if Redis is enabled
    if (config.isRedisEnabled) {
      await redisConsumerService.shutdown();
      await messageBroker.quitClientGracefully();
    } else {
      console.log('Redis services not running - skipping Redis shutdown');
    }

    closeDb();
    console.log('Exiting.....');
    process.exit(0);
  });
};
