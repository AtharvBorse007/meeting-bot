#!/bin/bash
# One EC2 server running everything (RECORDER_MODE=inprocess): the free-tier path.
# Run in AWS CloudShell (region ap-south-1) from a clone of this repository:
#
#   git clone --depth 1 https://github.com/AtharvBorse007/meeting-bot.git && cd meeting-bot
#   ADMIN_EMAIL=you@example.com bash deploy/aws/launch-single-vm.sh
#
# Optional: DOMAIN=recorder.example.com (default: <ip>.sslip.io), BUDGET_EMAIL (default ADMIN_EMAIL),
#           BUDGET_USD (default 20), INSTANCE_TYPE (default m7i-flex.large), REGION (default ap-south-1)
#
# It creates: a monthly budget alert on gross cost, an Elastic IP, a security group (80/443 open,
# 22 only from EC2 Instance Connect) and the server. The IDs are saved to ~/meeting-bot-vm.env,
# and running the script again reuses them instead of creating duplicates.
set -euo pipefail

: "${ADMIN_EMAIL:?Set ADMIN_EMAIL, e.g. ADMIN_EMAIL=you@example.com bash deploy/aws/launch-single-vm.sh}"
REGION="${REGION:-ap-south-1}"
BUDGET_EMAIL="${BUDGET_EMAIL:-$ADMIN_EMAIL}"
BUDGET_USD="${BUDGET_USD:-20}"
INSTANCE_TYPE="${INSTANCE_TYPE:-m7i-flex.large}"
REPO_URL="${REPO_URL:-$(git config --get remote.origin.url 2>/dev/null || echo https://github.com/AtharvBorse007/meeting-bot.git)}"
STATE=~/meeting-bot-vm.env
[ -f "$STATE" ] && . "$STATE"
save() { echo "$1=$2" >> "$STATE"; }

cd "$(dirname "$0")/../.."
[ -f deploy/cloud-init.sh ] || { echo "Run this from the meeting-bot repository"; exit 1; }

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "Account $ACCOUNT, region $REGION, instance $INSTANCE_TYPE"

# 1. Budget alert. IncludeCredit:false so usage paid by free-plan credits still counts.
if ! aws budgets describe-budget --account-id "$ACCOUNT" --budget-name meeting-bot >/dev/null 2>&1; then
  aws budgets create-budget --account-id "$ACCOUNT" \
    --budget "{\"BudgetName\":\"meeting-bot\",\"BudgetLimit\":{\"Amount\":\"$BUDGET_USD\",\"Unit\":\"USD\"},\"TimeUnit\":\"MONTHLY\",\"BudgetType\":\"COST\",\"CostTypes\":{\"IncludeCredit\":false}}" \
    --notifications-with-subscribers "[{\"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":80,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$BUDGET_EMAIL\"}]}]"
  echo "Budget alert created (\$$BUDGET_USD/month, email at 80%)"
else
  echo "Budget 'meeting-bot' already exists"
fi

# 2. Static IP and firewall
if [ -z "${ALLOC:-}" ]; then
  ALLOC=$(aws ec2 allocate-address --region "$REGION" --query AllocationId --output text); save ALLOC "$ALLOC"
fi
IP=$(aws ec2 describe-addresses --region "$REGION" --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text)

if [ -z "${SG:-}" ]; then
  SG=$(aws ec2 create-security-group --region "$REGION" --group-name meeting-bot \
    --description "meeting-bot HTTP HTTPS" --query GroupId --output text); save SG "$SG"
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG" --ip-permissions \
    'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}]' \
    'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]' \
    'IpProtocol=udp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]' >/dev/null
  PL=$(aws ec2 describe-managed-prefix-lists --region "$REGION" \
    --filters "Name=prefix-list-name,Values=com.amazonaws.$REGION.ec2-instance-connect" \
    --query 'PrefixLists[0].PrefixListId' --output text)
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG" \
    --ip-permissions "IpProtocol=tcp,FromPort=22,ToPort=22,PrefixListIds=[{PrefixListId=$PL}]" >/dev/null
fi

# 3. Start-up script with this deployment's settings (a temporary copy; the repo file is unchanged)
DOMAIN="${DOMAIN:-$IP.sslip.io}"
USERDATA=$(mktemp)
sed -e "s|^DOMAIN=.*|DOMAIN=\"$DOMAIN\"|" \
    -e "s|^ADMIN_EMAIL=.*|ADMIN_EMAIL=\"$ADMIN_EMAIL\"|" \
    -e "s|^REPO_URL=.*|REPO_URL=\"$REPO_URL\"|" \
    deploy/cloud-init.sh > "$USERDATA"
grep -E '^(DOMAIN|ADMIN_EMAIL|REPO_URL)=' "$USERDATA"

# 4. The server (x86 types use the amd64 image, Graviton t4g/m7g the arm64 one)
if [ -z "${ID:-}" ]; then
  case "$INSTANCE_TYPE" in *g.*|*gd.*|*gn.*) ARCH=arm64 ;; *) ARCH=amd64 ;; esac
  AMI=$(aws ssm get-parameter --region "$REGION" \
    --name "/aws/service/canonical/ubuntu/server/24.04/stable/current/$ARCH/hvm/ebs-gp3/ami-id" \
    --query Parameter.Value --output text)
  ID=$(aws ec2 run-instances --region "$REGION" --image-id "$AMI" --instance-type "$INSTANCE_TYPE" \
    --security-group-ids "$SG" --metadata-options HttpTokens=required \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=30,VolumeType=gp3,Encrypted=true}' \
    --user-data "file://$USERDATA" \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=meeting-bot}]' \
    --query 'Instances[0].InstanceId' --output text); save ID "$ID"
  aws ec2 wait instance-running --region "$REGION" --instance-ids "$ID"
  aws ec2 associate-address --region "$REGION" --instance-id "$ID" --allocation-id "$ALLOC" >/dev/null
else
  echo "Server $ID already exists; not launching another"
fi
rm -f "$USERDATA"

cat <<EOF

ALLOC=$ALLOC IP=$IP SG=$SG ID=$ID   (saved in $STATE)
Dashboard: https://$DOMAIN   (ready in about 10 minutes)
YouTube redirect URI: https://$DOMAIN/api/youtube/callback

Next: EC2 console -> meeting-bot -> Connect -> EC2 Instance Connect, then
  sudo tail -f /var/log/lecture-recorder-setup.log     # ends with "finished"; admin password just before
When it has finished, size it for this server and add the daily backup:
  cd /opt/lecture-recorder/deploy
  sudo sed -i -e 's/^MAX_CONCURRENT_BOTS=.*/MAX_CONCURRENT_BOTS=2/' -e 's/^LOW_DISK_GB=.*/LOW_DISK_GB=5/' .env
  sudo docker compose up -d
  (sudo crontab -l 2>/dev/null; echo '0 3 * * * bash /opt/lecture-recorder/deploy/backup.sh') | sudo crontab -
Check the budget confirmation email sent to $BUDGET_EMAIL.
EOF
