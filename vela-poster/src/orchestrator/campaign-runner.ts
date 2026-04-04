/**
 * Campaign Runner — orchestrates the full posting flow via Vela API.
 * Replaces background.js initiatePostToFBAction + POST_PAYLOAD handler.
 *
 * Multi-profile support:
 *   - "broadcast" mode: same post + same groups posted from ALL selected profiles sequentially
 *   - "per-profile" mode: each profile has its own group list, runs sequentially
 *   - Default (no profiles): single-profile mode, same as original extension
 */
import { VelaClient } from '../vela/client';
import { StorageAdapter, ProfileStorageManager } from '../storage/storage';
import { expandSpintax } from './spintax';
import { openComposer, waitForComposerInput, injectText } from './composer';
import { uploadMedia, waitForVideoUploadComplete } from './uploader';
import { clickPostButton, waitForPostCompletion } from './post-button';
import { pushEvent } from '../routes/extension-messages';
import { ProfileManager, ProfileGroupMapping } from './profile-manager';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Global posting lock — only one profile can inject text + click post at a time.
// Tab creation and page loading happen in parallel, but the actual posting step
// (focus → execCommand → click Post) must be serialized because execCommand
// needs real DOM focus which only one tab can have at a time.
let _postingLock: Promise<void> = Promise.resolve();
function withPostingLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _postingLock;
  let resolve: () => void;
  _postingLock = new Promise(r => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

interface PostPayload {
  text: string;
  images?: Array<{ base64: string }>;
  video_id?: string[];
  background?: any;
}

interface CampaignRequest {
  action: string;
  payload: {
    campaignId?: string;
    campaignName?: string;
    post: PostPayload;
    group: { urls: string[] };
    timeInSeconds: number;
    deliveryOptions?: DeliveryOptions;
    background?: any;
    // Multi-profile fields
    profileMode?: 'single' | 'broadcast' | 'per-profile';
    profileIds?: string[];
    profileGroupMappings?: ProfileGroupMapping[];
  };
}

interface DeliveryOptions {
  mode: 'continuous' | 'throttled';
  batchSize: number;
  waitMinutes: number;
  randomizeWait: boolean;
  isCustom: boolean;
}

interface PostResult {
  link: string;
  response: 'successful' | 'failed' | 'cancelled';
  reason?: string;
  timestamp?: string;
}

export class CampaignRunner {
  private vela: VelaClient;
  private storage: StorageAdapter;
  private profileStorageManager?: ProfileStorageManager;
  public profileManager: ProfileManager;

  // State guards (mirrors background.js)
  private _isRunning = false;
  private _isStopping = false;
  private _isStopRequested = false;
  private _activeCampaignId: string | null = null;
  private _activeTabId: string | null = null;
  private _activeProfileId: string | null = null;
  private _uiProfileId: string = 'default';
  private _postsCompleted: PostResult[] = [];
  private _pendingRequest: CampaignRequest | null = null;

  constructor(vela: VelaClient, storage: StorageAdapter, profileStorageManager?: ProfileStorageManager) {
    this.vela = vela;
    this.storage = storage;
    this.profileStorageManager = profileStorageManager;
    this.profileManager = new ProfileManager(vela, storage);
  }

  /** Get the storage for the current UI profile */
  private getStorage(): StorageAdapter {
    if (this.profileStorageManager && this._uiProfileId) {
      return this.profileStorageManager.getStorage(this._uiProfileId);
    }
    return this.storage;
  }

  isRunning(): boolean {
    return this._isRunning;
  }

  async start(request: CampaignRequest): Promise<{ success: boolean; started?: boolean; queued?: boolean; message?: string }> {
    // Guard: prevent double campaigns
    if (this._isRunning) {
      return { success: false, message: 'A campaign is already running.' };
    }
    if (this._isStopping) {
      // Wait briefly for the stop to complete
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (!this._isStopping) break;
      }
      if (this._isStopping) {
        // Force reset
        this.reset();
      }
    }

    const campaignId = request.payload.campaignId;
    this._isRunning = true;
    this._isStopping = false;
    this._isStopRequested = false;
    this._activeCampaignId = campaignId || null;
    this._uiProfileId = (request as any)._profileId || 'default';
    this._postsCompleted = [];

    console.log(`[Campaign] Starting: ${campaignId || 'manual'} with ${request.payload.group.urls.length} groups`);

    // Run campaign async
    this.runCampaign(request)
      .catch(err => console.error('[Campaign] Unhandled error:', err))
      .finally(async () => {
        this._isRunning = false;
        this._activeCampaignId = null;
        this._isStopping = false;
        this._isStopRequested = false;

        pushEvent({ type: 'campaign_complete', results: this._postsCompleted }, this._uiProfileId);

        // Launch queued campaign if any
        if (this._pendingRequest) {
          const queued = this._pendingRequest;
          this._pendingRequest = null;
          console.log('[Campaign] Starting queued campaign...');
          this.start(queued);
        }
      });

    return { success: true, started: true };
  }

  async stop(): Promise<void> {
    console.log('[Campaign] Stop requested');
    this._isStopRequested = true;
    this._isStopping = true;

    // Close active posting tab if any
    if (this._activeTabId) {
      try {
        await this.vela.closeTab(this._activeTabId);
      } catch {
        // Tab might already be closed
      }
      this._activeTabId = null;
    }
  }

  reset(): void {
    this._isRunning = false;
    this._isStopping = false;
    this._isStopRequested = false;
    this._activeCampaignId = null;
    this._activeTabId = null;
    this._postsCompleted = [];
    this._pendingRequest = null;
  }

  /**
   * Main campaign entry point — routes to single or multi-profile execution.
   */
  private async runCampaign(request: CampaignRequest): Promise<void> {
    const { payload } = request;
    const profileMode = payload.profileMode || 'single';

    this.updateStatus('Start posting');
    this.updateProgress('started');

    await this.getStorage().set('local', {
      showModal: true,
      modalHiddenByUser: false,
      isPostingInProgress: 'started',
      postsCompleted: [],
      postingStatus: 'Starting...',
    });

    if (profileMode === 'single' || !payload.profileIds || payload.profileIds.length === 0) {
      // Single-profile flow — use the UI profile as the Vela posting profile
      await this.runSingleProfileCampaign(request, this._uiProfileId || null);
    } else if (profileMode === 'broadcast') {
      // Same post + same groups → each profile posts sequentially
      for (let p = 0; p < payload.profileIds.length; p++) {
        if (this._isStopRequested) break;
        const profileId = payload.profileIds[p];
        this._activeProfileId = profileId;
        this.updateStatus(`Profile ${p + 1}/${payload.profileIds.length} starting...`);
        pushEvent({ type: 'profile_started', profileId, index: p, total: payload.profileIds.length }, this._uiProfileId);

        await this.runSingleProfileCampaign(request, profileId);

        pushEvent({ type: 'profile_completed', profileId, index: p, total: payload.profileIds.length }, this._uiProfileId);

        // Small delay between profiles
        if (p + 1 < payload.profileIds.length && !this._isStopRequested) {
          this.updateStatus(`Profile ${p + 1} done. Switching to next profile in 10s...`);
          await sleep(10000);
        }
      }
    } else if (profileMode === 'per-profile') {
      // Each profile has its own group list
      const mappings = payload.profileGroupMappings || [];
      for (let p = 0; p < mappings.length; p++) {
        if (this._isStopRequested) break;
        const mapping = mappings[p];
        this._activeProfileId = mapping.profileId;
        this.updateStatus(`Profile "${mapping.profileName}" (${p + 1}/${mappings.length}) starting...`);
        pushEvent({ type: 'profile_started', profileId: mapping.profileId, profileName: mapping.profileName, index: p, total: mappings.length }, this._uiProfileId);

        // Create a modified request with this profile's groups
        const profileRequest: CampaignRequest = {
          ...request,
          payload: {
            ...request.payload,
            group: { urls: mapping.groupUrls },
          },
        };
        await this.runSingleProfileCampaign(profileRequest, mapping.profileId);

        pushEvent({ type: 'profile_completed', profileId: mapping.profileId, profileName: mapping.profileName, index: p, total: mappings.length }, this._uiProfileId);

        if (p + 1 < mappings.length && !this._isStopRequested) {
          this.updateStatus(`Profile "${mapping.profileName}" done. Switching in 10s...`);
          await sleep(10000);
        }
      }
    }

    this._activeProfileId = null;

    // Campaign complete
    const successCount = this._postsCompleted.filter(p => p.response === 'successful').length;
    const totalCount = this._postsCompleted.length;
    this.updateProgress('done');
    this.updateStatus(`Posting complete. ${successCount}/${totalCount} successful.`);
    await this.getStorage().set('local', { isPostingInProgress: 'done' });
  }

  /**
   * Run the posting loop for a single profile (or no profile).
   * If profileId is provided, tabs are created within that Vela profile.
   */
  private async runSingleProfileCampaign(request: CampaignRequest, profileId: string | null): Promise<void> {
    const { payload } = request;
    const { group, timeInSeconds, deliveryOptions } = payload;
    const selectedGroups = group.urls;
    const originalPostText = payload.post.text;
    const profileLabel = profileId ? ` [profile:${profileId}]` : '';

    let consecutiveFailures = 0;

    for (let i = 0; i < selectedGroups.length; i++) {
      if (this._isStopRequested) {
        console.log(`[Campaign${profileLabel}] Stop requested, breaking loop`);
        break;
      }

      const groupLink = selectedGroups[i];
      this.updateStatus(`${profileLabel ? `Profile: ${profileId} — ` : ''}Post to group ${i + 1} / ${selectedGroups.length}`);

      // Expand spintax fresh for each group
      const expandedText = expandSpintax(originalPostText);
      console.log(`[Campaign${profileLabel}] Group ${i + 1}: ${groupLink}`);

      let success = false;
      let tabId: string | null = null;

      try {
        // Step 1: Create tab in the correct profile
        tabId = await this.createAndLoadTab(groupLink, profileId);
        if (!tabId) {
          throw new Error('Failed to create tab');
        }
        this._activeTabId = tabId;

        // Steps 2-9: Serialize the posting actions via global lock.
        // Tab creation + page loading happen in parallel across profiles,
        // but injecting text + clicking Post needs exclusive DOM focus.
        await withPostingLock(async () => {
          // Step 2: Open the composer
          const composerOpened = await openComposer(this.vela, tabId!);
          if (!composerOpened) {
            throw new Error('Failed to open composer');
          }

          // Step 3: Wait for composer input
          const inputReady = await waitForComposerInput(this.vela, tabId!);
          if (!inputReady) {
            throw new Error('Composer input not ready');
          }

          // Step 4: Upload images if any
          if (payload.post.images && payload.post.images.length > 0) {
            for (const image of payload.post.images) {
              await uploadMedia(this.vela, tabId!, image.base64, false);
              await sleep(1500);
            }
          }

          // Step 5: Upload videos if any
          if (payload.post.video_id && payload.post.video_id.length > 0) {
            const videoData = await this.getStorage().get('session', ['finalizedVideos']);
            const videos = videoData.finalizedVideos || {};
            for (const videoId of payload.post.video_id) {
              if (videos[videoId]) {
                await uploadMedia(this.vela, tabId!, videos[videoId], true);
                await waitForVideoUploadComplete(this.vela, tabId!);
              }
            }
          }

          // Step 6: Inject text
          const textInjected = await injectText(this.vela, tabId!, expandedText);
          if (!textInjected) {
            throw new Error('Failed to inject text');
          }

          // Step 7: Apply background if specified
          if (payload.background) {
            await this.applyBackground(tabId!, payload.background);
          }

          // Step 8: Click post button
          const posted = await clickPostButton(this.vela, tabId!);
          if (!posted) {
            throw new Error('Failed to click post button');
          }

          // Step 9: Wait for post completion
          await waitForPostCompletion(this.vela, tabId!);
        });

        success = true;
        consecutiveFailures = 0;
        console.log(`[Campaign${profileLabel}] ✅ Post ${i + 1}/${selectedGroups.length} successful`);

      } catch (err: any) {
        console.error(`[Campaign${profileLabel}] ❌ Post ${i + 1} failed:`, err.message);
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          console.warn(`[Campaign${profileLabel}] 3 consecutive failures`);
        }
      }

      // Record result
      this._postsCompleted.push({
        link: groupLink,
        response: success ? 'successful' : 'failed',
        timestamp: new Date().toISOString(),
        ...(profileId ? { profileId } as any : {}),
      });

      // Save results to storage so the popup UI picks them up
      await this.getStorage().set('local', {
        postsCompleted: this._postsCompleted,
        postingStatus: `Post ${i + 1} / ${selectedGroups.length} done.`,
      }).catch(() => {});

      // Push progress event to popup
      pushEvent({
        type: 'post_result',
        index: i,
        total: selectedGroups.length,
        link: groupLink,
        result: success ? 'successful' : 'failed',
        profileId: profileId || undefined,
      }, this._uiProfileId);

      // Cleanup: close tab
      if (tabId) {
        try { await this.vela.closeTab(tabId); } catch {}
        this._activeTabId = null;
      }

      // Wait before next post
      if (i + 1 < selectedGroups.length && !this._isStopRequested) {
        await this.waitBeforeNextPost(timeInSeconds, i, selectedGroups.length, deliveryOptions);
      }
    }
  }

  private async createAndLoadTab(url: string, profileId?: string | null): Promise<string | null> {
    try {
      const tab = await this.vela.createTab(url, profileId || undefined);
      if (!tab || !tab.id) return null;

      // Wait for page to fully load
      await this.vela.waitForLoad(tab.id);

      // Facebook is an SPA — the load event fires before dynamic content renders.
      // Wait for the page body to have substantial content (feed, composer, etc.)
      console.log('[Campaign] Page loaded, waiting for Facebook SPA content...');
      let contentReady = false;
      for (let i = 0; i < 15; i++) {
        try {
          const check = await this.vela.executeScript<{ ready: boolean }>(tab.id,
            `(function() {
              var body = document.body;
              if (!body) return { ready: false };
              var hasContent = body.innerText.length > 500;
              var hasFeed = !!document.querySelector('[role="feed"], [role="main"]');
              return { ready: hasContent && hasFeed };
            })()`
          );
          if (check && check.ready) {
            contentReady = true;
            break;
          }
        } catch {}
        await sleep(1000);
      }

      if (!contentReady) {
        console.warn('[Campaign] Facebook content did not fully render, proceeding anyway...');
      }

      // Extra wait for composer to be interactive
      await sleep(2000);

      return tab.id;
    } catch (e: any) {
      console.error('[Campaign] Tab creation failed:', e.message);
      return null;
    }
  }

  private async applyBackground(tabId: string, background: any): Promise<void> {
    // Apply background style in composer (if applicable)
    try {
      const bgScript = `
        (function() {
          // Look for background color buttons in the composer
          const bgButtons = document.querySelectorAll('[data-testid*="background"], [aria-label*="background"]');
          // This is a simplified version — background selection is complex in Facebook's UI
          return { found: bgButtons.length };
        })()
      `;
      await this.vela.executeScript(tabId, bgScript);
      await sleep(2000);
    } catch {
      console.warn('[Campaign] Background style application skipped');
    }
  }

  /**
   * Delivery throttling — ported from background.js waitBeforeNextPost()
   */
  private async waitBeforeNextPost(
    timeInSeconds: number,
    currentIndex: number,
    totalGroups: number,
    deliveryOptions?: DeliveryOptions
  ): Promise<void> {
    let actualWaitTime = timeInSeconds;

    // Default delivery: wait 140-520s after every 3 posts
    if (!deliveryOptions) {
      deliveryOptions = { mode: 'throttled', batchSize: 3, waitMinutes: 0, randomizeWait: true, isCustom: false };
    }

    if (!deliveryOptions.isCustom) {
      const postNumber = currentIndex + 1;
      if (postNumber % 3 === 0) {
        const minSec = 140;
        const maxSec = 520;
        actualWaitTime = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
      } else {
        actualWaitTime = 0;
      }
    } else if (deliveryOptions.mode === 'continuous') {
      actualWaitTime = 0;
    } else if (deliveryOptions.mode === 'throttled') {
      const postNumber = currentIndex + 1;
      if (postNumber % deliveryOptions.batchSize === 0) {
        actualWaitTime = deliveryOptions.waitMinutes * 60;
        if (deliveryOptions.randomizeWait) {
          const minWait = Math.round(actualWaitTime * 0.7);
          const maxWait = Math.round(actualWaitTime * 1.5);
          actualWaitTime = Math.floor(Math.random() * (maxWait - minWait + 1)) + minWait;
        }
      } else {
        actualWaitTime = 0;
      }
    }

    if (actualWaitTime === 0) return;

    this.updateStatus(`Post ${currentIndex + 1} / ${totalGroups} done. Next in ${actualWaitTime}s.`);

    let remaining = actualWaitTime;
    while (remaining > 0) {
      if (this._isStopRequested) {
        console.log('[Campaign] Stop requested during wait');
        break;
      }

      const waitChunk = Math.min(10, remaining);
      await sleep(waitChunk * 1000);
      remaining -= waitChunk;

      if (remaining > 0) {
        this.updateStatus(`Post ${currentIndex + 1} / ${totalGroups} done. Next in ${remaining}s.`);
      }
    }
  }

  private updateStatus(message: string): void {
    console.log(`[Status] ${message}`);
    pushEvent({ type: 'status', message }, this._uiProfileId);
    this.getStorage().set('local', { postingStatus: message }).catch(() => {});
  }

  private updateProgress(state: string): void {
    pushEvent({ type: 'progress', state }, this._uiProfileId);
    this.getStorage().set('local', { postingProgress: state }).catch(() => {});
  }
}
