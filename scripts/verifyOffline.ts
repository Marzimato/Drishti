/**
 * Offline-readiness check for the production build.
 *
 * Run with:  npm run build && npm run verify:offline
 *
 * WHY THIS EXISTS: "it's a PWA, so it works offline" is a claim, not a fact, and the
 * ways it silently stops being true are all invisible in a passing build.
 *
 *   - If any entry in the service worker's precache manifest 404s, `precacheAndRoute`
 *     rejects and the service worker never activates. Not "degrades" — the app has
 *     no offline support at all, while the build output looks perfectly normal.
 *   - If an asset the page needs is shipped but *not* precached, the app loads fine
 *     online and breaks only once the network goes away, which is precisely when
 *     nobody can debug it.
 *   - If a dependency introduces a stylesheet `@import` or a font URL pointing at a
 *     CDN, that request fails offline. Nothing in a typecheck or a unit test notices.
 *
 * Each of those is mechanically checkable against the built output, so it is checked
 * here rather than trusted.
 *
 * WHAT THIS DOES NOT DO: it does not drive a real browser, so it cannot prove the
 * browser installs and serves from the service worker. That still needs a device
 * test with the network off. This narrows what can go wrong; it does not eliminate it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';

const distDirectory = resolve(process.cwd(), 'dist');

const failures: string[] = [];
const notes: string[] = [];

function fail(message: string): void {
  failures.push(message);
}

function note(message: string): void {
  notes.push(message);
}

/* ------------------------------------------------------------------ helpers */

/** Every file in dist, as forward-slash paths relative to dist. */
function listDistFiles(directory = distDirectory): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listDistFiles(full));
    } else {
      found.push(relative(distDirectory, full).split(sep).join(posix.sep));
    }
  }
  return found;
}

function read(relativePath: string): string {
  return readFileSync(join(distDirectory, relativePath), 'utf8');
}

/**
 * Pulls the precache manifest out of the generated service worker.
 *
 * Reads the emitted `{url:"...",revision:...}` entries rather than the plugin's
 * config, because the config states intent and the emitted manifest is what the
 * browser will actually try to fetch. Those diverge whenever a globPattern misses.
 */
function precachedUrls(serviceWorkerSource: string): string[] {
  const urls: string[] = [];
  const pattern = /\{url:"([^"]+)",revision:/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(serviceWorkerSource)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

/** Assets index.html pulls in: the bundles, the manifest, the favicon. */
function referencedByHtml(html: string): string[] {
  const referenced = new Set<string>();
  const attribute = /(?:src|href)="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = attribute.exec(html)) !== null) {
    const value = match[1];
    if (value.startsWith('data:') || value.startsWith('#')) continue;
    if (/^[a-z]+:\/\//i.test(value)) {
      fail(`index.html references an absolute external URL, which cannot load offline: ${value}`);
      continue;
    }
    referenced.add(value.replace(/^\.?\//, ''));
  }
  return [...referenced];
}

/**
 * Constructs that cause a real network request, paired with the off-origin URL they
 * would request.
 *
 * The first version of this check simply flagged every `http(s)://` string in the
 * bundles, and reported four "failures" that were nothing of the kind: React's
 * error-decoder link, two Dexie error messages, and a Workbox console.warn. All four
 * are message text. None is ever fetched.
 *
 * A blunt check that cries wolf is worse than no check, because the next person
 * learns to ignore it. So the question asked here is not "does a URL appear" but
 * "would this URL be requested" — which means matching the constructs that do the
 * requesting.
 */
const FETCHING_CONSTRUCTS: Array<readonly [string, RegExp]> = [
  ['fetch()', /\bfetch\s*\(\s*["'`](https?:\/\/[^"'`]+)/g],
  ['dynamic import()', /\bimport\s*\(\s*["'`](https?:\/\/[^"'`]+)/g],
  ['importScripts()', /\bimportScripts\s*\(\s*["'`](https?:\/\/[^"'`]+)/g],
  ['new Worker()', /new\s+(?:Shared)?Worker\s*\(\s*["'`](https?:\/\/[^"'`]+)/g],
  ['new URL()', /new\s+URL\s*\(\s*["'`](https?:\/\/[^"'`]+)/g],
  ['XMLHttpRequest.open()', /\.open\s*\(\s*["'`][A-Z]+["'`]\s*,\s*["'`](https?:\/\/[^"'`]+)/g],
  ['element.src', /\.src\s*=\s*["'`](https?:\/\/[^"'`]+)/g],
  ['CSS @import', /@import\s+(?:url\(\s*)?["']?(https?:\/\/[^"')\s]+)/g],
  ['CSS url()', /url\(\s*["']?(https?:\/\/[^"')\s]+)/g],
];

function networkRequests(source: string): Array<{ construct: string; url: string }> {
  const found: Array<{ construct: string; url: string }> = [];
  for (const [construct, pattern] of FETCHING_CONSTRUCTS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1].includes('www.w3.org')) continue;
      found.push({ construct, url: match[1] });
    }
  }
  return found;
}

/**
 * Off-origin URLs that are merely embedded as strings.
 *
 * Reported rather than hidden: they are harmless today, but the list is short enough
 * to eyeball, and something genuinely fetched by a construct this script does not
 * model would show up here first.
 */
function embeddedUrlHosts(source: string): string[] {
  const hosts = new Set<string>();
  const pattern = /https?:\/\/([^/\s"'`)\\]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (match[1].includes('www.w3.org')) continue;
    hosts.add(match[1]);
  }
  return [...hosts];
}

/* -------------------------------------------------------------------- checks */

if (!existsSync(distDirectory)) {
  console.error('No dist/ directory. Run `npm run build` first.');
  process.exit(1);
}

const distFiles = listDistFiles();
const distFileSet = new Set(distFiles);

// 1. A service worker has to exist, and index.html has to register it.
const hasServiceWorker = distFileSet.has('sw.js');
if (!hasServiceWorker) {
  fail('dist/sw.js is missing — nothing will be cached, so there is no offline support.');
}

const html = read('index.html');
if (!/registerSW\.js|serviceWorker/.test(html)) {
  fail(
    'index.html does not register a service worker. The worker can exist and still never be installed.',
  );
} else {
  note('index.html registers the service worker');
}

// 2. Every precached URL must actually be present, or the worker fails to install.
const serviceWorker = hasServiceWorker ? read('sw.js') : '';
const precached = precachedUrls(serviceWorker);
const precachedSet = new Set(precached.map((url) => url.replace(/^\.?\//, '')));

if (precached.length === 0 && hasServiceWorker) {
  fail('The service worker precaches nothing.');
}

for (const url of precachedSet) {
  if (!distFileSet.has(url)) {
    fail(
      `Precached "${url}" is not in dist/. One missing entry makes precacheAndRoute reject and the worker never activates.`,
    );
  }
}

// 3. Anything index.html needs must be precached, or it loads online and dies offline.
for (const reference of referencedByHtml(html)) {
  if (!distFileSet.has(reference)) {
    fail(`index.html references "${reference}", which is not in dist/.`);
    continue;
  }
  // The registration script is fetched before the worker exists, so it is allowed
  // not to be precached; in this build it happens to be precached anyway.
  if (!precachedSet.has(reference) && reference !== 'registerSW.js') {
    fail(`"${reference}" is shipped and used by index.html but never precached.`);
  }
}

// 4. The worker must answer navigations from cache, or a refresh offline is a blank page.
if (hasServiceWorker && !serviceWorker.includes('NavigationRoute')) {
  fail(
    'No NavigationRoute in the service worker: the app would load at / but a refresh or deep link offline would fail.',
  );
} else if (hasServiceWorker) {
  note('navigations fall back to the precached index.html');
}

// 5. The worker imports workbox as a separate chunk; it must be shipped too.
const workboxImport = serviceWorker.match(/workbox-[a-z0-9]+/i)?.[0];
if (workboxImport && !distFileSet.has(`${workboxImport}.js`)) {
  fail(`The service worker imports ${workboxImport}.js, which is not in dist/.`);
} else if (workboxImport) {
  note(`workbox runtime ${workboxImport}.js is shipped`);
}

// 6. Nothing in the shipped bundles may actually request something off-origin.
const embeddedHosts = new Set<string>();
let requestingConstructs = 0;

for (const file of distFiles.filter((name) => /\.(js|css|html|webmanifest)$/.test(name))) {
  const source = read(file);
  for (const { construct, url } of networkRequests(source)) {
    requestingConstructs++;
    fail(`${file} would request an off-origin URL via ${construct}, which fails offline: ${url}`);
  }
  for (const host of embeddedUrlHosts(source)) embeddedHosts.add(host);
}

if (requestingConstructs === 0) {
  note('no shipped bundle contains a construct that requests an off-origin URL');
}
if (embeddedHosts.size > 0) {
  note(
    `off-origin hosts appear only as string literals (error messages and doc links), not as requests: ${[...embeddedHosts].sort().join(', ')}`,
  );
}

// 7. The manifest's icons must be cached, or the installed app has no icon offline.
if (distFileSet.has('manifest.webmanifest')) {
  const manifest = JSON.parse(read('manifest.webmanifest')) as {
    icons?: Array<{ src: string }>;
  };
  for (const icon of manifest.icons ?? []) {
    const source = icon.src.replace(/^\.?\//, '');
    if (!precachedSet.has(source)) {
      fail(`Manifest icon "${source}" is not precached.`);
    }
  }
  note(`${manifest.icons?.length ?? 0} manifest icon entries precached`);
}

/* -------------------------------------------------------------------- report */

const totalBytes = distFiles.reduce(
  (sum, file) => sum + statSync(join(distDirectory, file)).size,
  0,
);

console.log('');
console.log('DRISHTI — offline readiness');
console.log('---------------------------');
console.log(`files shipped   : ${distFiles.length}`);
console.log(`files precached : ${precachedSet.size}`);
console.log(`total size      : ${(totalBytes / 1024).toFixed(1)} KiB`);
console.log('');

for (const item of notes) console.log(`  ok    ${item}`);

if (failures.length > 0) {
  console.log('');
  for (const item of failures) console.log(`  FAIL  ${item}`);
  console.log('');
  console.log(`${failures.length} problem(s) would break offline operation.`);
  process.exit(1);
}

console.log('');
console.log('All static offline requirements are satisfied.');
console.log('');
console.log('Still to confirm on a real device, because this check cannot:');
console.log('  1. npm run preview:https');
console.log('  2. Open the HTTPS network URL on the phone, accept the certificate warning.');
console.log('  3. Add it to the home screen, then load it once so the worker installs.');
console.log('  4. Turn on aeroplane mode and launch it from the home screen.');
console.log('');
