#!/usr/bin/env node

/**
 * Instagram Reels downloader automation using Playwright + session cookie injection.
 *
 * Usage:
 *   node scripts/instagram_reels_downloader.js \
 *     --username your_instagram_username \
 *     --sessionid YOUR_SESSION_ID \
 *     --csrftoken YOUR_CSRF_TOKEN \
 *     --downloadDir ./downloads \
 *     --headless false
 *
 * You can also use environment variables:
 *   IG_USERNAME, IG_SESSIONID, IG_CSRFTOKEN, DOWNLOAD_DIR, HEADLESS
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CONFIG = {
  targetCount: 10,
  downloaderUrl: 'https://sssinstagram.com/reels-downloader',
  timeoutMs: 30_000,
  slowMoMs: 0,
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function toBoolean(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function randomDelay(page, min = 500, max = 1800) {
  const delay = randomInt(min, max);
  await page.waitForTimeout(delay);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return path.resolve(dirPath);
}

function getConfig() {
  const args = parseArgs(process.argv.slice(2));

  const username = args.username || process.env.IG_USERNAME;
  const sessionid = args.sessionid || process.env.IG_SESSIONID;
  const csrftoken = args.csrftoken || process.env.IG_CSRFTOKEN;
  const downloadDir = ensureDir(args.downloadDir || process.env.DOWNLOAD_DIR || './downloads');
  const headless = toBoolean(args.headless ?? process.env.HEADLESS, false);

  if (!username) throw new Error('Missing required username. Use --username or IG_USERNAME.');
  if (!sessionid) throw new Error('Missing required sessionid. Use --sessionid or IG_SESSIONID.');
  if (!csrftoken) throw new Error('Missing required csrftoken. Use --csrftoken or IG_CSRFTOKEN.');

  return {
    username,
    sessionid,
    csrftoken,
    downloadDir,
    headless,
  };
}

async function collectReelUrls(page, username) {
  const reelsUrl = `https://www.instagram.com/${username}/reels/`;
  console.log(`Navigating to ${reelsUrl}`);

  await page.goto(reelsUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeoutMs });
  await randomDelay(page, 1200, 2500);

  const gridCandidates = [
    'a[href*="/reel/"]',
    'main a[href*="/reel/"]',
    'article a[href*="/reel/"]',
  ];

  let links = [];
  for (const selector of gridCandidates) {
    try {
      await page.waitForSelector(selector, { timeout: 8_000, state: 'visible' });
      links = await page.$$eval(selector, (anchors) =>
        anchors
          .map((a) => a.href)
          .filter((href) => href && href.includes('/reel/'))
      );
      if (links.length > 0) break;
    } catch (error) {
      console.warn(`Selector did not match yet: ${selector} -> ${error.message}`);
    }
  }

  if (links.length < CONFIG.targetCount) {
    console.log('Not enough reels found, attempting a short scroll strategy...');
    for (let i = 0; i < 4 && links.length < CONFIG.targetCount; i += 1) {
      await page.mouse.wheel(0, 1200);
      await randomDelay(page, 1000, 1800);

      try {
        const moreLinks = await page.$$eval('a[href*="/reel/"]', (anchors) =>
          anchors
            .map((a) => a.href)
            .filter((href) => href && href.includes('/reel/'))
        );
        links = links.concat(moreLinks);
      } catch (error) {
        console.warn(`Error while collecting links after scroll: ${error.message}`);
      }
    }
  }

  const deduped = Array.from(new Set(links)).slice(0, CONFIG.targetCount);
  if (deduped.length === 0) {
    throw new Error('No reel URLs found. Session may be invalid or page layout changed.');
  }

  console.log(`Collected ${deduped.length} reel URL(s).`);
  deduped.forEach((url, i) => console.log(`${i + 1}. ${url}`));
  return deduped;
}

async function closeExtraPages(context, mainPage) {
  const pages = context.pages();
  for (const p of pages) {
    if (p !== mainPage && !p.isClosed()) {
      try {
        await p.close({ runBeforeUnload: true });
      } catch {
        // ignore popup close issues
      }
    }
  }
}

async function resolveSelectors(page, selectors, options = {}) {
  for (const selector of selectors) {
    try {
      const element = await page.waitForSelector(selector, options);
      if (element) return { selector, element };
    } catch {
      // continue trying fallback selector
    }
  }
  return null;
}

async function processDownloader(page, context, reelUrl, index, downloadDir) {
  console.log(`\n[${index}] Processing ${reelUrl}`);
  await page.goto(CONFIG.downloaderUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeoutMs });
  await randomDelay(page, 1200, 2200);

  const inputResult = await resolveSelectors(
    page,
    [
      'input[name="id"]',
      'input[type="url"]',
      'input[placeholder*="Instagram"]',
      'input.form-control',
    ],
    { state: 'visible', timeout: 15_000 }
  );

  if (!inputResult) {
    throw new Error('Could not find URL input field on downloader page.');
  }

  try {
    await inputResult.element.fill('');
    await inputResult.element.type(reelUrl, { delay: randomInt(40, 120) });
  } catch (error) {
    throw new Error(`Failed to fill input field (${inputResult.selector}): ${error.message}`);
  }

  await randomDelay(page, 400, 1200);

  const submitResult = await resolveSelectors(
    page,
    [
      'button:has-text("Download")',
      'input[type="submit"]',
      'button[type="submit"]',
      '.button',
    ],
    { state: 'visible', timeout: 10_000 }
  );

  if (!submitResult) {
    throw new Error('Could not find primary download/submit button.');
  }

  try {
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => null),
      submitResult.element.click(),
    ]);
  } catch (error) {
    throw new Error(`Failed to submit downloader form (${submitResult.selector}): ${error.message}`);
  }

  await randomDelay(page, 1200, 2400);

  const finalDownload = await resolveSelectors(
    page,
    [
      'a:has-text("Download")',
      'a[download]',
      'a[href*="cdn"]',
      'a.btn',
    ],
    { state: 'visible', timeout: 20_000 }
  );

  if (!finalDownload) {
    throw new Error('No final download link found in result panel.');
  }

  let savedPath = null;
  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 25_000 }),
      finalDownload.element.click(),
    ]);

    const suggestedName = download.suggestedFilename();
    const targetPath = path.join(downloadDir, `${String(index).padStart(2, '0')}-${suggestedName}`);
    await download.saveAs(targetPath);
    savedPath = targetPath;
  } catch (error) {
    throw new Error(`Download event/click failed (${finalDownload.selector}): ${error.message}`);
  } finally {
    await closeExtraPages(context, page);
  }

  return savedPath;
}

async function run() {
  const cfg = getConfig();
  const browser = await chromium.launch({
    headless: cfg.headless,
    slowMo: CONFIG.slowMoMs,
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1366, height: 900 },
    downloadsPath: cfg.downloadDir,
  });

  await context.addCookies([
    {
      name: 'sessionid',
      value: cfg.sessionid,
      domain: '.instagram.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
    {
      name: 'csrftoken',
      value: cfg.csrftoken,
      domain: '.instagram.com',
      path: '/',
      secure: true,
      sameSite: 'Lax',
    },
  ]);

  const page = await context.newPage();

  try {
    const reelUrls = await collectReelUrls(page, cfg.username);

    const downloadResults = [];
    for (let i = 0; i < reelUrls.length; i += 1) {
      const reelUrl = reelUrls[i];
      try {
        const savedPath = await processDownloader(page, context, reelUrl, i + 1, cfg.downloadDir);
        downloadResults.push({ reelUrl, savedPath, success: true });
        console.log(`[${i + 1}] Saved: ${savedPath}`);
      } catch (error) {
        downloadResults.push({ reelUrl, savedPath: null, success: false, error: error.message });
        console.error(`[${i + 1}] Failed: ${error.message}`);
      }

      await randomDelay(page, 1000, 2600);
    }

    const successful = downloadResults.filter((item) => item.success).length;
    console.log(`\nDone. ${successful}/${downloadResults.length} download(s) saved in ${cfg.downloadDir}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

run().catch((error) => {
  console.error('Fatal automation error:', error);
  process.exitCode = 1;
});
