#!/bin/bash
# Run this on the EC2 instance to set up the scraper
# Usage: chmod +x setup-ec2.sh && sudo ./setup-ec2.sh

set -e

echo "==> Setting up 2GB swap..."
if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "    Swap enabled."
else
    swapon /swapfile 2>/dev/null || true
    echo "    Swap already exists."
fi

echo "==> Installing Node.js 20..."
if ! command -v node &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
fi
echo "    Node $(node --version)"

echo "==> Installing Chrome + Xvfb..."
if ! command -v google-chrome &>/dev/null; then
    wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
    echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' > /etc/apt/sources.list.d/google-chrome.list
    apt update -y
    apt install -y google-chrome-stable
fi
apt install -y xvfb

echo "    Chrome $(google-chrome --version)"

echo "==> Installing pm2..."
npm install -g pm2 2>/dev/null

echo "==> Setting up Xvfb as a systemd service..."
cat > /etc/systemd/system/xvfb.service <<'EOF'
[Unit]
Description=Virtual Framebuffer X Server
After=network.target

[Service]
ExecStart=/usr/bin/Xvfb :99 -screen 0 1920x1080x24 -ac
Restart=always
User=ubuntu

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable xvfb
systemctl start xvfb

echo "==> Done! Now run:"
echo "    cd ~/google-image-scrapper && npm install"
echo "    DISPLAY=:99 PROXY_LIST=<proxy-ips> pm2 start server.js --name scraper"
