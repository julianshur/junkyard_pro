#!/bin/bash

set -e

FTP_HOST="ftp.junkyardpro.com"
FTP_USER="julianshur@junkyardpro.com"
REMOTE_DIR="/public_html"

# Prompt for FTP password
read -s -p "FTP Password: " FTP_PASS
echo

COMMIT_MSG="${1:-Auto deploy $(date '+%Y-%m-%d %H:%M:%S')}"

echo "Adding changes..."
git add .

echo "Committing..."
git commit -m "$COMMIT_MSG" || echo "Nothing new to commit."

BRANCH=$(git branch --show-current)

echo "Pushing to Git..."
git push origin "$BRANCH"

# Create temporary WinSCP script
cat > winscp-upload.txt << EOF
open ftps://$FTP_USER:$FTP_PASS@$FTP_HOST/ -explicit
option batch abort
option confirm off

synchronize remote "$(pwd)" "$REMOTE_DIR" -delete

exit
EOF

# Locate WinSCP
WINSCP="/c/Program Files (x86)/WinSCP/WinSCP.com"

if [ ! -f "$WINSCP" ]; then
    WINSCP="/c/Program Files/WinSCP/WinSCP.com"
fi

if [ ! -f "$WINSCP" ]; then
    echo "WinSCP.com not found."
    rm -f winscp-upload.txt
    exit 1
fi

echo "Uploading to Turbify..."
"$WINSCP" /script=winscp-upload.txt

rm -f winscp-upload.txt

echo "Deployment complete."