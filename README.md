# Google Image Scraper

A high-performance, Node.js-based scraper for Google Images built with Puppeteer. This tool is designed to mimic real user behavior while maximizing scraping speed through intelligent resource management and caching.

## 🚀 Key Features

- **High Performance**: Reuses a single browser instance to eliminate startup latency (saves ~1-2s per request).
- **Bot Detection Avoidance**: Simulates a real desktop browser (Chrome on Windows) to bypass basic bot detection and render dynamic content.
- **Smart Resource Management**: Blocks unnecessary assets (images, fonts, stylesheets) during the search phase to speed up page loads by up to 3x.
- **Fast Validation**: Validates image URLs in parallel using lightweight Node.js HEAD requests, ensuring only accessible images are returned.
- **Intelligent Scrolling**: Custom auto-scroll logic mimics human interaction to trigger lazy-loading of images.
- **In-Memory Caching**: Caches search results for 1 hour, providing instant sub-millisecond responses for repeat queries.

## 🛠️ Technical Architecture & Scraping Mechanics

This scraper is built to handle the complexities of modern Single Page Applications (SPAs) like Google Images while maintaining high throughput.

### 1. Browser Simulation (Detection Avoidance)

- **User-Agent Spoofing**: The scraper sets a standard `Mozilla/5.0...` User-Agent string to identify as a legitimate Chrome browser on Windows 10. This prevents Google from serving a simplified WAP version of the page or blocking the request immediately.
- **Dynamic Rendering**: Uses Puppeteer (Headless Chrome) to fully execute JavaScript, ensuring that dynamic content (which Google uses heavily for image grids) is properly rendered. This is crucial for scraping modern SPAs where static HTML parsers fail.

### 2. Performance Optimization

- **Resource Interception**: To speed up the "search" phase, the scraper intercepts network requests and **aborts** loading of:
  - Images (on the search results page itself)
  - Stylesheets (CSS)
  - Fonts
  - Media
    This allows the scraper to download _only_ the HTML structure and JS needed to find image URLs, significantly reducing bandwidth and CPU usage.
- **Parallel Validation**: Instead of checking images sequentially or inside the heavyweight browser context, the scraper extracts potential URLs and verifies them using lightweight Node.js `http/https` requests. This allows validating 50+ images in seconds.

### 3. Caching Strategy

- **Mechanism**: In-memory `Map`.
- **Key**: `${query}_${count}` (e.g. `ferrari_20`).
- **TTL**: 1 hour (3600 seconds).
- **Benefit**: drastically reduces load on Google's servers and provides instant responses for popular queries.

## 📦 Installation

Prerequisites: Node.js 18+

1.  Clone the repository.
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  (Optional) Install Puppeteer specifically if needed (handled by package.json).

## 🚦 Usage

Start the server:

```bash
node server.js
```

The server will start on port `3000` and launch a headless Chrome instance in the background.

### API Endpoint

**GET** `/api/search`

| Parameter | Type   | Default    | Description                         |
| :-------- | :----- | :--------- | :---------------------------------- |
| `q`       | string | (Required) | The search query (e.g. "red roses") |
| `count`   | number | 20         | Number of images to return (max 50) |

#### Example Request

```bash
curl "http://localhost:3000/api/search?q=puppy&count=10"
```

#### Example Response

```json
{
  "query": "puppy",
  "count": 10,
  "images": [
    "https://example.com/image1.jpg",
    "https://example.com/image2.jpg",
    ...
  ]
}
```

## � Docker Support

You can run the scraper in a Docker container to ensure a consistent environment.

### 1. Build the Image

```bash
docker build -t google-scraper .
```

### 2. Run the Container

```bash
docker run -p 3000:3000 google-scraper
```

The API will be available at `http://localhost:3000/api/search`.

## �📝 License

ISC

## ⚠️ Disclaimer

This tool is for **educational purposes only**.

- Scraping Google Search results may violate Google's Terms of Service.
- The author is not responsible for any misuse of this tool or any consequences resulting from its use (e.g., IP bans).
- Please use responsibly and consider using the official Google Custom Search API for production applications.
