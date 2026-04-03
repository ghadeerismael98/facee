import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

const BASE_DIR = path.join(process.env.HOME || '~', '.face-poster');

interface StorageChange {
  oldValue?: any;
  newValue?: any;
}

export class StorageAdapter extends EventEmitter {
  private local: Record<string, any> = {};
  private sync: Record<string, any> = {};
  private session: Record<string, any> = {};
  private storageDir: string;

  constructor(profileId?: string) {
    super();
    if (profileId) {
      this.storageDir = path.join(BASE_DIR, 'profiles', profileId);
    } else {
      this.storageDir = BASE_DIR;
    }
    this.ensureDir();
    this.local = this.loadFile('storage-local.json');
    this.sync = this.loadFile('storage-sync.json');
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private loadFile(filename: string): Record<string, any> {
    const filepath = path.join(this.storageDir, filename);
    try {
      if (fs.existsSync(filepath)) {
        return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
      }
    } catch (e) {
      console.error(`[Storage] Failed to load ${filename}:`, e);
    }
    return {};
  }

  private saveFile(filename: string, data: Record<string, any>): void {
    const filepath = path.join(this.storageDir, filename);
    try {
      fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      console.error(`[Storage] Failed to save ${filename}:`, e);
    }
  }

  private getArea(area: string): Record<string, any> {
    switch (area) {
      case 'local': return this.local;
      case 'sync': return this.sync;
      case 'session': return this.session;
      default: throw new Error(`Unknown storage area: ${area}`);
    }
  }

  private persistArea(area: string): void {
    if (area === 'local') this.saveFile('storage-local.json', this.local);
    else if (area === 'sync') this.saveFile('storage-sync.json', this.sync);
  }

  async get(area: string, keys?: string | string[]): Promise<Record<string, any>> {
    const store = this.getArea(area);
    if (!keys) return { ...store };

    const keyList = typeof keys === 'string' ? [keys] : keys;
    const result: Record<string, any> = {};
    for (const key of keyList) {
      if (key in store) {
        result[key] = store[key];
      }
    }
    return result;
  }

  async set(area: string, items: Record<string, any>): Promise<void> {
    const store = this.getArea(area);
    const changes: Record<string, StorageChange> = {};

    for (const [key, value] of Object.entries(items)) {
      changes[key] = { oldValue: store[key], newValue: value };
      store[key] = value;
    }

    this.persistArea(area);
    this.emit('changed', changes, area);
  }

  async remove(area: string, keys: string | string[]): Promise<void> {
    const store = this.getArea(area);
    const keyList = typeof keys === 'string' ? [keys] : keys;
    const changes: Record<string, StorageChange> = {};

    for (const key of keyList) {
      if (key in store) {
        changes[key] = { oldValue: store[key] };
        delete store[key];
      }
    }

    this.persistArea(area);
    this.emit('changed', changes, area);
  }

  async clear(area: string): Promise<void> {
    switch (area) {
      case 'local': this.local = {}; break;
      case 'sync': this.sync = {}; break;
      case 'session': this.session = {}; break;
    }
    this.persistArea(area);
  }
}

/**
 * Manages per-profile StorageAdapter instances.
 * Each Vela profile gets its own isolated storage directory.
 */
export class ProfileStorageManager extends EventEmitter {
  private adapters: Map<string, StorageAdapter> = new Map();

  getStorage(profileId: string): StorageAdapter {
    const id = profileId || 'default';
    if (!this.adapters.has(id)) {
      const adapter = new StorageAdapter(id);
      // Forward storage change events with profileId attached
      adapter.on('changed', (changes: Record<string, StorageChange>, area: string) => {
        this.emit('changed', changes, area, id);
      });
      this.adapters.set(id, adapter);
      console.log(`[Storage] Created profile storage: ${id}`);
    }
    return this.adapters.get(id)!;
  }

  getActiveProfileIds(): string[] {
    return Array.from(this.adapters.keys());
  }
}
