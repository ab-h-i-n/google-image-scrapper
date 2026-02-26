#!/bin/bash
# Run this on each proxy EC2 instance (Ubuntu/Amazon Linux 2)
# Usage: chmod +x install-proxy.sh && sudo ./install-proxy.sh <MAIN_EC2_IP> [<ADDITIONAL_IP> ...]
# Pass the main EC2's IP that will connect to this proxy.
# If connecting across VPCs or from localhost, pass the public IP.
# You can pass multiple IPs to allow additional clients (e.g., your local dev machine).

set -e

MAIN_EC2_IP="${1:?Usage: sudo ./install-proxy.sh <MAIN_EC2_IP> [<ADDITIONAL_IP> ...]}"
shift
EXTRA_IPS=("$@")
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

EXTRA_ACL=""
EXTRA_ALLOW=""
for i in "${!EXTRA_IPS[@]}"; do
    EXTRA_ACL="${EXTRA_ACL}acl extra_$i src ${EXTRA_IPS[$i]}/32
"
    EXTRA_ALLOW="${EXTRA_ALLOW}http_access allow extra_$i
"
done

cat > "$SQUID_CONF" <<EOF
# Allowed clients
acl main_ec2 src ${MAIN_EC2_IP}/32
${EXTRA_ACL}
# HTTPS CONNECT support
acl SSL_ports port 443
acl CONNECT method CONNECT

# Allow clients first, then restrict
http_access allow main_ec2
${EXTRA_ALLOW}http_access deny CONNECT !SSL_ports
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
echo "    Accepting connections from: ${MAIN_EC2_IP} ${EXTRA_IPS[*]}"
echo ""
echo "    Test from main EC2:"
echo "    curl -x http://$(hostname -I | awk '{print $1}'):${SQUID_PORT} https://httpbin.org/ip"
