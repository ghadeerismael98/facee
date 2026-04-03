import { Router, Request, Response } from 'express';
import { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { tabManager } from '../browser/tab-manager';

const router = Router();

function getPageOrFail(tabId: string, res: Response): Page | null {
  const page = tabManager.getPage(tabId);
  if (!page) {
    res.status(404).json({ error: 'Tab not found' });
    return null;
  }
  return page;
}

// ─── Tab CRUD ────────────────────────────────────────────────────────

router.get('/api/tabs', async (_req, res) => {
  const tabs = await tabManager.listTabs();
  res.json(tabs);
});

router.post('/api/tabs', async (req: Request, res: Response) => {
  try {
    const tab = await tabManager.createTab(req.body.url, req.body.profileId);
    res.json(tab);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/api/tabs/:id', async (req: Request, res: Response) => {
  try {
    await tabManager.closeTab(req.params.id);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Navigation ──────────────────────────────────────────────────────

router.post('/api/tabs/:id/navigate', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    await page.goto(req.body.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    res.json({ url: page.url() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/reload', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    await page.reload();
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Wait operations ─────────────────────────────────────────────────

router.post('/api/tabs/:id/wait-for-load-state', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    await page.waitForLoadState(req.body.state || 'load');
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/wait', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    const { selector, state, timeout } = req.body;
    await page.waitForSelector(selector, { state, timeout });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/wait-for-function', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    const { expression, timeout } = req.body;
    await page.waitForFunction(expression, undefined, { timeout });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/wait-for-navigation', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    await page.waitForNavigation({ timeout: req.body.timeout });
    res.json({ url: page.url() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/wait-for-timeout', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    await page.waitForTimeout(req.body.timeout || 1000);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Execute script ──────────────────────────────────────────────────

router.post('/api/tabs/:id/execute', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    const result = await page.evaluate(req.body.script);
    res.json({ result });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DOM interaction ─────────────────────────────────────────────────

router.post('/api/tabs/:id/click', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    await page.click(req.body.selector);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/fill', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    await page.fill(req.body.selector, req.body.value);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/type', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    const opts: { delay?: number } = {};
    if (req.body.delay) opts.delay = req.body.delay;
    await page.type(req.body.selector, req.body.text, opts);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/extract', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    const locator = page.locator(req.body.selector).first();
    let value: string | null;
    if (req.body.attribute) {
      value = await locator.getAttribute(req.body.attribute);
    } else {
      value = await locator.textContent();
    }
    res.json(value);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/scroll', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    await page.locator(req.body.selector).first().scrollIntoViewIfNeeded();
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/hover', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    await page.hover(req.body.selector);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/focus', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    await page.focus(req.body.selector);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Element queries ─────────────────────────────────────────────────

router.post('/api/tabs/:id/element/visible', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    const visible = await page.isVisible(req.body.selector);
    res.json(visible);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/element/count', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    const count = await page.locator(req.body.selector).count();
    res.json(count);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/element/bounding-box', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    const box = await page.locator(req.body.selector).first().boundingBox();
    res.json(box);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/element/inner-text', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    const text = await page.locator(req.body.selector).first().innerText();
    res.json(text);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Native input ────────────────────────────────────────────────────

router.post('/api/tabs/:id/native/click', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    await page.mouse.click(req.body.x, req.body.y);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/native/type', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    await page.keyboard.type(req.body.text);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/native/press', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    const { key, modifiers } = req.body;
    let combo = key;
    if (modifiers?.length) {
      combo = [...modifiers, key].join('+');
    }
    await page.keyboard.press(combo);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/native/paste', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    // Use insertText as a reliable paste substitute in headless mode
    // navigator.clipboard.writeText requires secure context which may not be available
    await page.keyboard.insertText(req.body.text);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/native/move', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    await page.mouse.move(req.body.x, req.body.y);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Mouse ───────────────────────────────────────────────────────────

router.post('/api/tabs/:id/mouse/click', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    const opts: { button?: 'left' | 'right' | 'middle' } = {};
    if (req.body.button) opts.button = req.body.button;
    await page.mouse.click(req.body.x, req.body.y, opts);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/mouse/move', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    await page.mouse.move(req.body.x, req.body.y, { steps: 10 });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Keyboard ────────────────────────────────────────────────────────

router.post('/api/tabs/:id/keyboard/press', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    const { key, modifiers } = req.body;
    let combo = key;
    if (modifiers?.length) {
      combo = [...modifiers, key].join('+');
    }
    await page.keyboard.press(combo);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/keyboard/insert-text', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    await page.keyboard.insertText(req.body.text);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── File upload ─────────────────────────────────────────────────────

router.post('/api/tabs/:id/upload', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    const { selector, file, filename } = req.body;
    if (!selector || !file) {
      res.status(400).json({ error: 'selector and file are required' });
      return;
    }

    let buffer: Buffer;
    if (file.startsWith('data:')) {
      const base64Data = file.split(',')[1];
      buffer = Buffer.from(base64Data, 'base64');
    } else {
      buffer = Buffer.from(file, 'base64');
    }

    const safeName = path.basename(filename || `upload-${Date.now()}`);
    const tmpPath = path.join(os.tmpdir(), safeName);
    fs.writeFileSync(tmpPath, buffer);
    try {
      await page.setInputFiles(selector, tmpPath);
    } finally {
      fs.unlinkSync(tmpPath);
    }
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Cookies ─────────────────────────────────────────────────────────

router.get('/api/tabs/:id/cookies', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    const cookies = await page.context().cookies();
    res.json(cookies);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/cookies', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    let cookies: any[];
    if (Array.isArray(req.body.cookies)) {
      cookies = req.body.cookies;
    } else if (Array.isArray(req.body)) {
      cookies = req.body;
    } else {
      cookies = [req.body];
    }
    await page.context().addCookies(cookies);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/api/tabs/:id/cookies', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    await page.context().clearCookies();
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Page content ────────────────────────────────────────────────────

router.get('/api/tabs/:id/screenshot', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    const buffer = await page.screenshot();
    const base64 = buffer.toString('base64');
    res.type('text/plain').send(base64);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/tabs/:id/source', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    const html = await page.content();
    res.type('text/plain').send(html);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/tabs/:id/text', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    const text = await page.evaluate('document.body.innerText');
    res.type('text/plain').send(text as string);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/tabs/:id/page-title', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    const title = await page.title();
    res.type('text/plain').send(title);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── localStorage ────────────────────────────────────────────────────

router.post('/api/tabs/:id/storage/local/get', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    const value = await page.evaluate(`localStorage.getItem(${JSON.stringify(req.body.key)})`);
    res.json(value);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/storage/local/set', async (req: Request, res: Response) => {
  const page = getPageOrFail(req.params.id, res);
  if (!page) return;
  try {
    await page.evaluate(`localStorage.setItem(${JSON.stringify(req.body.key)}, ${JSON.stringify(req.body.value)})`);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Dialog handling ─────────────────────────────────────────────────

router.put('/api/tabs/:id/dialog/config', (req: Request, res: Response) => {
  const entry = tabManager.getEntry(req.params.id);
  if (!entry) {
    res.status(404).json({ error: 'Tab not found' });
    return;
  }
  (entry as any).dialogConfig = {
    action: req.body.action,
    promptText: req.body.promptText,
  };
  res.json({ success: true });
});

router.post('/api/tabs/:id/dialog/accept', async (req: Request, res: Response) => {
  const entry = tabManager.getEntry(req.params.id);
  if (!entry) {
    res.status(404).json({ error: 'Tab not found' });
    return;
  }
  try {
    if ((entry as any).dialog) {
      await (entry as any).dialog.accept(req.body.promptText);
      (entry as any).dialog = undefined;
    }
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/tabs/:id/dialog/dismiss', async (req: Request, res: Response) => {
  const entry = tabManager.getEntry(req.params.id);
  if (!entry) {
    res.status(404).json({ error: 'Tab not found' });
    return;
  }
  try {
    if ((entry as any).dialog) {
      await (entry as any).dialog.dismiss();
      (entry as any).dialog = undefined;
    }
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
