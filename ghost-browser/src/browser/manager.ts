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
  // Anti-detection: hide automation signals
  '--disable-blink-features=AutomationControlled',
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

    console.log(`[BrowserManager] Launching Chromium (${headless ? 'headless' : 'headed'})...`);
    browser = await chromium.launch({
      headless,
      args: CHROMIUM_ARGS,
    });

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
