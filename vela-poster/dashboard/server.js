const express = require('express');
const cors = require('cors');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = 4000;
const POSTER_URL = process.env.POSTER_URL || 'http://localhost:3333';
const VELA_API_URL = process.env.VELA_API_URL || 'http://127.0.0.1:1306';
const VELA_API_KEY = process.env.VELA_API_KEY || '';
const DASH_USER = process.env.DASH_USER || '';
const DASH_PASS = process.env.DASH_PASS || '';
const VNC_HOST = process.env.VNC_HOST || 'ghost-browser';

// ─── Basic auth (if DASH_PASS is set) ───
if (DASH_PASS) {
  app.use((req, res, next) => {
    // Skip auth for health check
    if (req.path === '/health') return next();
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Basic ')) {
      res.set('WWW-Authenticate', 'Basic realm="Face Poster Dashboard"');
      return res.status(401).send('Authentication required');
    }
    const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
    if (user === DASH_USER && pass === DASH_PASS) return next();
    res.set('WWW-Authenticate', 'Basic realm="Face Poster Dashboard"');
    res.status(401).send('Invalid credentials');
  });
  console.log(`[Dashboard] Basic auth enabled (user: ${DASH_USER})`);
}

// ─── noVNC WebSocket proxy ───
app.use('/vnc', createProxyMiddleware({
  target: `http://${VNC_HOST}:6080`,
  changeOrigin: true,
  ws: true,
  pathRewrite: { '^/vnc': '' },
}));

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ─── In-memory schedule state ───
let scheduledCampaigns = []; // [{ profileId, startAt, status, timer }]

// ─── Helpers ───
async function posterApi(method, apiPath, body, profileId) {
  const headers = { 'Content-Type': 'application/json' };
  if (profileId) headers['X-Vela-Profile'] = profileId;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${POSTER_URL}${apiPath}`, opts);
  return res.json();
}

async function getVelaProfiles() {
  const res = await fetch(`${VELA_API_URL}/api/profiles`, { headers: { 'X-API-Key': VELA_API_KEY } });
  const data = await res.json();
  return data.profiles || data || [];
}

function addJitter(value, pct) {
  const jitter = value * pct * (Math.random() * 2 - 1);
  return Math.max(1, Math.round(value + jitter));
}

// ─── Profile management (Ghost Browser) ───
app.get('/api/profiles', async (_req, res) => {
  try { res.json({ profiles: await getVelaProfiles() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/profiles/create', async (req, res) => {
  try {
    const r = await fetch(`${VELA_API_URL}/api/profiles`, {
      method: 'POST',
      headers: { 'X-API-Key': VELA_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const profile = await r.json();
    res.json(profile);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/profiles/:id', async (req, res) => {
  try {
    await fetch(`${VELA_API_URL}/api/profiles/${req.params.id}`, {
      method: 'DELETE',
      headers: { 'X-API-Key': VELA_API_KEY },
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/profiles/:id/open-facebook', async (req, res) => {
  try {
    const r = await fetch(`${VELA_API_URL}/api/tabs`, {
      method: 'POST',
      headers: { 'X-API-Key': VELA_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.facebook.com', profileId: req.params.id }),
    });
    const tab = await r.json();
    res.json(tab);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Remote browser viewer proxy ───
app.get('/api/browser/screenshot/:tabId', async (req, res) => {
  try {
    const r = await fetch(`${VELA_API_URL}/api/tabs/${req.params.tabId}/screenshot`, {
      headers: { 'X-API-Key': VELA_API_KEY },
    });
    const base64 = await r.text();
    res.type('text/plain').send(base64);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/browser/click/:tabId', async (req, res) => {
  try {
    await fetch(`${VELA_API_URL}/api/tabs/${req.params.tabId}/native/click`, {
      method: 'POST',
      headers: { 'X-API-Key': VELA_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: req.body.x, y: req.body.y }),
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/browser/type/:tabId', async (req, res) => {
  try {
    await fetch(`${VELA_API_URL}/api/tabs/${req.params.tabId}/keyboard/insert-text`, {
      method: 'POST',
      headers: { 'X-API-Key': VELA_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: req.body.text }),
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/browser/press/:tabId', async (req, res) => {
  try {
    await fetch(`${VELA_API_URL}/api/tabs/${req.params.tabId}/keyboard/press`, {
      method: 'POST',
      headers: { 'X-API-Key': VELA_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: req.body.key }),
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/browser/scroll/:tabId', async (req, res) => {
  try {
    await fetch(`${VELA_API_URL}/api/tabs/${req.params.tabId}/execute`, {
      method: 'POST',
      headers: { 'X-API-Key': VELA_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: `window.scrollBy(0, ${req.body.deltaY || 300})` }),
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/browser/navigate/:tabId', async (req, res) => {
  try {
    await fetch(`${VELA_API_URL}/api/tabs/${req.params.tabId}/navigate`, {
      method: 'POST',
      headers: { 'X-API-Key': VELA_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: req.body.url }),
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/browser/tab/:tabId', async (req, res) => {
  try {
    await fetch(`${VELA_API_URL}/api/tabs/${req.params.tabId}`, {
      method: 'DELETE',
      headers: { 'X-API-Key': VELA_API_KEY },
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve the remote browser viewer page
app.get('/browser-viewer', (_req, res) => {
  res.sendFile(require('path').join(__dirname, 'browser-viewer.html'));
});

app.get('/api/dashboard/status', async (_req, res) => {
  try {
    const profiles = await getVelaProfiles();
    const statuses = {};
    await Promise.all(profiles.map(async (p) => {
      try {
        const data = await posterApi('GET', '/api/storage/local?keys=isPostingInProgress,postingStatus,postsCompleted', null, p.id);
        const check = await posterApi('POST', '/api/extension/message', { action: 'isPostInPRogress' }, p.id);
        statuses[p.id] = { name: p.name, color: p.color, isRunning: check.inProgress || false, postingStatus: data.isPostingInProgress || 'idle', statusMessage: data.postingStatus || '', postsCompleted: Array.isArray(data.postsCompleted) ? data.postsCompleted : [] };
      } catch { statuses[p.id] = { name: p.name, color: p.color, isRunning: false, postingStatus: 'idle', statusMessage: '', postsCompleted: [] }; }
    }));
    res.json({ statuses });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Post using each profile's own stored content
app.post('/api/dashboard/post', async (req, res) => {
  const { profileIds } = req.body;
  if (!profileIds || !Array.isArray(profileIds) || !profileIds.length) return res.status(400).json({ error: 'profileIds required' });
  const results = {};
  await Promise.all(profileIds.map(async (profileId) => {
    try {
      const localData = await posterApi('GET', '/api/storage/local?keys=fb-group-lists,fb-post-scheduler', null, profileId);
      const gl = localData['fb-group-lists']; const sc = localData['fb-post-scheduler'];
      const groupLists = gl?.state?.groupLists || gl?.state?.state?.groupLists || [];
      const selId = sc?.state?.selectedGroupId || sc?.state?.state?.selectedGroupId;
      const draft = sc?.state?.draftPost || sc?.state?.state?.draftPost;
      const group = groupLists.find(g => g.id === selId);
      if (!group || !group.urls?.length) { results[profileId] = { success: false, error: 'No groups' }; return; }
      if (!draft?.content) { results[profileId] = { success: false, error: 'No post content' }; return; }
      const payload = { action: 'POST_PAYLOAD', payload: { post: { title: '', text: draft.content, images: [], links: [], video_id: [] }, group: { urls: group.urls }, timeInSeconds: 10, background: null, deliveryOptions: draft.deliveryOptions || null } };
      results[profileId] = await posterApi('POST', '/api/extension/message', payload, profileId);
    } catch (e) { results[profileId] = { success: false, error: e.message }; }
  }));
  res.json({ results });
});

app.post('/api/dashboard/stop-all', async (req, res) => {
  const { profileIds } = req.body;
  if (!profileIds) return res.status(400).json({ error: 'profileIds required' });

  // Clear any scheduled launches for these profiles
  scheduledCampaigns = scheduledCampaigns.filter(s => {
    if (profileIds.includes(s.profileId)) {
      if (s.timer) clearTimeout(s.timer);
      return false;
    }
    return true;
  });

  const results = {};
  await Promise.all(profileIds.map(async id => {
    try { results[id] = await posterApi('POST', '/api/extension/message', { action: 'stopPosting' }, id); }
    catch (e) { results[id] = { error: e.message }; }
  }));
  res.json({ results });
});

// ─── New: Sync groups to selected profiles ───
app.post('/api/dashboard/sync-groups', async (req, res) => {
  const { profileIds, urls, listName } = req.body;
  if (!profileIds?.length || !urls?.length) return res.status(400).json({ error: 'profileIds and urls required' });

  const listId = 'dashboard-unified';
  const newList = { id: listId, name: listName || 'Dashboard Groups', urls };

  try {
    await Promise.all(profileIds.map(async (profileId) => {
      // Read current group lists
      const data = await posterApi('GET', '/api/storage/local?keys=fb-group-lists,fb-post-scheduler', null, profileId);
      const gl = data['fb-group-lists'];
      const sc = data['fb-post-scheduler'];

      // Get existing lists
      let groupLists = gl?.state?.groupLists || gl?.state?.state?.groupLists || [];
      // Upsert our list
      const existingIdx = groupLists.findIndex(g => g.id === listId);
      if (existingIdx !== -1) {
        groupLists[existingIdx] = newList;
      } else {
        groupLists.push(newList);
      }

      // Write back in Zustand persist format
      const glState = { state: { groupLists }, version: 0 };
      await posterApi('POST', '/api/storage/local', { 'fb-group-lists': glState }, profileId);

      // Also set this as the selected group list
      const scState = sc || { state: {}, version: 0 };
      const innerState = scState.state?.state || scState.state || {};
      if (scState.state?.state) {
        scState.state.state.selectedGroupId = listId;
      } else if (scState.state) {
        scState.state.selectedGroupId = listId;
      } else {
        scState.state = { selectedGroupId: listId };
      }
      await posterApi('POST', '/api/storage/local', { 'fb-post-scheduler': scState }, profileId);
    }));

    res.json({ success: true, synced: profileIds.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── New: Unified posting with scheduling ───
app.post('/api/dashboard/post-unified', async (req, res) => {
  const { profileIds, post, groups, deliveryOptions, schedule, timeInSeconds } = req.body;
  if (!profileIds?.length) return res.status(400).json({ error: 'profileIds required' });
  if (!post?.content && !post?.images?.length) return res.status(400).json({ error: 'Post content required' });
  if (!groups?.urls?.length) return res.status(400).json({ error: 'Group URLs required' });

  const strategy = schedule?.strategy || 'immediate';

  // Build the base payload
  function buildPayload(profileGroupUrls, videoId) {
    return {
      action: 'POST_PAYLOAD',
      payload: {
        post: {
          title: '',
          text: post.content || '',
          images: post.images || [],
          links: [],
          video_id: videoId ? [videoId] : (post.video_id || [])
        },
        group: { urls: profileGroupUrls },
        timeInSeconds: timeInSeconds || 10,
        background: null,
        deliveryOptions: deliveryOptions || null
      }
    };
  }

  async function launchProfile(profileId, groupUrlsForProfile) {
    const payload = buildPayload(groupUrlsForProfile);
    return posterApi('POST', '/api/extension/message', payload, profileId);
  }

  // Clear any existing scheduled campaigns
  scheduledCampaigns = scheduledCampaigns.filter(s => {
    if (profileIds.includes(s.profileId)) {
      if (s.timer) clearTimeout(s.timer);
      return false;
    }
    return true;
  });

  try {
    if (strategy === 'immediate') {
      // All at once — same as before
      const results = {};
      await Promise.all(profileIds.map(async (id) => {
        try { results[id] = await launchProfile(id, groups.urls); }
        catch (e) { results[id] = { success: false, error: e.message }; }
      }));
      return res.json({ success: true, results });
    }

    if (strategy === 'group-spread') {
      // Split groups across profiles
      const chunkSize = Math.ceil(groups.urls.length / profileIds.length);
      const chunks = [];
      for (let i = 0; i < profileIds.length; i++) {
        chunks.push(groups.urls.slice(i * chunkSize, (i + 1) * chunkSize));
      }

      if (schedule.sequential) {
        // Sequential with group spread
        const restMs = (schedule.restMinutes || 20) * 60 * 1000;
        let delay = 0;
        profileIds.forEach((id, i) => {
          const groupChunk = chunks[i] || [];
          if (!groupChunk.length) return;
          const actualDelay = schedule.randomize && i > 0 ? addJitter(delay, 0.3) : delay;
          const startAt = new Date(Date.now() + actualDelay);

          const entry = { profileId: id, startAt: startAt.toISOString(), status: i === 0 ? 'launching' : 'waiting', timer: null };
          if (i === 0) {
            // Launch first immediately
            launchProfile(id, groupChunk).catch(() => {});
            entry.status = 'running'; entry.launchedAt = new Date().toISOString();
          } else {
            entry.timer = setTimeout(async () => {
              entry.status = 'running'; entry.launchedAt = new Date().toISOString();
              try { await launchProfile(id, groupChunk); }
              catch (e) { entry.status = 'failed'; }
            }, actualDelay);
          }
          scheduledCampaigns.push(entry);

          // Estimate time per profile: ~3min per group + throttle pauses
          const estTimePerGroup = 3; // minutes
          const batchSize = deliveryOptions?.batchSize || 3;
          const waitMin = deliveryOptions?.waitMinutes || 5;
          const groupCount = groupChunk.length;
          const batches = Math.ceil(groupCount / batchSize);
          const estProfileTime = (groupCount * estTimePerGroup + (batches - 1) * waitMin) * 60 * 1000;
          delay += estProfileTime + (schedule.randomize ? addJitter(restMs, 0.3) : restMs);
        });
      } else {
        // Parallel group spread — launch all immediately
        const results = {};
        await Promise.all(profileIds.map(async (id, i) => {
          const groupChunk = chunks[i] || [];
          if (!groupChunk.length) { results[id] = { success: false, error: 'No groups assigned' }; return; }
          try { results[id] = await launchProfile(id, groupChunk); }
          catch (e) { results[id] = { success: false, error: e.message }; }
        }));
        return res.json({ success: true, results });
      }

      return res.json({ success: true, scheduled: true, strategy: 'group-spread' });
    }

    // Sequential / Staggered / Time-window
    let delays = [];
    if (strategy === 'sequential') {
      // Sequential: estimate completion time, add rest
      const restMs = (schedule.restMinutes || 20) * 60 * 1000;
      const estTimePerGroup = 3; // minutes
      const batchSize = deliveryOptions?.batchSize || 3;
      const waitMin = deliveryOptions?.waitMinutes || 5;
      const groupCount = groups.urls.length;
      const batches = Math.ceil(groupCount / batchSize);
      const estProfileTime = (groupCount * estTimePerGroup + (batches - 1) * waitMin) * 60 * 1000;

      let cumDelay = 0;
      for (let i = 0; i < profileIds.length; i++) {
        delays.push(cumDelay);
        cumDelay += estProfileTime + (schedule.randomize ? addJitter(restMs, 0.3) : restMs);
      }
    } else if (strategy === 'staggered') {
      const staggerMs = (schedule.staggerMinutes || 20) * 60 * 1000;
      for (let i = 0; i < profileIds.length; i++) {
        const d = staggerMs * i;
        delays.push(schedule.randomize ? addJitter(d, 0.2) : d);
      }
    } else if (strategy === 'time-window') {
      const windowMs = (schedule.timeWindowHours || 6) * 3600 * 1000;
      const stagger = profileIds.length > 1 ? windowMs / profileIds.length : 0;
      for (let i = 0; i < profileIds.length; i++) {
        const d = stagger * i;
        // Always add some jitter for time-window to look natural
        delays.push(addJitter(d, 0.15));
      }
    }

    // Schedule each profile
    profileIds.forEach((id, i) => {
      const delay = delays[i] || 0;
      const startAt = new Date(Date.now() + delay);
      const entry = { profileId: id, startAt: startAt.toISOString(), status: delay === 0 ? 'launching' : 'waiting', timer: null };

      if (delay === 0) {
        launchProfile(id, groups.urls).catch(() => {});
        entry.status = 'running'; entry.launchedAt = new Date().toISOString();
      } else {
        entry.timer = setTimeout(async () => {
          entry.status = 'running'; entry.launchedAt = new Date().toISOString();
          try { await launchProfile(id, groups.urls); }
          catch (e) { entry.status = 'failed'; }
        }, delay);
      }
      scheduledCampaigns.push(entry);
    });

    res.json({ success: true, scheduled: true, strategy });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── New: Schedule status ───
app.get('/api/dashboard/schedule-status', (_req, res) => {
  // Update statuses — remove old completed entries (older than 5 min after launch)
  const now = Date.now();
  scheduledCampaigns = scheduledCampaigns.filter(s => {
    if (s.status === 'running' || s.status === 'failed') {
      const ref = s.launchedAt ? new Date(s.launchedAt).getTime() : new Date(s.startAt).getTime();
      return (now - ref) < 300000;
    }
    return true;
  });

  const scheduled = scheduledCampaigns.map(s => ({
    profileId: s.profileId,
    startAt: s.startAt,
    status: s.status
  }));
  res.json({ scheduled });
});

// ─── New: Video upload ───
app.post('/api/dashboard/upload-video', async (req, res) => {
  const { profileIds, videoBase64, fileName } = req.body;
  if (!profileIds?.length || !videoBase64) return res.status(400).json({ error: 'profileIds and videoBase64 required' });

  try {
    const videoId = 'dashboard-video-' + Date.now();
    const chunkSize = 1024 * 1024; // 1MB chunks
    const alignedChunkSize = Math.floor(chunkSize / 4) * 4; // align to base64 4-char boundaries
    const raw = videoBase64.split(',')[1] || videoBase64;
    const totalChunks = Math.ceil(raw.length / alignedChunkSize);

    // Upload to each profile
    await Promise.all(profileIds.map(async (profileId) => {
      // Send chunks
      for (let i = 0; i < totalChunks; i++) {
        const chunk = raw.slice(i * alignedChunkSize, (i + 1) * alignedChunkSize);
        await posterApi('POST', '/api/extension/message', {
          action: 'save_video_chunk',
          id: videoId,
          index: i,
          base64: chunk,
          totalChunks,
          mimeType: 'video/mp4',
          fileName: fileName || 'video.mp4'
        }, profileId);
      }
      // Finalize
      await posterApi('POST', '/api/extension/message', {
        action: 'finalize_video',
        id: videoId,
        totalChunks,
        mimeType: 'video/mp4',
        fileName: fileName || 'video.mp4'
      }, profileId);
    }));

    res.json({ success: true, videoId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Serve dashboard ───
app.get('/', (_req, res) => { res.sendFile(path.join(__dirname, 'dashboard.html')); });
const server = require('http').createServer(app);
// Enable WebSocket upgrade for noVNC proxy
const vncProxy = createProxyMiddleware({
  target: `http://${VNC_HOST}:6080`,
  changeOrigin: true,
  ws: true,
});
server.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/vnc')) {
    req.url = req.url.replace(/^\/vnc/, '');
    vncProxy.upgrade(req, socket, head);
  }
});
server.listen(PORT, () => { console.log(`[Dashboard] Running on http://0.0.0.0:${PORT}`); });
