# Lecture Recorder on AWS (pay per use)

One CloudFormation template ([`deploy/aws/lecture-recorder.yaml`](../deploy/aws/lecture-recorder.yaml))
creates everything. You pay for recorders **only while lectures are being recorded**:

```
 Instructors ──HTTPS──► Dashboard server  (t4g.micro, always on: login, lectures, YouTube uploads)
                           │ starts one task per lecture          ▲ status every 5 s, End
                           ▼                                       │
                        Fargate recorder task  (1 per lecture, exists only during the lecture)
                           │ Chrome in the meeting; uploads the recording every 30 s
                           ▼
                        S3 bucket ──► joined into one video ──► YouTube playlist (unlisted)
```

| Created by the template | Purpose |
|---|---|
| Dashboard server (EC2 **t4g.micro**, Ubuntu 24.04 ARM) + Elastic IP | Dashboard, HTTPS (Caddy + Let's Encrypt), YouTube uploads, joining recordings |
| ECS cluster + recorder task definition (Fargate, ARM, 1 vCPU / 3 GB) | One recorder per lecture, started by Join, gone when the lecture ends |
| ECR repository | The recorder image (built and published by the dashboard server) |
| VPC with 2 public subnets + free S3 endpoint | Network; no NAT gateway (that alone would cost ~$35/month) |
| S3 bucket | Recording segments (kept 3 days), final recordings (→ Glacier Deep Archive after 30 days), daily database backups |
| IAM roles | Dashboard: start recorders, use the bucket, publish the image. Recorders: upload segments only. No keys stored anywhere |
| CloudWatch | Recorder logs (14 days), dashboard auto-recovery/reboot alarms |
| Budget (optional) | Email at 80% of your monthly budget and when the forecast passes it |

## What a lecture costs

Approximate on-demand prices in Mumbai (ap-south-1); confirm with the
[AWS Pricing Calculator](https://calculator.aws/).

| | Quiet month (~100 lecture-hours) | Busy month (~400 lecture-hours) |
|---|---|---|
| Dashboard t4g.micro + 30 GB disk + Elastic IP (always on) | ~$12 | ~$12 |
| Recorders: Fargate ARM 1 vCPU / 3 GB + public IP, ~$0.05 per lecture-hour | ~$5 | ~$20 |
| Data out to YouTube (first 100 GB/month free) | $0 | ~$5 |
| S3 (segments 3 days, recordings 30 days, then Deep Archive ~$0.002/GB) | ~$1–2 | ~$4 |
| Logs, image registry, alarms | <$1 | ~$1 |
| **Total** | **~$20** | **~$40** |

- A day without lectures costs only the dashboard: about **$0.40**.
- Up to 10 lectures at the same time by default (`MaxLecturesAtOnce`); there is nothing to resize.
- **Fargate Spot** (`UseSpot=true`): recorders about 70% cheaper (a busy month ~$27). When AWS
  reclaims a Spot task it gives 2 minutes' notice; a replacement joins the meeting and takes over
  *before* the old recorder leaves, so normally nothing is missed.
- Later, a **Compute Savings Plan** cuts Fargate and EC2 by another ~20–30%.

## What happens when something goes wrong

Your limit: a minute or two missing is acceptable, never the whole lecture or more than 5 minutes.

| Problem | What the system does | Missing |
|---|---|---|
| Recorder crashes / its task disappears | Noticed within ~30 s; a replacement starts and rejoins | ~2–3 min (task start-up) |
| Recorder hangs (no report for 60 s) | Stopped and replaced | ~3–4 min |
| AWS reclaims or retires the task (Spot, maintenance) | Replacement starts first; old one leaves once it's in | ~0 |
| Dashboard server restarts or is updated | Recorders keep recording on their own | 0 |
| Recording upload to S3 fails briefly | Each 30-s piece is retried; nothing is lost | 0 |

Each recorder uploads its recording every 30 seconds, so even a sudden crash loses at most ~30 s
of what was already recorded. Afterwards the pieces are joined into **one video**; the lecture shows
how many recorders it took and how much was missing.

The one thing the system can't fix: if nobody admits the recorder into the meeting. Instructors
should press **Join & record** a couple of minutes before class (the recorder needs 1–2 minutes to
start) and admit it when it asks to join.

## 1. Before you start

- An AWS account in the region you want (Mumbai: `ap-south-1`).
- The ability to add a DNS record for your domain.
- **Commit and push the code** — the server downloads it from the repository.
- An **IAM user** to deploy with: IAM → Users → Create user (`meeting-bot-deployer`, console
  access) → attach `deploy/aws/iam-policy-stackdeploy.json` as a policy. Its IAM rights only cover
  roles named `lecture-recorder-*`, so **name the stack exactly `lecture-recorder`**. Detach the
  policy after deploying; the running app does not use it.
- New accounts can have a low **Fargate vCPU quota** (Service Quotas → AWS Fargate); the template
  allows 10 lectures at once, which needs 10.

### Free-tier accounts: one EC2 server instead

Fargate is not covered by the AWS Free plan. Attach `deploy/aws/iam-policy-singlevm.json` to the
deploying user instead, open **CloudShell** in `ap-south-1`, and run:

```bash
git clone --depth 1 https://github.com/AtharvBorse007/meeting-bot.git && cd meeting-bot
ADMIN_EMAIL=you@deboistech.in bash deploy/aws/launch-single-vm.sh
```

It creates a budget alert (gross cost, so credit-paid usage counts), an Elastic IP, a security
group and an `m7i-flex.large` server (free-plan eligible, 2 vCPU / 8 GB) on `<ip>.sslip.io`,
then prints the follow-up commands (lower `MAX_CONCURRENT_BOTS` to 2, add the daily backup).
The Free plan closes the account after 6 months: upgrade or move before then.

## 2. Create the stack

**Console:** CloudFormation → *Create stack* → *With new resources* → *Upload a template file* →
`deploy/aws/lecture-recorder.yaml` → fill in:

| Parameter | What to enter |
|---|---|
| Dashboard address | e.g. `recorder.deboistech.in` — or leave **empty** to start on a free temporary address (`<ip>.sslip.io`) and switch later with `sudo bash set-domain.sh <your domain>` |
| Admin email / First admin password | your sign-in; the password is temporary |
| Recorder size | keep `medium` (1 vCPU / 3 GB) to start |
| Use Fargate Spot | `false` to start; switch to `true` once real lectures run well |
| Email for alerts | where alarms and budget warnings go (confirm the email AWS sends) |
| SshAllowedCidr / KeyPairName | leave empty — use Session Manager |
| RepoUrl | the repository with this code (private: `https://<token>@github.com/owner/repo.git`) |

Tick *I acknowledge that AWS CloudFormation might create IAM resources* and create the stack
(about 5 minutes).

**CLI** (from the repository folder):

```bash
aws cloudformation deploy --region ap-south-1 --stack-name lecture-recorder \
  --template-file deploy/aws/lecture-recorder.yaml --capabilities CAPABILITY_IAM \
  --parameter-overrides DomainName=recorder.deboistech.in AdminEmail=you@deboistech.in \
    AdminInitialPassword='Temp-Pass-123' AlertEmail=you@deboistech.in \
    RepoUrl=https://github.com/AtharvBorse007/meeting-bot.git
aws cloudformation describe-stacks --region ap-south-1 --stack-name lecture-recorder --query 'Stacks[0].Outputs'
```

## 3. Point your domain at it

From the stack's **Outputs**, add the record shown in `DnsRecord` at your DNS provider (an
**A record**, e.g. `recorder` → the `PublicIp`).

The server then installs itself and builds the recorder image: about **15–20 minutes** on the small
server. Watch it from the `ServerShell` output link (a terminal in the browser):
`sudo tail -f /var/log/lecture-recorder-setup.log`. It is ready when the log ends with
`Recorder image published` and `setup finished`.

If the DNS record was added after the installation and the page shows a certificate error, run once
in the server terminal: `cd /opt/lecture-recorder/deploy && sudo docker compose restart caddy`.

## 4. Sign in and set up

Open `https://<your address>`, sign in with the admin email and first password, and choose your own
password. Then:

1. **Settings → YouTube:** paste the Google OAuth client ID and secret (how to create them:
   [SETUP.md](SETUP.md) steps 4–5; the redirect URI is the `YouTubeRedirectUri` output) and press
   **Connect YouTube**.
2. **Subjects** and **Instructors** as in [SETUP.md](SETUP.md) step 3.
3. Check **Settings → Backups (Amazon S3)** shows the bucket without a warning.

**Test with a real lecture** before relying on it: start a Meet from one device, join it from a
second, press Join & record, admit the recorder, talk and share a screen for a few minutes, press
End & save. Then check the YouTube video (picture and sound). If 1 vCPU did not keep up, the
lecture's activity log says "Recorder … is very busy" — then update the stack with `RecorderSize=large`.

## Running it

Commands run in the server terminal (`ServerShell` link), in `/opt/lecture-recorder/deploy`:

| Task | Command |
|---|---|
| Dashboard logs | `sudo docker compose logs -f app` |
| Recorder logs | `RecorderLogsUrl` output (CloudWatch) |
| Update to new code (recordings carry on) | `sudo bash update.sh` |
| Change a setting | `sudo nano .env`, then `sudo docker compose up -d` |
| New temporary password for an account | `sudo bash reset-password.sh admin@yourdomain` |
| Restore the database from S3 | `sudo bash restore-from-s3.sh` |

Change recorder size or Spot later by **updating the stack** with new parameter values (the
dashboard and its data are not replaced).

**Backups:** the database goes to `db-backups/` in the bucket every day (kept 90 days). Final
recordings are in `recordings/<year>/<month>/<subject>/`; after 30 days they move to Glacier Deep
Archive — still safe, but a download from there needs a restore first (S3 console → object →
*Initiate restore*, up to 12 hours). The YouTube copy is always available.

## Removing it

Delete the stack. The S3 bucket is **kept** on purpose (it holds every recording); empty and delete
it yourself in the S3 console if you really want it gone.

## Security notes

- Only ports 80/443 of the dashboard are open; recorders accept no inbound traffic at all.
- The server is managed through Session Manager (logged in CloudTrail), no SSH keys.
- Each recorder authenticates to the dashboard with a random secret valid only for its own lecture,
  and can only upload to `segments/` in the bucket.
- The first admin password is visible to AWS users who can read the instance's user data; it only
  works until the first sign-in, when it must be replaced.
