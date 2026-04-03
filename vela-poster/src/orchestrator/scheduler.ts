/**
 * Scheduler — checks for and runs scheduled posts.
 * Replaces background.js startScheduleCronJob + checkAndRunScheduledPosts.
 */
import { StorageAdapter } from '../storage/storage';
import { CampaignRunner } from './campaign-runner';

export class Scheduler {
  private storage: StorageAdapter;
  private runner: CampaignRunner;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(storage: StorageAdapter, runner: CampaignRunner) {
    this.storage = storage;
    this.runner = runner;
  }

  start(intervalMs: number = 60000): void {
    console.log('[Scheduler] Started — checking every', intervalMs / 1000, 'seconds');
    this.interval = setInterval(() => this.checkAndRun(), intervalMs);
    // Also run immediately
    this.checkAndRun();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    console.log('[Scheduler] Stopped');
  }

  private async checkAndRun(): Promise<void> {
    if (this.runner.isRunning()) return; // Don't interfere with active campaigns

    try {
      const data = await this.storage.get('local', ['scheduledPosts']);
      const posts: any[] = data.scheduledPosts || [];

      if (posts.length === 0) return;

      const now = Date.now();

      for (const post of posts) {
        if (!post.scheduledTime || !post.payload) continue;

        const scheduledTime = new Date(post.scheduledTime).getTime();
        if (isNaN(scheduledTime)) continue;

        // Check if it's time to run (within 2-minute window)
        if (scheduledTime <= now && now - scheduledTime < 120000) {
          console.log(`[Scheduler] Running scheduled post: ${post.id || 'unnamed'}`);

          // Remove from scheduled list before running
          const remaining = posts.filter(p => p !== post);
          await this.storage.set('local', { scheduledPosts: remaining });

          // Start the campaign
          await this.runner.start({
            action: 'POST_PAYLOAD',
            payload: post.payload,
          });

          break; // One at a time
        }
      }
    } catch (e: any) {
      console.error('[Scheduler] Check failed:', e.message);
    }
  }
}
