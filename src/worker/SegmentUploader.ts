import { IUploader } from '../middleware/disk-uploader';
import { putObject, segmentKey } from '../archive/s3';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Takes the recorder's 2-second chunks and uploads them to S3 as numbered segments every
 * `segmentSeconds`. If the recorder dies, everything up to the last segment is already safe.
 * Segments that fail to upload are kept in memory and retried, in order.
 */
export class SegmentUploader implements IUploader {
  private buffer: Buffer[] = [];
  private bufferBytes = 0;
  private bufferStartedAt = 0;
  private nextIndex = 1;
  private queue: Array<{ index: number; body: Buffer }> = [];
  private draining: Promise<void> | null = null;
  private timer: NodeJS.Timeout;

  uploadedSegments = 0;
  uploadedBytes = 0;
  receivedBytes = 0;
  durationSeconds: number | undefined;
  lastUploadAt: number | null = null;
  lastError: string | null = null;

  constructor(
    private readonly lectureId: string,
    private readonly part: number,
    private readonly segmentSeconds: number,
    private readonly onError: (message: string) => void,
  ) {
    // Cut a segment on time even when chunks arrive slowly
    this.timer = setInterval(() => this.cutIfDue(), 1000);
    this.timer.unref();
  }

  async saveDataToTempFile(data: Buffer): Promise<boolean> {
    if (this.bufferBytes === 0) this.bufferStartedAt = Date.now();
    this.buffer.push(data);
    this.bufferBytes += data.length;
    this.receivedBytes += data.length;
    this.cutIfDue();
    return true;
  }

  setRecordingDuration(durationSeconds: number): void {
    this.durationSeconds = durationSeconds;
  }

  /** Called by the bot when the recording ends: upload everything that is left. */
  async uploadRecordingToRemoteStorage(): Promise<boolean> {
    return this.flush();
  }

  getSavedRecordingPath(): string | undefined {
    return undefined;
  }

  /** Upload what is buffered and wait until every segment is in S3 (gives up after ~2 minutes of failures). */
  async flush(): Promise<boolean> {
    this.cut();
    const deadline = Date.now() + 120_000;
    while (this.queue.length > 0 && Date.now() < deadline) {
      await this.drain();
      if (this.queue.length > 0) await sleep(2000);
    }
    return this.queue.length === 0;
  }

  close(): void {
    clearInterval(this.timer);
  }

  private cutIfDue(): void {
    if (this.bufferBytes > 0 && Date.now() - this.bufferStartedAt >= this.segmentSeconds * 1000) this.cut();
  }

  private cut(): void {
    if (this.bufferBytes === 0) return;
    this.queue.push({ index: this.nextIndex++, body: Buffer.concat(this.buffer) });
    this.buffer = [];
    this.bufferBytes = 0;
    void this.drain();
  }

  /** Uploads queued segments one at a time, in order. */
  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      let failures = 0;
      while (this.queue.length > 0) {
        const segment = this.queue[0];
        try {
          await putObject(segmentKey(this.lectureId, this.part, segment.index), segment.body, 'video/webm');
          this.queue.shift();
          this.uploadedSegments += 1;
          this.uploadedBytes += segment.body.length;
          this.lastUploadAt = Date.now();
          this.lastError = null;
          failures = 0;
        } catch (error) {
          failures += 1;
          this.lastError = (error as Error)?.message ?? String(error);
          if (failures === 1 || failures % 10 === 0) this.onError(`Uploading segment ${segment.index} failed (will retry): ${this.lastError}`);
          if (failures >= 5) break; // try again with the next cut or flush
          await sleep(Math.min(15_000, 1000 * 2 ** failures));
        }
      }
    })().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }
}
