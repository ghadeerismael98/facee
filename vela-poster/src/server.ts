import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { extensionMessageRouter } from './routes/extension-messages';
import { storageRouter } from './routes/storage';
import { profileRouter } from './routes/profiles';
import { VelaClient } from './vela/client';
import { ProfileStorageManager } from './storage/storage';
import { CampaignRunner } from './orchestrator/campaign-runner';
import { Scheduler } from './orchestrator/scheduler';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Initialize core services
export const velaClient = new VelaClient(
  process.env.VELA_API_URL || 'http://127.0.0.1:1306',
  process.env.VELA_API_KEY || ''
);

export const profileStorage = new ProfileStorageManager();
// Backward-compatible alias — returns the default profile's storage
export const storage = profileStorage.getStorage('default');

// Per-profile campaign runners
const campaignRunners: Map<string, CampaignRunner> = new Map();
export function getCampaignRunner(profileId: string): CampaignRunner {
  const id = profileId || 'default';
  if (!campaignRunners.has(id)) {
    const profileStore = profileStorage.getStorage(id);
    campaignRunners.set(id, new CampaignRunner(velaClient, profileStore, profileStorage));
    console.log(`[Server] Created campaign runner for profile: ${id}`);
  }
  return campaignRunners.get(id)!;
}

// Default campaign runner for backward compat + scheduler
export const campaignRunner = getCampaignRunner('default');
export const scheduler = new Scheduler(storage, campaignRunner);

// Helper to get profileId from request header
export function getProfileId(req: express.Request): string {
  return (req.headers['x-vela-profile'] as string) || 'default';
}

// API routes
app.use('/api/extension', extensionMessageRouter);
app.use('/api/storage', storageRouter);
app.use('/api/profiles', profileRouter);

// Health check
app.get('/api/status', async (_req, res) => {
  try {
    const velaStatus = await velaClient.getStatus();
    res.json({ ok: true, vela: velaStatus });
  } catch (e: any) {
    res.json({ ok: false, error: e.message });
  }
});

// Serve chrome-api-shim.js with Vela API key injected
app.get('/chrome-api-shim.js', (_req, res) => {
  const shimPath = path.join(__dirname, '..', 'ui', 'chrome-api-shim.js');
  const fs = require('fs');
  let content = fs.readFileSync(shimPath, 'utf-8');
  // Inject the Vela API key so the shim can query the Vela API for profile detection
  const apiKeyScript = `window.__velaApiKey = ${JSON.stringify(process.env.VELA_API_KEY || '')};\n`;
  res.type('application/javascript').send(apiKeyScript + content);
});

// Serve static UI files
app.use('/assets', express.static(path.join(__dirname, '..', 'ui', 'assets')));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'ui', 'index.html'));
});
app.get('/profiles', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'ui', 'profiles.html'));
});

// Disable HTTPS-first on all Vela profiles so they can access our HTTP server
async function disableHttpsFirstOnAllProfiles(): Promise<void> {
  try {
    const response = await velaClient.listProfiles();
    const profiles = Array.isArray(response) ? response : (response as any).profiles || [];
    for (const profile of profiles) {
      if (profile.httpsFirstEnabled !== false) {
        await velaClient.updateProfile(profile.id, { httpsFirstEnabled: false });
        console.log(`[Server] Disabled HTTPS-first on profile "${profile.name}"`);
      }
    }
  } catch (e: any) {
    console.warn('[Server] Could not auto-configure profiles:', e.message);
  }
}

// ── Per-profile port servers ─────────────────────────────────────
// Each Vela profile gets its own port (5001, 5002, ...) so dashboard iframes
// have separate origins → isolated localStorage/IndexedDB.
// Requests on these ports automatically get the X-Vela-Profile header set.
const PROFILE_PORT_BASE = 5001;
const profilePortMap: Record<string, number> = {};

async function startProfilePorts(): Promise<void> {
  try {
    const response = await velaClient.listProfiles();
    const profiles = Array.isArray(response) ? response : (response as any).profiles || [];

    profiles.forEach((profile: any, i: number) => {
      const port = PROFILE_PORT_BASE + i;
      profilePortMap[profile.id] = port;

      // Create a thin middleware that sets the profile header, then delegates to the main app
      const profileApp = express();
      profileApp.use((req, _res, next) => {
        req.headers['x-vela-profile'] = profile.id;
        next();
      });
      profileApp.use(app);

      profileApp.listen(port, () => {
        console.log(`[Server] Profile "${profile.name}" on port ${port}`);
      });
    });
  } catch (e: any) {
    console.warn('[Server] Could not start profile ports:', e.message);
  }
}

// Expose the port map via API so the dashboard can find them
app.get('/api/profile-ports', (_req, res) => {
  res.json(profilePortMap);
});

// Start server
app.listen(PORT, () => {
  console.log(`[Server] Vela Poster running on http://127.0.0.1:${PORT}`);
  console.log(`[Server] Vela API: ${process.env.VELA_API_URL || 'http://127.0.0.1:1306'}`);
  disableHttpsFirstOnAllProfiles();
  startProfilePorts();
  scheduler.start();
});
