// State
let globalTree = null;
let allRecords = [];
let allUrls = [];
let targetHost = '';
let isBusy = false;
let searchGeneration = 0;
let resultsList, scanBtn, refreshBtn, exportBar, searchInput, clearSearchBtn;
let statsBar, statCount, statEarliest, statLatest, statSource;
let optionsPanel, optionsToggle, currentHostEl, statusMessage;

// Cache entries include the query options so different filters never share results.
const CACHE_DURATION = 30 * 60 * 1000;
const DEFAULT_OPTIONS = { limit: 5000, from: '', to: '', only200: true };

function cacheKey(host, options) {
  return JSON.stringify(['v2', host, options.limit, options.from, options.to, options.only200]);
}

async function cleanExpiredCache() {
  try {
    const { archivum_cache: cache = {} } = await chrome.storage.local.get('archivum_cache');
    let changed = false;
    for (const key of Object.keys(cache)) {
      if (!key.startsWith('["v2",') || !cache[key]?.timestamp || Date.now() - cache[key].timestamp >= CACHE_DURATION) {
        delete cache[key];
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ archivum_cache: cache });
  } catch (error) {
    console.warn('Cache cleanup unavailable', error);
  }
}

async function getCachedResults(host, options) {
  try {
    const { archivum_cache: cache = {} } = await chrome.storage.local.get('archivum_cache');
    const entry = cache[cacheKey(host, options)];
    if (entry && Array.isArray(entry.records) && Date.now() - entry.timestamp < CACHE_DURATION) return entry;
  } catch { /* The popup also works when extension storage is unavailable. */ }
  return null;
}

async function setCachedResults(host, options, records, source = 'live') {
  try {
    const { archivum_cache: cache = {} } = await chrome.storage.local.get('archivum_cache');
    cache[cacheKey(host, options)] = { timestamp: Date.now(), records, source };
    await chrome.storage.local.set({ archivum_cache: cache });
  } catch (error) {
    console.warn('Cache write unavailable', error);
  }
}

function esc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SVG = {
  file: '<svg class="node-icon file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6"/></svg>',
  folder: '<svg class="node-icon folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h7l2 3h9v11H3z" fill="currentColor" fill-opacity=".12"/></svg>',
  caret: '<svg class="caret" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3v.5"/></svg>',
};

// Keep a node's own URLs separately from its children. This preserves /admin and
// /admin/login, query-string variants, and URL segments such as __proto__.
function makeNode(name = '') {
  return { name, children: new Map(), records: [], count: 0 };
}

function buildTree(records) {
  const root = makeNode();
  for (const record of records) {
    const url = new URL(record.url);
    const segments = [url.host, ...url.pathname.split('/').filter(Boolean)];
    let node = root;
    node.count++;
    for (const segment of segments) {
      if (!node.children.has(segment)) node.children.set(segment, makeNode(segment));
      node = node.children.get(segment);
      node.count++;
    }
    node.records.push(record);
  }
  return root;
}

function normalizeRecords(records) {
  return records.flatMap(record => {
    try {
      if (!/^https?:$/.test(new URL(record.url).protocol)) return [];
      return [{ url: record.url, timestamp: String(record.timestamp || ''), status: String(record.status || ''), mimetype: String(record.mimetype || '') }];
    } catch { return []; }
  });
}

function highlight(text, query) {
  const index = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  return index < 0 ? esc(text)
    : esc(text.slice(0, index)) + `<mark>${esc(text.slice(index, index + query.length))}</mark>` + esc(text.slice(index + query.length));
}

function createFileItem(record, name, depth, query = '') {
  const li = document.createElement('li');
  li.className = 'tree-item';
  const a = document.createElement('a');
  a.href = record.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.className = 'tree-file';
  a.style.paddingLeft = `${Math.min(depth, 8) * 13 + 8}px`;
  a.title = `${record.url}\nCaptured ${fmtTimestamp(record.timestamp)} · Opens original URL in a new tab`;
  const ext = new URL(record.url).pathname.match(/\.([a-zA-Z0-9]{1,10})$/)?.[1].toUpperCase();
  const status = /^\d{3}$/.test(record.status) ? record.status : '';
  a.innerHTML = `${SVG.file}<span class="node-name">${highlight(name, query)}</span>`
    + (ext ? `<span class="badge ext-badge">${esc(ext)}</span>` : '')
    + (status && status !== '200' ? `<span class="badge s${status[0]}xx">${status}</span>` : '')
    + '<span class="link-arrow" aria-hidden="true">↗</span>';
  li.appendChild(a);
  return li;
}

function recordLabel(record, name) {
  const url = new URL(record.url);
  const pathname = name === undefined ? url.pathname
    : name + (name !== '/' && url.pathname.endsWith('/') ? '/' : '');
  return pathname + url.search + url.hash;
}

function scheduleChunk(callback) {
  if ('requestIdleCallback' in window) window.requestIdleCallback(callback, { timeout: 100 });
  else setTimeout(callback, 16);
}

function populateTree(ul, node, depth) {
  const directories = [...node.children.values()].filter(child => child.children.size);
  const files = [...node.children.values()].filter(child => !child.children.size);
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  const entries = [
    ...directories.sort(byName).map(child => () => createFolderItem(child, depth)),
    ...node.records.map(record => () => createFileItem(record, recordLabel(record), depth)),
    ...files.sort(byName).flatMap(child => child.records.map(record => () => createFileItem(record, recordLabel(record, child.name), depth))),
  ];
  let index = 0;
  const chunk = () => {
    if (!ul.isConnected) return;
    const fragment = document.createDocumentFragment();
    const end = Math.min(index + 50, entries.length);
    while (index < end) fragment.appendChild(entries[index++]());
    ul.appendChild(fragment);
    if (index < entries.length) scheduleChunk(chunk);
  };
  scheduleChunk(chunk);
}

function createFolderItem(node, depth) {
  const li = document.createElement('li');
  li.className = 'tree-item';
  const details = document.createElement('details');
  details.className = 'tree-dir';
  const summary = document.createElement('summary');
  summary.className = 'tree-folder';
  summary.style.paddingLeft = `${Math.min(depth, 8) * 13 + 8}px`;
  summary.innerHTML = `${SVG.caret}${SVG.folder}<span class="node-name">${esc(node.name)}</span><span class="count-badge">${node.count.toLocaleString()}</span>`;
  const ul = document.createElement('ul');
  ul.className = 'tree';
  details.append(summary, ul);
  let populated = false;
  details.addEventListener('toggle', () => {
    if (!details.open || populated) return;
    populated = true;
    populateTree(ul, node, depth + 1);
  });
  // The website starts expanded; nested folders remain lazy and collapsible.
  if (depth === 0) details.open = true;
  li.appendChild(details);
  return li;
}

function renderTree() {
  const ul = document.createElement('ul');
  ul.className = 'tree';
  for (const node of globalTree.children.values()) ul.appendChild(createFolderItem(node, 0));
  resultsList.replaceChildren(ul);
  resultsList.scrollTop = 0;
}

// Query options
function setOptionsOpen(open, restoreFocus = false) {
  optionsPanel.classList.toggle('hidden', !open);
  optionsToggle.classList.toggle('active', open);
  optionsToggle.setAttribute('aria-expanded', String(open));
  if (open) document.getElementById('optLimit').focus();
  else if (restoreFocus) optionsToggle.focus();
}

function readQueryOptions() {
  const limitInput = document.getElementById('optLimit');
  const fromInput = document.getElementById('optFrom');
  const toInput = document.getElementById('optTo');
  for (const field of [limitInput, fromInput, toInput]) field.removeAttribute('aria-invalid');
  document.getElementById('optionsError').classList.add('hidden');
  const invalid = (field, message) => {
    setOptionsOpen(true);
    field.setAttribute('aria-invalid', 'true');
    field.focus();
    const error = document.getElementById('optionsError');
    error.textContent = message;
    error.classList.remove('hidden');
    return null;
  };
  const limit = Number(limitInput.value);
  if (!Number.isInteger(limit) || limit < 100 || limit > 50000) return invalid(limitInput, 'Choose a result limit between 100 and 50,000.');
  for (const field of [fromInput, toInput]) {
    const value = field.value.trim();
    if (!value) continue;
    const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    const date = new Date(`${iso}T00:00:00Z`);
    if (!/^\d{8}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) {
      return invalid(field, 'Enter a valid date as YYYYMMDD, such as 20240131.');
    }
  }
  const from = fromInput.value.trim();
  const to = toInput.value.trim();
  if (from && to && from > to) return invalid(toInput, 'The end date must be on or after the start date.');
  return { limit, from, to, only200: document.getElementById('optStatus200').checked };
}

async function fetchFromArchive(host, options) {
  const params = new URLSearchParams({
    url: `${host}/*`, output: 'json', fl: 'original,timestamp,statuscode,mimetype',
    collapse: 'urlkey', limit: String(options.limit),
  });
  if (options.from) params.set('from', options.from);
  if (options.to) params.set('to', options.to);
  if (options.only200) params.set('filter', 'statuscode:200');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(`https://web.archive.org/cdx/search/cdx?${params}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`The archive returned HTTP ${response.status}. Please try again shortly.`);
    const data = await response.json();
    if (!Array.isArray(data) || data.some(row => !Array.isArray(row))) throw new Error('The archive returned an unexpected response. Please try again.');
    return data.slice(1).map(([url, timestamp, status, mimetype]) => ({ url, timestamp, status, mimetype }));
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The archive is taking longer than expected. Please try again.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function fmtTimestamp(timestamp) {
  if (!timestamp || timestamp.length < 8) return '—';
  return `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`;
}

function setSource(source) {
  const labels = { live: 'Live results', cache: 'From cache', test: 'Local demo', loading: 'Querying', error: 'Try again', ready: 'Ready', empty: 'No results', unsupported: 'Website required' };
  statSource.textContent = labels[source] || source;
  statSource.className = `stat-source src-${source}`;
}

function showStats(records, source) {
  statCount.textContent = records.length.toLocaleString();
  const timestamps = records.map(record => record.timestamp).filter(Boolean).sort();
  statEarliest.textContent = timestamps.length ? fmtTimestamp(timestamps[0]) : '—';
  statLatest.textContent = timestamps.length ? fmtTimestamp(timestamps[timestamps.length - 1]) : '—';
  setSource(source);
  statsBar.classList.remove('hidden');
}

function displayResults(records, source) {
  allRecords = normalizeRecords(records);
  allUrls = allRecords.map(record => record.url);
  globalTree = allRecords.length ? buildTree(allRecords) : null;
  searchGeneration++;
  if (!allRecords.length) {
    statsBar.classList.add('hidden');
    exportBar.classList.add('hidden');
    searchInput.disabled = true;
    setSource('empty');
    resultsList.innerHTML = `<div class="empty-state"><span class="state-icon">${SVG.search}</span><h3 class="empty-title">No pages found this time.</h3><p class="empty-sub">No archived URLs matched this query for<br><strong>${esc(targetHost)}</strong>.</p><p class="empty-hint">Try a wider date range or include other HTTP statuses.</p></div>`;
    statusMessage.textContent = 'No archived URLs matched this query.';
    return;
  }
  showStats(allRecords, source);
  renderTree();
  exportBar.classList.remove('hidden');
  searchInput.disabled = false;
  statusMessage.textContent = `${allRecords.length.toLocaleString()} archived URLs loaded${source === 'cache' ? ' from cache' : ''}.`;
}

// Search rendering is batched so large queries keep the popup responsive.
function applySearch(query) {
  const generation = ++searchGeneration;
  if (!globalTree || isBusy) return;
  clearSearchBtn.classList.toggle('hidden', !query);
  document.getElementById('searchShortcut').classList.toggle('hidden', !!query);
  if (!query) {
    renderTree();
    statusMessage.textContent = 'Showing all archived URLs.';
    return;
  }
  const q = query.toLowerCase();
  const matches = allRecords.filter(record => record.url.toLowerCase().includes(q));
  resultsList.replaceChildren();
  resultsList.scrollTop = 0;
  statusMessage.textContent = `${matches.length.toLocaleString()} search results.`;
  if (!matches.length) {
    resultsList.innerHTML = `<div class="empty-search"><span class="state-icon">${SVG.search}</span><h3 class="empty-title">No matching paths.</h3><p class="empty-sub">Nothing found for “<strong>${esc(query)}</strong>”.<br>Try a different keyword or clear your search.</p></div>`;
    return;
  }
  const header = document.createElement('div');
  header.className = 'search-header';
  header.textContent = `${matches.length.toLocaleString()} matching URL${matches.length === 1 ? '' : 's'}`;
  const ul = document.createElement('ul');
  ul.className = 'tree';
  resultsList.append(header, ul);
  let index = 0;
  const chunk = () => {
    if (generation !== searchGeneration || !ul.isConnected) return;
    const fragment = document.createDocumentFragment();
    const end = Math.min(index + 100, matches.length);
    while (index < end) {
      const record = matches[index++];
      const url = new URL(record.url);
      const name = (url.host.toLowerCase().includes(q) ? url.host : '') + url.pathname + url.search + url.hash;
      fragment.appendChild(createFileItem(record, name, 0, query));
    }
    ul.appendChild(fragment);
    if (index < matches.length) scheduleChunk(chunk);
  };
  chunk();
}

// Export the complete query results, regardless of the current text filter.
function download(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  statusMessage.textContent = `${filename} exported.`;
}

function exportTxt() { download(allUrls.join('\n'), 'archivum_urls.txt', 'text/plain'); }
function exportJson() { download(JSON.stringify(allRecords, null, 2), 'archivum_records.json', 'application/json'); }
function exportCsv() {
  const rows = allRecords.map(record => [record.url, record.timestamp, record.status, record.mimetype]
    .map(value => `"${String(value || '').replace(/"/g, '""')}"`).join(','));
  download(['url,timestamp,status,mimetype', ...rows].join('\n'), 'archivum_records.csv', 'text/csv');
}

async function getActiveTab() {
  if (window.chrome?.tabs?.query) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }
  return { url: window.location.href };
}

function getTarget(tab) {
  let url;
  try { url = new URL(tab?.url); } catch { /* Handled below. */ }
  if (!url || !/^https?:$/.test(url.protocol)) throw new Error('Open a website in an HTTP or HTTPS tab, then reopen Archivum to explore its history.');
  return url;
}

function setLoading(message) {
  setSource('loading');
  resultsList.innerHTML = `<div class="loading-state"><div class="spinner" aria-hidden="true"></div><h3 class="empty-title">Looking back in time…</h3><p class="empty-sub">${esc(message)}</p><p class="empty-sub">Large archives can take a little longer.</p></div>`;
  statusMessage.textContent = message;
}

function setBusy(busy) {
  isBusy = busy;
  scanBtn.disabled = busy || !targetHost;
  refreshBtn.disabled = busy || !targetHost;
  searchInput.disabled = busy || !allRecords.length;
  document.getElementById('scanLabel').textContent = busy ? 'Querying archive…' : 'Query archive';
  resultsList.setAttribute('aria-busy', String(busy));
  for (const input of optionsPanel.querySelectorAll('input')) input.disabled = busy;
}

function showError(error, unsupported = false) {
  setSource(unsupported ? 'unsupported' : 'error');
  resultsList.innerHTML = `<div class="error-state"><span class="state-icon">${SVG.alert}</span><h3 class="empty-title">${unsupported ? 'Start with a website.' : 'The archive couldn’t be reached.'}</h3><p class="empty-sub">${esc(error.message || String(error))}</p></div>`;
  statusMessage.textContent = error.message || String(error);
}

async function doScan(forceRefresh = false) {
  if (isBusy) return;
  const options = readQueryOptions();
  if (!options) return;
  setOptionsOpen(false);
  searchInput.value = '';
  clearSearchBtn.classList.add('hidden');
  document.getElementById('searchShortcut').classList.remove('hidden');
  exportBar.classList.add('hidden');
  statsBar.classList.add('hidden');
  // A failed or empty query must not leave the previous results searchable.
  allRecords = [];
  allUrls = [];
  globalTree = null;
  searchGeneration++;
  setBusy(true);
  setLoading('Searching the Wayback Machine for archived URLs.');
  try {
    const url = getTarget(await getActiveTab());
    targetHost = url.hostname;
    currentHostEl.textContent = targetHost;
    currentHostEl.title = targetHost;
    await cleanExpiredCache();
    if (!forceRefresh) {
      const cached = await getCachedResults(targetHost, options);
      if (cached) {
        displayResults(cached.records, cached.source === 'test' ? 'test' : 'cache');
        return;
      }
    }
    // Preserve the existing local demo without making an external request.
    if (targetHost === 'localhost' || targetHost === '127.0.0.1') {
      const paths = ['/', '/index.html', '/about.html', '/contact.html', '/admin/', '/admin/login.html', '/admin/dashboard.html', '/assets/style.css', '/assets/app.js', '/api/users.json'];
      const records = paths.map(path => ({ url: url.origin + path, timestamp: '20240101120000', status: '200', mimetype: 'text/html' }));
      displayResults(records, 'test');
      await setCachedResults(targetHost, options, records, 'test');
      return;
    }
    const records = normalizeRecords(await fetchFromArchive(targetHost, options));
    displayResults(records, 'live');
    await setCachedResults(targetHost, options, records);
  } catch (error) {
    console.error(error);
    showError(error);
  } finally {
    setBusy(false);
  }
}

// Initialize controls before asynchronous tab/cache reads.
document.addEventListener('DOMContentLoaded', async () => {
  resultsList = document.getElementById('results');
  scanBtn = document.getElementById('scanBtn');
  refreshBtn = document.getElementById('refreshBtn');
  exportBar = document.getElementById('exportBar');
  searchInput = document.getElementById('searchInput');
  clearSearchBtn = document.getElementById('clearSearch');
  statsBar = document.getElementById('statsBar');
  statCount = document.getElementById('statCount');
  statEarliest = document.getElementById('statEarliest');
  statLatest = document.getElementById('statLatest');
  statSource = document.getElementById('statSource');
  optionsPanel = document.getElementById('optionsPanel');
  optionsToggle = document.getElementById('optionsToggle');
  currentHostEl = document.getElementById('currentHost');
  statusMessage = document.getElementById('statusMessage');
  setBusy(true);
  scanBtn.addEventListener('click', () => doScan(false));
  refreshBtn.addEventListener('click', () => doScan(true));
  optionsToggle.addEventListener('click', () => setOptionsOpen(optionsPanel.classList.contains('hidden')));
  document.getElementById('closeOptions').addEventListener('click', () => setOptionsOpen(false, true));
  document.addEventListener('pointerdown', event => {
    if (!optionsPanel.contains(event.target) && !optionsToggle.contains(event.target)) setOptionsOpen(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (!optionsPanel.classList.contains('hidden')) { event.preventDefault(); setOptionsOpen(false, true); }
      else if (document.activeElement === searchInput && searchInput.value) { event.preventDefault(); searchInput.value = ''; applySearch(''); }
    }
    if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.target.matches('input, textarea') && !searchInput.disabled && optionsPanel.classList.contains('hidden')) {
      event.preventDefault();
      searchInput.focus();
    }
  });
  searchInput.addEventListener('input', () => applySearch(searchInput.value.trim()));
  clearSearchBtn.addEventListener('click', () => { searchInput.value = ''; applySearch(''); searchInput.focus(); });
  document.getElementById('exportTxt').addEventListener('click', exportTxt);
  document.getElementById('exportJson').addEventListener('click', exportJson);
  document.getElementById('exportCsv').addEventListener('click', exportCsv);
  try {
    const url = getTarget(await getActiveTab());
    targetHost = url.hostname;
    currentHostEl.textContent = targetHost;
    currentHostEl.title = targetHost;
    await cleanExpiredCache();
    const cached = await getCachedResults(targetHost, DEFAULT_OPTIONS);
    if (cached) displayResults(cached.records, cached.source === 'test' ? 'test' : 'cache');
  } catch (error) {
    currentHostEl.textContent = 'No website selected';
    showError(error, true);
  } finally {
    setBusy(false);
  }
});
