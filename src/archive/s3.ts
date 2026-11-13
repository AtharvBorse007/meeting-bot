import fs from 'fs';
import { GetObjectCommand, HeadBucketCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import config from '../config';

/**
 * The S3 bucket that keeps a permanent copy of every recording and the daily database backups.
 * On EC2 the credentials come from the instance role, so no keys are stored anywhere.
 */

export const archiveEnabled = () => Boolean(config.archive.bucket);

let client: S3Client | undefined;
const s3 = (): S3Client => {
  if (!client) {
    client = new S3Client({
      region: config.archive.region,
      ...(config.archive.endpoint ? { endpoint: config.archive.endpoint } : {}),
      forcePathStyle: config.archive.forcePathStyle,
    });
  }
  return client;
};

const withPrefix = (key: string) => (config.archive.prefix ? `${config.archive.prefix}/${key}` : key);

/** S3 keys only use safe characters, so links and CLI commands never need escaping. */
const keyPart = (value: string) =>
  value.normalize('NFKD').replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '-').replace(/-{2,}/g, '-').slice(0, 80) || 'untitled';

/** recordings/2026/11/Physics-Batch-A/Physics - abc-defg-hij - 3-35pm Nov 13 2026.webm -> safe key */
export function recordingKey(subjectName: string, fileName: string, recordedAt: number): string {
  const date = new Date(recordedAt);
  const month = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}`;
  const base = fileName.replace(/\.[^.]+$/, '');
  const extension = fileName.slice(base.length) || '.webm';
  return withPrefix(`recordings/${month}/${keyPart(subjectName)}/${keyPart(base)}${extension}`);
}

export async function uploadFile(
  filePath: string,
  key: string,
  options: { contentType: string; metadata?: Record<string, string>; storageClass?: string; onProgress?: (fraction: number) => void },
): Promise<void> {
  const total = (await fs.promises.stat(filePath)).size;
  const upload = new Upload({
    client: s3(),
    params: {
      Bucket: config.archive.bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: options.contentType,
      // S3 metadata must be ASCII
      Metadata: Object.fromEntries(Object.entries(options.metadata ?? {}).map(([k, v]) => [k, v.replace(/[^\x20-\x7e]/g, '?')])),
      ...(options.storageClass ? { StorageClass: options.storageClass as never } : {}),
      ServerSideEncryption: config.archive.endpoint ? undefined : 'AES256',
    },
    partSize: 16 * 1024 * 1024,
    queueSize: 2,
  });
  if (options.onProgress && total > 0) {
    upload.on('httpUploadProgress', (progress) => {
      if (progress.loaded) options.onProgress?.(Math.min(1, progress.loaded / total));
    });
  }
  await upload.done();
}

/** A short-lived download link for a backed-up recording. */
export async function downloadUrl(key: string, fileName: string, minutes = 10): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({
    Bucket: config.archive.bucket,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${fileName.replace(/[^\x20-\x7e]|"/g, '_')}"`,
  }), { expiresIn: minutes * 60 });
}

export const dbBackupKey = (stamp: string) => withPrefix(`db-backups/meetingbot-${stamp}.db`);

/** Checks that the bucket exists and the server is allowed to use it. */
export async function checkBucket(): Promise<string | null> {
  try {
    await s3().send(new HeadBucketCommand({ Bucket: config.archive.bucket }));
    return null;
  } catch (error) {
    const err = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    const status = err.$metadata?.httpStatusCode;
    if (status === 403) return `No permission to use the bucket "${config.archive.bucket}" (check the server's IAM role).`;
    if (status === 404) return `The bucket "${config.archive.bucket}" does not exist.`;
    return `Could not reach S3: ${err.message || err.name || 'unknown error'}`;
  }
}

// ------------------------------------------------------------------ recording segments
// Recorders running outside the dashboard server upload what they record in short segments:
//   segments/<lecture id>/part-01/seg-000001.webm, seg-000002.webm, ...
// The segments of one part, concatenated in order, are that part's recording.

export const segmentPrefix = (lectureId: string, part: number) =>
  withPrefix(`segments/${lectureId}/part-${String(part).padStart(2, '0')}/`);

export const segmentKey = (lectureId: string, part: number, index: number) =>
  `${segmentPrefix(lectureId, part)}seg-${String(index).padStart(6, '0')}.webm`;

export async function putObject(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
  await s3().send(new PutObjectCommand({
    Bucket: config.archive.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ...(config.archive.endpoint ? {} : { ServerSideEncryption: 'AES256' as const }),
  }));
}

export async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3().send(new ListObjectsV2Command({ Bucket: config.archive.bucket, Prefix: prefix, ContinuationToken: token }));
    for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys.sort();
}

/** Appends an S3 object to an open file. */
export async function appendObjectTo(key: string, target: fs.WriteStream): Promise<number> {
  const object = await s3().send(new GetObjectCommand({ Bucket: config.archive.bucket, Key: key }));
  let bytes = 0;
  for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
    bytes += chunk.length;
    if (!target.write(chunk)) await new Promise<void>((resolve) => target.once('drain', () => resolve()));
  }
  return bytes;
}
