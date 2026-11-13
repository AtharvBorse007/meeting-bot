import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import { DescribeTasksCommand, ECSClient, RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import config from '../config';

/**
 * Starts recorder workers outside the dashboard process. One worker records one part of one
 * lecture and then exits, so nothing is paid for while no lecture is being recorded.
 */

export interface LaunchRequest {
  lectureId: string;
  part: number;
  token: string;
}

export interface RecorderLauncher {
  /** Starts a worker; returns a reference (ECS task ARN or process id). Throws when it can't. */
  launch(request: LaunchRequest): Promise<string>;
  /** Whether each worker still exists (true = running or starting, or a string = why it stopped). */
  status(refs: string[]): Promise<Map<string, true | string>>;
  /** Stops a worker the hard way (it is not answering). */
  terminate(ref: string): Promise<void>;
}

const workerEnv = (request: LaunchRequest): Record<string, string> => ({
  CONTROL_URL: config.recorder.controlUrl,
  WORKER_TOKEN: request.token,
  LECTURE_ID: request.lectureId,
  PART: String(request.part),
});

// --------------------------------------------------------------- AWS Fargate

export class EcsLauncher implements RecorderLauncher {
  private client = new ECSClient({
    region: config.ecs.region,
    ...(config.ecs.endpoint ? { endpoint: config.ecs.endpoint } : {}),
  });

  async launch(request: LaunchRequest): Promise<string> {
    const env = workerEnv(request);
    const result = await this.client.send(new RunTaskCommand({
      cluster: config.ecs.cluster,
      taskDefinition: config.ecs.taskDefinition,
      count: 1,
      ...(config.ecs.useSpot
        ? { capacityProviderStrategy: [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }] }
        : { launchType: 'FARGATE' as const }),
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: config.ecs.subnets,
          securityGroups: config.ecs.securityGroups,
          assignPublicIp: 'ENABLED', // reaches Google Meet, S3 and the dashboard without a NAT gateway
        },
      },
      overrides: {
        containerOverrides: [{
          name: config.ecs.containerName,
          environment: Object.entries(env).map(([name, value]) => ({ name, value })),
        }],
      },
      startedBy: `lecture-${request.lectureId.slice(0, 8)}`.slice(0, 36),
      tags: [
        { key: 'app', value: 'lecture-recorder' },
        { key: 'lecture', value: request.lectureId },
        { key: 'part', value: String(request.part) },
      ],
      propagateTags: 'TASK_DEFINITION',
    }));
    const task = result.tasks?.[0];
    if (!task?.taskArn) {
      const failure = result.failures?.[0];
      throw new Error(`AWS could not start a recorder: ${failure?.reason ?? 'unknown reason'}${failure?.detail ? ` (${failure.detail})` : ''}`);
    }
    return task.taskArn;
  }

  async status(refs: string[]): Promise<Map<string, true | string>> {
    const statuses = new Map<string, true | string>();
    for (let i = 0; i < refs.length; i += 100) {
      const batch = refs.slice(i, i + 100);
      const result = await this.client.send(new DescribeTasksCommand({ cluster: config.ecs.cluster, tasks: batch }));
      for (const task of result.tasks ?? []) {
        if (!task.taskArn) continue;
        statuses.set(task.taskArn, task.lastStatus === 'STOPPED'
          ? `the recorder task stopped (${task.stoppedReason || task.stopCode || 'no reason given'})`
          : true);
      }
      for (const failure of result.failures ?? []) {
        if (failure.arn) statuses.set(failure.arn, `the recorder task no longer exists (${failure.reason ?? 'missing'})`);
      }
    }
    return statuses;
  }

  async terminate(ref: string): Promise<void> {
    await this.client.send(new StopTaskCommand({ cluster: config.ecs.cluster, task: ref, reason: 'Recorder not responding' }));
  }
}

// --------------------------------------------- local processes (development)

/** Runs each worker as a child process of the dashboard: the ECS design on one machine. */
export class ProcessLauncher implements RecorderLauncher {
  private children = new Map<string, ChildProcess>();

  async launch(request: LaunchRequest): Promise<string> {
    const compiled = __filename.endsWith('.js');
    const entry = path.join(__dirname, '..', 'worker', compiled ? 'index.js' : 'index.ts');
    const args = compiled
      ? [...process.execArgv, entry]
      // Under ts-node (development): run the worker the same way
      : [...process.execArgv, require.resolve('ts-node/dist/bin.js'), entry];
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...workerEnv(request), RECORDER_MODE: 'worker' },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const ref = `pid-${child.pid}-${request.lectureId.slice(0, 8)}-${request.part}`;
    this.children.set(ref, child);
    child.on('exit', () => setTimeout(() => this.children.delete(ref), 10 * 60_000).unref());
    return ref;
  }

  async status(refs: string[]): Promise<Map<string, true | string>> {
    const statuses = new Map<string, true | string>();
    for (const ref of refs) {
      const child = this.children.get(ref);
      if (!child) statuses.set(ref, 'the recorder process is gone');
      else if (child.exitCode !== null || child.signalCode !== null) {
        statuses.set(ref, `the recorder process exited (${child.signalCode ?? `code ${child.exitCode}`})`);
      } else statuses.set(ref, true);
    }
    return statuses;
  }

  async terminate(ref: string): Promise<void> {
    this.children.get(ref)?.kill('SIGKILL');
  }

  /** Test hook: simulate a crash (SIGKILL) or an AWS shutdown notice (SIGTERM) of a lecture's worker. */
  signal(lectureId: string, signal: NodeJS.Signals): boolean {
    for (const [ref, child] of this.children) {
      if (ref.includes(lectureId.slice(0, 8)) && child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
        return true;
      }
    }
    return false;
  }
}

let launcher: RecorderLauncher | undefined;
export const getLauncher = (): RecorderLauncher => {
  if (!launcher) launcher = config.recorderMode === 'ecs' ? new EcsLauncher() : new ProcessLauncher();
  return launcher;
};
