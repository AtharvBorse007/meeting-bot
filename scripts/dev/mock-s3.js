/**
 * Dev/test helper - NOT used in normal operation.
 *
 * A minimal stand-in for Amazon S3 (path-style, no auth checks), enough for the app's backups:
 * HeadBucket, PutObject, multipart uploads and GetObject (including pre-signed links).
 *
 *   node scripts/dev/mock-s3.js 4563
 *
 * and start the app with
 *   ARCHIVE_S3_BUCKET=test-bucket ARCHIVE_S3_ENDPOINT=http://127.0.0.1:4563 ARCHIVE_S3_FORCE_PATH_STYLE=true
 *   AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
 *
 * GET /_state lists what was stored.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const http = require('http');
const crypto = require('crypto');

const port = Number(process.argv[2]) || 4563;
const objects = new Map(); // "bucket/key" -> { body, contentType, storageClass, metadata }
const uploads = new Map(); // uploadId -> { bucket, key, parts: Map<number, Buffer>, headers }

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
});

/** Undo the SDK's "aws-chunked" streaming encoding: <hex size>[;ext]\r\n<data>\r\n ... 0\r\n<trailers> */
function decodeAwsChunked(buffer) {
  const parts = [];
  let offset = 0;
  for (;;) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd < 0) break;
    const size = parseInt(buffer.slice(offset, lineEnd).toString().split(';')[0], 16);
    if (!size) break;
    parts.push(buffer.slice(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

const payload = (req, body) =>
  String(req.headers['content-encoding'] || '').includes('aws-chunked') || req.headers['x-amz-decoded-content-length']
    ? decodeAwsChunked(body) : body;

const metadataFrom = (headers) => Object.fromEntries(
  Object.entries(headers).filter(([k]) => k.startsWith('x-amz-meta-')).map(([k, v]) => [k.slice('x-amz-meta-'.length), v]));

const etag = (buffer) => `"${crypto.createHash('md5').update(buffer).digest('hex')}"`;
const xml = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const body = await readBody(req);

  if (url.pathname === '/_state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      objects: [...objects.entries()].map(([path, o]) => ({
        bucket: path.split('/')[0], key: path.slice(path.indexOf('/') + 1), size: o.body.length,
        contentType: o.contentType, storageClass: o.storageClass, metadata: o.metadata,
      })),
      openUploads: uploads.size,
    }));
    return;
  }

  const [, bucket, ...rest] = url.pathname.split('/');
  const key = decodeURIComponent(rest.join('/'));
  const id = `${bucket}/${key}`;

  if (!key) {
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      // ListObjectsV2 (single page)
      const prefix = url.searchParams.get('prefix') || '';
      const items = [...objects.entries()]
        .filter(([path]) => path.startsWith(`${bucket}/${prefix}`))
        .map(([path, o]) => `<Contents><Key>${path.slice(bucket.length + 1)}</Key><LastModified>${(o.modified || new Date()).toISOString()}</LastModified><Size>${o.body.length}</Size><StorageClass>${o.storageClass}</StorageClass></Contents>`);
      xml(res, 200, `<ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${items.length}</KeyCount><IsTruncated>false</IsTruncated>${items.join('')}</ListBucketResult>`);
      return;
    }
    // HeadBucket / anything else on the bucket itself
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'POST' && url.searchParams.has('uploads')) {
    const uploadId = crypto.randomBytes(8).toString('hex');
    uploads.set(uploadId, { bucket, key, parts: new Map(), headers: req.headers });
    xml(res, 200, `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
    return;
  }

  const uploadId = url.searchParams.get('uploadId');
  if (uploadId) {
    const upload = uploads.get(uploadId);
    if (!upload) {
      xml(res, 404, '<Error><Code>NoSuchUpload</Code><Message>No such upload</Message></Error>');
      return;
    }
    if (req.method === 'PUT') {
      const part = payload(req, body);
      upload.parts.set(Number(url.searchParams.get('partNumber')), part);
      res.writeHead(200, { ETag: etag(part) });
      res.end();
      return;
    }
    if (req.method === 'POST') {
      const data = Buffer.concat([...upload.parts.keys()].sort((a, b) => a - b).map((n) => upload.parts.get(n)));
      objects.set(id, {
        body: data,
        contentType: upload.headers['content-type'],
        storageClass: upload.headers['x-amz-storage-class'] || 'STANDARD',
        metadata: metadataFrom(upload.headers),
        modified: new Date(),
      });
      uploads.delete(uploadId);
      xml(res, 200, `<CompleteMultipartUploadResult><Location>http://${req.headers.host}/${id}</Location><Bucket>${bucket}</Bucket><Key>${key}</Key><ETag>${etag(data)}</ETag></CompleteMultipartUploadResult>`);
      return;
    }
    if (req.method === 'DELETE') {
      uploads.delete(uploadId);
      res.writeHead(204);
      res.end();
      return;
    }
  }

  if (req.method === 'PUT') {
    const data = payload(req, body);
    objects.set(id, {
      body: data,
      contentType: req.headers['content-type'],
      storageClass: req.headers['x-amz-storage-class'] || 'STANDARD',
      metadata: metadataFrom(req.headers),
        modified: new Date(),
    });
    res.writeHead(200, { ETag: etag(data) });
    res.end();
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const object = objects.get(id);
    if (!object) {
      xml(res, 404, '<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>');
      return;
    }
    res.writeHead(200, {
      'Content-Type': object.contentType || 'application/octet-stream',
      'Content-Length': object.body.length,
      ...(url.searchParams.get('response-content-disposition') ? { 'Content-Disposition': url.searchParams.get('response-content-disposition') } : {}),
    });
    res.end(req.method === 'GET' ? object.body : undefined);
    return;
  }

  xml(res, 400, `<Error><Code>NotImplemented</Code><Message>Mock S3 has no ${req.method} ${url.pathname}${url.search}</Message></Error>`);
});

const bindHost = process.env.MOCK_S3_HOST || '127.0.0.1';
server.listen(port, bindHost, () => console.log(`[mock-s3] listening on http://${bindHost}:${port}`));
