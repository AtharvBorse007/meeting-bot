import config, { NODE_ENV } from '../config';
import { Storage } from '@google-cloud/storage';
import { Logger } from 'winston';
import fs from 'fs';
import path from 'path';

interface UploadOption {
  skipTimestamp?: boolean;
}

const storage = new Storage();

async function uploadImageToGCP(
  fileName: string,
  buffer: Buffer,
  logger: Logger
): Promise<void> {
  try {
    const bucket = storage.bucket(config.miscStorageBucket ?? '');
    const file = bucket.file(fileName);
    await file.save(buffer);
  } catch (error) {
    logger.error('Error uploading buffer:', error);
  }
}

// Local mode: keep debug screenshots on disk so a failed join can be diagnosed
async function saveDebugImageLocally(buffer: Buffer, fileName: string, botId: string, logger: Logger) {
  try {
    await fs.promises.mkdir(config.debugDir, { recursive: true });
    const safe = (v: string) => v.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(config.debugDir, `${safe(botId)}-${safe(fileName)}-${stamp}.png`);
    await fs.promises.writeFile(file, buffer);
    logger.info(`Debug screenshot saved: ${file}`);
  } catch (error) {
    logger.warn('Could not save debug screenshot', error as any);
  }
}

export const uploadDebugImage = async (
  buffer: Buffer,
  fileName: string,
  userId: string,
  logger: Logger,
  botId?: string,
  opts?: UploadOption
) => {
  try {
    if (config.uploaderType === 'local') {
      await saveDebugImageLocally(buffer, fileName, botId ?? 'bot', logger);
      return;
    }
    if (NODE_ENV === 'development') {
      // TODO add disk based file saving
      return;
    }
    logger.info('Begin upload Debug Image', userId);
    if (!config.miscStorageBucket) {
      logger.error('Developer TODO: Add .env value for GCP_MISC_BUCKET', userId);
      return;
    }
    const bot = botId ?? 'bot';
    const now = opts?.skipTimestamp ? '' : `-${new Date().toISOString()}`;
    const qualifiedFile = `${config.miscStorageFolder}/${userId}/${bot}/${fileName}${now}.png`;
    await uploadImageToGCP(qualifiedFile, buffer, logger);
    logger.info(`Debug Image File uploaded successfully: ${fileName}`, userId);
  } catch (err) {
    logger.error('Error uploading debug image:', userId, err);
  }
};
