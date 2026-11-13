import crypto from 'crypto';
import fs from 'fs';
import config from '../config';
import { deleteSetting, getJsonSetting, getSetting, setJsonSetting, setSetting } from '../db/settings';

/**
 * Everything the app does with YouTube, using plain HTTPS calls to the YouTube Data API v3:
 * the one-time "Connect YouTube" sign-in for the channel, playlists (one per subject) and
 * resumable video uploads. The channel's refresh token is kept in the settings table.
 */

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
];
const AUTH_KEY = 'youtube.auth';
const ERROR_KEY = 'youtube.error';
// Upload chunks must be a multiple of 256 KiB
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;

interface StoredAuth {
  refreshToken: string;
  channelId: string | null;
  channelTitle: string | null;
  connectedAt: number;
}

export class YouTubeError extends Error {
  constructor(
    message: string,
    /** 'auth' = the connection is broken, 'quota' = today's allowance is used up, 'other' = anything else */
    public readonly kind: 'auth' | 'quota' | 'other',
    public readonly httpStatus?: number,
  ) {
    super(message);
  }
}

export interface YouTubeStatus {
  /** A Google OAuth client is set (on the server or in the dashboard) */
  configured: boolean;
  /** Where the OAuth client comes from: server environment, or entered by the admin in the dashboard */
  credentialsSource: 'environment' | 'dashboard' | null;
  clientId: string | null;
  connected: boolean;
  channelTitle: string | null;
  channelId: string | null;
  connectedAt: number | null;
  /** Why the connection stopped working, when it did */
  error: string | null;
  /** Must be listed as an authorised redirect URI on the Google OAuth client */
  redirectUri: string;
  privacy: string;
}

export const redirectUri = () => `${config.publicUrl}/api/youtube/callback`;
const CLIENT_KEY = 'youtube.client';

/**
 * The Google OAuth client. YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET on the server win; otherwise
 * the admin enters them in the dashboard (Settings), so nobody needs to log in to the server.
 */
function credentials(): { clientId: string; clientSecret: string; source: 'environment' | 'dashboard' } | null {
  if (config.youtube.clientId && config.youtube.clientSecret) {
    return { clientId: config.youtube.clientId, clientSecret: config.youtube.clientSecret, source: 'environment' };
  }
  const saved = getJsonSetting<{ clientId: string; clientSecret: string }>(CLIENT_KEY);
  return saved?.clientId && saved.clientSecret ? { ...saved, source: 'dashboard' } : null;
}

export const isConfigured = () => credentials() !== null;

/** Save the OAuth client entered in the dashboard. A different client invalidates the current connection. */
export function saveCredentials(clientId: string, clientSecret: string): void {
  const previous = getJsonSetting<{ clientId: string }>(CLIENT_KEY);
  setJsonSetting(CLIENT_KEY, { clientId, clientSecret });
  if (previous?.clientId !== clientId) disconnect();
  accessToken = undefined;
}
const storedAuth = () => getJsonSetting<StoredAuth>(AUTH_KEY);
export const isConnected = () => isConfigured() && Boolean(storedAuth()?.refreshToken);

export function getStatus(): YouTubeStatus {
  const auth = storedAuth();
  const creds = credentials();
  return {
    configured: creds !== null,
    credentialsSource: creds?.source ?? null,
    clientId: creds?.clientId ?? null,
    connected: isConnected(),
    channelTitle: auth?.channelTitle ?? null,
    channelId: auth?.channelId ?? null,
    connectedAt: auth?.connectedAt ?? null,
    error: getSetting(ERROR_KEY) ?? null,
    redirectUri: redirectUri(),
    privacy: config.youtube.privacy,
  };
}

// --------------------------------------------------------------------- sign-in

const pendingStates = new Map<string, number>(); // state -> expiry

/** The Google consent page the admin is sent to when pressing "Connect YouTube". */
export function buildAuthUrl(): string {
  const state = crypto.randomBytes(24).toString('base64url');
  pendingStates.set(state, Date.now() + 15 * 60 * 1000);
  const params = new URLSearchParams({
    client_id: credentials()?.clientId ?? '',
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline', // we need a refresh token: uploads happen while nobody is signed in
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${config.youtube.authUrl}?${params}`;
}

export function consumeState(state: unknown): boolean {
  if (typeof state !== 'string') return false;
  const expires = pendingStates.get(state);
  pendingStates.delete(state);
  return Boolean(expires && expires > Date.now());
}

async function tokenRequest(body: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
  const response = await fetch(config.youtube.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: credentials()?.clientId ?? '', client_secret: credentials()?.clientSecret ?? '', ...body }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = await response.json().catch(() => ({})) as { error?: string; error_description?: string; access_token?: string; expires_in?: number; refresh_token?: string };
  if (!response.ok || !json.access_token) {
    const detail = json.error_description || json.error || `HTTP ${response.status}`;
    // invalid_grant = the refresh token was revoked or has expired
    throw new YouTubeError(`Google sign-in failed: ${detail}`, json.error === 'invalid_grant' ? 'auth' : 'other', response.status);
  }
  return { access_token: json.access_token, expires_in: json.expires_in ?? 3600, refresh_token: json.refresh_token };
}

/** Second half of "Connect YouTube": swap the code Google sent back for a long-lived refresh token. */
export async function completeSignIn(code: string): Promise<YouTubeStatus> {
  const tokens = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  if (!tokens.refresh_token) {
    throw new YouTubeError('Google did not return a refresh token. Remove the app under myaccount.google.com/permissions and connect again.', 'other');
  }
  accessToken = { value: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in - 60) * 1000 };

  let channelId: string | null = null;
  let channelTitle: string | null = null;
  try {
    const channels = await api<{ items?: Array<{ id: string; snippet?: { title?: string } }> }>(
      'GET', '/youtube/v3/channels', { part: 'snippet', mine: 'true' });
    channelId = channels.items?.[0]?.id ?? null;
    channelTitle = channels.items?.[0]?.snippet?.title ?? null;
  } catch {
    // The name is only for display
  }
  if (!channelId) {
    accessToken = undefined;
    throw new YouTubeError('That Google account has no YouTube channel yet. Create the channel on youtube.com first, then connect again.', 'other');
  }

  setJsonSetting(AUTH_KEY, { refreshToken: tokens.refresh_token, channelId, channelTitle, connectedAt: Date.now() } satisfies StoredAuth);
  deleteSetting(ERROR_KEY);
  return getStatus();
}

export function disconnect(): void {
  deleteSetting(AUTH_KEY);
  deleteSetting(ERROR_KEY);
  accessToken = undefined;
}

// ---------------------------------------------------------------- API plumbing

let accessToken: { value: string; expiresAt: number } | undefined;

async function getAccessToken(): Promise<string> {
  if (accessToken && accessToken.expiresAt > Date.now()) return accessToken.value;

  const auth = storedAuth();
  if (!isConfigured() || !auth?.refreshToken) {
    throw new YouTubeError('YouTube is not connected.', 'auth');
  }
  try {
    const tokens = await tokenRequest({ refresh_token: auth.refreshToken, grant_type: 'refresh_token' });
    accessToken = { value: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in - 60) * 1000 };
    deleteSetting(ERROR_KEY);
    return accessToken.value;
  } catch (error) {
    if (error instanceof YouTubeError && error.kind === 'auth') {
      // Typical causes: access was removed in the Google account, or the OAuth app is still in
      // "Testing" mode (Google then expires the connection after 7 days).
      setSetting(ERROR_KEY, 'YouTube stopped accepting the saved connection. Press "Connect YouTube" again. If this happens every week, publish the OAuth app (see docs/SETUP.md).');
    }
    throw error;
  }
}

async function toError(response: Response): Promise<YouTubeError> {
  const text = await response.text().catch(() => '');
  let message = text.slice(0, 300);
  let reason = '';
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
    message = parsed.error?.message ?? message;
    reason = parsed.error?.errors?.[0]?.reason ?? '';
  } catch {
    // not JSON
  }
  const quota = ['quotaExceeded', 'dailyLimitExceeded', 'uploadLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded'].includes(reason);
  const kind = response.status === 401 ? 'auth' : quota ? 'quota' : 'other';
  if (response.status === 401) accessToken = undefined;
  return new YouTubeError(`YouTube said: ${message || `HTTP ${response.status}`}${reason ? ` (${reason})` : ''}`, kind, response.status);
}

async function api<T>(method: 'GET' | 'POST', path: string, query: Record<string, string>, body?: unknown): Promise<T> {
  const token = await getAccessToken();
  const response = await fetch(`${config.youtube.apiBase}${path}?${new URLSearchParams(query)}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw await toError(response);
  return await response.json() as T;
}

// ------------------------------------------------------------------- playlists

/** YouTube allows up to 150 characters in a playlist title and 100 in a video title; neither may contain < or >. */
const clean = (text: string, max: number) => text.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

export async function createPlaylist(title: string): Promise<string> {
  const playlist = await api<{ id: string }>('POST', '/youtube/v3/playlists', { part: 'snippet,status' }, {
    snippet: { title: clean(title, 150), description: 'Lecture recordings' },
    status: { privacyStatus: config.youtube.privacy },
  });
  return playlist.id;
}

export async function addToPlaylist(playlistId: string, videoId: string): Promise<void> {
  await api('POST', '/youtube/v3/playlistItems', { part: 'snippet' }, {
    snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } },
  });
}

// --------------------------------------------------------------------- uploads

export interface VideoMeta {
  title: string;
  description: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** "bytes=0-1048575" -> 1048576 (the next byte YouTube expects) */
const nextOffset = (range: string | null) => {
  const match = range?.match(/bytes=0-(\d+)/);
  return match ? Number(match[1]) + 1 : 0;
};

/**
 * Upload a recording with YouTube's resumable protocol: open an upload session, then send the file
 * in 8 MB pieces. A piece that fails is retried from wherever YouTube says it got to, so a network
 * blip in the middle of a 2 GB lecture does not start the upload again.
 */
export async function uploadVideo(
  filePath: string, meta: VideoMeta, onProgress?: (fraction: number) => void,
): Promise<string> {
  const total = (await fs.promises.stat(filePath)).size;
  if (total === 0) throw new YouTubeError('The recording file is empty.', 'other');
  const contentType = filePath.toLowerCase().endsWith('.mp4') ? 'video/mp4' : 'video/webm';

  const start = await fetch(`${config.youtube.apiBase}/upload/youtube/v3/videos?${new URLSearchParams({ uploadType: 'resumable', part: 'snippet,status' })}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(total),
      'X-Upload-Content-Type': contentType,
    },
    body: JSON.stringify({
      snippet: { title: clean(meta.title, 100), description: meta.description.replace(/[<>]/g, '').slice(0, 4500), categoryId: '27' },
      status: { privacyStatus: config.youtube.privacy, selfDeclaredMadeForKids: false, embeddable: true },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!start.ok) throw await toError(start);
  const sessionUrl = start.headers.get('location');
  if (!sessionUrl) throw new YouTubeError('YouTube did not open an upload session.', 'other');

  const file = await fs.promises.open(filePath, 'r');
  try {
    let offset = 0;
    let failures = 0;

    while (offset < total) {
      const length = Math.min(UPLOAD_CHUNK_BYTES, total - offset);
      const chunk = Buffer.alloc(length);
      await file.read(chunk, 0, length, offset);

      let response: Response;
      try {
        response = await fetch(sessionUrl, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${await getAccessToken()}`,
            'Content-Length': String(length),
            'Content-Range': `bytes ${offset}-${offset + length - 1}/${total}`,
          },
          body: chunk,
          redirect: 'manual', // 308 means "send more", not "go elsewhere"
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (networkError) {
        if (++failures > 8) throw new YouTubeError(`The upload kept failing: ${(networkError as Error).message}`, 'other');
        await sleep(Math.min(60_000, 2000 * 2 ** failures));
        const resumed = await resumeOffset(sessionUrl, total, offset);
        if (typeof resumed === 'string') return resumed;
        offset = resumed;
        continue;
      }

      if (response.status === 308) {
        offset = nextOffset(response.headers.get('range'));
        failures = 0;
        onProgress?.(offset / total);
        continue;
      }
      if (response.ok) {
        const video = await response.json() as { id?: string };
        if (!video.id) throw new YouTubeError('YouTube accepted the upload but returned no video id.', 'other');
        onProgress?.(1);
        return video.id;
      }
      if (response.status >= 500 || response.status === 429) {
        if (++failures > 8) throw await toError(response);
        await sleep(Math.min(60_000, 2000 * 2 ** failures));
        const resumed = await resumeOffset(sessionUrl, total, offset);
        if (typeof resumed === 'string') return resumed;
        offset = resumed;
        continue;
      }
      throw await toError(response);
    }
    throw new YouTubeError('The upload ended without YouTube confirming the video.', 'other');
  } finally {
    await file.close();
  }
}

/**
 * Ask YouTube how much of an interrupted upload it has. Returns the next byte to send, or the
 * video id when the last piece had in fact arrived and only the reply was lost.
 */
async function resumeOffset(sessionUrl: string, total: number, fallback: number): Promise<number | string> {
  try {
    const response = await fetch(sessionUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Length': '0', 'Content-Range': `bytes */${total}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 308) return nextOffset(response.headers.get('range'));
    if (response.ok) {
      const video = await response.json() as { id?: string };
      if (video.id) return video.id;
    }
  } catch {
    // fall through and retry the same piece
  }
  return fallback;
}
