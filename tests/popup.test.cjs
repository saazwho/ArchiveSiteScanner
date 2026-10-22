const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPopup() {
  const storage = {};
  const context = vm.createContext({
    URL, URLSearchParams, console, setTimeout, clearTimeout, AbortController,
    document: { addEventListener() {} },
    chrome: { storage: { local: {
      get: async () => structuredClone(storage),
      set: async values => Object.assign(storage, structuredClone(values)),
    } } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8'), context);
  return { context, storage };
}
const record = url => ({ url, timestamp: '20240101120000', status: '200', mimetype: 'text/html' });
const options = { limit: 5000, from: '', to: '', only200: true };

function collect(node) {
  return [...node.records, ...[...node.children.values()].flatMap(collect)];
}

test('tree preserves directory landing pages, URL variants, and multiple hosts', () => {
  const { context } = loadPopup();
  const records = [
    'https://example.com/', 'https://example.com/admin', 'https://example.com/admin/',
    'https://example.com/admin/login', 'https://example.com/search?q=one',
    'https://example.com/search?q=two', 'http://example.com/admin',
    'https://www.example.com/',
  ].map(record);
  const tree = context.buildTree(records);
  assert.equal(tree.count, records.length);
  assert.deepEqual(collect(tree).map(r => r.url).sort(), records.map(r => r.url).sort());
  assert.equal(tree.children.get('example.com').children.get('admin').count, 4);
});

test('reserved object names are ordinary paths, without prototype mutation', () => {
  const { context } = loadPopup();
  const records = ['https://example.com/__proto__/polluted', 'https://example.com/constructor/prototype', 'https://example.com/toString'].map(record);
  const tree = context.buildTree(records);
  assert.equal(collect(tree).length, 3);
  assert.equal(vm.runInContext('Object.prototype.polluted', context), undefined);
});

test('cache separates every query option and retains the local demo source', async () => {
  const { context } = loadPopup();
  await context.setCachedResults('example.com', options, [record('https://example.com/')], 'test');
  assert.equal((await context.getCachedResults('example.com', options)).source, 'test');
  for (const change of [{ limit: 100 }, { from: '20240101' }, { to: '20241231' }, { only200: false }]) {
    assert.equal(await context.getCachedResults('example.com', { ...options, ...change }), null);
  }
  assert.equal(await context.getCachedResults('another.example', options), null);
});

test('cache cleanup drops expired and legacy entries, keeping current data', async () => {
  const { context, storage } = loadPopup();
  await context.setCachedResults('fresh.example', options, []);
  await context.setCachedResults('expired.example', options, []);
  storage.archivum_cache[context.cacheKey('expired.example', options)].timestamp -= 31 * 60 * 1000;
  storage.archivum_cache['legacy.example'] = { timestamp: Date.now(), records: [] };
  await context.cleanExpiredCache();
  assert.equal(Object.keys(storage.archivum_cache).length, 1);
  assert.equal(await context.getCachedResults('expired.example', options), null);
  assert.ok(await context.getCachedResults('fresh.example', options));
});

test('unsafe or malformed URLs never become clickable results', () => {
  const { context } = loadPopup();
  const records = context.normalizeRecords([
    record('javascript:alert(1)'), record('data:text/html,test'), record('invalid'), null,
    { url: 'https://example.com/', status: 200 },
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, '200');
});

test('search highlights escape markup and preserve query-string distinctions', () => {
  const { context } = loadPopup();
  assert.equal(context.highlight('<img onerror="boom">', 'img'), '&lt;<mark>img</mark> onerror=&quot;boom&quot;&gt;');
  assert.equal(context.recordLabel(record('https://example.com/find?q=one'), 'find'), 'find?q=one');
  assert.equal(context.recordLabel(record('https://example.com/admin/'), 'admin'), 'admin/');
  assert.equal(context.recordLabel(record('https://example.com/admin')), '/admin');
  assert.equal(context.recordLabel(record('https://example.com/admin/')), '/admin/');
});

test('only HTTP and HTTPS tabs can be queried', () => {
  const { context } = loadPopup();
  assert.equal(context.getTarget({ url: 'https://example.com/path' }).hostname, 'example.com');
  for (const url of ['chrome://extensions', 'about:blank', 'file:///tmp/index.html', undefined]) {
    assert.throws(() => context.getTarget({ url }), /Open a website/);
  }
});

test('CDX requests preserve scope, fields, filters, and successful response records', async () => {
  const { context } = loadPopup();
  let request;
  context.fetch = async url => {
    request = new URL(url);
    return { ok: true, json: async () => [['original', 'timestamp', 'statuscode', 'mimetype'], ['https://example.com/', '20240201120000', '200', 'text/html']] };
  };
  const records = await context.fetchFromArchive('example.com', { ...options, from: '20240101', to: '20241231' });
  assert.equal(request.origin, 'https://web.archive.org');
  assert.equal(request.searchParams.get('url'), 'example.com/*');
  assert.equal(request.searchParams.get('collapse'), 'urlkey');
  assert.equal(request.searchParams.get('filter'), 'statuscode:200');
  assert.equal(request.searchParams.get('from'), '20240101');
  assert.equal(request.searchParams.get('to'), '20241231');
  assert.equal(records[0].timestamp, '20240201120000');
  await context.fetchFromArchive('example.com', { ...options, only200: false });
  assert.equal(request.searchParams.has('filter'), false);
});

test('CDX errors and malformed responses produce actionable errors', async () => {
  const { context } = loadPopup();
  context.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(context.fetchFromArchive('example.com', options), /HTTP 503/);
  context.fetch = async () => ({ ok: true, json: async () => ({ error: 'not CDX' }) });
  await assert.rejects(context.fetchFromArchive('example.com', options), /unexpected response/);
});
