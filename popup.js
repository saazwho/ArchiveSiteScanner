// Move all DOM-dependent code inside DOMContentLoaded
let globalTree = null;
let allUrls = [];
let resultsList, scanBtn, exportBtn, searchInput;

// Cache management constants
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes in milliseconds

// Clean up expired cache entries
async function cleanExpiredCache() {
  try {
    const result = await chrome.storage.local.get('archivum_cache');
    const cache = result.archivum_cache || {};
    const now = Date.now();
    let hasExpired = false;

    for (const [host, data] of Object.entries(cache)) {
      if (now - data.timestamp > CACHE_DURATION) {
        delete cache[host];
        hasExpired = true;
      }
    }

    if (hasExpired) {
      await chrome.storage.local.set({ archivum_cache: cache });
    }
  } catch (err) {
    console.warn('Failed to clean cache:', err);
  }
}

// Get cached results for a host
async function getCachedResults(host) {
  try {
    const result = await chrome.storage.local.get('archivum_cache');
    const cache = result.archivum_cache || {};
    const hostCache = cache[host];
    
    if (hostCache && (Date.now() - hostCache.timestamp < CACHE_DURATION)) {
      return hostCache;
    }
    return null;
  } catch (err) {
    console.warn('Failed to get cache:', err);
    return null;
  }
}

// Store results in cache
async function setCachedResults(host, urls, tree) {
  try {
    const result = await chrome.storage.local.get('archivum_cache');
    const cache = result.archivum_cache || {};
    
    cache[host] = {
      timestamp: Date.now(),
      urls: urls,
      tree: tree
    };
    
    await chrome.storage.local.set({ archivum_cache: cache });
  } catch (err) {
    console.warn('Failed to set cache:', err);
  }
}

function buildFlatTree(urls) {
  const tree = {};
  urls.forEach(raw => {
    try {
      const parts = new URL(raw).pathname.split('/').filter(Boolean);
      if (!parts.length || raw.endsWith('/')) parts.push(raw);
      let cur = tree;
      parts.forEach((seg, i) => {
        if (!cur[seg]) cur[seg] = i === parts.length - 1 ? raw : {};
        cur = cur[seg];
      });
    } catch {
      console.warn('Skipping bad URL', raw);
    }
  });
  return tree;
}

function renderTreeLazy(subtree, depth = 0) {
  const ul = document.createElement('ul');
  ul.classList.add('tree');

  for (const [name, node] of Object.entries(subtree)) {
    const li = document.createElement('li');
    li.classList.add('tree-node');
    li.style.paddingLeft = `${depth * 12}px`;

    if (typeof node === 'string') {
      const icon = document.createElement('i');
      icon.classList.add('fa-regular', 'fa-file', 'mr-2', 'text-gray-700');
      const a = document.createElement('a');
      a.href        = node;
      a.target      = '_blank';
      a.textContent = name;
      a.classList.add('file-link');
      li.append(icon, a);
    } else {
      const details = document.createElement('details');
      details.classList.add('folder');

      const summary = document.createElement('summary');
      summary.classList.add('folder-summary');
      summary.innerHTML = `
        <i class=\"fa-regular fa-folder mr-2\"></i>
        <span class=\"folder-name\">${name}</span>
      `;
      details.appendChild(summary);

      const childUl = document.createElement('ul');
      childUl.classList.add('tree');
      childUl.style.margin = '0'; childUl.style.padding = '0';
      details.appendChild(childUl);

      let populated = false;
      details.addEventListener('toggle', () => {
        const icon = summary.querySelector('i');
        if (details.open) {
          icon.classList.replace('fa-folder', 'fa-folder-open');
          if (!populated) {
            populated = true;
            const entries = Object.entries(node);
            let idx = 0;
            const chunkSize = 50;

            const populateChunk = (deadline) => {
              const fragment = document.createDocumentFragment();
              let count = 0;
              while (idx < entries.length && count < chunkSize && (!deadline || deadline.timeRemaining() > 0)) {
                const [cName, cNode] = entries[idx++];
                const childLi = renderTreeLazy({ [cName]: cNode }, depth + 1).firstElementChild;
                fragment.appendChild(childLi);
                count++;
              }
              childUl.appendChild(fragment);
              if (idx < entries.length) {
                if ('requestIdleCallback' in window) requestIdleCallback(populateChunk);
                else setTimeout(populateChunk, 16);
              }
            };

            if ('requestIdleCallback' in window) requestIdleCallback(populateChunk);
            else setTimeout(populateChunk, 16);
          }
        } else {
          icon.classList.replace('fa-folder-open', 'fa-folder');
        }
      });

      li.appendChild(details);
    }

    ul.appendChild(li);
  }

  return ul;
}

// Initialize popup - load cached results if available
async function initializePopup() {
  try {
    // Clean expired cache first
    await cleanExpiredCache();

    // Determine current host
    let host;
    if (window.chrome?.tabs?.query) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      host = new URL(tab.url).hostname;
    } else {
      host = new URL(window.location.href).hostname;
    }

    // Check for cached results
    const cachedResults = await getCachedResults(host);
    if (cachedResults) {
      // Display cached results immediately
      allUrls = cachedResults.urls;
      globalTree = cachedResults.tree;
      window._scannedUrls = cachedResults.urls;

      resultsList.innerHTML = `
        <div class="flex items-center justify-center gap-2 py-2 mb-2 bg-blue-900/30 rounded">
          <i class="fas fa-database text-blue-400"></i>
          <span class="text-blue-300 text-sm">Cached results loaded (${Math.round((Date.now() - cachedResults.timestamp) / 60000)} min old)</span>
        </div>
      `;

      // Add the tree display after a brief delay
      setTimeout(() => {
        const cacheMessage = resultsList.querySelector('.bg-blue-900\\/30');
        if (cacheMessage) {
          cacheMessage.remove();
        }
        resultsList.appendChild(renderTreeLazy(globalTree));
        exportBtn.classList.remove('hidden');
      }, 1500);
    } else {
      // No cached results - show helpful message
      resultsList.innerHTML = `
        <div class="text-center text-gray-400 py-8">
          <i class="fas fa-search text-4xl mb-3 text-gray-500"></i>
          <p class="mb-2">No cached results found</p>
          <p class="text-sm">Click "Query Current URL" to scan this site</p>
        </div>
      `;
    }
  } catch (err) {
    console.warn('Failed to initialize popup:', err);
    resultsList.innerHTML = `
      <div class="text-center text-gray-400 py-8">
        <i class="fas fa-search text-4xl mb-3 text-gray-500"></i>
        <p class="mb-2">Ready to scan</p>
        <p class="text-sm">Click "Query Current URL" to get started</p>
      </div>
    `;
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Initialize DOM element references
  resultsList = document.getElementById('results');
  scanBtn = document.getElementById('scanBtn');
  exportBtn = document.getElementById('exportBtn');

  // Dynamically insert search box above the results
  function insertSearchBox() {
    const container = document.createElement('div');
    container.className = 'py-2';
    const input = document.createElement('input');
    input.id = 'searchInput';
    input.type = 'text';
    input.placeholder = 'Filter results by extension (e.g. .html)';
    input.className = 'w-full p-2 rounded border border-gray-300 mb-2';
    container.appendChild(input);
    resultsList.parentNode.insertBefore(container, resultsList);
    
    // Now get reference to the search input
    searchInput = document.getElementById('searchInput');
    
    // Add search filter logic
    searchInput.addEventListener('input', () => {
      const extRaw = searchInput.value.trim();
      if (!extRaw) {
        // show full tree
        resultsList.innerHTML = '';
        resultsList.appendChild(renderTreeLazy(globalTree));
        exportBtn.classList.remove('hidden');
        return;
      }
      const ext = extRaw.startsWith('.') ? extRaw : `.${extRaw}`;
      // filter URLs
      const matches = allUrls.filter(u => u.toLowerCase().endsWith(ext.toLowerCase()));
      resultsList.innerHTML = '';
      const ul = document.createElement('ul');
      ul.classList.add('tree');
      matches.forEach(u => {
        const name = new URL(u).pathname.split('/').pop() || u;
        const li = document.createElement('li');
        li.classList.add('tree-node');
        const icon = document.createElement('i');
        icon.classList.add('fa-regular', 'fa-file', 'mr-2', 'text-gray-700');
        const a = document.createElement('a');
        a.href        = u;
        a.target      = '_blank';
        a.textContent = name;
        a.classList.add('file-link');
        li.append(icon, a);
        ul.append(li);
      });
      resultsList.appendChild(ul);
      exportBtn.classList.add('hidden');
    });
  }

  // Insert search box
  insertSearchBox();

  // Add scan button event listener
  scanBtn.addEventListener('click', async () => {
    // clear search input
    searchInput.value = '';
    exportBtn.classList.add('hidden');
    window._scannedUrls = [];

    try {
      // Clean expired cache first
      await cleanExpiredCache();

      // determine host & URL
      let host, urlHref;
      if (window.chrome?.tabs?.query) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        host    = new URL(tab.url).hostname;
        urlHref = tab.url;
      } else {
        host    = new URL(window.location.href).hostname;
        urlHref = window.location.href;
      }

      // Check for cached results first
      const cachedResults = await getCachedResults(host);
      if (cachedResults) {
        resultsList.innerHTML = `
          <div class="flex items-center justify-center gap-2 py-2 mb-2 bg-green-900/30 rounded">
            <i class="fas fa-refresh text-green-400"></i>
            <span class="text-green-300 text-sm">Refreshing from cache (${Math.round((Date.now() - cachedResults.timestamp) / 60000)} min old)</span>
          </div>
        `;
        
        allUrls = cachedResults.urls;
        globalTree = cachedResults.tree;
        window._scannedUrls = cachedResults.urls;
        
        // Add the tree display after a brief delay to show the cache message
        setTimeout(() => {
          const cacheMessage = resultsList.querySelector('.bg-green-900\\/30');
          if (cacheMessage) {
            cacheMessage.remove();
          }
          resultsList.appendChild(renderTreeLazy(globalTree));
          exportBtn.classList.remove('hidden');
        }, 1000);
        
        return;
      }

      // No cache available, fetch fresh data
      resultsList.innerHTML = `
        <div class="flex items-center justify-center gap-2 py-4">
          <i class="fas fa-spinner fa-spin text-white text-3xl"></i>
          <span class="text-white font-medium">Polling archive...</span>
        </div>
      `;

      let urls = [];
      if (host === 'localhost' || host === '127.0.0.1') {
        resultsList.innerHTML = `
          <div class="flex items-center justify-center gap-2 py-4">
            <i class="fas fa-spinner fa-spin text-white text-3xl"></i>
            <span class="text-white font-medium">Generating test tree...</span>
          </div>
        `;
        const base = urlHref.replace(/\/?$/, '');
        urls = [
          `${base}/`,
          `${base}/index.html`,
          `${base}/about.html`,
          `${base}/folder1/`,
          `${base}/folder1/page1.html`,
          `${base}/folder1/page2.html`,
          `${base}/folder2/`,
          `${base}/folder2/subfolder/`,
          `${base}/folder2/subfolder/item.html`
        ];
      } else {
        const apiURL   = `https://web.archive.org/cdx/search/cdx?url=${host}/*&output=json&fl=original&collapse=urlkey`;
        const response = await fetch(apiURL);
        const data     = await response.json();
        resultsList.innerHTML = `
          <div class="flex items-center justify-center gap-2 py-4">
            <i class="fas fa-spinner fa-spin text-white text-3xl"></i>
            <span class="text-white font-medium">Organizing results...</span>
          </div>
        `;
        urls = data.slice(1).map(r => r[0]);
      }

      allUrls = urls;
      window._scannedUrls = urls;

      if (!urls.length) {
        resultsList.innerHTML = `<div class="text-white text-center">No archived URLs found.</div>`;
        return;
      }

      // build tree
      const flat = buildFlatTree(urls);
      const rootFiles = {}, rootDirs = {};
      Object.entries(flat).forEach(([name, node]) => {
        if (typeof node === 'string') rootFiles[name] = node;
        else                            rootDirs[name]  = node;
      });

      const inner = {};
      if (Object.keys(rootFiles).length) inner['/'] = rootFiles;
      Object.assign(inner, rootDirs);
      globalTree = { '/': inner };

      // Cache the results
      await setCachedResults(host, urls, globalTree);

      // render full tree
      resultsList.innerHTML = '';
      resultsList.appendChild(renderTreeLazy(globalTree));
      exportBtn.classList.remove('hidden');
    } catch (err) {
      console.error(err);
      resultsList.innerHTML = `
        <div class="text-red-800 bg-white/70 p-2 rounded text-center">
          ⚠️ Error: ${err.message || err}
        </div>
      `;
    }
  });

  // Add export button event listener
  exportBtn.addEventListener('click', () => {
    const blob = new Blob([allUrls.join('\n')], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'archived_urls.txt';
    a.click();
    URL.revokeObjectURL(url);
  });

  // Initialize the popup
  initializePopup();
});