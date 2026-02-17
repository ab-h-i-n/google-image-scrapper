(() => {
  const form = document.getElementById('searchForm');
  const queryInput = document.getElementById('queryInput');
  const countInput = document.getElementById('countInput');
  const searchBtn = document.getElementById('searchBtn');
  const loader = document.getElementById('loader');
  const errorMsg = document.getElementById('errorMsg');
  const results = document.getElementById('results');
  const resultsTitle = document.getElementById('resultsTitle');
  const imageList = document.getElementById('imageList');
  const copyAllBtn = document.getElementById('copyAllBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const toast = document.getElementById('toast');

  let currentUrls = [];

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = queryInput.value.trim();
    const count = parseInt(countInput.value) || 20;
    if (!query) return;

    // Reset UI
    errorMsg.classList.remove('active');
    errorMsg.textContent = '';
    results.classList.remove('active');
    imageList.innerHTML = '';
    currentUrls = [];

    // Show spinner
    loader.classList.add('active');
    searchBtn.disabled = true;

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&count=${count}`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Something went wrong');
      }

      if (data.images.length === 0) {
        throw new Error('No images found. Try a different query.');
      }

      currentUrls = data.images;
      resultsTitle.textContent = `Found ${data.count} image URLs for "${data.query}"`;
      renderImages(data.images);
      results.classList.add('active');
    } catch (err) {
      errorMsg.textContent = err.message;
      errorMsg.classList.add('active');
    } finally {
      loader.classList.remove('active');
      searchBtn.disabled = false;
    }
  });

  function renderImages(urls) {
    imageList.innerHTML = '';
    urls.forEach((url, i) => {
      const li = document.createElement('li');
      li.className = 'image-item';
      li.style.animationDelay = `${i * 0.04}s`;

      li.innerHTML = `
        <span class="item-index">${i + 1}</span>
        <img class="item-thumb" src="${escapeHtml(url)}" alt="Image ${i + 1}" loading="lazy" onerror="this.style.display='none'">
        <div class="item-url">
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(url)}">${escapeHtml(url)}</a>
        </div>
        <button class="item-copy-btn" data-url="${escapeAttr(url)}" title="Copy URL">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </button>
      `;

      imageList.appendChild(li);
    });

    // Attach per-item copy handlers
    imageList.querySelectorAll('.item-copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        copyToClipboard(btn.dataset.url);
        showToast('URL copied to clipboard!');
      });
    });
  }

  // Copy All
  copyAllBtn.addEventListener('click', () => {
    if (currentUrls.length === 0) return;
    copyToClipboard(currentUrls.join('\n'));
    showToast(`Copied ${currentUrls.length} URLs to clipboard!`);
  });

  // Download as TXT
  downloadBtn.addEventListener('click', () => {
    if (currentUrls.length === 0) return;
    const blob = new Blob([currentUrls.join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `image-urls-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('Downloaded as TXT file!');
  });

  function copyToClipboard(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 2500);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Lightbox Logic
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');
  const caption = document.getElementById('caption');
  const lightboxDownloadBtn = document.getElementById('lightbox-download');
  const closeBtn = document.querySelector('.lightbox-close');

  if (lightbox) { 
    imageList.addEventListener('click', (e) => {
      // Handle clicks on thumbnail images
      if (e.target.classList.contains('item-thumb')) {
        lightbox.classList.add('active');
        lightboxImg.src = e.target.src;
        caption.textContent = `Image Source: ${new URL(e.target.src).hostname}`;
        lightboxDownloadBtn.href = e.target.src;
      }
    });
  
    closeBtn.addEventListener('click', () => {
      lightbox.classList.remove('active');
    });
  
    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox) {
        lightbox.classList.remove('active');
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lightbox.classList.contains('active')) {
        lightbox.classList.remove('active');
      }
    });
  }
})();
