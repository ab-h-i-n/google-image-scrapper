#!/bin/bash
# Run this on each proxy EC2 instance (Ubuntu/Amazon Linux 2)
# Usage: chmod +x install-proxy.sh && sudo ./install-proxy.sh <MAIN_EC2_PRIVATE_IP>

set -e

MAIN_EC2_IP="${1:?Usage: sudo ./install-proxy.sh <MAIN_EC2_PRIVATE_IP>}"
SQUID_PORT=3128

echo "==> Setting up 2GB swap..."
if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "    Swap created and enabled."
else
    echo "    Swap already exists, skipping."
fi

echo "==> Detecting OS..."
if command -v apt &>/dev/null; then
    PKG_MGR="apt"
    apt update -y
    apt install -y squid
elif command -v yum &>/dev/null; then
    PKG_MGR="yum"
    yum install -y squid
else
    echo "Unsupported OS. Install squid manually."
    exit 1
fi

echo "==> Configuring Squid..."
SQUID_CONF="/etc/squid/squid.conf"
cp "$SQUID_CONF" "$SQUID_CONF.bak"

cat > "$SQUID_CONF" <<EOF
# Allow only the main scraper EC2
acl main_ec2 src ${MAIN_EC2_IP}/32
http_access allow main_ec2
http_access deny all

# Port
http_port ${SQUID_PORT}

# Hide proxy headers
forwarded_for off
request_header_access Via deny all
request_header_access X-Forwarded-For deny all
request_header_access Cache-Control deny all

# Minimal logging
access_log none
cache_log /var/log/squid/cache.log

# No caching needed
cache deny all
EOF

echo "==> Configuring UFW firewall..."
if command -v ufw &>/dev/null; then
    ufw allow 22/tcp
    ufw allow ${SQUID_PORT}/tcp
    echo "y" | ufw enable
    echo "    UFW enabled: ports 22 and ${SQUID_PORT} allowed."
else
    echo "    UFW not found, skipping firewall setup."
fi

echo "==> Starting Squid..."
systemctl enable squid
systemctl restart squid

echo "==> Done! Squid proxy running on port ${SQUID_PORT}"
echo "    Only accepting connections from ${MAIN_EC2_IP}"
echo ""
echo "    Test from main EC2:"
echo "    curl -x http://$(hostname -I | awk '{print $1}'):${SQUID_PORT} https://httpbin.org/ip"
