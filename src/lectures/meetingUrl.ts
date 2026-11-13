import { HttpError } from '../auth';
import { getMeetingCode } from '../util/recordingName';

/**
 * Turns what an instructor pasted into a clean meeting link. Google Meet only for now.
 * Accepts a full link, a link without https://, or a bare code like "abc-defg-hij".
 */
export const normalizeMeetingUrl = (input: unknown): { url: string; code: string } => {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new HttpError(400, 'Paste the Google Meet link first.');

  if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(raw)) {
    const code = raw.toLowerCase();
    return { url: `https://meet.google.com/${code}`, code };
  }

  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new HttpError(400, 'That does not look like a meeting link.');
  }

  if (parsed.hostname !== 'meet.google.com') {
    throw new HttpError(400, 'Only Google Meet links (meet.google.com/...) can be recorded at the moment.');
  }
  const code = getMeetingCode(parsed.toString());
  if (!code) {
    throw new HttpError(400, 'Could not find a meeting code in that link (it should look like abc-defg-hij).');
  }
  // Drop tracking parameters (authuser, pli ...) but keep the meeting itself
  return { url: `https://meet.google.com/${code}`, code };
};
