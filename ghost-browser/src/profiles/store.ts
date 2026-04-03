import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import { config } from '../config';
import { GhostProfile } from './types';

function profilesDir(): string {
  return path.join(config.dataDir, 'profiles');
}

function validateId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid profile ID');
  return id;
}

function profileDir(id: string): string {
  return path.join(profilesDir(), validateId(id));
}

function profilePath(id: string): string {
  return path.join(profileDir(id), 'profile.json');
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function randomSeed(): number {
  return 100000 + require('crypto').randomInt(900000);
}

export const profileStore = {
  list(): GhostProfile[] {
    ensureDir(profilesDir());
    const dirs = fs.readdirSync(profilesDir(), { withFileTypes: true })
      .filter(d => d.isDirectory());

    const profiles: GhostProfile[] = [];
    for (const dir of dirs) {
      const fp = path.join(profilesDir(), dir.name, 'profile.json');
      if (fs.existsSync(fp)) {
        try {
          profiles.push(JSON.parse(fs.readFileSync(fp, 'utf-8')));
        } catch { /* skip corrupt */ }
      }
    }
    return profiles;
  },

  get(id: string): GhostProfile | null {
    const fp = profilePath(id);
    if (!fs.existsSync(fp)) return null;
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch {
      return null;
    }
  },

  create(data: Partial<GhostProfile>): GhostProfile {
    const id = data.id || uuid();
    const now = new Date().toISOString();
    const profile: GhostProfile = {
      id,
      name: data.name || `Profile ${id.slice(0, 6)}`,
      icon: data.icon || 'person.circle',
      color: data.color || '#4A90D9',
      fingerprintSeed: data.fingerprintSeed || randomSeed(),
      fingerprintEnabled: data.fingerprintEnabled !== false,
      userAgent: data.userAgent,
      timezone: data.timezone || data.spoofTimezone || undefined,
      locale: data.locale || data.spoofLanguage || undefined,
      proxy: data.proxy,
      torEnabled: data.torEnabled || false,
      viewport: data.viewport,
      spoofLanguage: data.spoofLanguage,
      spoofTimezone: data.spoofTimezone,
      userAgentId: data.userAgentId,
      dnsProvider: data.dnsProvider,
      contentBlockerEnabled: data.contentBlockerEnabled,
      blockTrackers: data.blockTrackers,
      blockAds: data.blockAds,
      blockPopups: data.blockPopups,
      httpsFirstEnabled: data.httpsFirstEnabled ?? false,
      createdAt: now,
      updatedAt: now,
    };

    ensureDir(profileDir(id));
    fs.writeFileSync(profilePath(id), JSON.stringify(profile, null, 2));
    return profile;
  },

  update(id: string, data: Partial<GhostProfile>): GhostProfile | null {
    const existing = this.get(id);
    if (!existing) return null;

    const updated: GhostProfile = {
      ...existing,
      ...data,
      id, // never change the id
      updatedAt: new Date().toISOString(),
    };

    // Map Vela-compat fields
    if (data.spoofTimezone !== undefined) updated.timezone = data.spoofTimezone || undefined;
    if (data.spoofLanguage !== undefined) updated.locale = data.spoofLanguage || undefined;

    fs.writeFileSync(profilePath(id), JSON.stringify(updated, null, 2));
    return updated;
  },

  delete(id: string): boolean {
    const dir = profileDir(id);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  },
};
