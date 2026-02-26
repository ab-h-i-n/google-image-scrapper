# Google Image Scraper

A high-performance Google Images scraper built with Node.js and Puppeteer, with proxy-based IP rotation to avoid blocks.

## EC2 Deployment Guide

### Prerequisites

- An AWS account with EC2 access
- At least 2 EC2 instances (1 main + 1 or more proxy)
- All instances should be in the **same VPC** for free internal traffic
- Security groups configured (see below)

### Security Group Setup

**Main EC2 (scraper app):**
| Port | Source | Purpose |
|------|--------|---------|
| 22 | Your IP | SSH access |
| 80 | 0.0.0.0/0 | Public HTTP access |

**Proxy EC2(s):**
| Port | Source | Purpose |
|------|--------|---------|
| 22 | Your IP | SSH access |
| 3128 | Main EC2 security group | Squid proxy |

---

### Step 1: Set Up Proxy EC2 Instances

SSH into each proxy EC2 and run:

```bash
# Download the install script (or scp it from your machine)
scp -i your-key.pem install-proxy.sh ubuntu@<PROXY_EC2_PUBLIC_IP>:~/

# SSH in
ssh -i your-key.pem ubuntu@<PROXY_EC2_PUBLIC_IP>

# Run the installer (defaults to main EC2 IP <MAIN_EC2_PUBLIC_IP>)
chmod +x install-proxy.sh
sudo ./install-proxy.sh
```

This will:
- Create a 2GB swap file
- Install and configure Squid proxy
- Only allow connections from your main EC2
- Strip proxy headers so Google can't detect proxy usage

Verify it's running:
```bash
sudo systemctl status squid
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

Run with proxy IP rotation:

```bash
docker compose up -d --build
```

Configure your proxy IPs in the `.env` file (see `.env.example`):

```bash
cp .env.example .env
# Edit .env with your proxy EC2 private IPs
```

Example `.env`:
```
PORT=3000
PROXY_LIST=10.0.1.10,10.0.1.11,10.0.1.12
```

To apply changes, restart:

```bash
docker compose up -d --build
```

---

### Step 3: Verify Everything Works

From your main EC2, test each proxy:

```bash
# Test proxy connectivity
curl -x http://<PROXY_EC2_PRIVATE_IP>:3128 https://httpbin.org/ip
```

Test the scraper API:

```bash
curl "http://localhost/api/search?q=puppies&count=5"
```

From your browser, visit:

```
http://<MAIN_EC2_PUBLIC_IP>
```

---

## Adding More Proxies

1. Launch a new EC2 instance in the same VPC
2. Add port 3128 inbound rule from main EC2's security group
3. Run `install-proxy.sh` on it
4. Add its private IP to `PROXY_LIST` in `docker-compose.yml`
5. `docker compose up -d --build`

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
