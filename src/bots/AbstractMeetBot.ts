import { IUploader } from '../middleware/disk-uploader';

export interface BotLaunchParams {
  provider: 'google' | 'microsoft' | 'zoom';
  url: string;
  name: string;
  teamId: string;
  userId: string;
  bearerToken: string;
  timezone: string;
  botId?: string;
  eventId?: string;
}

/** Coarse lifecycle phases a bot reports while it works (shown live on the dashboard). */
export type BotPhase =
  | 'launching'   // starting the browser
  | 'joining'     // opening the meeting and pressing "Ask to join"
  | 'lobby'       // waiting for someone to let the bot in
  | 'recording'   // in the call and recording
  | 'leaving'     // recording stopped, leaving the call
  | 'saving';     // writing the recording to storage

export interface BotReporter {
  phase(phase: BotPhase, detail?: string): void;
  /** People currently in the call, including the bot itself. */
  participants(count: number): void;
}

/** Overrides for when a recording ends and how it is encoded (used for lectures). */
export interface RecordingRules {
  /** End the recording after a long silence. Lectures have breaks and quiet lab time, so they turn this off. */
  silenceDetection: boolean;
  /** Leave this long after everybody else has left. */
  aloneExitSeconds: number;
  /** Leave if nobody else ever shows up within this time. */
  initialAloneMinutes: number;
  /** Hard upper limit for one recording. */
  maxDurationMinutes: number;
  videoKbps?: number;
  audioKbps?: number;
  /** Tried before the defaults for the file type, e.g. 'video/webm;codecs=vp8,opus'. */
  preferredMimeTypes?: string[];
  /** Cap on the captured frame rate. */
  frameRate?: number;
}

export interface JoinParams {
  url: string;
  name: string;
  bearerToken: string;
  teamId: string;
  timezone: string;
  userId: string;
  botId?: string;
  eventId?: string;
  uploader: IUploader;
  /** Optional progress callbacks (used by the dashboard). */
  reporter?: BotReporter;
  /** Position in the cascade of bot windows, so concurrent bots don't open on top of each other. */
  windowSlot?: number;
  /** When omitted, the limits from the environment (MEETING_INACTIVITY_MINUTES etc.) apply. */
  rules?: RecordingRules;
}

export abstract class AbstractMeetBot {
  abstract join(params: JoinParams): Promise<void>;
}
