const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const TRACE_KEY = Symbol.for('odd-ecosys.qa-browser-guard.trace');

function isLoopbackHttpUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return ['http:', 'https:'].includes(url.protocol) && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

function record(entry) {
  const trace = globalThis[TRACE_KEY];
  if (Array.isArray(trace)) trace.push({ sequence: trace.length + 1, ...entry });
}

async function guardContext(context) {
  const originalNewPage = context.newPage.bind(context);
  context.newPage = async (...args) => {
    const page = await originalNewPage(...args);
    page.on('domcontentloaded', () => record({ type: 'domcontentloaded', url: page.url() }));
    return page;
  };
  await context.route('**/*', async route => {
    const requestUrl = route.request().url();
    if (isLoopbackHttpUrl(requestUrl)) return route.continue();
    let host = '<invalid-url>';
    try { host = new URL(requestUrl).hostname; } catch {}
    record({ type: 'blocked', host });
    process.stderr.write(`[qa-browser-egress-guard] aborted external browser request to ${host}\n`);
    return route.abort('blockedbyclient');
  });
  return context;
}

/** Wrap Playwright's Chromium API so each test-created context is guarded before its first page exists. */
export function installLoopbackBrowserGuard(playwright) {
  if (!playwright?.chromium || playwright.chromium[Symbol.for('odd-ecosys.qa-browser-guard.installed')]) return;
  const chromium = playwright.chromium;
  Object.defineProperty(chromium, Symbol.for('odd-ecosys.qa-browser-guard.installed'), { value: true });
  const originalLaunch = chromium.launch.bind(chromium);
  chromium.launch = async (...args) => {
    const browser = await originalLaunch(...args);
    const originalNewContext = browser.newContext.bind(browser);
    browser.newContext = async (...contextArgs) => guardContext(await originalNewContext(...contextArgs));
    const originalNewPage = browser.newPage.bind(browser);
    browser.newPage = async (...pageArgs) => {
      const context = await browser.newContext();
      return context.newPage(...pageArgs);
    };
    return browser;
  };
}

export function isLoopbackBrowserUrl(value) { return isLoopbackHttpUrl(value); }
