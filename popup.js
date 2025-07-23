// Dynamically insert a search box above the results
const resultsList = document.getElementById('results');
(function insertSearchBox() {
  const container = document.createElement('div');
  container.className = 'py-2';
  const input = document.createElement('input');
  input.id = 'searchInput';
  input.type = 'text';
  input.placeholder = 'Filter by extension (e.g. .html)';
  input.className = 'w-full p-2 rounded border border-gray-300 mb-2';
  container.appendChild(input);
  resultsList.parentNode.insertBefore(container, resultsList);
})();

const scanBtn     = document.getElementById('scanBtn');
const exportBtn   = document.getElementById('exportBtn');

let globalTree = null;
let allUrls    = [];

scanBtn.addEventListener('click', async () => {
  // clear search input
  const searchInput = document.getElementById('searchInput');
  searchInput.value = '';

  resultsList.innerHTML = `
    <div class="flex items-center justify-center gap-2 py-4">
      <i class="fas fa-spinner fa-spin text-white text-3xl"></i>
      <span class="text-white font-medium">Polling archive...</span>
    </div>
  `;
  exportBtn.classList.add('hidden');
  window._scannedUrls = [];

  try {
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

exportBtn.addEventListener('click', () => {
  const blob = new Blob([allUrls.join('\n')], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'archived_urls.txt';
  a.click();
  URL.revokeObjectURL(url);
});

function buildFlatTree(urls) {
  const tree = {};
  urls.forEach(raw => {
    try {
      const parts = new URL(raw).pathname.split('/').filter(Boolean);
      if (!parts.length || raw.endsWith('/')) parts.push('index.html');
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

// Filter logic: show only files matching extension
const searchInput = document.getElementById('searchInput');
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
