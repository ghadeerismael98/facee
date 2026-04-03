import { chromium as playwrightChromium, Browser } from 'playwright';

let browser: Browser | null = null;

const headless = process.env.HEADLESS !== 'false';

const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-infobars',
  '--disable-features=VizDisplayCompositor',
  '--disable-gpu-sandbox',
];

if (headless) {
  CHROMIUM_ARGS.push('--disable-gpu', '--disable-software-rasterizer');
}

let chromium: any = playwrightChromium;

// Try to use playwright-extra with stealth plugin for better anti-detection
try {
  const { chromium: stealthChromium } = require('playwright-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  stealthChromium.use(StealthPlugin());
  chromium = stealthChromium;
  console.log('[BrowserManager] Stealth plugin loaded');
} catch (e) {
  console.log('[BrowserManager] Stealth plugin not available, using vanilla Playwright');
}

export const browserManager = {
  async launch(): Promise<Browser> {
    if (browser && browser.isConnected()) return browser;

    const launchOptions: any = {
      headless,
      args: CHROMIUM_ARGS,
    };

    // Use system Chromium executable if set (Docker headed mode)
    const execPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    if (execPath) {
      const fs = require('fs');
      if (fs.existsSync(execPath)) {
        launchOptions.executablePath = execPath;
        // System chromium may not work with playwright-extra — fall back to vanilla
        chromium = playwrightChromium;
        console.log(`[BrowserManager] Using system Chromium: ${execPath} (vanilla Playwright)`);
      }
    }

    console.log(`[BrowserManager] Launching Chromium (${headless ? 'headless' : 'headed'})...`);

    try {
      browser = await chromium.launch(launchOptions);
    } catch (e: any) {
      // If launch fails with stealth, retry with vanilla playwright
      console.warn(`[BrowserManager] Launch failed: ${e.message}, retrying with vanilla Playwright...`);
      browser = await playwrightChromium.launch(launchOptions);
    }

    browser!.on('disconnected', () => {
      console.log('[BrowserManager] Browser disconnected');
      browser = null;
    });

    console.log('[BrowserManager] Chromium launched');
    return browser!;
  },

  getBrowser(): Browser | null {
    return browser;
  },

  async close(): Promise<void> {
    if (browser) {
      await browser.close();
      browser = null;
    }
  },
};
