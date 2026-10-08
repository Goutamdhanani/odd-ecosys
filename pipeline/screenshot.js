// ============================================================
//  ODD-ECOSYS Pipeline — Screenshot Capture (Placeholder)
//  Will use Playwright when available; currently stores metadata
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCREENSHOTS_DIR = path.join(__dirname, '..', 'data', 'screenshots');

// Ensure directory exists
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

/**
 * Check if Playwright is available.
 */
let _playwrightAvailable = null;
async function isPlaywrightAvailable() {
  if (_playwrightAvailable !== null) return _playwrightAvailable;
  try {
    await import('playwright');
    _playwrightAvailable = true;
  } catch {
    _playwrightAvailable = false;
  }
  return _playwrightAvailable;
}

/**
 * Get the expected screenshot path for a lead.
 * @param {number} leadId
 * @returns {string} Absolute path to screenshot file
 */
export function getScreenshotPath(leadId) {
  return path.join(SCREENSHOTS_DIR, `${leadId}.png`);
}

/**
 * Capture a screenshot of a lead's website.
 * Currently a placeholder — returns null if Playwright isn't installed.
 * When Playwright is available, captures a 1280x720 viewport screenshot.
 *
 * @param {object} lead - Lead object with website_url
 * @returns {Promise<string|null>} Path to screenshot, or null if not captured
 */
export async function captureScreenshot(lead) {
  if (!lead.website_url) {
    return null;
  }

  const screenshotPath = getScreenshotPath(lead.id);

  // Check if screenshot already exists
  if (fs.existsSync(screenshotPath)) {
    return screenshotPath;
  }

  const available = await isPlaywrightAvailable();
  if (!available) {
    // Placeholder: log that screenshot is pending
    // Stage 6 will install Playwright and capture these
    return null;
  }

  // Playwright is available — capture screenshot
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
    });

    let url = lead.website_url;
    if (!url.startsWith('http')) url = `https://${url}`;

    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 15000,
    });

    await page.screenshot({ path: screenshotPath, fullPage: false });
    await browser.close();

    return screenshotPath;
  } catch (error) {
    console.log(`   ⚠️  Screenshot failed for lead #${lead.id}: ${error.message}`);
    return null;
  }
}

/**
 * Get rendered HTML from a page using Playwright (for SPA detection).
 * Returns null if Playwright isn't available.
 *
 * @param {string} url
 * @returns {Promise<{html: string, text: string}|null>}
 */
export async function getRenderedPage(url) {
  const available = await isPlaywrightAvailable();
  if (!available) return null;

  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
    });

    if (!url.startsWith('http')) url = `https://${url}`;

    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 15000,
    });

    const html = await page.content();
    const text = await page.evaluate(() => document.body?.innerText || '');

    await browser.close();
    return { html, text };
  } catch {
    return null;
  }
}
