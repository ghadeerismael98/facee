import { Page, Dialog } from 'playwright';
import { v4 as uuid } from 'uuid';
import { contextManager } from './context-manager';
import { stateManager } from '../persistence/state-manager';

interface TabEntry {
  page: Page;
  profileId: string;
  windowId: string;
  dialog?: Dialog;
  dialogConfig?: { action: 'accept' | 'dismiss'; promptText?: string };
}

const tabs = new Map<string, TabEntry>();

// Per-profile locks to prevent race conditions on tab creation
const profileLocks = new Map<string, Promise<void>>();

async function withProfileLock<T>(profileId: string, fn: () => Promise<T>): Promise<T> {
  const currentLock = profileLocks.get(profileId) || Promise.resolve();
  let resolveLock: () => void;
  const newLock = new Promise<void>(r => { resolveLock = r; });
  profileLocks.set(profileId, newLock);
  try {
    await currentLock;
    return await fn();
  } finally {
    resolveLock!();
  }
}

export const tabManager = {
  async createTab(url?: string, profileId?: string): Promise<{ id: string; url: string; title: string; windowId: string; active: boolean; profileId?: string }> {
    const pId = profileId || 'default';

    return withProfileLock(pId, async () => {
      // Close ALL existing tabs for this profile — one tab per profile max
      const toClose: string[] = [];
      for (const [id, entry] of tabs) {
        if (entry.profileId === pId) toClose.push(id);
      }
      for (const id of toClose) {
        console.log(`[TabManager] Closing existing tab for profile "${pId}"`);
        await this.closeTab(id);
      }

      const context = await contextManager.getOrCreate(pId);
      const page = await context.newPage();
      const tabId = uuid();
      const windowId = `window-${pId}`;

      // Setup dialog handler
      page.on('dialog', async (dialog) => {
        const entry = tabs.get(tabId);
        if (!entry) return;
        entry.dialog = dialog;

        if (entry.dialogConfig) {
          if (entry.dialogConfig.action === 'accept') {
            await dialog.accept(entry.dialogConfig.promptText);
          } else {
            await dialog.dismiss();
          }
        }
      });

      if (url) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

          // Restore localStorage for this origin
          const origin = new URL(url).origin;
          const storage = stateManager.loadStorage(pId, origin);
          if (storage && Object.keys(storage).length > 0) {
            await page.evaluate(`(function() {
              var data = ${JSON.stringify(storage)};
              for (var k in data) { try { localStorage.setItem(k, data[k]); } catch(e) {} }
            })()`);
          }
        } catch (e) {
          console.warn(`[TabManager] Navigation to ${url} failed:`, e);
        }
      }

      tabs.set(tabId, { page, profileId: pId, windowId });

      return {
        id: tabId,
        url: page.url(),
        title: await page.title().catch(() => ''),
        windowId,
        active: true,
        profileId: pId !== 'default' ? pId : undefined,
      };
    });
  },

  async closeTab(tabId: string): Promise<void> {
    const entry = tabs.get(tabId);
    if (!entry) return;

    // Save localStorage before closing
    try {
      const url = entry.page.url();
      if (url && url !== 'about:blank') {
        const origin = new URL(url).origin;
        const data = await entry.page.evaluate(`(function() {
          var result = {};
          for (var i = 0; i < localStorage.length; i++) {
            var key = localStorage.key(i);
            if (key) result[key] = localStorage.getItem(key) || '';
          }
          return result;
        })()`).catch(() => ({})) as Record<string, string>;
        if (Object.keys(data).length > 0) {
          stateManager.saveStorage(entry.profileId, origin, data);
        }
      }
    } catch { /* skip */ }

    await entry.page.close().catch(() => {});
    tabs.delete(tabId);
  },

  getPage(tabId: string): Page | null {
    return tabs.get(tabId)?.page || null;
  },

  getEntry(tabId: string): TabEntry | null {
    return tabs.get(tabId) || null;
  },

  async listTabs(): Promise<Array<{ id: string; url: string; title: string; windowId: string; active: boolean; profileId?: string }>> {
    const result: Array<{ id: string; url: string; title: string; windowId: string; active: boolean; profileId?: string }> = [];
    for (const [id, entry] of tabs) {
      const title = await entry.page.title().catch(() => '');
      result.push({
        id,
        url: entry.page.url(),
        title,
        windowId: entry.windowId,
        active: true,
        profileId: entry.profileId !== 'default' ? entry.profileId : undefined,
      });
    }
    return result;
  },

  getTabCount(): number {
    return tabs.size;
  },

  getTabsByProfile(profileId: string): string[] {
    const result: string[] = [];
    for (const [id, entry] of tabs) {
      if (entry.profileId === (profileId || 'default')) result.push(id);
    }
    return result;
  },
};
