/**
 * Dev/test helper - NOT used in normal operation.
 *
 * A tiny stand-in for Google sign-in and the YouTube Data API, so the whole
 * "record -> upload -> add to playlist" path can be tested without a real channel:
 *
 *   node scripts/dev/mock-youtube.js 4010
 *
 * and start the app with
 *   YOUTUBE_CLIENT_ID=test YOUTUBE_CLIENT_SECRET=test
 *   YOUTUBE_API_BASE=http://127.0.0.1:4010
 *   GOOGLE_OAUTH_AUTH_URL=http://127.0.0.1:4010/o/oauth2/v2/auth
 *   GOOGLE_OAUTH_TOKEN_URL=http://127.0.0.1:4010/token
 *
 * GET /_state returns everything that was "uploaded". MOCK_YT_FAIL_CHUNKS=n makes the first n
 * upload chunks fail with 503, to exercise the resume logic.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const http = require('http');

const port = Number(process.argv[2]) || 4010;
let failChunks = Number(process.env.MOCK_YT_FAIL_CHUNKS) || 0;

const state = { playlists: [], playlistItems: [], videos: [], tokenRequests: 0, failedChunks: 0 };
const sessions = new Map(); // id -> { meta, total, received }
let counter = 0;

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
});

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const body = await readBody(req);
  const authed = () => (req.headers.authorization || '').startsWith('Bearer mock-access-');

  // --- Google sign-in: "consent" is granted immediately
  if (url.pathname === '/o/oauth2/v2/auth') {
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', 'mock-code');
    back.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { Location: back.toString() });
    res.end();
    return;
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    state.tokenRequests += 1;
    const form = new URLSearchParams(body.toString());
    if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') !== 'mock-refresh') {
      json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      return;
    }
    json(res, 200, {
      access_token: `mock-access-${state.tokenRequests}`, expires_in: 3600,
      ...(form.get('grant_type') === 'authorization_code' ? { refresh_token: 'mock-refresh' } : {}),
    });
    return;
  }

  if (url.pathname === '/_state') {
    json(res, 200, state);
    return;
  }

  if (!authed()) {
    json(res, 401, { error: { message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } });
    return;
  }

  // --- YouTube Data API
  if (url.pathname === '/youtube/v3/channels') {
    json(res, 200, { items: [{ id: 'UCmockchannel', snippet: { title: 'Mock Lecture Channel' } }] });
    return;
  }
  if (url.pathname === '/youtube/v3/playlists' && req.method === 'POST') {
    const input = JSON.parse(body.toString());
    const playlist = { id: `PLmock${String(++counter).padStart(8, '0')}`, title: input.snippet.title, privacy: input.status.privacyStatus };
    state.playlists.push(playlist);
    json(res, 200, { id: playlist.id });
    return;
  }
  if (url.pathname === '/youtube/v3/playlistItems' && req.method === 'POST') {
    const input = JSON.parse(body.toString());
    state.playlistItems.push({ playlistId: input.snippet.playlistId, videoId: input.snippet.resourceId.videoId });
    json(res, 200, { id: `item${++counter}` });
    return;
  }

  // --- resumable upload
  if (url.pathname === '/upload/youtube/v3/videos' && req.method === 'POST') {
    const id = `session${++counter}`;
    sessions.set(id, { meta: JSON.parse(body.toString()), total: Number(req.headers['x-upload-content-length']), received: 0 });
    // Use the address the caller used, so this also works from inside a container
    res.writeHead(200, { Location: `http://${req.headers.host}/upload-session/${id}` });
    res.end();
    return;
  }
  const match = url.pathname.match(/^\/upload-session\/(\w+)$/);
  if (match && req.method === 'PUT') {
    const session = sessions.get(match[1]);
    if (!session) {
      json(res, 404, { error: { message: 'Upload session not found' } });
      return;
    }
    const range = String(req.headers['content-range'] || '');
    const status = range.match(/^bytes \*\/(\d+)$/);
    if (!status) {
      if (failChunks > 0) {
        failChunks -= 1;
        state.failedChunks += 1;
        json(res, 503, { error: { message: 'Backend Error', errors: [{ reason: 'backendError' }] } });
        return;
      }
      const [, start] = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/) || [];
      if (Number(start) !== session.received) {
        json(res, 400, { error: { message: `Expected offset ${session.received}, got ${start}` } });
        return;
      }
      session.received += body.length;
    }
    if (session.received >= session.total) {
      if (!session.videoId) {
        session.videoId = `mockvid${String(++counter).padStart(4, '0')}`;
        state.videos.push({
          id: session.videoId, bytes: session.received,
          title: session.meta.snippet.title, description: session.meta.snippet.description,
          privacy: session.meta.status.privacyStatus,
        });
      }
      json(res, 200, { id: session.videoId });
      return;
    }
    res.writeHead(308, session.received > 0 ? { Range: `bytes=0-${session.received - 1}` } : {});
    res.end();
    return;
  }

  json(res, 404, { error: { message: `Mock YouTube has no ${req.method} ${url.pathname}` } });
});

const bindHost = process.env.MOCK_YT_HOST || '127.0.0.1';
server.listen(port, bindHost, () => console.log(`[mock-youtube] listening on http://${bindHost}:${port}`));
