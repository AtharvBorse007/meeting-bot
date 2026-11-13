import { createLogger, format, Logger, transports } from 'winston';
import Transport from 'winston-transport';
import config from '../config';
import { RecordingRules } from '../bots/AbstractMeetBot';
import { RecordingUploadFailedError, UnsupportedMeetingError, WaitingAtLobbyRetryError } from '../error';
import { GOOGLE_REQUEST_DENIED } from '../constants';

/** Pieces used both by the dashboard and by recorder workers (which have no database). */

export interface LectureLogEntry {
  t: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
};

export const safeFileName = (value: string) => value.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim();

/** How a lecture is recorded: stays through silence, leaves when the lecture is really over. */
export const lectureRules = (): RecordingRules => ({
  silenceDetection: false,
  aloneExitSeconds: config.lectureAloneExitMinutes * 60,
  initialAloneMinutes: config.lectureInitialAloneMinutes,
  maxDurationMinutes: config.lectureMaxHours * 60,
  videoKbps: config.recordingVideoKbps,
  audioKbps: config.recordingAudioKbps,
  preferredMimeTypes: [`video/webm;codecs=${config.recordingCodec},opus`],
  frameRate: config.recordingFps,
});

export const describeFailure = (error: unknown): string => {
  if (error instanceof WaitingAtLobbyRetryError) {
    return (error.documentBodyText ?? '').includes(GOOGLE_REQUEST_DENIED)
      ? 'Someone in the meeting denied the recorder\'s request to join.'
      : 'The recorder was not let into the meeting in time. Admit it when it asks to join, then start it again.';
  }
  if (error instanceof UnsupportedMeetingError) {
    return error.googleMeetPageStatus === 'SIGN_IN_PAGE'
      ? 'This meeting only allows signed-in Google accounts, so the recorder cannot join as a guest.'
      : 'This link did not open a joinable Google Meet meeting.';
  }
  if (error instanceof RecordingUploadFailedError) {
    return 'The meeting was recorded but saving the file failed.';
  }
  // Playwright errors are multi-line call logs; the first line is the useful part
  if (error instanceof Error) return (error.message || error.name).split(/\r?\n/)[0].slice(0, 300);
  return String(error);
};

/** Sends log lines to a callback (the dashboard's activity log) as well as the console. */
class CallbackTransport extends Transport {
  constructor(private readonly onLog: (entry: LectureLogEntry) => void) {
    super();
  }

  log(info: { level: string; message: unknown }, callback: () => void) {
    setImmediate(() => this.emit('logged', info));
    try {
      const level: LectureLogEntry['level'] = info.level === 'error' ? 'error' : info.level === 'warn' ? 'warn' : 'info';
      let message = typeof info.message === 'string' ? info.message : safeJson(info.message);
      // Console output of the meeting page is far too chatty for the dashboard
      if (!message.startsWith('[Playwright chrome logger]')) {
        message = message.replace(/\s+/g, ' ').trim();
        if (message.length > 400) message = `${message.slice(0, 400)}…`;
        this.onLog({ t: Date.now(), level, message });
      }
    } finally {
      callback();
    }
  }
}

export function createLectureLogger(label: string, onLog: (entry: LectureLogEntry) => void): Logger {
  return createLogger({
    level: 'info',
    transports: [
      new transports.Console({
        format: format.combine(
          format.timestamp(),
          format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? ` ${safeJson(meta)}` : '';
            return `[${timestamp}] [${level}] [${label}] ${message}${metaStr}`;
          }),
        ),
      }),
      new CallbackTransport(onLog),
    ],
  });
}
