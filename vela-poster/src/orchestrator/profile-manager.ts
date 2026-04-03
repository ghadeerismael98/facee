/**
 * Profile Manager — manages Vela profiles for multi-account posting.
 *
 * Supports two campaign modes:
 * 1. "broadcast" — one post, same groups, all selected profiles post sequentially
 * 2. "per-profile" — each profile has its own group list, runs sequentially
 */
import { VelaClient } from '../vela/client';
import { StorageAdapter } from '../storage/storage';

export interface VelaProfile {
  id: string;
  name: string;
  icon?: string;
  color?: string;
}

export interface ProfileGroupMapping {
  profileId: string;
  profileName: string;
  groupUrls: string[];
}

export class ProfileManager {
  private vela: VelaClient;
  private storage: StorageAdapter;

  constructor(vela: VelaClient, storage: StorageAdapter) {
    this.vela = vela;
    this.storage = storage;
  }

  /**
   * List all available Vela profiles.
   */
  async listProfiles(): Promise<VelaProfile[]> {
    try {
      const response = await this.vela.listProfiles();
      // Vela returns { profiles: [...] } — extract the array
      const profiles = Array.isArray(response) ? response : (response as any).profiles || [];
      return profiles.map((p: any) => ({
        id: p.id,
        name: p.name,
        icon: p.icon,
        color: p.color,
      }));
    } catch (e: any) {
      console.error('[ProfileManager] Failed to list profiles:', e.message);
      return [];
    }
  }

  /**
   * Get the saved group-to-profile mappings from storage.
   */
  async getProfileGroups(): Promise<ProfileGroupMapping[]> {
    const data = await this.storage.get('local', ['profileGroupMappings']);
    return data.profileGroupMappings || [];
  }

  /**
   * Save group-to-profile mappings.
   */
  async saveProfileGroups(mappings: ProfileGroupMapping[]): Promise<void> {
    await this.storage.set('local', { profileGroupMappings: mappings });
  }

  /**
   * Get the list of profiles selected for campaigns.
   */
  async getSelectedProfiles(): Promise<string[]> {
    const data = await this.storage.get('local', ['selectedProfileIds']);
    return data.selectedProfileIds || [];
  }

  /**
   * Save selected profile IDs.
   */
  async setSelectedProfiles(profileIds: string[]): Promise<void> {
    await this.storage.set('local', { selectedProfileIds: profileIds });
  }

  /**
   * Create a tab in a specific Vela profile.
   * Opens a new window with the profile, then navigates to the URL.
   */
  async createTabInProfile(profileId: string, url: string): Promise<string | null> {
    try {
      const tab = await this.vela.createTab(url, profileId);
      if (!tab || !tab.id) return null;
      await this.vela.waitForLoad(tab.id);
      return tab.id;
    } catch (e: any) {
      console.error(`[ProfileManager] Failed to create tab in profile ${profileId}:`, e.message);
      return null;
    }
  }
}
