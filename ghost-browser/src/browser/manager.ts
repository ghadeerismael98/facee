import { chromium as playwrightChromium, Browser } from 'playwright';

let browser: Browser | null = null;

const headless = process.env.HEADLESS !== 'false';

const CHROME_ARGS = [
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
  '--lang=en-US',
  '--window-size=1920,1080',
];

if (headless) {
  CHROME_ARGS.push('--disable-gpu', '--disable-software-rasterizer');
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
      args: CHROME_ARGS,
      channel: 'chrome',  // Use real Google Chrome instead of Chromium
    };

    console.log(`[BrowserManager] Launching Chrome (${headless ? 'headless' : 'headed'})...`);

    try {
      browser = await chromium.launch(launchOptions);
    } catch (e: any) {
      // If Chrome not available, fall back to Chromium
      console.warn(`[BrowserManager] Chrome not available: ${e.message}, falling back to Chromium...`);
      delete launchOptions.channel;
      try {
        browser = await chromium.launch(launchOptions);
      } catch (e2: any) {
        console.warn(`[BrowserManager] Stealth launch failed: ${e2.message}, using vanilla Playwright...`);
        delete launchOptions.channel;
        browser = await playwrightChromium.launch(launchOptions);
      }
    }

    browser!.on('disconnected', () => {
      console.log('[BrowserManager] Browser disconnected');
      browser = null;
    });

    console.log('[BrowserManager] Chrome launched');
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
