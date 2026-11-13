/**
 * Download a database backup from the S3 backup bucket to data/restore-from-s3.db
 * (used by deploy/restore-from-s3.sh; the server's IAM role provides the access).
 *
 *   node dist/cli/fetch-db-backup.js            the newest backup
 *   node dist/cli/fetch-db-backup.js <key>      a specific one (see the list it prints)
 */
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import config from '../config';

async function main() {
  if (!config.archive.bucket) {
    console.error('ARCHIVE_S3_BUCKET is not set, so there are no S3 backups.');
    process.exitCode = 1;
    return;
  }
  const s3 = new S3Client({
    region: config.archive.region,
    ...(config.archive.endpoint ? { endpoint: config.archive.endpoint } : {}),
    forcePathStyle: config.archive.forcePathStyle,
  });
  const prefix = `${config.archive.prefix ? `${config.archive.prefix}/` : ''}db-backups/`;

  const backups: Array<{ key: string; size: number; modified: Date }> = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: config.archive.bucket, Prefix: prefix, ContinuationToken: token }));
    for (const object of page.Contents ?? []) {
      if (object.Key && object.LastModified) backups.push({ key: object.Key, size: object.Size ?? 0, modified: object.LastModified });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  if (backups.length === 0) {
    console.error(`No database backups found under s3://${config.archive.bucket}/${prefix}`);
    process.exitCode = 1;
    return;
  }
  // Newest first; the key ends in the date, which breaks ties
  backups.sort((a, b) => b.modified.getTime() - a.modified.getTime() || b.key.localeCompare(a.key));
  console.log('Available backups (newest first):');
  for (const backup of backups.slice(0, 10)) console.log(`  ${backup.key}  ${backup.modified.toISOString()}  ${backup.size} bytes`);

  const wanted = process.argv[2] ? backups.find((b) => b.key === process.argv[2]) : backups[0];
  if (!wanted) {
    console.error(`No backup with the key ${process.argv[2]}.`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(config.dataDir, { recursive: true });
  const target = path.join(config.dataDir, 'restore-from-s3.db');
  const object = await s3.send(new GetObjectCommand({ Bucket: config.archive.bucket, Key: wanted.key }));
  await pipeline(object.Body as Readable, fs.createWriteStream(target));
  console.log(`Downloaded ${wanted.key} to ${target}`);
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exitCode = 1;
});
