# Lecture Recorder — setup guide

This puts the recorder on the internet at your own address (for example
`https://recorder.deboistech.in`). It runs on one Linux VM on any cloud — **AWS, Google Cloud,
Azure or Oracle** — or on your own always-on machine.

| Piece | What it does | Cost |
|---|---|---|
| One Linux VM (4 vCPU / 16 GB to start) | Runs the dashboard and the recorder browsers | Oracle's Always Free VM costs nothing; on AWS, Google Cloud and Azure it is a normal VM (credits can cover it) |
| Caddy (included) | HTTPS certificate for your domain, renewed automatically | Free |
| YouTube channel | Stores and streams every lecture, one playlist per subject | Free |
| Google Cloud project | Gives the app permission to upload to that channel | Free (no billing account needed) |

Plan for about an hour the first time. Steps 1–3 get the dashboard online; steps 4–5 connect YouTube.

---

## 1. Create the server

Follow the section for your cloud in **[CLOUD.md](CLOUD.md)** (console steps and CLI commands for
AWS, Google Cloud, Azure and Oracle). If you paste `deploy/cloud-init.sh` into the VM's start-up
script field as described there, the VM installs itself and you can skip step 3.

Note the VM's **static public IP address**.

## 2. Point your domain at it

At your domain's DNS provider, add an **A record**:

| Name | Type | Value |
|---|---|---|
| `recorder` (for recorder.yourdomain.com) | A | the server's public IP |

Wait until `ping recorder.yourdomain.com` shows that IP (usually minutes).

## 3. Install and start

From your computer:

```bash
ssh ubuntu@<server-ip>
```

On the server:

```bash
git clone https://github.com/omkar-kokane/meeting-bot.git
cd meeting-bot/deploy
bash install.sh
```

Make sure the code you want to run has been committed and pushed first. If the repository is
private, create a read-only access token on GitHub and clone with it. (Copying the folder up with
`scp` also works; leave out `node_modules`, `data` and `recordings`.)

`install.sh` asks for the dashboard address and the admin email, installs Docker, opens the
firewall, builds the app and starts it. At the end it prints the **admin sign-in** — the password
is temporary and must be changed at the first sign-in. (To see it again later:
`docker compose logs app | grep -A6 "Admin account"`.)

Log out of the server and back in once after the install, so `docker` commands work without `sudo`.

Open `https://recorder.yourdomain.com` and sign in. The certificate is fetched on the first visit,
so the very first load can take a few seconds.

Then, in the dashboard:

1. **Subjects** → add your subjects (e.g. "Physics – Batch A"). Each becomes one YouTube playlist.
2. **Instructors** → *Add instructor*, tick their subjects. Send them the sign-in details the
   dashboard shows; they choose their own password at the first sign-in.

Recording already works at this point: lectures are kept on the server and wait until YouTube is
connected.

## 4. Prepare the YouTube channel

1. Use a dedicated Google account for the lectures (e.g. `lectures@deboistech.in` or a Gmail
   address) and create its **YouTube channel** at youtube.com (profile → Create a channel).
2. **Verify the account** at **youtube.com/verify** (phone number). Without this YouTube rejects
   videos longer than 15 minutes.

## 5. Connect YouTube

1. Go to **console.cloud.google.com** (signed in with any Google account you control) and create a
   project, e.g. "Lecture Recorder". No billing account is needed.
2. **APIs & Services → Library** → search **YouTube Data API v3** → **Enable**.
3. **Google Auth Platform** (formerly "OAuth consent screen") → *Get started*:
   - App name "Lecture Recorder", your support email, audience **External**, your contact email.
   - **Audience → Publish app** so the status is **In production**.
     *This matters:* while an app is in "Testing", Google ends its access after 7 days and uploads
     stop until someone reconnects.
4. **Clients → Create client**:
   - Application type **Web application**
   - Authorized redirect URI: `https://recorder.yourdomain.com/api/youtube/callback`
     (the exact address is also shown in the dashboard under **Settings**)
   - Copy the **Client ID** and **Client secret**.
5. In the dashboard: **Settings → YouTube**, paste the **Client ID** and **Client secret** and
   press *Save YouTube app*. (Alternatively set `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` in
   `deploy/.env` on the server; values there take precedence.)

6. Still in **Settings**, press **Connect YouTube**, and sign in with the **channel's** Google
   account. Google warns *"Google hasn't verified this app"*: that is expected for your own private
   app — choose **Advanced → Go to Lecture Recorder** and allow both YouTube permissions.
   (Verification by Google is only needed for apps that many outside users sign in to.)

Recordings that were waiting start uploading straight away.

### Check with a test lecture

Start a Google Meet from one device, join it from a second device (the recorder leaves meetings
where it is alone), start the recorder from the dashboard, admit it, talk and share a screen for a
couple of minutes, then press **End & save**. Within a few minutes the dashboard shows *On YouTube*
with **Watch** and **Playlist** links. Open the video and check that it is **unlisted** with sound
and picture.

---

## How lectures are recorded

- The recorder joins as a guest named **Lecture Recorder** (`BOT_NAME`). If the meeting asks, admit
  it — it waits up to 10 minutes (`JOIN_WAIT_TIME_MINUTES`).
- It records the meeting tab exactly as a participant sees it: the speaker or the shared screen,
  with everyone's audio.
- It keeps recording through silence and breaks. It leaves when the instructor presses
  **End & save**, when the meeting ends, when it has been the only one in the meeting for
  10 minutes (`LECTURE_ALONE_EXIT_MINUTES`), or after 5 hours (`LECTURE_MAX_HOURS`).
- Up to 3 lectures can be recorded at the same time (`MAX_CONCURRENT_BOTS`). A fourth is refused
  with a clear message rather than queued, because a queued live lecture would be missed.
- Recordings shorter than a minute are kept on the server but not uploaded (accidental starts).
- If the server restarts in the middle of a lecture, what was recorded until then is saved and
  uploaded, and the lecture says so.

Meetings the recorder **cannot** join: meetings restricted to signed-in members of one Google
Workspace organisation, and meetings where nobody admits it.

## Running it

| Task | Command (in `~/meeting-bot/deploy`) |
|---|---|
| See what is happening | `docker compose logs -f app` |
| Change a setting | edit `.env`, then `docker compose up -d` |
| Update to new code | `bash update.sh` (refuses while lectures are recording) |
| Back up accounts, subjects and history | `bash backup.sh` (daily: `crontab -e` → `0 3 * * * bash /home/ubuntu/meeting-bot/deploy/backup.sh`) |
| Restart | `docker compose restart app` (in-progress recordings are saved first) |

**Disk space.** At the default quality a lecture hour is about 0.4 GB. The server copy of a
recording is deleted 14 days after it is safely on YouTube (`LOCAL_RETENTION_DAYS`), or earlier
when the disk has less than 15 GB free (`LOW_DISK_GB`). Recordings that have not reached YouTube
yet are never deleted. *Settings* in the dashboard shows the disk usage.

**Capacity.** Three simultaneous recordings is the default limit (`MAX_CONCURRENT_BOTS`). If the
recordings stutter, lower `MAX_CONCURRENT_BOTS` to 2, or lower `RECORDING_VIDEO_KBPS` /
`RECORDING_FPS`.

## Moving servers

Everything that matters (accounts, subjects, lecture history and the YouTube connection) is in the
database; the videos are on YouTube. To move, between lectures:

1. Old server: `cd ~/meeting-bot/deploy && bash backup.sh` and copy `deploy/.env` and the newest
   `deploy/backups/meetingbot-*.db` to your computer (or straight to the new server with `scp`).
2. Make sure nothing is still waiting to upload (Settings → *Waiting to upload* is 0).
3. New server: put the old `deploy/.env` in place, run `bash install.sh` (step 3), copy the backup
   into `deploy/backups/`, then
   ```bash
   bash restore.sh backups/meetingbot-YYYY-MM-DD-HHMM.db
   ```
4. Point the domain's DNS A record at the new server's IP. The address stays the same, so the
   YouTube redirect URI and everyone's bookmarks keep working.

## Troubleshooting

| Problem | What to check |
|---|---|
| The address does not load | DNS A record points at the server; ports 80/443 allowed in the cloud firewall (security group / firewall rule / NSG / security list, see CLOUD.md); `docker compose ps` shows both containers running |
| "Not secure" / certificate error | DNS must point at the server *before* the first visit; `docker compose logs caddy` |
| Recorder stays "Waiting to be admitted" | Someone in the meeting must admit it; meetings limited to one organisation can't be joined |
| A lecture shows "Upload will retry" | The reason is shown on the lecture; it retries by itself. YouTube's daily upload limit resets at midnight US Pacific time |
| Settings says YouTube stopped accepting the connection | Press **Reconnect**. If it happens every week, the Google app is still in "Testing" — publish it (step 5.3) |
| Forgot a password | Instructors: the admin sets a new temporary one under **Instructors → Edit**. Admin: `bash reset-password.sh admin@yourdomain.com` on the server prints a new temporary password |
| YouTube videos end up *private* although they should be unlisted | Google can restrict uploads from new API projects until they pass an audit. Check the video in YouTube Studio; if it says "locked as private", request the audit from the YouTube API Services form |
