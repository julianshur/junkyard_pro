#!/bin/bash

set -e

FTP_HOST="ftp.junkyardpro.com"
FTP_USER="[julianshur@junkyardpro.com](mailto:julianshur@junkyardpro.com)"
FTP_PORT="21"
REMOTE_DIR="/"

# Prompt for password if not already set

if [ -z "$FTP_PASS" ]; then
read -s -p "FTP Password: " FTP_PASS
echo
fi

COMMIT_MSG="${1:-Auto deploy $(date '+%Y-%m-%d %H:%M:%S')}"

echo "Adding changes..."
git add .

echo "Committing..."
git commit -m "$COMMIT_MSG" || echo "Nothing new to commit."

BRANCH=$(git branch --show-current)

echo "Pushing to Git..."
git push origin "$BRANCH"

echo "Deploying to Turbify via FTPS..."

lftp -u "$FTP_USER","$FTP_PASS" "$FTP_HOST" <<EOF
set ftp:ssl-force true
set ftp:ssl-protect-data true
set ssl:verify-certificate true

open -p $FTP_PORT $FTP_HOST

mirror -R 
--verbose 
--delete 
--exclude .git/ 
--exclude .github/ 
--exclude node_modules/ 
--exclude "*.log" 
./ $REMOTE_DIR

quit
EOF

echo "Deployment complete."
