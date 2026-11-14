# Lecture Recorder — architecture and deployment handbook

Everything a developer needs to understand, fork, deploy and operate this system, in one file.
(Deeper per-topic notes: [docs/AWS.md](docs/AWS.md), [docs/SETUP.md](docs/SETUP.md),
[docs/CLOUD.md](docs/CLOUD.md).)

**Status (14 Nov 2026):** code-complete and tested end to end against fakes (Google Meet, YouTube,
S3, ECS) with real Chrome recorders, locally and inside the production Docker image.
**Not yet verified:** a deployment in a real AWS account, a real Google Meet join from AWS, and a
real YouTube upload. Section 9 lists exactly what to check on the first real deployment.

---

## 1. What it does

Deboistech runs online lectures on Google Meet. This system records them and publishes them:

1. The **admin** creates instructor accounts and subjects. One subject = one YouTube playlist.
2. An **instructor** signs in, picks a subject, pastes the Meet link, presses **Join & record**.
3. A **recorder** (a real Chrome browser, shown in the meeting as "Lecture Recorder") joins as a
   guest and records what a participant sees and hears: speaker, shared screens, all audio.
4. It stops when the instructor presses **End & save**, the meeting ends, it has been alone for
   10 minutes, or after 5 hours. Silence does **not** stop it (breaks, lab time).
5. The video is uploaded to YouTube as **unlisted** and added to the subject's playlist. A copy of
   every recording goes to S3.

Out of scope today: Zoom/Teams (bots exist in the original code base but are not wired into the
dashboard), a student-facing site, scheduling.

**Business constraints that shaped the design**

- Cost target about **US$40/month**; usage is bursty (some days zero lectures, up to 3–4 at once).
  So nothing lecture-sized may run idle → recorders are started per lecture.
- Loss tolerance: 1–2 minutes of a lecture may be missing, **never the whole lecture or more than
  5 minutes** → segments uploaded every 30 s, automatic replacement of failed recorders.

## 2. Architecture

```
 Instructor/Admin browser
        │ HTTPS (Caddy, Let's Encrypt)
        ▼
 ┌─────────────────────────────────────────────┐
 │ Dashboard server — EC2 t4g.micro, always on │      Google OAuth + YouTube Data API
 │  Docker Compose: caddy + app (Node 22)      │──────► upload video, create/add to playlist
 │  • Express API + static UI + SSE            │
 │  • SQLite (data volume)                     │
 │  • RemoteRecorders: starts/monitors tasks   │
 │  • joins segments (ffmpeg), UploadWorker,   │
 │    ArchiveWorker                            │
 └──────────┬──────────────────────▲───────────┘
   ecs:RunTask (1 per lecture)     │ HTTPS /internal/worker/* (job, heartbeat every 5 s, finished)
            ▼                      │
 ┌─────────────────────────────────┴───────────┐
 │ Recorder task — ECS Fargate (ARM, 1 vCPU/3GB)│──► joins Google Meet (Chromium + Xvfb + PulseAudio)
 │  same Docker image, APP_ROLE=recorder        │
 │  exists only while its lecture is recorded   │
 └──────────┬───────────────────────────────────┘
            │ PutObject every 30 s
            ▼
 ┌─────────────────────────────────────────────┐
 │ S3 bucket                                    │
 │  segments/<lecture>/part-NN/seg-*.webm (3 d) │
 │  recordings/<yyyy>/<mm>/<subject>/…webm      │ → Glacier Deep Archive after 30 days
 │  db-backups/meetingbot-<date>.db (90 d)      │
 └─────────────────────────────────────────────┘
```

One Docker image serves both roles (`deploy/entrypoint.sh` decides by `APP_ROLE` / `RECORDER_MODE`).

### Recorder modes (`RECORDER_MODE`)

| Mode | Where browsers run | Use |
|---|---|---|
| `ecs` | one Fargate task per lecture | **production on AWS** (pay per use) |
| `inprocess` (default) | inside the dashboard process, up to `MAX_CONCURRENT_BOTS` | single VM on any cloud, local use |
| `process` | one local worker process per lecture | development of the ecs design without AWS |

### Life of a lecture (ecs mode)

1. `POST /api/lectures` → row in `lectures` (status `launching`) → `RemoteRecorders.startLecture`
   inserts part 1 in `lecture_parts` with a hashed random token and calls `ecs:RunTask`, passing
   `CONTROL_URL`, `WORKER_TOKEN`, `LECTURE_ID`, `PART` as container overrides.
2. The task boots (1–2 min), `src/worker/index.ts` fetches its job from
   `GET /internal/worker/job`, launches Chromium and joins the meeting (`GoogleMeetBot`).
3. Recording is the tab's own `getDisplayMedia` + `MediaRecorder` (VP8/Opus WebM, 800 kbps,
   15 fps ≈ 0.4 GB/hour). 2-second chunks go to `SegmentUploader`, which writes a numbered segment
   to S3 every 30 s (retrying in order on failure).
4. Every 5 s the worker posts a heartbeat (phase, participants, bytes, logs). The reply carries
   `stop` (End was pressed) and `handoverDone`.
5. At the end the worker flushes the last segment and posts `finished` with a result:
   `ended | stopped | interrupted | crashed | join-failed | cancelled`.
6. The dashboard downloads the segments, concatenates them per part, joins parts with
   `ffmpeg -c copy`, writes the duration, and saves one file in `data/recordings`.
7. `UploadWorker` → YouTube (resumable upload, retry with back-off, playlist created on demand).
   `ArchiveWorker` → `recordings/` in S3. The server copy is deleted only when the video is on
   YouTube **and** in S3 (after `LOCAL_RETENTION_DAYS`, or earlier when disk is low).

### Failure handling

| Event | Detection | Reaction | Typical loss |
|---|---|---|---|
| Recorder crash / task vanishes | `ecs:DescribeTasks` every 30 s, or worker reports `crashed` | new part started, rejoins | 2–3 min (task start) |
| Recorder hangs | no heartbeat for 60 s | task stopped, new part | 3–4 min |
| AWS reclaims task (Spot/maintenance, SIGTERM) | worker reports `interrupted` at once | new part starts while the old one keeps recording (≤100 s) | ~0 |
| Dashboard restart/update | — | recorders continue; state is in SQLite and picked up again | 0 |
| S3 PutObject fails | per segment | kept in memory, retried in order | 0 |
| YouTube upload fails / quota / disconnected | per attempt | retry 1, 5, 15, 60, 180 min; waits while disconnected | 0 (delay only) |

At most `RECORDER_MAX_PARTS` (8) recorders per lecture. A **replacement has to be admitted to the
meeting again** if the meeting requires the host to admit guests — the dashboard shows "Waiting to
be admitted" and the instructor must click Admit. This is the main operational caveat.

## 3. Repository map

| Path | Purpose |
|---|---|
| `src/index.ts`, `src/app/index.ts` | start-up, graceful shutdown, Express app |
| `src/app/api.ts` | dashboard API (auth, lectures, SSE, admin, YouTube, backups) |
| `src/app/internal.ts` | `/internal/worker/*` endpoints for recorder tasks (token auth) |
| `src/auth/` | scrypt passwords, cookie sessions, login limiter, first admin |
| `src/db/` | SQLite (`node:sqlite`), migrations in `db/index.ts` (`PRAGMA user_version`) |
| `src/lectures/LectureManager.ts` | lecture lifecycle; in-process recording; delegates to RemoteRecorders |
| `src/recorders/RemoteRecorders.ts` | parts, heartbeats, watchdog, replacement, assembling |
| `src/recorders/launchers.ts` | `EcsLauncher` (RunTask/DescribeTasks/StopTask), `ProcessLauncher` |
| `src/worker/` | the recorder task: `index.ts`, `SegmentUploader.ts` |
| `src/bots/GoogleMeetBot.ts` | joining Meet and the in-page recorder (inherited, extended) |
| `src/youtube/` | OAuth, playlists, resumable upload, upload queue, local clean-up |
| `src/archive/` | S3 client, backup of recordings and database |
| `src/cli/` | `reset-password`, `fetch-db-backup` |
| `ui/` | dashboard: plain HTML/CSS/JS, no build step |
| `Dockerfile` | the production image (amd64 + arm64, Debian Chromium) |
| `deploy/aws/lecture-recorder.yaml` | CloudFormation: the whole AWS setup |
| `deploy/*.sh` | install, update, backup, restore, restore-from-s3, reset-password, set-domain |
| `deploy/docker-compose.yml`, `deploy/Caddyfile` | app + Caddy on the server |
| `scripts/dev/` | fakes (Meet, YouTube, S3, ECS) and end-to-end tests |

Inherited from the upstream `screenappai/meeting-bot` project and **not used by this product**:
`Dockerfile.production`, `Dockerfile.development`, `Dockerfile.chrome-cdp`, `docker-compose.yml`
(root), `.github/workflows/docker-build.yml`, Redis consumer, Teams/Zoom bots, the unauthenticated
`/google|/microsoft|/zoom/join` routes (off unless `LEGACY_API_ENABLED=true` — never enable on a
public address).

### Data model (SQLite, `data/meetingbot.db`)

- `users` (admin | instructor, scrypt hash, must_change_password, active), `auth_sessions`
- `subjects` (name, `playlist_id`, archived), `instructor_subjects`
- `lectures` — status (`launching|joining|lobby|recording|leaving|saving|saved|failed|cancelled`),
  upload_* (YouTube), archive_* (S3), file name/size, `stop_requested`, `part_count`
- `lecture_parts` — one row per recorder task: token hash, task ARN, heartbeat, segments, result
- `settings` — YouTube OAuth client + refresh token, DB-backup state

### Security model

- Dashboard: session cookie (HttpOnly, SameSite=Lax, Secure), same-origin check on writes, login
  rate limit, CSP. Instructors only see their own lectures; `/api/admin/*` is admin-only.
- Recorder ↔ dashboard: per-part random bearer token (only its SHA-256 is stored).
- AWS: no access keys anywhere. Dashboard instance role: RunTask/DescribeTasks/StopTask on this
  cluster, the bucket, ECR push. Recorder task role: `s3:PutObject` on `segments/*` only.
  Security groups: dashboard 80/443 in; recorders nothing in. Server access via Session Manager.
- Secrets at rest: YouTube client secret and refresh token are in the SQLite file on the server's
  encrypted disk and in the S3 database backups (bucket is private, encrypted, HTTPS-only).

## 4. Deploying on AWS

**Prerequisites:** an AWS account (admin user with MFA; region `ap-south-1` Mumbai), this
repository pushed to GitHub (public, or private with a read-only token in `RepoUrl`), a Google
account for the YouTube channel.

> The product currently lives on the **`lecture-recorder`** branch (the template's `RepoBranch`
> default). If you fork, keep that branch name or change the parameter. After merging to `main`,
> set `RepoBranch=main`.

### 4.1 Create the stack

Console: **CloudFormation → Create stack → With new resources → Upload a template file** →
`deploy/aws/lecture-recorder.yaml`. Stack name: `lecture-recorder`.

| Parameter | Value |
|---|---|
| DomainName | your address (e.g. `recorder.deboistech.in`), **or empty** to start on `https://<ip>.sslip.io` |
| AdminEmail | admin sign-in |
| AdminInitialPassword | temporary, 8–64 chars from `A-Za-z0-9@%+=:,./_-`; must be changed at first sign-in |
| RecorderSize | `medium` (1 vCPU / 3 GB) |
| UseSpot | `false` to start |
| AlertEmail, MonthlyBudgetUsd | your email, e.g. 50 |
| RepoUrl, RepoBranch | your fork; `lecture-recorder` |
| everything else | defaults |

Tick the IAM acknowledgement and create. CLI equivalent:

```bash
aws cloudformation deploy --region ap-south-1 --stack-name lecture-recorder \
  --template-file deploy/aws/lecture-recorder.yaml --capabilities CAPABILITY_IAM \
  --parameter-overrides AdminEmail=you@example.com AdminInitialPassword='Temp-Pass-123' \
    AlertEmail=you@example.com RepoUrl=https://github.com/<you>/meeting-bot.git
aws cloudformation describe-stacks --region ap-south-1 --stack-name lecture-recorder --query 'Stacks[0].Outputs'
```

The stack takes ~5 minutes. Then the server installs itself (Docker, build image, start, push the
recorder image to ECR): **15–20 minutes**. Follow it via the `ServerShell` output (Session
Manager): `sudo tail -f /var/log/lecture-recorder-setup.log` until `setup finished`.

Outputs you need: `DashboardUrl`, `PublicIp`, `YouTubeRedirectUri`, `ServerShell`,
`BackupBucketName`, `RecorderLogsUrl`.

### 4.2 Domain

- With a domain: create an **A record** → `PublicIp`. If added after installation:
  `cd /opt/lecture-recorder/deploy && sudo docker compose restart caddy`.
- Started without one: later create the A record, then on the server
  `cd /opt/lecture-recorder/deploy && sudo bash set-domain.sh recorder.yourdomain.com`, and add the
  new redirect URI to the Google OAuth client.

### 4.3 YouTube (Google side)

1. Channel: a dedicated Google account with a YouTube channel, **phone-verified**
   (youtube.com/verify) — otherwise videos over 15 minutes are rejected.
2. console.cloud.google.com → new project → enable **YouTube Data API v3**.
3. Google Auth Platform (OAuth consent): External; **publish to "In production"** (in "Testing"
   the connection expires every 7 days).
4. Clients → Create client → **Web application** → authorised redirect URI = `YouTubeRedirectUri`.
5. Dashboard → **Settings → YouTube**: paste client ID + secret → **Connect YouTube**, sign in as
   the channel's account ("Google hasn't verified this app" → Advanced → continue).

### 4.4 First use

Sign in at `DashboardUrl`, change the password, add **Subjects**, add **Instructors** (assign
subjects; the dashboard shows the temporary sign-in to pass on). Then run the acceptance test in
section 9.

## 5. Configuration reference

On the server: `/opt/lecture-recorder/deploy/.env` (written by the template; see
`deploy/.env.example` for all keys). Apply changes with `sudo docker compose up -d`.

| Variable | Default | Meaning |
|---|---|---|
| `DOMAIN` | — | dashboard host; Caddy gets the certificate; `PUBLIC_URL=https://DOMAIN` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | — | first admin (only used when the DB is empty) |
| `RECORDER_MODE` | `inprocess` | `ecs` on AWS |
| `MAX_CONCURRENT_BOTS` | 3 (template: 10) | lectures at the same time |
| `ECS_CLUSTER`, `ECS_TASK_DEFINITION`, `ECS_SUBNETS`, `ECS_SECURITY_GROUPS`, `ECS_USE_SPOT` | from template | where recorder tasks run |
| `ECR_REPOSITORY_URI` | from template | where `update.sh` publishes the recorder image |
| `RECORDER_SEGMENT_SECONDS` | 30 | upload interval = worst-case loss on a crash |
| `RECORDER_HEARTBEAT_TIMEOUT_SECONDS` | 60 | hung recorder is replaced after this |
| `RECORDER_START_TIMEOUT_SECONDS` | 360 | a task that never reports is replaced |
| `ARCHIVE_S3_BUCKET`, `AWS_REGION` | from template | backups + segments (required in ecs mode) |
| `ARCHIVE_DEEP_ARCHIVE_DAYS` | 30 | must match the bucket lifecycle (UI hides Download after it) |
| `BOT_NAME` | `Lecture Recorder` | name shown in the meeting |
| `LECTURE_ALONE_EXIT_MINUTES` / `LECTURE_INITIAL_ALONE_MINUTES` / `LECTURE_MAX_HOURS` | 10 / 20 / 5 | when the recorder leaves |
| `JOIN_WAIT_TIME_MINUTES` | 10 | wait to be admitted |
| `RECORDING_VIDEO_KBPS` / `_AUDIO_KBPS` / `_CODEC` / `_FPS` | 800 / 64 / vp8 / 15 | quality vs CPU/size |
| `MIN_UPLOAD_SECONDS` | 60 | shorter recordings are not sent to YouTube |
| `LOCAL_RETENTION_DAYS`, `LOW_DISK_GB` | 14 / 15 (template: 2 / 4) | server-copy clean-up |
| `YOUTUBE_PRIVACY` | `unlisted` | |
| `YOUTUBE_CLIENT_ID/SECRET` | empty | optional; normally entered in the dashboard |
| `TZ` | `Asia/Kolkata` | dates in video titles |

Recorder size and Spot are **stack parameters**: update the stack to change them.

## 6. Operations

All in `/opt/lecture-recorder/deploy` on the dashboard server (Session Manager):

| Task | Command |
|---|---|
| Dashboard logs | `sudo docker compose logs -f app` |
| Recorder logs | CloudWatch (`RecorderLogsUrl`); also each lecture's **Activity** in the dashboard |
| Deploy new code | push to the branch, then `sudo bash update.sh` (rebuilds, restarts dashboard, publishes recorder image; running recordings continue with the old image) |
| Reset a password | `sudo bash reset-password.sh user@example.com` |
| Restore DB from S3 | `sudo bash restore-from-s3.sh` (newest) |
| Change domain | `sudo bash set-domain.sh new.domain` |

Backups: DB daily to `db-backups/`; recordings in `recordings/`. Deep-Archived recordings need an
S3 restore (≤12 h) before download; the YouTube copy is always available. Deleting the stack keeps
the bucket.

## 7. Costs (Mumbai, on-demand, approximate — verify with the AWS Pricing Calculator)

| | ~100 lecture-hours/month | ~400 lecture-hours/month |
|---|---|---|
| Dashboard t4g.micro + 30 GB gp3 + Elastic IP | ~$12 | ~$12 |
| Fargate ARM 1 vCPU/3 GB + task public IP (~$0.05/h) | ~$5 | ~$20 |
| Data out to YouTube (first 100 GB free), S3, logs, ECR | ~$2 | ~$10 |
| **Total** | **~$20** | **~$40** |

Levers: `UseSpot=true` (recorders ~70% cheaper), Compute Savings Plan, `RecorderSize`. Deliberately
avoided: NAT gateway (~$35/mo), load balancer (~$20/mo), RDS.

## 8. Development and tests

Needs Node.js ≥ 22.13 and Google Chrome (Docker for the image tests).

```bash
npm install
node scripts/dev/dev-server.js        # http://localhost:3055 with fake Meet/YouTube/S3 (prints admin sign-in)
node scripts/dev/e2e.js               # inprocess mode: 83 checks
node scripts/dev/e2e-remote.js        # ecs mode against a fake ECS: 40 checks (49 on Linux/with ffmpeg)
docker build -t lecture-recorder:test .
node scripts/dev/e2e-docker.js        # the image, inprocess mode
node scripts/dev/e2e-docker-remote.js # the image, ecs mode incl. crash, Spot notice, hang, restart
npx tsc --noEmit -p . && npx eslint src scripts --quiet
```

Fake meeting codes: any code stays in the call; `eee-nnnn-ddd` ends after ~25 s; `lll-oooo-bbb`
is never admitted. `scripts/dev/mock-ecs.js` implements RunTask/DescribeTasks/StopTask and runs
each task as a local worker; `POST /_signal?lecture=<id>&signal=SIGKILL|SIGTERM|SIGSTOP` simulates
crash / AWS notice / hang.

Adding a DB change: append a migration string to `MIGRATIONS` in `src/db/index.ts`.

## 9. First real deployment — what to verify

Nothing below has been run against real services yet. Check in this order:

1. **Stack creation.** In a brand-new account the ECS cluster can fail with *"Unable to assume the
   service linked role"*: run `aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com`
   (or simply delete the failed stack and create it again). If `t4g`/Graviton types are refused,
   report it — the template is ARM-only (dashboard and recorders must match).
2. **Server install** finishes on t4g.micro (1 GB RAM + 4 GB swap). If the image build runs out of
   memory, update the stack with `DashboardInstanceType=t4g.small`.
3. **HTTPS** works on the sslip.io address or your domain (`sudo docker compose logs caddy`).
4. **Settings → Backups** shows the bucket with no warning and a database backup time.
5. **A real lecture:** host a Meet from one device, join from a second, Join & record, admit the
   recorder, talk + share a screen 5 minutes, End & save. Verify:
   - the task started within ~2 min and the recorder was admitted (**Google may treat joins from
     data-centre IPs differently — this is the biggest unknown**);
   - YouTube video is unlisted, in the playlist, with picture and sound (**new API projects may
     have uploads forced to private until an API audit — check in YouTube Studio**);
   - no "Recorder is very busy" warning in Activity (else `RecorderSize=large`);
   - `recordings/…` exists in the bucket; the ECS task is STOPPED afterwards.
6. **Failure drill:** during a test lecture, stop the task in the ECS console → a replacement must
   join within ~3 minutes (admit it) and the final video must be one file with a note about parts.
7. **Three lectures at once**, then check the bill after a day (Billing → Cost Explorer).

## 10. Known limitations and next steps

- Google Meet only; guest join (meetings restricted to an organisation's signed-in users can't be
  joined). A signed-in recorder account is possible (`GOOGLE_CHROME_STORAGE_STATE_PATH`) but not
  set up for Fargate.
- A replacement recorder needs to be admitted again; two recorders are visible briefly during a
  hand-over.
- Joined multi-part videos have a hard cut at the gap (no "missing" slate).
- One dashboard server (single AZ). Its failure pauses new starts and uploads, not recordings;
  CloudWatch alarms recover/reboot it. State is restorable from the daily S3 DB backup.
- Playwright is pinned at 1.45 and drives the distribution's current Chromium; upgrade Playwright
  if Chromium automation starts failing.
- Zoom/Teams support, scheduling, student access — not built.
- The repository is public and its history contains three sample recordings under
  `recordings/me/` (commit 269e230); remove them from history if that matters.
