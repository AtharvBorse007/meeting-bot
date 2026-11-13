# Running Lecture Recorder on AWS, Google Cloud, Azure or Oracle

The recorder is one Docker image (built for both x86-64 and ARM64) plus Caddy for HTTPS, started
with Docker Compose. It runs the same way on any cloud: **one Linux VM**. Only creating the VM,
opening the firewall and fixing the IP address differ, and that is all this page covers. After it,
continue with step 2 (DNS) of [SETUP.md](SETUP.md).

## What every cloud needs

| | Recommendation |
|---|---|
| Image | **Ubuntu 24.04 LTS** (22.04 and Debian 12 also work), x86-64 or ARM64 |
| Size for up to 3 lectures at once | **4 vCPU, 16 GB RAM** to start; check the CPU use during real lectures and go smaller if it stays low |
| Disk | **100 GB** SSD (about 0.4 GB per lecture hour, kept 14 days after upload) |
| Inbound ports | **22** (SSH, ideally only from your office IP), **80** and **443** TCP, **443** UDP (optional) from anywhere |
| Public IP | **static** (Elastic IP / static external IP / Standard public IP), so the DNS record stays valid |
| Pricing model | normal on-demand, **not** Spot / Preemptible: those can be stopped in the middle of a lecture |
| Burstable sizes | avoid AWS T-series and Azure B-series for daily use: recordings use CPU steadily for hours, which exhausts burst credits |

Each lecture runs its own browser, so the dashboard must run on a VM, not on "serverless"
container services (Cloud Run, AWS Fargate/App Runner, Azure Container Apps). Those stop or
throttle containers between web requests, limit request length, and lose local files on restart,
which would cut off recordings that last for hours.

## The quickest way: let the VM install itself

[`deploy/cloud-init.sh`](../deploy/cloud-init.sh) installs everything on the VM's first boot.
Open it, fill in `DOMAIN` and `ADMIN_EMAIL` at the top (and `REPO_URL` if your repository is not
the public one), and paste the whole file into the VM's start-up script field when you create the
VM (named per cloud below). About ten minutes after the VM starts, the dashboard is running.

- Watch the progress: `sudo tail -f /var/log/lecture-recorder-setup.log`
- The first admin password is printed at the end of that log.
- The code lives in `/opt/lecture-recorder`; the server commands in SETUP.md run in
  `/opt/lecture-recorder/deploy`, with `sudo` (e.g. `sudo docker compose logs -f app`).

If you prefer to install by hand, create the VM without the script, SSH in, and run
`git clone <repo> && cd meeting-bot/deploy && bash install.sh` as described in SETUP.md step 3.

If the DNS record was added after the VM started, run `sudo docker compose restart caddy` in the
`deploy` folder once DNS points at the VM, so the HTTPS certificate is fetched right away.

---

## AWS (EC2)

**Recommended: [AWS.md](AWS.md)** — one CloudFormation template creates the server, a static IP,
an S3 bucket for permanent backups of every recording, the IAM role, alarms and a budget, and the
server installs itself. The manual way:

**Console:** EC2 → *Launch instance*

1. Region: **Asia Pacific (Mumbai) ap-south-1** (or the one closest to your students).
2. AMI: **Ubuntu Server 24.04 LTS** (64-bit x86, or 64-bit Arm for Graviton).
3. Instance type: **m7i.xlarge** (4 vCPU, 16 GiB) or the Graviton **m7g.xlarge** (cheaper, ARM).
4. Key pair: create or choose one.
5. Network settings → *Create security group*: allow **SSH**, **HTTP** and **HTTPS** from anywhere.
6. Storage: **100 GiB gp3**.
7. Advanced details → **User data**: paste `deploy/cloud-init.sh` (filled in).
8. After launch: EC2 → *Elastic IPs* → *Allocate* → *Associate* with the instance. Use this IP in DNS.

**CLI** (AWS CLI v2, from the repository folder):

```bash
REGION=ap-south-1
AMI=$(aws ssm get-parameter --region $REGION \
  --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query Parameter.Value --output text)        # use .../arm64/... with m7g instances

aws ec2 create-security-group --region $REGION --group-name lecture-recorder \
  --description "Lecture Recorder: SSH, HTTP, HTTPS"
aws ec2 authorize-security-group-ingress --region $REGION --group-name lecture-recorder --ip-permissions \
  'IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=0.0.0.0/0}]' \
  'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}]' \
  'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]' \
  'IpProtocol=udp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]'

aws ec2 run-instances --region $REGION --image-id "$AMI" --instance-type m7i.xlarge \
  --key-name YOUR_KEY_PAIR --security-groups lecture-recorder \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=100,VolumeType=gp3}' \
  --user-data file://deploy/cloud-init.sh \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=lecture-recorder}]'

aws ec2 allocate-address --region $REGION                  # note the AllocationId and PublicIp
aws ec2 associate-address --region $REGION --instance-id i-XXXXXXXX --allocation-id eipalloc-XXXXXXXX
```

SSH user: `ubuntu`.

## Google Cloud (Compute Engine)

**Console:** Compute Engine → VM instances → *Create instance*

1. Region **asia-south1 (Mumbai)**, machine type **e2-standard-4** (4 vCPU, 16 GB).
   ARM alternative: **t2a-standard-4** or **c4a-standard-4** where available.
2. Boot disk: **Ubuntu 24.04 LTS** (x86/64 or Arm64 to match), **100 GB** balanced persistent disk.
3. Firewall: tick **Allow HTTP traffic** and **Allow HTTPS traffic**.
4. Advanced → Management → Automation → **Startup script**: paste `deploy/cloud-init.sh` (filled in).
   (Google runs this on every boot; the script notices it has already installed and does nothing.)
5. Keep provisioning model **Standard**.
6. VPC network → *IP addresses*: make the VM's external address **static**.

**CLI** (gcloud):

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud compute firewall-rules create lecture-recorder-web \
  --allow=tcp:80,tcp:443,udp:443 --target-tags=lecture-recorder
gcloud compute addresses create lecture-recorder-ip --region=asia-south1

gcloud compute instances create lecture-recorder --zone=asia-south1-a \
  --machine-type=e2-standard-4 \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=100GB --boot-disk-type=pd-balanced \
  --tags=lecture-recorder --address=lecture-recorder-ip \
  --metadata-from-file=startup-script=deploy/cloud-init.sh

gcloud compute addresses describe lecture-recorder-ip --region=asia-south1 --format='value(address)'
```

SSH: the *SSH* button in the console, or `gcloud compute ssh lecture-recorder --zone=asia-south1-a`.

Free-trial credits: when they run out, a trial account's resources are stopped, not billed (unless
the account was upgraded to paid). Move to the permanent server before that — see *Moving servers*
in SETUP.md.

## Microsoft Azure (Virtual Machines)

**Console:** Virtual machines → *Create* → *Azure virtual machine*

1. Region **Central India** (or the closest one).
2. Image: **Ubuntu Server 24.04 LTS** (x64, or Arm64 for the `p` sizes).
3. Size: **Standard_D4as_v5** (4 vCPU, 16 GiB) or the ARM **Standard_D4ps_v5**.
4. Inbound ports: allow **SSH (22)**, **HTTP (80)**, **HTTPS (443)**.
5. Disks: OS disk **128 GiB Standard SSD** (or Premium SSD).
6. Networking: the new public IP is **Standard SKU**, which is static.
7. Advanced → **Custom data**: paste `deploy/cloud-init.sh` (filled in).

**CLI** (az):

```bash
az group create --name lecture-recorder --location centralindia

az vm create --resource-group lecture-recorder --name lecture-recorder \
  --image Canonical:ubuntu-24_04-lts:server:latest \
  --size Standard_D4as_v5 --os-disk-size-gb 128 \
  --admin-username azureuser --generate-ssh-keys \
  --public-ip-sku Standard \
  --custom-data deploy/cloud-init.sh

az vm open-port --resource-group lecture-recorder --name lecture-recorder --port 80,443 --priority 900
az vm show -d --resource-group lecture-recorder --name lecture-recorder --query publicIps -o tsv
```

SSH user: `azureuser`.

## Oracle Cloud (Always Free)

**Console:** Compute → Instances → *Create instance*

1. Sign up at cloud.oracle.com (a credit or debit card is needed to verify the account). Pick the
   home region closest to your students; it can't be changed later. Upgrading to Pay As You Go
   keeps usage free within the Always Free limits but protects the VM from being reclaimed when idle;
   set a $1 budget alert.
2. Image **Canonical Ubuntu 24.04**, shape **Ampere VM.Standard.A1.Flex**, **2 OCPUs, 12 GB**
   (the free allowance), boot volume **150 GB**, keep "Assign a public IPv4 address".
3. Advanced options → Management → **Cloud-init script**: paste `deploy/cloud-init.sh` (filled in).
4. Instance → Primary VNIC → Subnet → Security list → *Add Ingress Rules*: source `0.0.0.0/0`,
   TCP port **80**, and again for TCP port **443**.
5. Reserve the public IP (Networking → IP management → Reserved public IPs) if you want it to
   survive re-creating the instance.

`install.sh` also opens 80/443 in the VM's own firewall, which Oracle's images close by default.
SSH user: `ubuntu`.

## Your own computer or an office server

Any always-on machine with Ubuntu 24.04 (or Docker installed) works the same way: run
`bash install.sh`. If it has no public IP, a tunnel (for example Cloudflare Tunnel) can publish it
on your domain instead of opening ports.

---

## Checking it

On the VM, in the `deploy` folder:

```bash
sudo docker compose ps              # app (healthy) and caddy should be running
sudo docker compose logs -f app     # what the recorder is doing
sudo docker stats                   # CPU and memory while lectures are recording
```

If CPU stays near 100% while three lectures record, set `MAX_CONCURRENT_BOTS=2` (or choose a
bigger VM); if it stays well below 50%, a smaller VM will do.
