import { BrowserContext } from 'playwright';
import { browserManager } from './manager';
import { profileStore } from '../profiles/store';
import { GhostProfile } from '../profiles/types';
import { buildFingerprintPayload } from '../fingerprint/inject';
import { generateFingerprint, generateMatchingUA } from '../fingerprint/generator';
import { stateManager } from '../persistence/state-manager';
import { torManager } from '../tor/manager';

interface ContextEntry {
  context: BrowserContext;
  profileId: string;
}

const contexts = new Map<string, ContextEntry>();

export const contextManager = {
  async getOrCreate(profileId: string): Promise<BrowserContext> {
    const id = profileId || 'default';

    const existing = contexts.get(id);
    if (existing) return existing.context;

    const browser = await browserManager.launch();
    const profile = profileStore.get(id);

    // Generate fingerprint-matching UA if no custom UA is set
    const seed = profile?.fingerprintSeed || 500000;
    const matchingUA = profile?.userAgent || generateMatchingUA(seed);

    // Build context options
    const options: any = {
      viewport: profile?.viewport || { width: 1920, height: 1080 },
      userAgent: matchingUA,
      locale: profile?.locale || profile?.spoofLanguage || undefined,
      timezoneId: profile?.timezone || profile?.spoofTimezone || undefined,
    };

    // Tor takes priority over proxy
    if (profile?.torEnabled) {
      const tor = await torManager.start(id);
      options.proxy = {
        server: `socks5://127.0.0.1:${tor.socksPort}`,
      };
      console.log(`[ContextManager] Profile "${id}" using Tor (SOCKS:${tor.socksPort}, exit: ${tor.exitIp || 'pending'})`);
    } else if (profile?.proxy) {
      const p = profile.proxy;
      options.proxy = {
        server: `${p.type}://${p.host}:${p.port}`,
        username: p.username,
        password: p.password,
      };
    }

    const context = await browser.newContext(options);

    // Inject fingerprint if enabled
    if (profile?.fingerprintEnabled !== false) {
      const fpProfile = { ...profile, userAgent: matchingUA } as any;
      const payload = buildFingerprintPayload(seed, fpProfile);
      await context.addInitScript(payload);
    }

    // Restore cookies
    if (profile) {
      const cookies = stateManager.loadCookies(id);
      if (cookies.length > 0) {
        try {
          await context.addCookies(cookies);
        } catch (e) {
          console.warn(`[ContextManager] Failed to restore cookies for ${id}:`, e);
        }
      }
    }

    contexts.set(id, { context, profileId: id });

    context.on('close', () => {
      contexts.delete(id);
    });

    console.log(`[ContextManager] Created context for profile "${id}"`);
    return context;
  },

  getContext(profileId: string): BrowserContext | null {
    return contexts.get(profileId || 'default')?.context || null;
  },

  async destroyContext(profileId: string): Promise<void> {
    const id = profileId || 'default';
    const entry = contexts.get(id);
    if (!entry) return;

    // Save cookies before closing
    try {
      const cookies = await entry.context.cookies();
      stateManager.saveCookies(id, cookies);
    } catch { /* context may already be closing */ }

    await entry.context.close();
    contexts.delete(id);

    // Stop Tor if running for this profile
    await torManager.stop(id);
  },

  async saveAllState(): Promise<void> {
    for (const [id, entry] of contexts) {
      try {
        const cookies = await entry.context.cookies();
        stateManager.saveCookies(id, cookies);
      } catch { /* skip */ }
    }
  },

  getContextCount(): number {
    return contexts.size;
  },

  getActiveProfileIds(): string[] {
    return Array.from(contexts.keys());
  },

  async closeAll(): Promise<void> {
    await this.saveAllState();
    for (const [, entry] of contexts) {
      try { await entry.context.close(); } catch { /* skip */ }
    }
    contexts.clear();
    await torManager.stopAll();
  },
};
