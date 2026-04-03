import { Router } from 'express';
import { velaClient, profileStorage, getCampaignRunner, getProfileId } from '../server';


export const extensionMessageRouter = Router();

// Per-profile event queues
const eventQueues: Map<string, any[]> = new Map();

function getQueue(profileId: string): any[] {
  if (!eventQueues.has(profileId)) {
    eventQueues.set(profileId, []);
  }
  return eventQueues.get(profileId)!;
}

export function pushEvent(event: any, profileId?: string): void {
  const id = profileId || 'default';
  const queue = getQueue(id);
  queue.push(event);
  if (queue.length > 100) queue.shift();
}

// Forward storage changes as events so the popup's chrome.storage.onChanged fires
setTimeout(() => {
  if (profileStorage && typeof profileStorage.on === 'function') {
    profileStorage.on('changed', (changes: Record<string, any>, area: string, pId: string) => {
      pushEvent({ type: 'storage_changed', changes, area }, pId);
    });
  }
}, 0);

// GET /api/extension/events — polled by the shim for progress updates
extensionMessageRouter.get('/events', (req, res) => {
  const profileId = getProfileId(req);
  const queue = getQueue(profileId);
  const events = queue.splice(0);
  res.json(events);
});

// POST /api/extension/message — main message dispatch
extensionMessageRouter.post('/message', async (req, res) => {
  const message = req.body;
  const { action } = message;
  const profileId = getProfileId(req);
  const storage = profileStorage.getStorage(profileId);
  const campaignRunner = getCampaignRunner(profileId);

  try {
    switch (action) {
      // ── Campaign control ────────────────────────────────────────
      case 'POST_PAYLOAD': {
        message._profileId = profileId;
        const result = await campaignRunner.start(message);
        res.json(result);
        return;
      }

      case 'stopPosting': {
        await campaignRunner.stop();
        res.json({ stopped: true });
        return;
      }

      case 'isPostInPRogress': {
        res.json({ inProgress: campaignRunner.isRunning() });
        return;
      }

      case 'resetPostingState': {
        campaignRunner.reset();
        res.json({ reset: true });
        return;
      }

      // ── Storage-backed actions ──────────────────────────────────
      case 'checkLoginState': {
        res.json({
          loggedIn: true,
          isLoggedIn: true,
          user: { email: 'local@vela-poster', name: 'Vela User', uid: 'vela-local-user' },
        });
        return;
      }

      case 'handleLogout': {
        res.json({ loggedOut: true });
        return;
      }

      case 'get_user_info': {
        res.json({
          success: true,
          user: { email: 'local@vela-poster', name: 'Vela User', id: 'vela-local-user' },
        });
        return;
      }

      // ── Premium / Credits — always unlimited ──────────────────
      case 'checkPremium': {
        res.json({ isPremium: true, subscriptionId: 'vela-unlimited', expiry: null });
        return;
      }

      case 'checkCredits': {
        res.json({ subscription: true, postsRemaining: 999999, credits: 999999, subscriptionId: 'vela-unlimited' });
        return;
      }

      case 'premiumStatusChanged':
      case 'subscriptionUpdated': {
        res.json({ updated: true, success: true, message: 'Premium status update notification sent' });
        return;
      }

      // ── Campaigns / Scheduling ──────────────────────────────────
      case 'DELETE_CAMPAIGN': {
        const campaigns = await storage.get('local', ['campaigns']);
        const list = campaigns.campaigns || [];
        const filtered = list.filter((c: any) => c.id !== message.campaignId);
        await storage.set('local', { campaigns: filtered });
        res.json({ deleted: true });
        return;
      }

      case 'schedulePost': {
        const scheduled = await storage.get('local', ['scheduledPosts']);
        const posts = scheduled.scheduledPosts || [];
        posts.push(message.schedule);
        await storage.set('local', { scheduledPosts: posts });
        res.json({ scheduled: true });
        return;
      }

      case 'getScheduledPosts': {
        const scheduledData = await storage.get('local', ['scheduledPosts']);
        res.json({ posts: scheduledData.scheduledPosts || [] });
        return;
      }

      // ── Snapshots ───────────────────────────────────────────────
      case 'snapshot_log': {
        if (message.payload) {
          const snaps = await storage.get('local', ['snapshots']);
          const list = snaps.snapshots || [];
          list.push({ ...message.payload, timestamp: Date.now() });
          if (list.length > 200) list.splice(0, list.length - 200);
          await storage.set('local', { snapshots: list });
        }
        res.json({ logged: true });
        return;
      }

      case 'fetchSnapshotItems': {
        const snapData = await storage.get('local', ['snapshots']);
        res.json({ items: snapData.snapshots || [] });
        return;
      }

      // ── Config ──────────────────────────────────────────────────
      case 'fetch-config':
      case 'fetch-firebase-config': {
        res.json({});
        return;
      }

      // ── Media upload (video chunks) ─────────────────────────────
      case 'save_video_chunk': {
        const { id, index, base64 } = message;
        const chunks = await storage.get('session', ['videoChunks']);
        const allChunks = chunks.videoChunks || {};
        if (!allChunks[id]) allChunks[id] = {};
        allChunks[id][index] = base64;
        await storage.set('session', { videoChunks: allChunks });
        res.json({ received: true });
        return;
      }

      case 'finalize_video': {
        const { id } = message;
        const chunkData = await storage.get('session', ['videoChunks']);
        const vidChunks = chunkData.videoChunks || {};
        const videoChunks = vidChunks[id] || {};
        const sortedKeys = Object.keys(videoChunks).sort((a, b) => parseInt(a) - parseInt(b));
        const combined = sortedKeys.map(k => videoChunks[k]).join('');
        const videos = await storage.get('session', ['finalizedVideos']);
        const vids = videos.finalizedVideos || {};
        vids[id] = combined;
        await storage.set('session', { finalizedVideos: vids });
        delete vidChunks[id];
        await storage.set('session', { videoChunks: vidChunks });
        res.json({ done: true });
        return;
      }

      case 'fileChunk': {
        const fileChunks = await storage.get('session', ['fileChunks']);
        const fc = fileChunks.fileChunks || {};
        if (!fc[message.id]) fc[message.id] = {};
        fc[message.id][message.index] = message.data;
        await storage.set('session', { fileChunks: fc });
        res.json({ received: true });
        return;
      }

      case 'clearCurrentDB': {
        await storage.clear('session');
        res.json({ cleared: true });
        return;
      }

      // ── Misc ────────────────────────────────────────────────────
      case 'upgrade_clicked': {
        res.json({ opened: true });
        return;
      }

      case 'openTab': {
        try {
          await velaClient.createTab(message.url);
          res.json({ opened: true });
        } catch (e: any) {
          res.json({ error: e.message });
        }
        return;
      }

      default: {
        console.warn(`[Router] Unknown action: ${action}`);
        res.json({ error: `Unknown action: ${action}` });
        return;
      }
    }
  } catch (e: any) {
    console.error(`[Router] Error handling action ${action}:`, e);
    res.status(500).json({ error: e.message });
  }
});
