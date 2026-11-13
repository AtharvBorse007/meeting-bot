import dotenv from 'dotenv';
import path from 'path';
import { UploaderType } from './types';
dotenv.config();

const ENVIRONMENTS = [
  'production',
  'staging',
  'development',
  'cli',
  'test',
] as const;

export type Environment = (typeof ENVIRONMENTS)[number];
export const NODE_ENV: Environment = ENVIRONMENTS.includes(
  process.env.NODE_ENV as Environment
)
  ? (process.env.NODE_ENV as Environment)
  : 'staging';

console.log('NODE_ENV', process.env.NODE_ENV);

// GCP settings are only needed for the hosted (non-local) deployment.
const requiredSettings = process.env.UPLOADER_TYPE && process.env.UPLOADER_TYPE !== 'local' ? [
  'GCP_DEFAULT_REGION',
  'GCP_MISC_BUCKET',
] : [];
const missingSettings = requiredSettings.filter((s) => !process.env[s]);
if (missingSettings.length > 0) {
  missingSettings.forEach((ms) =>
    console.error(`ENV settings ${ms} is missing.`)
  );
}

const constructRedisUri = () => {
  const host = process.env.REDIS_HOST || 'redis';
  const port = process.env.REDIS_PORT || 6379;
  const username = process.env.REDIS_USERNAME;
  const password = process.env.REDIS_PASSWORD;

  if (username && password) {
    return `redis://${username}:${password}@${host}:${port}`;
  } else if (password) {
    return `redis://:${password}@${host}:${port}`;
  } else {
    return `redis://${host}:${port}`;
  }
};

const normalizeFileExtension = (extension?: string) => {
  if (!extension) return '.webm';
  return extension.startsWith('.') ? extension : `.${extension}`;
};

const parseOptionalNumber = (value?: string) => {
  if (typeof value === 'undefined' || value.trim() === '') return undefined;
  return Number(value);
};

// Project root, resolved from this file so it is the same under ts-node (src/) and tsc (dist/).
const projectRoot = path.resolve(__dirname, '..');

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
};

const parseNumber = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
};

const port = Number(process.env.PORT) || 3000;
const uploaderType = (process.env.UPLOADER_TYPE || 'local') as UploaderType;
// Everything the app must keep between restarts (database, temp recording chunks, lecture logs)
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(projectRoot, 'data');

export default {
  port,
  // Loopback by default; the Docker image sets HOST=0.0.0.0 and sits behind the HTTPS proxy.
  host: process.env.HOST || '127.0.0.1',
  // The address people type to reach the dashboard. Used for the YouTube sign-in redirect.
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  // Set when running behind a reverse proxy (Caddy/nginx) so client IPs and https are detected
  trustProxy: process.env.TRUST_PROXY === 'true',
  projectRoot,
  dataDir,
  dbPath: path.join(dataDir, 'meetingbot.db'),
  lectureLogsDir: path.join(dataDir, 'lecture-logs'),
  // Recording chunks are written here while a meeting is in progress
  tempVideoDir: process.env.TEMP_VIDEO_DIR
    ? path.resolve(process.env.TEMP_VIDEO_DIR)
    : uploaderType === 'local' ? path.join(dataDir, 'tmp') : path.join(process.cwd(), 'dist', '_tempvideo'),
  // First admin account, created when the database has no users yet
  adminEmail: process.env.ADMIN_EMAIL || 'admin@example.com',
  adminPassword: process.env.ADMIN_PASSWORD,
  // Name the bot shows in the meeting
  botName: process.env.BOT_NAME || 'Lecture Recorder',
  // Lecture rules: the bot stays through silence and only leaves when the lecture is really over
  lectureAloneExitMinutes: parseNumber(process.env.LECTURE_ALONE_EXIT_MINUTES, 10),
  lectureInitialAloneMinutes: parseNumber(process.env.LECTURE_INITIAL_ALONE_MINUTES, 20),
  lectureMaxHours: parseNumber(process.env.LECTURE_MAX_HOURS, 5),
  // Recordings shorter than this are kept on the server but not sent to YouTube (accidental starts)
  minUploadSeconds: process.env.MIN_UPLOAD_SECONDS !== undefined && process.env.MIN_UPLOAD_SECONDS !== '' ? Math.max(0, Number(process.env.MIN_UPLOAD_SECONDS) || 0) : 60,
  // Recording quality. 800 kbps video + 64 kbps audio is roughly 0.4 GB per lecture hour.
  recordingVideoKbps: parseNumber(process.env.RECORDING_VIDEO_KBPS, 800),
  recordingAudioKbps: parseNumber(process.env.RECORDING_AUDIO_KBPS, 64),
  // VP8 needs far less CPU to encode than VP9, which matters with several recorders on a small server
  recordingCodec: (process.env.RECORDING_CODEC === 'vp9' ? 'vp9' : 'vp8') as 'vp8' | 'vp9',
  // Lectures are mostly slides and faces; 15 frames per second halves the encoding work of 30
  recordingFps: parseNumber(process.env.RECORDING_FPS, 15),
  // Below this much free disk space, server copies that are already on YouTube are removed early,
  // and below a quarter of it new recordings are refused
  lowDiskGb: parseNumber(process.env.LOW_DISK_GB, 15),
  // Permanent backup copy of every recording (and daily database backups) in S3. Off when no bucket is set.
  // Credentials come from the usual AWS chain: the EC2 instance role on AWS, or AWS_ACCESS_KEY_ID etc.
  archive: {
    bucket: process.env.ARCHIVE_S3_BUCKET || '',
    region: process.env.ARCHIVE_S3_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1',
    prefix: (process.env.ARCHIVE_S3_PREFIX || '').replace(/^\/+|\/+$/g, ''),
    storageClass: process.env.ARCHIVE_S3_STORAGE_CLASS || 'STANDARD_IA',
    // Only for S3-compatible stores and tests (MinIO, a fake S3)
    endpoint: process.env.ARCHIVE_S3_ENDPOINT || undefined,
    forcePathStyle: process.env.ARCHIVE_S3_FORCE_PATH_STYLE === 'true',
    // Hour of the day (server time zone) for the daily database backup
    dbBackupHour: Math.min(23, Math.max(0, Number(process.env.DB_BACKUP_HOUR ?? 3) || 0)),
    // The S3 lifecycle moves recordings to Glacier Deep Archive after this many days (0 = never).
    // Those need a restore (hours) before they can be downloaded again.
    deepArchiveDays: Math.max(0, Number(process.env.ARCHIVE_DEEP_ARCHIVE_DAYS ?? 0) || 0),
  },
  /**
   * Where the recorder browsers run:
   *   inprocess  inside this server (one machine does everything; the default)
   *   ecs        one AWS Fargate task per lecture, started on demand and gone afterwards (pay per use)
   *   process    one local worker process per lecture - the ECS design on one machine (development/tests)
   * In ecs/process mode recordings are streamed to the S3 bucket in short segments while recording.
   */
  recorderMode: (['ecs', 'process'].includes(process.env.RECORDER_MODE ?? '') ? process.env.RECORDER_MODE : 'inprocess') as 'inprocess' | 'ecs' | 'process',
  recorder: {
    // Address the recorder workers use to reach this server (defaults to PUBLIC_URL)
    controlUrl: (process.env.CONTROL_URL || process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    // A recorder uploads what it has recorded this often, so a crash loses at most this much
    segmentSeconds: parseNumber(process.env.RECORDER_SEGMENT_SECONDS, 30),
    heartbeatSeconds: parseNumber(process.env.RECORDER_HEARTBEAT_SECONDS, 5),
    // No word from a recorder for this long: it is replaced by a new one that rejoins the meeting
    heartbeatTimeoutSeconds: parseNumber(process.env.RECORDER_HEARTBEAT_TIMEOUT_SECONDS, 60),
    // A new recorder that hasn't reported in by then is considered failed and started again
    startTimeoutSeconds: parseNumber(process.env.RECORDER_START_TIMEOUT_SECONDS, 360),
    // How many recorders one lecture may use in total (the first one plus replacements)
    maxParts: parsePositiveInt(process.env.RECORDER_MAX_PARTS, 8),
  },
  ecs: {
    region: process.env.ECS_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1',
    cluster: process.env.ECS_CLUSTER || '',
    taskDefinition: process.env.ECS_TASK_DEFINITION || '',
    containerName: process.env.ECS_CONTAINER_NAME || 'recorder',
    subnets: (process.env.ECS_SUBNETS || '').split(',').map((s) => s.trim()).filter(Boolean),
    securityGroups: (process.env.ECS_SECURITY_GROUPS || '').split(',').map((s) => s.trim()).filter(Boolean),
    // Fargate Spot is ~70% cheaper; when AWS reclaims a task, a replacement takes over first
    useSpot: process.env.ECS_USE_SPOT === 'true',
    // Only for tests (a fake ECS)
    endpoint: process.env.ECS_ENDPOINT || undefined,
  },
  // How often old server copies are cleaned up
  cleanupIntervalSeconds: parseNumber(process.env.CLEANUP_INTERVAL_SECONDS, 600),
  // Days a recording stays on the server after it reached YouTube
  localRetentionDays: parseNumber(process.env.LOCAL_RETENTION_DAYS, 14),
  youtube: {
    clientId: process.env.YOUTUBE_CLIENT_ID || '',
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET || '',
    privacy: (['private', 'unlisted', 'public'].includes(process.env.YOUTUBE_PRIVACY ?? '') ? process.env.YOUTUBE_PRIVACY : 'unlisted') as 'private' | 'unlisted' | 'public',
    // Overridable so tests can point at a fake server
    apiBase: (process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com').replace(/\/+$/, ''),
    authUrl: process.env.GOOGLE_OAUTH_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: process.env.GOOGLE_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  },
  // The original unauthenticated /google, /microsoft, /zoom join routes (off unless asked for)
  legacyApiEnabled: process.env.LEGACY_API_ENABLED === 'true',
  uiDir: path.join(projectRoot, 'ui'),
  // Where finished recordings are written when UPLOADER_TYPE=local
  recordingsDir: process.env.RECORDINGS_DIR ? path.resolve(process.env.RECORDINGS_DIR) : path.join(projectRoot, 'recordings'),
  // Debug screenshots taken when a join step fails (local mode only)
  debugDir: path.join(projectRoot, 'debug-screenshots'),
  // How many meetings can be recorded at the same time (each one runs its own browser)
  maxConcurrentBots: parsePositiveInt(process.env.MAX_CONCURRENT_BOTS, 3),
  // Bot browser windows are cascaded so they don't stack exactly on top of each other.
  // BOT_WINDOW_POSITION=offscreen parks them outside the visible desktop instead.
  botWindowPosition: (process.env.BOT_WINDOW_POSITION === 'offscreen' ? 'offscreen' : 'cascade') as 'offscreen' | 'cascade',
  db: {
    host: process.env.DB_HOST || 'localhost',
    user: process,
  },
  authBaseUrlV2: process.env.AUTH_BASE_URL_V2 ?? 'http://localhost:8081/v2',
  // Unset MAX_RECORDING_DURATION_MINUTES to use default upper limit on duration
  maxRecordingDuration: process.env.MAX_RECORDING_DURATION_MINUTES ?
    Number(process.env.MAX_RECORDING_DURATION_MINUTES) :
    180, // There's an upper limit on meeting duration 3 hours
  chromeExecutablePath: process.env.CHROME_PATH, // We use Google Chrome with Playwright for recording
  googleChromeCdpUrl: process.env.GOOGLE_CHROME_CDP_URL,
  googleChromeUserDataDir: process.env.GOOGLE_CHROME_USER_DATA_DIR,
  googleChromeStorageStatePath: process.env.GOOGLE_CHROME_STORAGE_STATE_PATH,
  googleAnonymousJoinRequestAttempts: process.env.GOOGLE_ANONYMOUS_JOIN_REQUEST_ATTEMPTS ?
    Number(process.env.GOOGLE_ANONYMOUS_JOIN_REQUEST_ATTEMPTS) :
    10,
  inactivityLimit: process.env.MEETING_INACTIVITY_MINUTES ? Number(process.env.MEETING_INACTIVITY_MINUTES) : 1,
  activateInactivityDetectionAfter: process.env.INACTIVITY_DETECTION_START_DELAY_MINUTES ? Number(process.env.INACTIVITY_DETECTION_START_DELAY_MINUTES) :  1,
  loneParticipantExitDelaySeconds: process.env.LONE_PARTICIPANT_EXIT_DELAY_SECONDS ? Number(process.env.LONE_PARTICIPANT_EXIT_DELAY_SECONDS) : 10,
  serviceKey: process.env.SCREENAPP_BACKEND_SERVICE_API_KEY,
  joinWaitTime: process.env.JOIN_WAIT_TIME_MINUTES ? Number(process.env.JOIN_WAIT_TIME_MINUTES) : 10,
  // Number of retries for transient errors (not applied to WaitingAtLobbyRetryError)
  retryCount: process.env.RETRY_COUNT ? Number(process.env.RETRY_COUNT) : 2,
  teamsPrewarmEnabled: process.env.TEAMS_PREWARM_ENABLED === 'true',
  teamsAudioStabilizationMs: process.env.TEAMS_AUDIO_STABILIZATION_MS ? Number(process.env.TEAMS_AUDIO_STABILIZATION_MS) : 1000,
  miscStorageBucket: process.env.GCP_MISC_BUCKET,
  miscStorageFolder: process.env.GCP_MISC_BUCKET_FOLDER ? process.env.GCP_MISC_BUCKET_FOLDER : 'meeting-bot',
  region: process.env.GCP_DEFAULT_REGION,
  accessKey: process.env.GCP_ACCESS_KEY_ID ?? '',
  accessSecret: process.env.GCP_SECRET_ACCESS_KEY ?? '',
  redisQueueName: process.env.REDIS_QUEUE_NAME ?? 'jobs:meetbot:list',
  redisProcessingQueueName: process.env.REDIS_PROCESSING_QUEUE_NAME ?? 'jobs:meetbot:processing',
  redisUri: constructRedisUri(),
  // Notification: Webhook (disabled by default)
  notifyWebhookEnabled: process.env.NOTIFY_WEBHOOK_ENABLED === 'true',
  notifyWebhookUrl: process.env.NOTIFY_WEBHOOK_URL,
  // Optional secret to sign payloads (HMAC-SHA256). If set, signature will be sent in X-Webhook-Signature header
  notifyWebhookSecret: process.env.NOTIFY_WEBHOOK_SECRET,
  // Notification: Redis. Explicitly enabled via NOTIFY_REDIS_ENABLED, and enabled
  // automatically for Redis-worker mode so completed jobs are written to result list.
  notifyRedisEnabled: process.env.NOTIFY_REDIS_ENABLED === 'true' || process.env.REDIS_CONSUMER_ENABLED === 'true',
  // If not provided, uses redisUri with specified database selection
  notifyRedisUri: process.env.NOTIFY_REDIS_URI, // optional override
  notifyRedisDb: parseOptionalNumber(process.env.NOTIFY_REDIS_DB),
  notifyRedisList: process.env.NOTIFY_REDIS_LIST ?? 'jobs:meetbot:recordings',
  notifyRedisFailureList: process.env.NOTIFY_REDIS_FAILURE_LIST ?? 'jobs:meetbot:failures',
  uploaderFileExtension: normalizeFileExtension(process.env.UPLOADER_FILE_EXTENSION),
  isRedisEnabled: process.env.REDIS_CONSUMER_ENABLED === 'true',
  s3CompatibleStorage: {
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    bucket: process.env.S3_BUCKET_NAME,
    forcePathStyle: process.env.S3_USE_MINIO_COMPATIBILITY === 'true',
  },
  // Object storage provider selection: 's3' (default) or 'azure'
  storageProvider: (process.env.STORAGE_PROVIDER === 'azure' ? 'azure' : 's3') as 's3' | 'azure',
  azureBlobStorage: {
    // Either provide full connection string OR account + key/SAS OR managed identity
    connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
    accountName: process.env.AZURE_STORAGE_ACCOUNT,
    accountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY, // optional when using connection string
    sasToken: process.env.AZURE_STORAGE_SAS_TOKEN, // starts with ?sv=...
    useManagedIdentity: process.env.AZURE_USE_MANAGED_IDENTITY === 'true',
    container: process.env.AZURE_STORAGE_CONTAINER,
    blobPrefix: process.env.AZURE_BLOB_PREFIX || '',
    signedUrlTtlSeconds: process.env.AZURE_SIGNED_URL_TTL_SECONDS ? Number(process.env.AZURE_SIGNED_URL_TTL_SECONDS) : 3600,
    uploadConcurrency: process.env.AZURE_UPLOAD_CONCURRENCY ? Number(process.env.AZURE_UPLOAD_CONCURRENCY) : 4,
  },
  uploaderType,
};
