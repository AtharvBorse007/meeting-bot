import { Logger } from 'winston';
import { KnownError } from '../error';
import { getErrorType } from '../util/logger';
import config from '../config';

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Tracks the meetings being recorded. Up to `config.maxConcurrentBots` run at once; every bot
 * launches its own browser, so they don't share any state.
 */
export class JobStore {
  private runningCount: number = 0;
  private exclusiveRunning: boolean = false;
  private shutdownRequested: boolean = false;

  /**
   * Reserve a slot for a job that manages its own lifecycle (e.g. a dashboard session).
   * Returns a release function, or null when at capacity or shutting down.
   * An `exclusive` job (Microsoft Teams: its ffmpeg recorder uses the one shared virtual display and
   * audio device) only starts when nothing else is running and keeps everything else out until it ends.
   * The release function is idempotent.
   */
  tryAcquire(options?: { exclusive?: boolean }): (() => void) | null {
    const exclusive = options?.exclusive === true;
    if (this.shutdownRequested || this.exclusiveRunning) {
      return null;
    }
    if (exclusive ? this.runningCount > 0 : this.runningCount >= config.maxConcurrentBots) {
      return null;
    }
    this.runningCount += 1;
    if (exclusive) this.exclusiveRunning = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.runningCount -= 1;
      if (exclusive) this.exclusiveRunning = false;
    };
  }

  async addJob<T>(
    task: () => Promise<T>,
    logger: Logger,
    retryCount: number = 0,
    onPermanentFailure?: (error: unknown) => Promise<void> | void,
    onCompleted?: () => Promise<void> | void,
    options?: { exclusive?: boolean }
  ): Promise<{ accepted: boolean }> {
    const release = this.tryAcquire(options);
    if (!release) {
      return { accepted: false };
    }

    // Execute the task asynchronously without waiting for completion
    this.executeTaskWithRetry(task, logger, retryCount).then(async () => {
      logger.info('LogBasedMetric Bot has finished recording meeting successfully.');
      if (onCompleted) {
        try {
          await onCompleted();
        } catch (completionCallbackError) {
          logger.warn('Meeting completion callback failed', completionCallbackError as any);
        }
      }
    }).catch(async (error) => {
      const errorType = getErrorType(error);
      if (error instanceof KnownError) {
        logger.error('KnownError JobStore is permanently exiting:', { error });
      } else {
        logger.error('Error executing task after multiple retries:', { error });
      }
      logger.error(`LogBasedMetric Bot has permanently failed. [errorType: ${errorType}]`);
      if (onPermanentFailure) {
        try {
          await onPermanentFailure(error);
        } catch (failureNotificationError) {
          logger.warn('Meeting failure notification failed', failureNotificationError as any);
        }
      }
    }).finally(release);

    logger.info('LogBasedMetric Bot job has been queued and started recording meeting.');
    return { accepted: true };
  }

  private async executeTaskWithRetry<T>(
    task: () => Promise<T>,
    logger: Logger,
    retryCount: number
  ): Promise<void> {
    try {
      await task();
    } catch (error) {
      if (error instanceof KnownError && !error.retryable) {
        logger.error('KnownError is not retryable:', error.name, error.message);
        throw error;
      }

      if (error instanceof KnownError && error.retryable && (retryCount + 1) >= error.maxRetries) {
        logger.error(`KnownError: ${error.maxRetries} tries consumed:`, error.name, error.message);
        throw error;
      }

      retryCount += 1;
      await sleep(retryCount * 30000);
      if (retryCount < 3) {
        if (retryCount) {
          logger.warn(`Retry count: ${retryCount}`);
        }
        await this.executeTaskWithRetry(task, logger, retryCount);
      } else {
        throw error;
      }
    }
  }

  /** True when no further job can be accepted (at capacity). */
  isBusy(): boolean {
    return this.exclusiveRunning || this.runningCount >= config.maxConcurrentBots;
  }

  /** Number of meetings currently being processed. */
  activeCount(): number {
    return this.runningCount;
  }

  get capacity(): number {
    return config.maxConcurrentBots;
  }

  /**
   * Check if shutdown has been requested
   */
  isShutdownRequested(): boolean {
    return this.shutdownRequested;
  }

  /**
   * Request graceful shutdown - prevents new jobs from being accepted
   */
  requestShutdown(): void {
    this.shutdownRequested = true;
  }

  /**
   * Wait for ongoing tasks to complete
   * @returns Promise that resolves when all tasks are complete
   */
  async waitForCompletion(): Promise<void> {
    if (this.runningCount === 0) {
      return; // No tasks running, can shutdown immediately
    }

    console.log('Waiting for ongoing tasks to complete...');

    return new Promise<void>((resolve) => {
      const checkCompletion = () => {
        if (this.runningCount === 0) {
          console.log('All tasks completed successfully');
          resolve();
        } else {
          setTimeout(checkCompletion, 1000); // Check every 1 second
        }
      };
      checkCompletion();
    });
  }
}
