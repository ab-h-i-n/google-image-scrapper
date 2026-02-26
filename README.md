# Google Image Scraper

A high-performance Google Images scraper built with Node.js and Puppeteer, with proxy-based IP rotation to avoid blocks.

## EC2 Deployment Guide

### Prerequisites

- An AWS account with EC2 access
- At least 2 EC2 instances (1 main + 1 or more proxy)
- Security groups configured (see below)

### Same VPC vs Different VPC

Check if your instances are in the same VPC by running this on each EC2:

```bash
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60") && curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/network/interfaces/macs/ | head -1 | xargs -I{} curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/network/interfaces/macs/{}vpc-id
```

| Scenario | Which IP to use | Notes |
|----------|----------------|-------|
| **Same VPC** | Private IP (e.g. `172.31.x.x`) | Free traffic, lower latency, more secure, never changes |
| **Different VPC/Region** | Public IP (Elastic IP recommended) | Elastic IPs don't change on restart; regular public IPs do |

### AWS Security Group Setup

**Main EC2 (scraper app):**
| Type | Port | Source | Purpose |
|------|------|--------|---------|
| SSH | 22 | Your IP | SSH access |
| HTTP | 80 | 0.0.0.0/0 | Public HTTP access |

**Proxy EC2(s):**
| Type | Port | Source | Purpose |
|------|------|--------|---------|
| SSH | 22 | Your IP | SSH access |
| Custom TCP | 3128 | Main EC2 private IP/32 (e.g. `172.31.4.41/32`) | Squid proxy |

### UFW Firewall Setup (on each Proxy EC2)

If UFW is active on your proxy instances, allow port 3128:

```bash
sudo ufw allow 3128/tcp
sudo ufw reload
```

Check UFW status:
```bash
sudo ufw status
```

---

### Step 1: Set Up Proxy EC2 Instances

SSH into each proxy EC2 and run:

```bash
# Download the install script (or scp it from your machine)
scp -i your-key.pem install-proxy.sh ubuntu@<PROXY_EC2_PUBLIC_IP>:~/

# SSH in
ssh -i your-key.pem ubuntu@<PROXY_EC2_PUBLIC_IP>

# Run the installer with your main EC2's private IP
chmod +x install-proxy.sh
sudo ./install-proxy.sh <MAIN_EC2_PRIVATE_IP>
```

This will:
- Create a 2GB swap file
- Install and configure Squid proxy
- Only allow connections from your main EC2
- Strip proxy headers so Google can't detect proxy usage

Verify it's running:
```bash
sudo systemctl status squid
sudo ss -tlnp | grep 3128
```

Repeat for each proxy EC2 instance.

---

### Step 2: Set Up Main EC2 (Scraper App)

SSH into your main EC2:

```bash
ssh -i your-key.pem ubuntu@<MAIN_EC2_PUBLIC_IP>
```

#### Install Docker

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg

# Add Docker's official GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add Docker repo
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Allow running docker without sudo
sudo usermod -aG docker $USER
newgrp docker
```

#### Clone and Run the App

```bash
git clone <your-repo-url> google-search-scrapper
cd google-search-scrapper
```

Configure your proxy IPs in the `.env` file:

```bash
cp .env.example .env
nano .env
```

Example `.env` (use private IPs if same VPC, public/Elastic IPs if different VPC):
```
PORT=3000
PROXY_LIST=172.31.35.106,172.31.40.50
```

Build and run:

```bash
docker compose up -d --build
```

To apply changes after editing `.env`, restart:

```bash
docker compose up -d --build
```

---

### Step 3: Verify Everything Works

From your main EC2, test each proxy:

```bash
# Test proxy connectivity (use private or public IP based on your setup)
curl -x http://<PROXY_EC2_IP>:3128 https://httpbin.org/ip
```

The response should show the **proxy EC2's public IP**, not your main EC2's IP.

Test the scraper API:

```bash
curl "http://localhost/api/search?q=puppies&count=5"
```

From your browser, visit:

```
http://<MAIN_EC2_PUBLIC_IP>
```

---

### Troubleshooting

| Problem | Likely Cause | Fix |
|---------|-------------|-----|
| `curl` hangs/times out | AWS security group missing port 3128 rule | Add inbound rule for port 3128 from main EC2 IP |
| `403 CONNECT tunnel failed` | Squid ACL rejecting your IP | Re-run `install-proxy.sh` with correct main EC2 IP, or fix manually: `sudo sed -i 's\|acl main_ec2 src .*/32\|acl main_ec2 src <MAIN_EC2_PRIVATE_IP>/32\|' /etc/squid/squid.conf && sudo systemctl restart squid` |
| `Connection refused` | Squid not running | `sudo systemctl restart squid` and check `sudo systemctl status squid` |
| UFW blocking | OS firewall active | `sudo ufw allow 3128/tcp` |

---

## Adding More Proxies

1. Launch a new EC2 instance
2. Add port 3128 inbound rule in its security group (source: main EC2 IP)
3. Run `install-proxy.sh` on it with your main EC2's private IP
4. If UFW is active: `sudo ufw allow 3128/tcp`
5. Add its IP to `PROXY_LIST` in `.env` on the main EC2
6. `docker compose up -d --build`

---

## API Reference

**GET** `/api/search`

| Parameter | Type   | Default    | Description                         |
|-----------|--------|------------|-------------------------------------|
| `q`       | string | (required) | Search query (e.g. "red roses")     |
| `count`   | number | 20         | Number of images to return (max 50) |

**Example:**

```bash
curl "http://<YOUR_EC2_IP>/api/search?q=sunset&count=10"
```

**Response:**

```json
{
  "query": "sunset",
  "count": 10,
  "images": [
    "https://example.com/image1.jpg",
    "https://example.com/image2.jpg"
  ]
}
```

---

## Architecture

```
User Request
     │
     ▼
Main EC2 (Docker)
├── Express API (port 80 → 3000)
├── Browser Pool (round-robin)
│   ├── Direct (main EC2 IP)
│   ├── Proxy 1 → EC2-A (Squid)
│   ├── Proxy 2 → EC2-B (Squid)
│   └── Proxy N → EC2-N (Squid)
└── In-memory cache (1hr TTL)
```

Each request rotates to the next browser/proxy, distributing load across IPs.

---

## Disclaimer

This tool is for **educational purposes only**.

- Scraping Google Search results may violate Google's Terms of Service.
- The author is not responsible for any misuse or consequences (e.g., IP bans).
- Consider using the official Google Custom Search API for production use.

## License

ISC
