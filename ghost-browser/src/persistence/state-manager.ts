import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';

function profileDataDir(profileId: string): string {
  return path.join(config.dataDir, 'profiles', profileId);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const stateManager = {
  saveCookies(profileId: string, cookies: any[]): void {
    const dir = profileDataDir(profileId);
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, 'cookies.json'), JSON.stringify(cookies, null, 2));
  },

  loadCookies(profileId: string): any[] {
    const fp = path.join(profileDataDir(profileId), 'cookies.json');
    if (!fs.existsSync(fp)) return [];
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch {
      return [];
    }
  },

  saveStorage(profileId: string, origin: string, data: Record<string, string>): void {
    const dir = profileDataDir(profileId);
    ensureDir(dir);
    const fp = path.join(dir, 'storage.json');

    let all: Record<string, Record<string, string>> = {};
    if (fs.existsSync(fp)) {
      try { all = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { /* reset */ }
    }

    all[origin] = data;
    fs.writeFileSync(fp, JSON.stringify(all, null, 2));
  },

  loadStorage(profileId: string, origin: string): Record<string, string> | null {
    const fp = path.join(profileDataDir(profileId), 'storage.json');
    if (!fs.existsSync(fp)) return null;
    try {
      const all = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      return all[origin] || null;
    } catch {
      return null;
    }
  },
};
