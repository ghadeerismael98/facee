// Keep both buffers and metadata per video ID
const videoBuffers = {}; // { [id]: Uint8Array[] }
const videoMeta = {}; // { [id]: { type: string, total: number } }
let triggeredSet = new Set();

// PERSISTENCE FIX: State guards now use chrome.storage.session for resilience across SW restarts
// Falls back to memory if API unavailable (Chrome < 102)
let isCurrentlyPosting = false; // Guard to prevent concurrent posting sessions
let activeCampaignId = null; // Track which campaign is currently running (CRITICAL FIX for double-posting bug)
let isStopping = false; // Flag to prevent new campaigns from starting during cleanup (FIX for race condition)
let activePostingTabId = null; // Track current posting tab for fast stop behavior
let pendingPostPayloadRequest = null; // Queue one manual campaign while previous stop is in progress

const SUPPORTS_SESSION_STORAGE = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session;

// Initialize state from persistent storage on startup
async function initializeStateFromStorage() {
  if (!SUPPORTS_SESSION_STORAGE) return;
  try {
    const state = await chrome.storage.session.get(['isCurrentlyPosting', 'activeCampaignId', 'isStopping', 'triggeredSet']);
    if (state.isCurrentlyPosting) isCurrentlyPosting = true;
    if (state.activeCampaignId) activeCampaignId = state.activeCampaignId;
    if (state.isStopping) isStopping = true;
    if (state.triggeredSet) {
      triggeredSet = new Set(state.triggeredSet);
    }
    console.log('[State] Initialized from session storage:', { isCurrentlyPosting, activeCampaignId, isStopping, triggeredSetSize: triggeredSet.size });
  } catch (e) {
    console.error('[State] Failed to initialize from session storage:', e);
  }
}

// Call on service worker startup
initializeStateFromStorage();

// Helper to persist state changes
async function persistState() {
  if (!SUPPORTS_SESSION_STORAGE) return;
  try {
    await chrome.storage.session.set({
      isCurrentlyPosting,
      activeCampaignId,
      isStopping,
      triggeredSet: Array.from(triggeredSet) // CRITICAL FIX: Persist triggeredSet to survive SW restarts
    });
  } catch (e) {
    console.error('[State] Failed to persist state:', e);
  }
}

// DATABASE CACHE: Reduce redundant IndexedDB reads with 5-second TTL
let dbCache = null;
let dbCacheTime = 0;
const DB_CACHE_TTL_MS = 5000;

async function getDataFromDBCached() {
  const now = Date.now();
  if (dbCache && (now - dbCacheTime) < DB_CACHE_TTL_MS) {
    console.log('[Cache] Returning cached DB data (age:', now - dbCacheTime, 'ms)');
    return dbCache;
  }
  
  // Cache miss - fetch from actual getDataFromDB
  console.log('[Cache] Cache miss or expired, fetching fresh data');
  const data = await getDataFromDB();
  dbCache = data;
  dbCacheTime = now;
  return data;
}

// Spintax expansion helper
function expandSpintax(text) {
  if (!text) return text;
  
  // Log for debugging
  console.log("[Spintax] Input text:", text);
  let spintaxGroupCount = 0;
  
  // FIX: Handle HTML formatting by temporarily removing it
  // This allows spintax patterns like {opt1|opt2} to work even with <strong>, <em>, etc.
  // Create a map of placeholders for HTML tags
  const htmlMap = {};
  let htmlCounter = 0;
  const placeholder = (id) => `__HTML_PLACEHOLDER_${id}__`;
  
  // Extract HTML tags and replace with placeholders
  let processedText = text.replace(/<[^>]+>/g, (match) => {
    htmlMap[htmlCounter] = match;
    const ph = placeholder(htmlCounter);
    htmlCounter++;
    return ph;
  });
  
  console.log("[Spintax] Processed text (HTML removed):", processedText);
  
  // Parse and expand spintax groups {option1|option2|option3}
  let result = processedText.replace(/\{([^{}]+)\}/g, (match, content) => {
    console.log("[Spintax] Found match:", match, "content:", content);
    const options = content.split('|').map(opt => opt.trim()).filter(opt => opt.length > 0);
    console.log("[Spintax] Options:", options);
    
    if (options.length > 1) {
      spintaxGroupCount++;
      // CRITICAL FIX: Generate fresh random value for each match to ensure proper randomization
      // Previously Math.random() may have been cached or reused incorrectly
      const randomIndex = Math.floor(Math.random() * options.length);
      const selected = options[randomIndex];
      console.log("[Spintax] Random index:", randomIndex, "Selected:", selected);
      return selected;
    }
    return match; // Return original if no valid options
  });
  
  // Restore HTML tags from placeholders
  Object.keys(htmlMap).forEach(id => {
    result = result.replace(placeholder(id), htmlMap[id]);
  });
  
  console.log("[Spintax] Output text:", result);
  if (spintaxGroupCount > 0) {
    trackMixpanel("spintax_expanded", {
      source: "background",
      groups: spintaxGroupCount,
    });
    captureSentryMessage("spintax_expanded", {
      source: "background",
      groups: spintaxGroupCount,
    });
  }
  return result;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 1) Save each chunk
  if (msg.action === "save_video_chunk") {
    const { id, index, total, base64, type } = msg;

    try {
      // Decode base64 into a Uint8Array
      const binary = atob(base64.split(",")[1]);
      const buf = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        buf[i] = binary.charCodeAt(i);
      }

      // Initialize storage if first chunk
      if (!videoBuffers[id]) {
        videoBuffers[id] = [];
        videoMeta[id] = { type, total };
      }

      videoBuffers[id][index] = buf;
      sendResponse({ received: true });
    } catch (err) {
      sendResponse({ received: false, error: err.message });
    }

    return true; // keep sendResponse available
  }

  // 2) Finalize and reassemble
  if (msg.action === "finalize_video") {
    const { id } = msg;
    const meta = videoMeta[id];
    const buffers = videoBuffers[id];

    if (
      !meta ||
      !buffers ||
      buffers.length !== meta.total ||
      buffers.some((c) => !c)
    ) {
      sendResponse({ done: false, error: "Missing or incomplete chunks" });
      return true;
    }

    // Reassemble with the correct MIME type
    const blob = new Blob(buffers, { type: meta.type });

    // Save to IndexedDB
    const openReq = indexedDB.open("MediaStore", 1);
    openReq.onupgradeneeded = () => {
      const db = openReq.result;
      if (!db.objectStoreNames.contains("videos")) {
        db.createObjectStore("videos");
      }
    };

    openReq.onsuccess = () => {
      const db = openReq.result;
      const tx = db.transaction("videos", "readwrite");
      tx.objectStore("videos").put(blob, id);

      tx.oncomplete = () => {
        db.close();

        // cleanup
        delete videoBuffers[id];
        delete videoMeta[id];

        sendResponse({ done: true });
      };

      tx.onerror = () => {
        db.close();
        sendResponse({ done: false, error: tx.error.message });
      };
    };

    openReq.onerror = () => {
      sendResponse({ done: false, error: openReq.error.message });
    };

    return true; // async response
  }
});

// Fetch current sotred Videos
const MAX_CHUNK_SIZE = 256 * 1024; // 256 KB

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "video-stream") return;

  port.onMessage.addListener(async (msg) => {
    if (msg.action !== "get_videos_by_ids") return;
    try {
      const db = await openMediaDB();
      for (const id of msg.ids) {
        const blob = await getBlobById(db, id);
        if (!blob) {
          // signal “no data” for this id
          port.postMessage({ id, done: true, error: "not-found" });
          continue;
        }

        // slice & send
        let offset = 0;
        while (offset < blob.size) {
          const slice = blob.slice(offset, offset + MAX_CHUNK_SIZE);
          const arrayBuffer = await slice.arrayBuffer();
          port.postMessage({
            id,
            chunk: Array.from(new Uint8Array(arrayBuffer)),
            type: blob.type,
            done: false,
          });
          // wait for consumer to ack before sending next slice
          await new Promise((res) => {
            const listener = (ack) => {
              if (ack.id === id && ack.received === true) {
                port.onMessage.removeListener(listener);
                res();
              }
            };
            port.onMessage.addListener(listener);
          });
          offset += MAX_CHUNK_SIZE;
        }

        // signal end-of-file for this video
        port.postMessage({ id, done: true });
      }
    } catch (err) {
      port.postMessage({ action: "error", message: err.message });
    }
  });
});

async function openMediaDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("MediaDB", 1);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains("media")) {
        db.createObjectStore("media", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getBlobById(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("media", "readonly");
    const store = tx.objectStore("media");
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result?.value?.blob);
    req.onerror = () => reject(req.error);
  });
}

// ✅ Helper function: Convert Blob to base64
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]); // Only base64 part
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Background script

const requestQueue = [];
let isProcessing = false;
const REQUEST_INTERVAL = 500; // ms between requests
const MIXPANEL_TOKEN = "b9e21ff4a7c6ee5ff5267aa0f3422e8d";
// ── Persistent Mixpanel distinct_id (stored in chrome.storage.local) ─────────
let MP_DISTINCT_ID = 'anonymous';
(function () {
  try {
    chrome.storage.local.get(['mp_distinct_id'], (r) => {
      if (r && r.mp_distinct_id) {
        MP_DISTINCT_ID = r.mp_distinct_id;
      } else {
        MP_DISTINCT_ID = 'ext_' + Date.now() + '_' + Math.random().toString(36).slice(2);
        chrome.storage.local.set({ mp_distinct_id: MP_DISTINCT_ID });
      }
    });
  } catch (_) {}
})();
const MIXPANEL_TRACK_URL = "https://api-eu.mixpanel.com/track"; // EU endpoint
const MIXPANEL_IGNORED_ACTIONS = new Set([
  "callApi",
  "fileChunk",
  "save_video_chunk",
  "finalize_video",
  "snapshot_log",
  "clearCurrentDB",
  "ping",
]);
let currentEmailHash = "anonymous";
let currentIsPremium = false;
let currentPostsRemaining = null;
const VERIFIED_PREMIUM_STATUS_TTL_MS = 30 * 1000;
let lastVerifiedPremiumStatus = {
  email: "",
  isPremium: null,
  checkedAt: 0,
};
let mixpanelDistinctIdPromise = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "callApi") {
    if (message.payload?.event) {
      trackMixpanel("content_feature_event", {
        event_name: message.payload.event,
        event_type: message.payload.type || "unknown",
      });
    }
    // Push request to queue
    requestQueue.push({ payload: message.payload, sendResponse });

    // Start processing if not already
    if (!isProcessing) processQueue();

    return true; // keep channel open for async sendResponse
  }
});

function processQueue() {
  if (requestQueue.length === 0) {
    isProcessing = false;
    return;
  }

  isProcessing = true;
  const { payload, sendResponse } = requestQueue.shift();

  fetch("https://server.fbgroupbulkposter.com/telemetry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then(async (response) => {
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        sendResponse({ success: false, error: data || response.statusText });
      } else {
        sendResponse({ success: true, data });
      }
    })
    .catch((error) => {
      sendResponse({ success: false, error: error.toString() });
    })
    .finally(() => {
      setTimeout(processQueue, REQUEST_INTERVAL);
    });
}

function updatePostingStatus(message) {
  chrome.storage.local.set({ postingStatus: message }, function () {
    if (chrome.runtime.lastError) {
      console.error("Storage error (updatePostingStatus):", chrome.runtime.lastError);
    }
  });
}

async function waitBeforeNextPost(timeInSeconds, currentIndex, totalGroups, deliveryOptions = null) {
  // Determine wait time based on delivery mode
  let actualWaitTime = timeInSeconds; // Default to legacy timeInSeconds

  // Default delivery behavior when user hasn't selected anything:
  // - every 3 posts (batchSize = 3)
  // - randomize wait between 70% and 150% of the base wait
  // If no deliveryOptions passed, treat as not customized and use defaults
  if (!deliveryOptions) {
    deliveryOptions = { mode: "throttled", batchSize: 3, waitMinutes: 0, randomizeWait: true, isCustom: false };
  }

  if (deliveryOptions) {
    // If user hasn't customized delivery settings (isCustom === false or undefined),
    // apply our new default: after every 3 posts, wait randomly between 140 and 520 seconds.
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
      // No wait for continuous mode
      actualWaitTime = 0;
    } else if (deliveryOptions.mode === 'throttled') {
      // Check if we should wait (every batchSize posts)
      const postNumber = currentIndex + 1;
      if (postNumber % deliveryOptions.batchSize === 0) {
        // Apply wait time in seconds
        actualWaitTime = deliveryOptions.waitMinutes * 60;
        
        // Apply randomization if enabled
        if (deliveryOptions.randomizeWait) {
          const minWait = Math.round(actualWaitTime * 0.7);
          const maxWait = Math.round(actualWaitTime * 1.5);
          actualWaitTime = Math.floor(Math.random() * (maxWait - minWait + 1)) + minWait;
        }
      } else {
        actualWaitTime = 0;
      }
    }
  }

  // If no wait needed, return immediately
  if (actualWaitTime === 0) {
    return;
  }

  updatePostingStatus(
    `Post ${
      currentIndex + 1
    } / ${totalGroups} done. Next post will continue in ${actualWaitTime} seconds.`
  );

  // Loop to decrement the remaining time every 10 seconds and log the message
  let remainingTime = actualWaitTime;
  while (remainingTime > 0) {
    // FIX: Check for stop request during wait to allow immediate stopping
    if (state.isStopRequested) {
      console.log("✅ Stop requested during wait, exiting early");
      break;
    }
    
    await sleep(10); // Sleep for 10 seconds
    remainingTime -= 10; // Decrement the remaining time by 10 seconds

    // Check to not go below zero
    if (remainingTime < 0) {
      remainingTime = 0;
    }

    // Update the log with the remaining time
    if (remainingTime > 0) {
      updatePostingStatus(
        `Post ${
          currentIndex + 1
        } / ${totalGroups} done. Next post will continue in ${remainingTime} seconds.`
      );
    }
  }
}

async function cleanUpAfterPosting(tabId) {
  await new Promise((resolve) => {
    chrome.tabs.remove(tabId, () => {
      if (chrome.runtime.lastError) {
        // Tab may already be closed; continue cleanup flow.
      }
      resolve();
    });
  });

  const start = Date.now();
  while (Date.now() - start < 1500) {
    const tabs = await new Promise((resolve) =>
      chrome.tabs.query({ active: true, currentWindow: true }, resolve)
    );
    if (tabs && tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, { action: "removeOverlay" }, () => {
        if (chrome.runtime.lastError) {
          // Silently ignore - tab might not have content script
        }
      });
      break;
    }
    await sleepMs(100);
  }
}

async function hashEmail(email) {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalized) return "";
  if (!globalThis.crypto || !globalThis.crypto.subtle) return "";
  const encoded = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function maybeSetSentryIdentity(emailHash) {
  try {
    const sentry = globalThis.Sentry;
    if (!sentry) return;

    if (emailHash) {
      if (typeof sentry.setUser === "function") sentry.setUser({ id: emailHash });
      if (typeof sentry.setTag === "function") sentry.setTag("email_hash", emailHash);
      return;
    }

    if (typeof sentry.setUser === "function") sentry.setUser(null);
    if (typeof sentry.setTag === "function") sentry.setTag("email_hash", "anonymous");
  } catch (_) {
    // Ignore Sentry context errors to avoid affecting posting flow.
  }
}

async function syncSentryIdentityFromEmail(email) {
  const hash = await hashEmail(email);
  currentEmailHash = hash || "anonymous";
  maybeSetSentryIdentity(hash);
  return hash || "anonymous";
}

async function syncSentryIdentityFromStoredUser() {
  try {
    const data = await chrome.storage.sync.get(["user", "isPremium", "postsRemaining"]);
    currentIsPremium = !!data?.isPremium;
    currentPostsRemaining =
      typeof data?.postsRemaining === "number" ? data.postsRemaining : null;
    await syncSentryIdentityFromEmail(data?.user?.email || "");
  } catch (_) {
    currentEmailHash = "anonymous";
    maybeSetSentryIdentity("");
  }
}

function rememberVerifiedPremiumStatus(email, isPremium) {
  if (!email) return;
  lastVerifiedPremiumStatus = {
    email,
    isPremium: !!isPremium,
    checkedAt: Date.now(),
  };
  currentIsPremium = !!isPremium;
}

function getFreshVerifiedPremiumStatus(
  email,
  maxAgeMs = VERIFIED_PREMIUM_STATUS_TTL_MS
) {
  if (!email) return null;
  if (
    lastVerifiedPremiumStatus.email !== email ||
    typeof lastVerifiedPremiumStatus.isPremium !== "boolean"
  ) {
    return null;
  }
  if (Date.now() - lastVerifiedPremiumStatus.checkedAt > maxAgeMs) {
    return null;
  }
  return lastVerifiedPremiumStatus.isPremium;
}

function toBase64Utf8(value) {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  return btoa(unescape(encodeURIComponent(json)));
}

function sanitizeMixpanelProps(raw, maxLen = 200) {
  if (raw == null) return raw;
  if (typeof raw === "string") return raw.length > maxLen ? `${raw.slice(0, maxLen)}...` : raw;
  if (typeof raw === "number" || typeof raw === "boolean") return raw;
  if (Array.isArray(raw)) return raw.slice(0, 10).map((v) => sanitizeMixpanelProps(v, maxLen));
  if (typeof raw === "object") {
    const out = {};
    Object.keys(raw)
      .slice(0, 30)
      .forEach((k) => {
        out[k] = sanitizeMixpanelProps(raw[k], maxLen);
      });
    return out;
  }
  return String(raw);
}

async function getOrCreateMixpanelDistinctId() {
  if (mixpanelDistinctIdPromise) return mixpanelDistinctIdPromise;
  mixpanelDistinctIdPromise = new Promise((resolve) => {
    chrome.storage.local.get(["mixpanel_distinct_id"], (res) => {
      const existing = res?.mixpanel_distinct_id;
      if (existing) {
        resolve(existing);
        return;
      }
      const generated = `anon_${crypto.randomUUID()}`;
      chrome.storage.local.set({ mixpanel_distinct_id: generated }, () => resolve(generated));
    });
  });
  return mixpanelDistinctIdPromise;
}

async function trackMixpanel(eventName, props = {}) {
  try {
    if (!eventName || !MIXPANEL_TOKEN) return;
    const distinctId =
      currentEmailHash && currentEmailHash !== "anonymous"
        ? currentEmailHash
        : (MP_DISTINCT_ID !== 'anonymous' ? MP_DISTINCT_ID : await getOrCreateMixpanelDistinctId());
    const payload = {
      event: eventName,
      properties: {
        token: MIXPANEL_TOKEN,
        distinct_id: distinctId,
        time: Date.now(),
        $insert_id: crypto.randomUUID(),
        app_version: chrome.runtime.getManifest().version,
        extension_version: chrome.runtime.getManifest().version,
        extension_id: chrome.runtime.id,
        email_hash: currentEmailHash || "anonymous",
        is_premium: currentIsPremium,
        posts_remaining: currentPostsRemaining,
        ...sanitizeMixpanelProps(props),
      },
    };
    const body = `data=${encodeURIComponent(toBase64Utf8(payload))}`;
    fetch(MIXPANEL_TRACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }).catch(() => {});
  } catch (_) {
    // Never break posting flow because analytics failed.
  }
}

function captureSentryMessage(message, extras = {}, level = "info") {
  try {
    const sentry = globalThis.Sentry;
    if (!sentry || typeof sentry.captureMessage !== "function") return;

    if (typeof sentry.withScope === "function") {
      sentry.withScope((scope) => {
        if (scope && typeof scope.setLevel === "function") scope.setLevel(level);
        if (scope && typeof scope.setTag === "function") {
          scope.setTag("email_hash", currentEmailHash || "anonymous");
          scope.setTag("channel", "background");
        }
        if (scope && typeof scope.setExtra === "function") {
          const safeExtras = sanitizeMixpanelProps(extras);
          Object.keys(safeExtras || {}).forEach((key) => {
            scope.setExtra(key, safeExtras[key]);
          });
        }
        sentry.captureMessage(message);
      });
      return;
    }

    sentry.captureMessage(message);
  } catch (_) {
    // Ignore Sentry-only failure.
  }
}

function captureSentryException(error, extras = {}) {
  try {
    const sentry = globalThis.Sentry;
    if (!sentry || typeof sentry.captureException !== "function") return;
    if (typeof sentry.withScope === "function") {
      sentry.withScope((scope) => {
        if (scope && typeof scope.setTag === "function") {
          scope.setTag("email_hash", currentEmailHash || "anonymous");
          scope.setTag("channel", "background");
        }
        if (scope && typeof scope.setExtra === "function") {
          const safeExtras = sanitizeMixpanelProps(extras);
          Object.keys(safeExtras || {}).forEach((key) => {
            scope.setExtra(key, safeExtras[key]);
          });
        }
        sentry.captureException(error);
      });
      return;
    }
    sentry.captureException(error);
  } catch (_) {
    // Ignore Sentry-only failure.
  }
}

async function trackFirstSuccessfulSessionIfNeeded(postsCompleted) {
  try {
    if (!Array.isArray(postsCompleted) || postsCompleted.length === 0) return;
    const allSuccessful = postsCompleted.every(
      (entry) => entry && entry.response === "successful" && !entry.skipped
    );
    if (!allSuccessful) return;
    const key = `mixpanel_first_success_${currentEmailHash || "anonymous"}`;
    const marker = await chrome.storage.local.get([key]);
    if (marker && marker[key]) return;
    await chrome.storage.local.set({ [key]: Date.now() });
    trackMixpanel("first_successful_posting_session", {
      total_groups: postsCompleted.length,
    });
  } catch (_) {
    // Ignore analytics-only failure.
  }
}

async function trackTrialExhaustedIfNeeded(source) {
  try {
    const key = `mixpanel_trial_exhausted_${currentEmailHash || "anonymous"}`;
    const now = Date.now();
    const marker = await chrome.storage.local.get([key]);
    const lastTs = marker?.[key];
    if (typeof lastTs === "number" && now - lastTs < 60 * 60 * 1000) return;
    await chrome.storage.local.set({ [key]: now });
    trackMixpanel("trial_exhausted_blocked", {
      source,
      posts_remaining: currentPostsRemaining,
      is_premium: currentIsPremium,
    });
    // ── credits_exhausted + upgrade_prompt_shown ─────────────────────
    trackMixpanel("credits_exhausted", {
      source,
      posts_remaining: currentPostsRemaining,
    });
    trackMixpanel("upgrade_prompt_shown", {
      source,
      posts_remaining: currentPostsRemaining,
    });
  } catch (_) {
    // Ignore analytics-only failure.
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  if (changes.user) {
    const nextEmail = changes.user.newValue?.email || "";
    syncSentryIdentityFromEmail(nextEmail)
      .then(() => {
        trackMixpanel(nextEmail ? "user_login_detected" : "user_logout_detected");
      })
      .catch(() => {});
  }
  if (changes.isPremium) {
    currentIsPremium = !!changes.isPremium.newValue;
  }
  if (changes.postsRemaining) {
    currentPostsRemaining =
      typeof changes.postsRemaining.newValue === "number"
        ? changes.postsRemaining.newValue
        : null;
  }
});

syncSentryIdentityFromStoredUser()
  .then(() => trackMixpanel("extension_background_started"))
  .catch(() => {});

const state = {
  isStopRequested: false, // Flag to stop posting process
  avoidNightTimePosting: false, // (Future implementation) Flag to avoid night-time posting
  groupLinks: [], // List of group links to post content
  remainingGroups: [], // Links remaining for posting
  postsCompleted: [], // Track completed posts with success/failure
};

const getUserStatus = async () => {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["user", "isPremium", "postsRemaining"], (result) => {
      const email = result.user?.email;
      
      // PERFORMANCE FIX: Return cached data immediately for instant UI rendering
      // Do not block the popup from opening
      const cachedData = {
        postsRemaining: result.postsRemaining ?? 6,
        isPremium: result.isPremium ?? false,
        email: email
      };
      
      resolve(cachedData); // UI renders now with last-known state
      
      // BACKGROUND REFRESH: Non-blocking premium status verification
      // Only happens after UI is already displayed
      if (email) {
        verifyPremiumStatus(email)
          .then(freshStatus => {
            // Only update storage if status changed
            if (freshStatus.isPremium !== cachedData.isPremium) {
              console.log("[Premium Status] Status changed, updating storage");
              chrome.storage.sync.set({ isPremium: freshStatus.isPremium });
              // Notify popup if still open about the status change
              chrome.runtime.sendMessage({
                action: "statusChanged", 
                isPremium: freshStatus.isPremium,
                email: email
              }).catch(() => {
                // Popup may be closed, this is fine
              });
            } else {
              console.log("[Premium Status] Status unchanged, no update needed");
            }
          })
          .catch(error => {
            console.error("[Premium Status] Background verification failed:", error);
          });
      }
    });
  });
};

// Function to check stored schedules and execute logic
async function checkAndRunScheduledPosts() {
  (async () => {
    const userStatus = await getUserStatus();
    const isPremium = userStatus.isPremium;
    chrome.storage.sync.set({ postsRemaining: userStatus.postsRemaining });
    const postsRemaining = userStatus.postsRemaining;

    const data = await getDataFromDBCached();
    if (
      !(isPremium || postsRemaining > 0) ||
      !data?.state?.scheduledPosts?.length
    )
      return;

    const now = new Date();
    let currentHour = now.getHours(); // Keep 24-hour format for consistency
    const currentMinute = now.getMinutes();
    const currentDay = now.getDay(); // 0 = Sunday, 6 = Saturday
    const currentDate = now.getDate();

    let updatedPosts = [];

    data.state.scheduledPosts.forEach((post) => {
      const { id, schedule } = post;
      if (!schedule || schedule.completed) return;

      const { frequency, time, recurring, startDate } = schedule;
      let [hour, minute] = time.split(":").map(Number);

      // Ensure hour is in 24-hour format (assume input is already in 24-hour format)
      hour = hour % 24; // Normalize hour within 24-hour range
      minute = parseInt(minute, 10);

      if (hour === currentHour && minute === currentMinute) {
        if (frequency === "once") {
          runPostLogic(id);
          post.schedule.completed = true; // Mark post as completed
          updatedPosts.push(post);
        } else if (frequency === "daily") {
          runPostLogic(id);
        } else if (
          frequency === "weekly" &&
          recurring?.weekDays?.includes(getDayName(currentDay))
        ) {
          runPostLogic(id);
        } else if (
          frequency === "monthly" &&
          recurring?.monthDays?.includes(currentDate)
        ) {
          runPostLogic(id);
        }
      }
    });

    // 🔄 Update the database with completed "once" posts
    if (updatedPosts.length > 0) {
      await updateDataInDB(data);
    }
  })();
}

function updatePostingProgress(status) {
  chrome.storage.local.set({ isPostingInProgress: status }, function () {
    if (chrome.runtime.lastError) {
      console.error("Storage error (updatePostingProgress):", chrome.runtime.lastError);
    }
  });
}

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clearOperationDone() {
  await new Promise((resolve) => chrome.storage.local.remove("operationDone", resolve));
}

async function handleResponse() {
  // Helper wrappers to use chrome.storage with async/await
  const getLocal = (keys) =>
    new Promise((resolve) => chrome.storage.local.get(keys, (res) => resolve(res)));
  const getSync = (keys) =>
    new Promise((resolve) => chrome.storage.sync.get(keys, (res) => resolve(res)));

  let response = null;
  // REMOVED: await sleep(5); - No need to wait 5 seconds before checking status
  // This caused unnecessary delays when composer fails to open immediately
  let timeTaken = 0;
  let lastIntermediateState = null;

  while (true) {
    if (state.isStopRequested || isStopping) {
      console.log("[handleResponse] 🛑 Stop requested while waiting for operationDone");
      trackMixpanel("group_post_result", { result: "cancelled" });
      return false;
    }

    const result = await getLocal(["operationDone"]);
    response = result?.operationDone;

    if (response === "failed") {
      console.log("[handleResponse] ❌ Post failed - operationDone: failed");
      trackMixpanel("group_post_result", { result: "failed" });
      return false;
    }
    if (response === "successful") {
      console.log("[handleResponse] ✅ Post successful - operationDone: successful");
      trackMixpanel("group_post_result", { result: "successful" });
      const data = await getSync(["user"]);
      const email = data?.user?.email;
      if (email) {
        try {
          const shouldConsumeCredit = await shouldConsumeCreditAfterSuccess(email);
          if (shouldConsumeCredit) {
            await useCredit(email);
          }
        } catch (error) {
          console.warn("[Credits] useCredit failed, continuing:", error?.message || error);
        }
      }
      return true;
    }
    if (response && response !== lastIntermediateState) {
      console.log(`[handleResponse] ⏳ Waiting - intermediate operationDone state: ${response}`);
      lastIntermediateState = response;
    }

    await sleep(1);
    timeTaken++;

    if (timeTaken > 120) {
      console.warn("[handleResponse] ⏱️ TIMEOUT after 120 seconds - no operationDone response");
      trackMixpanel("group_post_result", { result: "timeout" });
      return false;
    }
  }
}

function updatePostingStatus(message) {
  chrome.storage.local.set({ postingStatus: message }, function () {
    if (chrome.runtime.lastError) {
      console.error("Storage error (updatePostingStatus):", chrome.runtime.lastError);
    }
  });
}

// CONTENT SCRIPT READINESS CHECK: Verify content.js is loaded before sending messages
async function checkContentScriptReady(tabId, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { action: "ping" }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.pong) {
            resolve(true);
          } else {
            reject(new Error("Content script did not respond to ping"));
          }
        });
      });
    } catch (error) {
      console.warn(`[Content Ready] Attempt ${attempt}/${maxRetries} failed:`, error.message);
      if (attempt < maxRetries) {
        await sleepMs(500); // Wait before retrying
      } else {
        throw error;
      }
    }
  }
}

async function postContent(tabId, contentAction) {
  // Verify content script is ready before sending post command
  try {
    await checkContentScriptReady(tabId);
  } catch (error) {
    console.error("[Content Ready] Failed to verify content script readiness:", error.message);
    throw error;
  }

  await new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, contentAction, () => {
      if (!chrome.runtime.lastError) {
        resolve();
        return;
      }

      const errMsg = chrome.runtime.lastError.message || "Unknown sendMessage error";
      const fatalSendError =
        errMsg.includes("Could not establish connection") ||
        errMsg.includes("Receiving end does not exist");

      if (fatalSendError) {
        reject(new Error(errMsg));
      } else {
        // Non-fatal when listener handles request asynchronously without sendResponse.
        console.warn("[Post Content] Non-fatal sendMessage warning:", errMsg);
        resolve();
      }
    });
  });
}

// TAB RETRY LOGIC: Retry tab creation with exponential backoff
async function createTabWithRetry(url, maxRetries = 3, initialDelayMs = 2000) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Tab Creation] Attempt ${attempt}/${maxRetries} for ${url}`);
      const tab = await createTab(url);
      return tab;
    } catch (error) {
      lastError = error;
      console.error(`[Tab Creation] Attempt ${attempt} failed:`, error.message);
      
      if (attempt < maxRetries) {
        const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
        console.log(`[Tab Creation] Waiting ${delayMs}ms before retry...`);
        await sleepMs(delayMs);
      }
    }
  }
  throw new Error(`Failed to create tab after ${maxRetries} attempts: ${lastError.message}`);
}

function createTab(url, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let timeoutId = null;
    let listener = null;
    let createdWindowId = null;
    let settled = false;

    const cleanup = () => {
      if (listener) {
        chrome.tabs.onUpdated.removeListener(listener);
        listener = null;
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const settleResolve = (tabId) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ id: tabId });
    };

    const settleReject = (error, options = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      const errObj = error instanceof Error ? error : new Error(String(error || "Unknown error"));
      if (options.closeWindow && createdWindowId) {
        chrome.windows.remove(createdWindowId, () => reject(errObj));
        return;
      }
      reject(errObj);
    };

    const handleCreatedWindow = (newWindow) => {
      if (chrome.runtime.lastError) {
        return settleReject(new Error(chrome.runtime.lastError.message));
      }

      const tabId = newWindow?.tabs?.[0]?.id;
      createdWindowId = newWindow?.id;

      if (!tabId) {
        return settleReject(new Error("Failed to get tab id from newly created window"), {
          closeWindow: true,
        });
      }

      listener = (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId || !changeInfo || changeInfo.status !== "complete") {
          return;
        }

        chrome.windows.get(createdWindowId, {}, (win) => {
          if (chrome.runtime.lastError || !win) {
            return settleReject(new Error("Window not found or already closed."));
          }

          chrome.windows.update(
            createdWindowId,
            {
              width: 600,
              height: 500,
              top: 100,
              left: 100,
              focused: true,
            },
            () => settleResolve(tabId)
          );
        });
      };

      chrome.tabs.onUpdated.addListener(listener);

      timeoutId = setTimeout(() => {
        settleReject(new Error("Timed out waiting for tab to load"), { closeWindow: true });
      }, timeoutMs);
    };

    try {
      chrome.system.display.getInfo((displayInfo) => {
        const primaryDisplay = Array.isArray(displayInfo)
          ? displayInfo.find((display) => display.isPrimary)
          : null;
        const leftPosition = 0;
        const topPosition =
          (primaryDisplay && primaryDisplay.bounds && primaryDisplay.bounds.height - 200) || 100;

        chrome.windows.create(
          {
            url: url,
            type: "popup",
            left: leftPosition,
            top: topPosition,
            width: 300,
            height: 300,
            focused: true,
          },
          handleCreatedWindow
        );
      });
    } catch (err) {
      settleReject(err);
    }
  });
}

async function handleStopRequest() {
  //let activeIndex = null;
  updatePostingStatus(`Posting stopped. Summary...`);
  updatePostingProgress("done");

  state.remainingGroups = state.groupLinks.slice(state.postsCompleted.length);
  state.remainingGroups.forEach((groupLink) => {
    state.postsCompleted.push({ link: groupLink, response: "failed" });
  });

  chrome.storage.local.set({
    postsCompleted: state.postsCompleted,
    showModal: true,
    modalHiddenByUser: false,
    isPostingInProgress: "done",
  }, () => {
    if (chrome.runtime.lastError) {
      console.error("Storage error (handleStopRequest):", chrome.runtime.lastError);
    }
  });
  
  // IMPORTANT:
  // Do NOT clear guard flags here.
  // Keep `isStopping`/`isCurrentlyPosting` until the active posting loop exits
  // (in POST_PAYLOAD finally). This prevents a second campaign from starting
  // while the first one is still unwinding.
  isStopping = true;
  await persistState();
  trackMixpanel("posting_session_stopped", {
    completed_count: Array.isArray(state.postsCompleted) ? state.postsCompleted.length : 0,
  });
  console.log("[Stop] Stop requested; waiting for active posting loop to exit");

  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, { action: "removeOverlay" }, () => {
        if (chrome.runtime.lastError) {
          // Silently ignore - tab might not have content script
        }
      });
    }
  });
}

function finalizePosting(postsCompleted) {
  // Persist summary-related state explicitly so popup can always show results.
  chrome.storage.local.set({
    postsCompleted: postsCompleted,
    showModal: true,
    modalHiddenByUser: false,
    isPostingInProgress: "done",
  }, () => {
    if (chrome.runtime.lastError) {
      console.error("Storage error (finalizePosting):", chrome.runtime.lastError);
    }
  });
  updatePostingStatus(`Posting completed successfully.`);
  updatePostingProgress("done");
  const summary = Array.isArray(postsCompleted)
    ? postsCompleted.reduce(
        (acc, entry) => {
          acc.total += 1;
          if (entry?.response === "successful") acc.successful += 1;
          else if (entry?.response === "cancelled") acc.cancelled += 1;
          else acc.failed += 1;
          if (entry?.skipped) acc.skipped += 1;
          return acc;
        },
        { total: 0, successful: 0, failed: 0, skipped: 0, cancelled: 0 }
      )
    : { total: 0, successful: 0, failed: 0, skipped: 0, cancelled: 0 };
  trackMixpanel("posting_session_completed", summary);
  // ── campaign_completed ───────────────────────────────────────────────
  trackMixpanel("campaign_completed", {
    posts_sent: summary.successful,
    posts_failed: summary.failed,
    posts_total: summary.total,
    posts_skipped: summary.skipped,
    posts_cancelled: summary.cancelled,
  });
  trackFirstSuccessfulSessionIfNeeded(postsCompleted);
  // Note: Flag clearing is now handled in finally block of initiatePostToFBAction
  console.log("✅ Posting session completed");
}

async function initiatePostToFBAction(request) {
  try {
    // CRITICAL FIX: Check if campaign still exists in storage before starting
    const campaignId = request.payload.campaignId;
    if (campaignId) {
      const stored = await getDataFromDBCached();
      const campaign = stored?.state?.scheduledPosts?.find(p => p.id === campaignId);
      if (!campaign) {
        console.error("❌ Campaign not found in storage - it was cancelled. Aborting.");
        updatePostingStatus("Campaign was cancelled. Posting aborted.");
        updatePostingProgress("done");
        return;
      }
    }
    
    // FIX: Reset state for new campaign and track it with campaignId
    Object.assign(state, {
      isStopRequested: false,
      postsCompleted: [],
      groupLinks: request.payload.group.urls.slice() || [], // Clone the array
      remainingGroups: [],
    });
    activeCampaignId = campaignId;
    await persistState(); // CRITICAL FIX: Persist immediately after setting activeCampaignId

    updatePostingProgress("started");
    updatePostingStatus(`Start posting`);

    chrome.storage.local.set({
      showModal: true,
      modalHiddenByUser: false,
      isPostingInProgress: "started",
    });
    const { timeInSeconds, group } = request.payload;

    const selectedGroups = group.urls;
    state.groupLinks = group.urls.slice(); // Clone the array
    
    // Store original post text to expand fresh for each group
    console.log("[POST] Original post:", request.payload.post);
    const originalPostText = request.payload.post.text;

    // ── campaign_started ──────────────────────────────────────────────────
    const _campaignStartTime = Date.now();
    const _postType = (Array.isArray(request.payload.post.video_id) && request.payload.post.video_id.length)
      ? "video"
      : (Array.isArray(request.payload.post.images) && request.payload.post.images.length ? "image" : "text");
    trackMixpanel("campaign_started", {
      campaign_id: campaignId || null,
      campaign_name: request.payload.campaignName || null,
      group_count: selectedGroups.length,
      post_type: _postType,
    });

    // goes through the group urls
    let _consecutiveFailures = 0; // tracks consecutive post failures
    for (let i = 0; i < selectedGroups.length; i++) {
      if (state.isStopRequested) {
        break;
      }
      // CRITICAL FIX: Check campaign status before each post
      if (campaignId) {
        const stored = await getDataFromDBCached();
        const campaign = stored?.state?.scheduledPosts?.find(p => p.id === campaignId);
        if (!campaign) {
          console.warn("⚠️ Campaign was cancelled during posting. Stopping.");
          break;
        }
      }
      updatePostingStatus(`Post to group ${i + 1} / ${selectedGroups.length}`);

      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs.length > 0) {
          chrome.tabs.sendMessage(tabs[0].id, { action: "showOverlay" }, () => {
            if (chrome.runtime.lastError) {
              // Silently ignore - tab might not have content script
            }
          });
        }
      });

      const groupLink = selectedGroups[i];
      // Open a new tab for each group link with retry logic
      let tab;
      try {
        tab = await createTabWithRetry(groupLink);
      } catch (error) {
        console.error(`[Campaign] Failed to create tab for ${groupLink}. Skipping this group.`, error);
        state.postsCompleted.push({
          status: "failed",
          groupLink,
          reason: "Tab creation failed after retries",
          timestamp: new Date().toISOString(),
        });
        continue; // Skip this group and move to the next
      }
      let shouldWait = true;
      let contentAction;
      switch (request.action) {
        case "POST_PAYLOAD":
          // CRITICAL FIX: Expand spintax FRESH for each group to get different randomized text
          const expandedPost = expandSpintax(originalPostText);
          console.log(`[POST] Group ${i + 1}: Expanded text:`, expandedPost);
          contentAction = {
            action: "contentPostPost",
            post: {
              ...request.payload.post,
              text: expandedPost,
            },
            background: request.payload.background,
          };
          break;
        default:
          console.error("Unknown action in initiatePostToFBAction:", request.action);
          throw new Error(`Unknown action: ${request.action}`);
      }
      // CRITICAL FIX: Final safety check before actually posting to Facebook
      if (campaignId) {
        const stored = await getDataFromDBCached();
        const campaign = stored?.state?.scheduledPosts?.find(p => p.id === campaignId);
        if (!campaign) {
          console.warn("⚠️ Campaign was cancelled - skipping this post to prevent orphan posts");
          state.postsCompleted.push({
            link: groupLink,
            response: "cancelled"
          });
          await cleanUpAfterPosting(tab.id);
          if (activePostingTabId === tab.id) {
            activePostingTabId = null;
          }
          continue;
        }
      }
      
      // CRITICAL FIX: Clear operationDone BEFORE sending message to content script
      // so we don't accidentally delete the immediate failure response
      let responseHandled = false;
      try {
        console.log("[Posting Loop] Clearing operationDone before sending post...");
        await clearOperationDone();
        await postContent(tab.id, contentAction);
        console.log("[Posting Loop] Post content sent, waiting for response from content script...");
        responseHandled = await handleResponse();
      } catch (error) {
        console.error(`[Posting Loop] Post flow failed for ${groupLink}:`, error);
      }
      console.log("[Posting Loop] Response received:", responseHandled ? "successful" : "failed");
      // ── post_success / post_failed / consecutive_failures ──────────────
      if (responseHandled) {
        trackMixpanel("post_success", {
          group_id: selectedGroups[i],
          post_index: i,
          campaign_id: campaignId || null,
        });
        _consecutiveFailures = 0;
      } else {
        const _postFailReason = state.isStopRequested ? "stopped_by_user" : "post_error";
        trackMixpanel("post_failed", {
          group_id: selectedGroups[i],
          post_index: i,
          campaign_id: campaignId || null,
          reason: _postFailReason,
        });
        captureSentryException(new Error("Post failed"), {
          group_id: selectedGroups[i],
          post_index: i,
          campaign_id: campaignId || null,
          reason: _postFailReason,
        });
        _consecutiveFailures++;
        if (_consecutiveFailures >= 3) {
          trackMixpanel("consecutive_failures", {
            count: _consecutiveFailures,
            campaign_id: campaignId || null,
            last_group: selectedGroups[i],
          });
        }
      }

      state.postsCompleted.push({
        // postIndex: activeIndex || activeIndexProducts,
        link: selectedGroups[i],
        response: responseHandled ? "successful" : "failed",
      });
      // Credits are consumed in handleResponse() through useCredit(email).
      // Keep this flow single-source-of-truth to avoid double deductions.
      await cleanUpAfterPosting(tab.id);
      if (activePostingTabId === tab.id) {
        activePostingTabId = null;
      }
      console.log(`[Posting Loop] ✅ Cleanup complete for post ${i + 1}/${selectedGroups.length}`);
      // if (responseHandled && i + 1 != selectedGroups.length && shouldWait) {
      //   await waitBeforeNextPost(timeInSeconds, i, selectedGroups.length);
      // }
      if (i + 1 < selectedGroups.length && shouldWait) {
        console.log(`[Posting Loop] 🕐 Waiting before next post (${i + 2}/${selectedGroups.length})...`);
        await waitBeforeNextPost(timeInSeconds, i, selectedGroups.length, request.payload.deliveryOptions);
      }
      await sleep(1);
      console.log(`[Posting Loop] 🚀 Moving to next group (${i + 2}/${selectedGroups.length})...`);
    }
    finalizePosting(state.postsCompleted);
  } catch (err) {
    console.error("initiatePostToFBAction error:", err);
    trackMixpanel("campaign_failed", {
      reason: err && err.message ? err.message : String(err),
      campaign_id: activeCampaignId || null,
      posts_completed: state.postsCompleted.length,
    });
    captureSentryException(err, {
      phase: "initiatePostToFBAction",
      campaign_id: activeCampaignId || null,
    });
    // Ensure partial cleanup: mark remaining groups as failed
    state.remainingGroups = state.groupLinks.slice(state.postsCompleted.length);
    state.remainingGroups.forEach((groupLink) => {
      state.postsCompleted.push({ link: groupLink, response: "failed" });
    });
    try {
      chrome.storage.local.set({
        postsCompleted: state.postsCompleted,
        showModal: true,
        modalHiddenByUser: false,
        isPostingInProgress: "done",
      }, () => {
        if (chrome.runtime.lastError) {
          console.error("Storage error (postsCompleted):", chrome.runtime.lastError);
        }
      });
    } catch (e) {
      // ignore storage errors
    }
    updatePostingStatus(`Posting failed: ${err?.message || err}`);
    updatePostingProgress("done");
  }
  // CRITICAL FIX: Removed duplicate cleanup block - cleanup is handled in POST_PAYLOAD handler finally block
}

function runPostLogic(postId) {
  (async () => {
    // CRITICAL FIX: Check if a campaign is already running before starting scheduled post
    if (isCurrentlyPosting || isStopping) {
      console.log("⚠️ runPostLogic blocked: campaign already running or stopping");
      captureSentryMessage("scheduled_campaign_blocked", {
        reason: "already_running",
        campaign_id: postId,
      }, "warning");
      return;
    }

    const userStatus = await getUserStatus();
    const isPremium = userStatus.isPremium;
    const postsRemaining = userStatus.postsRemaining;
    currentIsPremium = !!isPremium;
    currentPostsRemaining = typeof postsRemaining === "number" ? postsRemaining : null;

    const data = await getDataFromDBCached();
    if (isPremium || postsRemaining > 0) {
      if (!!data) {
        if (!!data.state && !!data.state.scheduledPosts) {
          const StoreData = data.state.scheduledPosts;
          const post = StoreData.find((item) => item.id === postId);

          if (post) {
            // CRITICAL FIX: Set state guards BEFORE calling initiatePostToFBAction
            isCurrentlyPosting = true;
            activeCampaignId = postId;
            await persistState();
            
            // Reuse the existing POST_PAYLOAD logic
            const request = {
              action: "POST_PAYLOAD",
              payload: {
                post: post.schedule.postData.post,
                group: post.schedule.postData.group,
                background: post.schedule.postData.background,
                timeInSeconds: parseTime(post.schedule.time),
                campaignId: postId, // CRITICAL FIX: Pass campaign ID so background can track it
              },
            };
            initiatePostToFBAction(request)
              .then(() => {
                trackMixpanel("scheduling_succeeded", {
                  campaign_id: postId,
                  groups_count: post?.schedule?.postData?.group?.urls?.length || 0,
                });
              })
              .catch((err) => {
                console.error("Error during scheduled posting:", err);
                trackMixpanel("scheduling_failed", {
                  campaign_id: postId,
                  reason: err && err.message ? err.message : String(err),
                });
                captureSentryException(err, {
                  phase: "runPostLogic_scheduled",
                  campaign_id: postId,
                });
              })
              .finally(async () => {
                isCurrentlyPosting = false;
                activeCampaignId = null;
                isStopping = false;
                await persistState();
                console.log("Scheduled campaign cleanup complete");
              });
            trackMixpanel("scheduled_campaign_started", {
              campaign_id: postId,
              groups_count: post?.schedule?.postData?.group?.urls?.length || 0,
            });
            trackMixpanel("scheduling_used", {
              campaign_id: postId,
              frequency: post?.schedule?.frequency || "unknown",
              groups_count: post?.schedule?.postData?.group?.urls?.length || 0,
            });
            captureSentryMessage("scheduled_campaign_started", {
              campaign_id: postId,
              groups_count: post?.schedule?.postData?.group?.urls?.length || 0,
            });
            if (!isPremium) {
              const newPostsRemaining = postsRemaining - 1;
              chrome.storage.sync.set({ postsRemaining: newPostsRemaining });
            }
          }
        }
      }
    } else {
      trackTrialExhaustedIfNeeded("run_post_logic");
      trackMixpanel("scheduled_campaign_blocked", {
        reason: "trial_exhausted",
        campaign_id: postId,
      });
      captureSentryMessage("scheduled_campaign_blocked", {
        reason: "trial_exhausted",
        campaign_id: postId,
      }, "warning");
    }
  })();

  // Add your actual post logic here
}

async function getCredits(email) {
  if (!email) return console.log("Please enter an email");

  const data = await fetchCreditsJson(
    `https://server.fbgroupbulkposter.com/credits/${email}`
  );
  chrome.storage.sync.set({ postsRemaining: data.credits });
  return data;
}

async function fetchCreditsJson(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Credits request failed with status ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Credits request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function useCredit(email) {
  if (!email) return console.log("Please enter an email");

  const data = await fetchCreditsJson(
    `https://server.fbgroupbulkposter.com/credits/${email}`,
    {
      method: "POST",
    }
  );
  // Reflect server-authoritative credit value for non-premium users.
  try {
    const premiumStatus = await verifyPremiumStatus(email);
    if (!premiumStatus.isPremium) {
      if (typeof data?.credits === "number") {
        chrome.storage.sync.set({ postsRemaining: Math.max(0, data.credits) });
      } else {
        // Fallback for unexpected server payloads.
        chrome.storage.sync.get(["postsRemaining"], (r) => {
          const current = typeof r?.postsRemaining !== "undefined" ? r.postsRemaining : 6;
          const next = Math.max(0, current - 1);
          chrome.storage.sync.set({ postsRemaining: next });
        });
      }
    }
  } catch (e) {
    console.error("Error verifying premium status in useCredit:", e);
  }

  return data;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "checkPremium") {
    if (request.email) {
      (async () => {
        try {
          const result = await fetchSubscriptionStatus(request.email);
          sendResponse(result); // Send the result back to the caller
        } catch (error) {
          sendResponse({ error: "Failed to check subscription" });
        }
      })();
      return true; // Important: keep the message channel open for async response
    }
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "checkCredits") {
    (async () => {
      try {
        if (!request.email) console.log("No email found ", request.email);
        const subscription = await fetchSubscriptionStatus(request.email);
        const credits = await getCredits(request.email);

        console.log(request, credits, subscription);
        currentIsPremium = !!subscription?.isPremium;
        currentPostsRemaining = typeof credits?.credits === "number" ? credits.credits : null;
        if (!currentIsPremium && typeof currentPostsRemaining === "number" && currentPostsRemaining <= 0) {
          trackTrialExhaustedIfNeeded("check_credits");
          captureSentryMessage("trial_exhausted_blocked", {
            source: "check_credits",
            posts_remaining: currentPostsRemaining,
          }, "warning");
        }
        trackMixpanel("credits_checked", {
          is_premium: currentIsPremium,
          posts_remaining: currentPostsRemaining,
        });

        sendResponse({
          subscription: subscription?.isPremium,
          postsRemaining: credits?.credits,
          subscriptionId: subscription?.subscriptionId,
        });
      } catch (err) {
        console.error("Error in checkCredits handler:", err);
        sendResponse({ error: "Failed to fetch credits or subscription" });
      }
    })();

    // 👇 Tell Chrome to keep the message channel open for the async response
    return true;
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "checkLoginState") {
    const checkCookie = (url, callback) => {
      chrome.cookies.get({ url, name: "firebaseUser" }, async (cookie) => {
        if (cookie) {
          try {
            const userObj = JSON.parse(decodeURIComponent(cookie.value));
            await chrome.storage.sync.set({
              last_loggedin_user: userObj.email,
            });

            await chrome.storage.sync.set({ user: userObj });
            trackMixpanel("user_login_detected", { source: "cookie_check" });

            callback({ loggedIn: true, user: userObj });
          } catch (err) {
            console.error("Error processing cookie", err);
            callback(null);
          }
        } else {
          callback(null); // Try next fallback
        }
      });
    };

    // Check production cookie
    checkCookie("https://auth.fbgroupbulkposter.com/", (result) => {
      if (result) {
        sendResponse(result);
      } else {
        // Fallback to staging/local
        checkCookie(
          "https://clownfish-app-google-auth-v2-nghvc.ondigitalocean.app/",
          (localResult) => {
            if (localResult) {
              sendResponse(localResult);
              chrome.storage.sync.set({ user: localResult.user });
              trackMixpanel("user_login_detected", { source: "fallback_cookie_check" });
            } else {
              chrome.storage.sync.set({ user: {} }, () => {
                trackMixpanel("user_logout_detected", { source: "cookie_check" });
                sendResponse({ loggedIn: false, user: {} });
              });
            }
          }
        );
      }
    });

    return true; // ✅ Keeps message channel open for async sendResponse
  }

  if (request.action === "handleLogout") {
    const removeCookie = (url, cb) => {
      chrome.cookies.remove({ url, name: "firebaseUser" }, cb);
    };

    removeCookie("https://auth.fbgroupbulkposter.com/", () => {
      removeCookie(
        "https://clownfish-app-google-auth-v2-nghvc.ondigitalocean.app/",
        () => {
          chrome.storage.sync.set({ user: {} }, () => {
            chrome.runtime.sendMessage({ action: "highlightContentLogout" });
          });
        }
      );
    });
    chrome.storage.sync.remove(["postsRemaining", "isPremium", "user"], () => {
      console.log("postsRemaining and isPremium removed from storage.");
    });
    trackMixpanel("user_logout_detected", { source: "manual_logout" });

    // CRITICAL FIX: Clear cache and triggered snapshots on logout
    dbCache = null;
    dbCacheTime = 0;
    triggeredSet.clear();
    console.log("[Logout] Cleared dbCache and triggeredSet");

    // ❌ No sendResponse used, so no need to return true
  }

  if (request.action === "isPostInPRogress") {
    chrome.storage.local.get(["showModal"], (result) => {
      sendResponse({ working: result.showModal, user: {} });
    });
    return true; // ✅ async sendResponse
  }

  if (request.action === "resetPostingState") {
    (async () => {
      console.log("✅ Reset request received. Clearing posting flags...");
      isCurrentlyPosting = false;
      isStopping = false;
      activeCampaignId = null;
      await persistState(); // CRITICAL FIX: Await to ensure state is persisted
      console.log("✅ Posting state reset complete");
      sendResponse({ success: true, message: "Posting state cleared" });
    })();
    return true; // Keep channel open for async response
  }

  if (request.action === "DELETE_CAMPAIGN") {
    // CAMPAIGN CLEANUP: Delete a specific campaign from storage
    (async () => {
      const campaignId = request.campaignId;
      if (!campaignId) {
        sendResponse({ success: false, message: "Campaign ID required" });
        return;
      }
      
      try {
        const data = await getDataFromDB();
        if (data && data.state && data.state.scheduledPosts) {
          const filtered = data.state.scheduledPosts.filter(p => p.id !== campaignId);
          const updated = { ...data, state: { ...data.state, scheduledPosts: filtered } };
          
          // Save back to storage
          chrome.storage.local.set({ state: updated.state }, () => {
            console.log(`[Campaign Cleanup] Deleted campaign ${campaignId}`);
            trackMixpanel("campaign_deleted", { campaign_id: campaignId });
            sendResponse({ success: true, message: `Campaign ${campaignId} deleted` });
          });
        } else {
          sendResponse({ success: false, message: "No campaigns found" });
        }
      } catch (error) {
        console.error("[Campaign Cleanup] Error deleting campaign:", error);
        sendResponse({ success: false, message: error.message });
      }
    })();
    return true; // CRITICAL FIX: Keep message channel open for async sendResponse
  }

  if (request.action === "POST_PAYLOAD") {
    const launchPostPayloadCampaign = (postRequest, source = "manual") => {
      const campaignId = postRequest?.payload?.campaignId;
      isCurrentlyPosting = true;
      isStopping = false;
      state.isStopRequested = false;
      activeCampaignId = campaignId;

      console.log(
        `✅ POST_PAYLOAD accepted (${source}): starting post operation for campaign`,
        campaignId
      );
      trackMixpanel("posting_session_started", {
        campaign_id: campaignId || null,
        groups_count: postRequest?.payload?.group?.urls?.length || 0,
        is_scheduled: !!campaignId,
        source,
      });
      // ── delivery_pacing_used ─────────────────────────────────────────
      if (postRequest && postRequest.payload && postRequest.payload.deliveryOptions
          && postRequest.payload.deliveryOptions.isCustom) {
        trackMixpanel("delivery_pacing_used", {
          campaign_id: campaignId || null,
          mode: postRequest.payload.deliveryOptions.mode || "unknown",
          batch_size: postRequest.payload.deliveryOptions.batchSize || null,
          wait_minutes: postRequest.payload.deliveryOptions.waitMinutes || 0,
          randomize: !!postRequest.payload.deliveryOptions.randomizeWait,
        });
        trackMixpanel("feature_used", { feature_name: "delivery_pacing" });
      }

      (async () => {
        await persistState();
        initiatePostToFBAction(postRequest)
          .catch((err) => console.error("Error during posting:", err))
          .finally(async () => {
            isCurrentlyPosting = false;
            activeCampaignId = null;
            isStopping = false;
            state.isStopRequested = false;
            await persistState();
            console.log("Campaign cleanup complete: cleared all posting flags");

            if (pendingPostPayloadRequest) {
              const queued = pendingPostPayloadRequest;
              pendingPostPayloadRequest = null;
              console.log("▶️ Starting queued POST_PAYLOAD after previous campaign cleanup");
              launchPostPayloadCampaign(queued, "queued_after_stop");
            }
          });
      })();
    };

    console.log(
      "POST_PAYLOAD received. Current state - isCurrentlyPosting:",
      isCurrentlyPosting,
      "isStopping:",
      isStopping
    );

    if (isCurrentlyPosting || isStopping) {
      if (state.isStopRequested || isStopping) {
        pendingPostPayloadRequest = request;
        console.log("⏳ POST_PAYLOAD queued: current campaign is stopping");
        sendResponse({
          success: true,
          queued: true,
          message:
            "Current campaign is stopping. New campaign queued and will start automatically.",
        });
        return true;
      }

      console.log("⚠️ POST_PAYLOAD rejected: campaign already running");
      trackMixpanel("posting_session_start_rejected", {
        reason: "already_running",
        active_campaign_id: activeCampaignId || null,
      });
      sendResponse({
        success: false,
        message:
          "A campaign is already running. Please wait for it to finish or use the Stop button to cancel.",
      });
      return;
    }

    launchPostPayloadCampaign(request, "manual");
    sendResponse({ success: true, started: true });
    return true; // Keep channel open
  }

  if (request.action === "stopPosting") {
    // Wrap in async IIFE to properly handle persistState()
    (async () => {
      if (!isCurrentlyPosting && !activeCampaignId) {
        // No active campaign: ensure state is clean and return quickly.
        state.isStopRequested = false;
        isStopping = false;
        await persistState();
        sendResponse({ success: true, message: "No active posting session" });
        return;
      }

      // CRITICAL FIX: Set stopping flag first to prevent race conditions
      isStopping = true;
      state.isStopRequested = true;
      await persistState(); // CRITICAL FIX: Persist immediately after setting isStopping

      // Fast-stop currently active posting tab to reduce stop latency.
      if (activePostingTabId) {
        chrome.tabs.remove(activePostingTabId, () => {
          // Ignore tab-close errors (already closed, invalid id, etc.)
        });
        activePostingTabId = null;
      }
      await handleStopRequest();
      console.log("✅ Posting stopped by user, cleanup complete");
      trackMixpanel("posting_stop_requested");
      sendResponse({ success: true });
    })();
    return true; // Keep channel open for async response
  }

  // ── upgrade_clicked: fired by popup when user clicks upgrade/buy ─────
  if (request.action === "upgrade_clicked") {
    trackMixpanel("upgrade_clicked", {
      source: request.source || "unknown",
      email_hash: currentEmailHash || "anonymous",
    });
    sendResponse({ success: true });
    return true;
  }

  if (request.action === "get_user_info") {
    chrome.storage.sync.get(["user"], (data) => {
      if (chrome.runtime.lastError) {
        console.error("Storage error (get_user_info):", chrome.runtime.lastError);
        sendResponse({ success: false, user: {} });
        return;
      }
      const user = data.user || {};
      const userInfo = {
        name: user.name || null,
        email: user.email || null,
        id: user.uid || user.id || null,
      };
      sendResponse({ success: true, user: userInfo });
    });
    return true; // ✅ async sendResponse
  }
});

function getMessageHTML(message) {
  // Full class string converted to selector
  const classSelector =
    "html-div xdj266r x14z9mp xat24cr x1lziwak xexx8yu xyri2b x18d9i69 x1c1uobl x78zum5 x1n2onr6 xh8yej3";
  const el = document.querySelector(`div.${classSelector.replace(/ /g, ".")}`);
  const htmlContent = el ? el.innerHTML : message.payload.html;
  return JSON.stringify({ html: htmlContent });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "callAi") {
    (async () => {
      try {
        const resp = await fetch(
          "https://server.fbgroupbulkposter.com/dom-analyze",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: getMessageHTML(message),
          }
        );

        const rawText = await resp.text();

        if (!resp.ok) {
          sendResponse({ error: `Server error ${resp.status}` });
        } else {
          try {
            const data = JSON.parse(rawText);
            sendResponse({ selector: data.selector });
          } catch (parseErr) {
            sendResponse({ error: "Invalid JSON from server" });
          }
        }
      } catch (err) {
        sendResponse({ error: "Fetch failed" });
      }
    })(); // 👈 Call the async IIFE

    return true; // 👈 MUST be returned synchronously from listener
  }
});

function queryTabsAsync(queryInfo) {
  return new Promise((resolve) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      if (chrome.runtime.lastError) {
        resolve([]);
        return;
      }
      resolve(Array.isArray(tabs) ? tabs : []);
    });
  });
}

function sendTabMessageAsync(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError?.message || "";
      if (err) {
        reject(new Error(err));
        return;
      }
      resolve(response);
    });
  });
}

function executeScriptAsync(details) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(details, (results) => {
      const err = chrome.runtime.lastError?.message || "";
      if (err) {
        reject(new Error(err));
        return;
      }
      resolve(results || []);
    });
  });
}

function focusTabAsync(tab) {
  return new Promise((resolve) => {
    if (!tab?.id) {
      resolve();
      return;
    }
    chrome.tabs.update(tab.id, { active: true }, () => {
      chrome.windows.update(tab.windowId, { focused: true }, () => resolve());
    });
  });
}

function isUsablePickerTab(tab) {
  if (!tab?.id || !tab.url) return false;
  try {
    const parsed = new URL(tab.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = (parsed.hostname || "").toLowerCase();
    if (
      host === "chromewebstore.google.com" ||
      host === "chrome.google.com" ||
      host.endsWith(".chrome.google.com")
    ) {
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function isFacebookTab(tab) {
  try {
    const host = new URL(tab?.url || "").hostname.toLowerCase();
    return host === "facebook.com" || host.endsWith(".facebook.com");
  } catch (_) {
    return false;
  }
}

function isIgnorableTabError(message) {
  return (
    message.includes("Cannot access contents of the page") ||
    message.includes("No tab with id") ||
    message.includes("The tab was closed")
  );
}

async function ensureContentScriptLoadedForTab(tabId) {
  let markerResults;
  try {
    markerResults = await executeScriptAsync({
      target: { tabId },
      func: () => !!window.__myExtensionContentLoaded,
    });
  } catch (err) {
    throw err;
  }

  const alreadyLoaded = !!(markerResults && markerResults[0]?.result);
  if (alreadyLoaded) return;

  await executeScriptAsync({
    target: { tabId },
    files: ["content.js"],
  });
}

async function findPickerCandidateTabs() {
  const [activeTabs, allTabs] = await Promise.all([
    queryTabsAsync({ active: true, currentWindow: true }),
    queryTabsAsync({}),
  ]);

  const activeTab = activeTabs[0];
  const selected = [];
  const seen = new Set();

  const addIfCandidate = (tab) => {
    if (!tab || seen.has(tab.id) || !isUsablePickerTab(tab)) return;
    seen.add(tab.id);
    selected.push(tab);
  };

  addIfCandidate(activeTab);
  allTabs.filter(isFacebookTab).forEach(addIfCandidate);
  allTabs.forEach(addIfCandidate);

  return selected;
}

async function tryShowPickerOnTab(tab) {
  await ensureContentScriptLoadedForTab(tab.id);
  await focusTabAsync(tab);
  return sendTabMessageAsync(tab.id, { action: "show_select_files_content" });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== "show_select_files") return;

  (async () => {
    try {
      const candidates = await findPickerCandidateTabs();
      if (!candidates.length) {
        sendResponse({
          error:
            "No supported tab found. Open any regular website tab (http/https), then try adding media again.",
        });
        return;
      }

      let lastError = null;
      for (const tab of candidates) {
        try {
          const response = await tryShowPickerOnTab(tab);
          sendResponse(response || { selected: false });
          return;
        } catch (err) {
          lastError = err;
          const message = String(err?.message || err || "");
          if (!isIgnorableTabError(message)) {
            console.warn("[show_select_files] Failed on tab", tab.id, message);
          }
        }
      }

      sendResponse({
        error:
          lastError?.message ||
          "Could not open media picker in any tab. Open facebook.com in a regular tab and retry.",
      });
    } catch (err) {
      sendResponse({
        error: String(err?.message || err || "Failed to open media picker"),
      });
    }
  })();

  return true; // Keep message channel open for async response
});

const fileChunksMap = new Map(); // temp in-memory storage for chunks

// IndexedDB setup
function getDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("MediaDB", 1);

    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("media")) {
        db.createObjectStore("media", { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// background.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, fileId } = message;
  if (action === "fileChunk") {
    const { index, totalChunks, name, type, size, data: base64 } = message;

    if (!fileChunksMap.has(fileId)) {
      fileChunksMap.set(fileId, {
        chunks: Array(totalChunks),
        count: 0,
        total: totalChunks,
        meta: { name, type, size, id: fileId },
      });
    }
    const fileData = fileChunksMap.get(fileId);

    const binary = atob(base64);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      arr[i] = binary.charCodeAt(i);
    }

    fileData.chunks[index] = arr;
    fileData.count++;

    if (fileData.count === fileData.total) {
      const { chunks, meta } = fileData;
      const fullBlob = new File(chunks, meta.name, {
        type: meta.type,
        lastModified: Date.now(),
      });

      saveFileToIndexedDB(meta.id, fullBlob);
      fileChunksMap.delete(fileId);
    }

    sendResponse(); // ✅ resolves the promise in content script
    return true; // ✅ keep message channel open for async
  }

  if (action === "clearCurrentDB") {
    if (message.fileId) {
      deleteFileFromIndexedDB(message.fileId);
    } else {
      // indexedDB.databases().then(dbs => dbs.forEach(db => indexedDB.deleteDatabase(db.name)));
    }
    sendResponse();
    return true;
  }
});

async function saveFileToIndexedDB(id, fileObj) {
  const db = await getDB();
  const tx = db.transaction("media", "readwrite");
  const store = tx.objectStore("media");

  const entry = { key: id, value: { blob: fileObj, type: fileObj.type } };
  store.put(entry);
}

async function deleteFileFromIndexedDB(id) {
  const db = await getDB();
  const tx = db.transaction("media", "readwrite");
  const store = tx.objectStore("media");
  store.delete(id);
}

function injectContentScriptToAllTabs() {
  // IMPORTANT:
  // `content.js` is already declared in `manifest.json` as a content_script, so Chrome
  // injects it automatically. Manually re-injecting this file can cause:
  //   "Uncaught SyntaxError: Identifier 'config' has already been declared"
  // and noisy host-permission errors on restricted pages.
  return;
}

function initializeDB() {
  const request = indexedDB.open("permanentStore", 1);

  request.onupgradeneeded = (event) => {
    const db = event.target.result;

    if (!db.objectStoreNames.contains("snapshots")) {
      db.createObjectStore("snapshots", { keyPath: "id" }); // or use autoIncrement: true if needed
    }
  };

  request.onsuccess = () => {
    request.result.close();
  };

  // request.onerror = (event) => {
  //   console.error("❌ Error initializing IndexedDB:", event.target.error);
  // };
}

chrome.runtime.onInstalled.addListener(() => {
  initializeDB();
});

chrome.runtime.onStartup.addListener(() => {
  // No manual content-script injection on startup.
});

// Disabled by default: content scripts are manifest-injected.
// Keep as an emergency switch only; when enabled, it runs narrowly on facebook.com tabs.
const ENABLE_TAB_WATCHDOG_INJECTION = false;
const TAB_WATCHDOG_INTERVAL_MS = 30000;

function isInjectableFacebookTabUrl(url) {
  try {
    if (!url) return false;
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = (parsed.hostname || "").toLowerCase();
    return host === "facebook.com" || host.endsWith(".facebook.com");
  } catch (e) {
    return false;
  }
}

function checkAndInjectContentScript(tab) {
  if (!tab?.id || !isInjectableFacebookTabUrl(tab.url)) return;
  chrome.scripting.executeScript(
    {
      target: { tabId: tab.id },
      func: () => {
        return !!window.__myExtensionContentLoaded;
      },
    },
    (results) => {
      const checkErr = chrome.runtime.lastError?.message || "";
      if (checkErr) {
        if (
          checkErr.includes("Cannot access contents of the page") ||
          checkErr.includes("No tab with id") ||
          checkErr.includes("The tab was closed")
        ) {
          return;
        }
        console.warn("[watchdog] marker check failed:", checkErr);
        return;
      }

      if (!results || !results[0] || !results[0].result) {
        chrome.scripting.executeScript(
          {
            target: { tabId: tab.id },
            files: ["content.js"],
          },
          () => {
            const injectErr = chrome.runtime.lastError?.message || "";
            if (!injectErr) return;
            if (
              injectErr.includes("Cannot access contents of the page") ||
              injectErr.includes("No tab with id") ||
              injectErr.includes("The tab was closed")
            ) {
              return;
            }
            console.warn("[watchdog] inject failed:", injectErr);
          }
        );
      }
    }
  );
}

function watchTabsPeriodically() {
  if (!ENABLE_TAB_WATCHDOG_INJECTION) return;
  setInterval(() => {
    chrome.tabs.query(
      { url: ["*://facebook.com/*", "*://*.facebook.com/*"] },
      (tabs) => {
        if (chrome.runtime.lastError) return;
        for (const tab of tabs) {
          checkAndInjectContentScript(tab);
        }
      }
    );
  }, TAB_WATCHDOG_INTERVAL_MS);
}

// Disabled: content scripts are injected via manifest. Periodic re-injection risks
// duplicate declarations and unnecessary errors on restricted pages.
// watchTabsPeriodically();

//Handing versions
// background.js
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    // First-ever install — fire once
    trackMixpanel("extension_installed", {
      version: chrome.runtime.getManifest().version,
    });
  }
  if (details.reason === "update") {
    const newVer = chrome.runtime.getManifest().version;
    chrome.storage.local.set({ updatedVersion: newVer }, () => {
      if (chrome.runtime.lastError) {
        console.error("Storage error (updatedVersion):", chrome.runtime.lastError);
      }
    });
  }
});

// STARTUP RECOVERY: Clear stale posting flags on browser restart
// AUTO-CLEANUP: Delete campaigns older than 30 days on startup
async function autoCleanupOldCampaigns() {
  try {
    const data = await getDataFromDB();
    if (!data || !data.state || !data.state.scheduledPosts) return;
    
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    
    const filtered = data.state.scheduledPosts.filter(campaign => {
      const createdTime = campaign.createdAt ? new Date(campaign.createdAt).getTime() : now;
      const age = now - createdTime;
      if (age > thirtyDaysMs) {
        console.log(`[Auto-Cleanup] Deleting campaign ${campaign.id} (age: ${Math.floor(age / (24 * 60 * 60 * 1000))} days)`);
        return false; // Exclude from filtered list
      }
      return true; // Keep campaign
    });
    
    if (filtered.length < data.state.scheduledPosts.length) {
      const updated = { ...data, state: { ...data.state, scheduledPosts: filtered } };
      chrome.storage.local.set({ state: updated.state }, () => {
        console.log(`[Auto-Cleanup] Removed ${data.state.scheduledPosts.length - filtered.length} old campaigns`);
      });
      // Also clear cache since data changed
      dbCache = null;
      dbCacheTime = 0;
    }
  } catch (error) {
    console.error("[Auto-Cleanup] Error during cleanup:", error);
  }
}

chrome.runtime.onStartup.addListener(async () => {
  console.log("[Startup] Browser restarted. Checking for stale posting flags...");
  isCurrentlyPosting = false;
  activeCampaignId = null;
  isStopping = false;
  await persistState();
  
  // Run auto-cleanup of old campaigns
  await autoCleanupOldCampaigns();
  
  console.log("[Startup] Stale flags cleared");
});

chrome.runtime.requestUpdateCheck((status) => {
  if (status === "update_available") {
    showUpdateMessage();
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  const action = message?.action;
  if (!action || MIXPANEL_IGNORED_ACTIONS.has(action)) return;
  trackMixpanel("feature_action", {
    action,
    from_tab: !!sender?.tab,
    has_payload: !!message?.payload,
  });
});

function showUpdateMessage() {
  // Service workers do not have access to DOM APIs.
  // Keep this as a no-op log to avoid runtime exceptions.
  console.log("[Update] update_available (no DOM in service worker) - skipping banner");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "snapshot_log" && message.payload) {
    const snapshot = message.payload;

    // Optional: Upload to server
    fetch("https://server.fbgroupbulkposter.com/api/snapshots", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(snapshot),
    });
  }
});

const fetchSubscriptionStatus = async (email, { throwOnError = false } = {}) => {
  try {
    const response = await fetch(
      `https://auth.fbgroupbulkposter.com/api/subscription?email=${encodeURIComponent(email)}`
    );
    const data = await response.json();

    if (data.status === "success" && data.subscription) {
      const isPremium = data.subscription.status === "active";
      // Store for caching purposes only - NEVER trust this for security checks
      chrome.storage.sync.set({
        isPremium,
      });
      chrome.storage.sync.set({
        subscriptionId: data.subscription.subscription_id,
      });
      rememberVerifiedPremiumStatus(email, isPremium);
      return {
        isPremium,
        subscriptionId: data.subscription.subscription_id,
      };
    } else {
      chrome.storage.sync.set({ isPremium: false });
      chrome.storage.sync.set({
        subscriptionId: null,
      });
      rememberVerifiedPremiumStatus(email, false);
      return { isPremium: false, subscriptionId: null };
    }
  } catch (error) {
    console.error("Security: Error fetching subscription status from server:", error);
    if (throwOnError) {
      throw error;
    }
    // SECURITY FIX: On error, assume NOT premium to prevent unauthorized access
    return { isPremium: false, subscriptionId: null };
  }
};

// SECURITY FIX: Always verify premium status with server, never trust client-side storage
// This prevents users from modifying isPremium in DevTools to unlock premium features
const verifyPremiumStatus = async (email, { throwOnError = false } = {}) => {
  if (!email) {
    return { isPremium: false, subscriptionId: null };
  }
  try {
    const result = await fetchSubscriptionStatus(email, { throwOnError });
    return result;
  } catch (error) {
    console.error("Security: Failed to verify premium status:", error);
    if (throwOnError) {
      throw error;
    }
    // SECURITY: Default to non-premium if verification fails
    return { isPremium: false, subscriptionId: null };
  }
};

async function shouldConsumeCreditAfterSuccess(email) {
  const cachedPremiumStatus = getFreshVerifiedPremiumStatus(email);
  if (cachedPremiumStatus === true) {
    return false;
  }
  if (cachedPremiumStatus === false) {
    return true;
  }

  try {
    const premiumStatus = await verifyPremiumStatus(email, {
      throwOnError: true,
    });
    return !premiumStatus.isPremium;
  } catch (error) {
    console.warn(
      "[Credits] Premium verification unavailable before credit decision; defaulting to consume credit:",
      error?.message || error
    );
    return true;
  }
}

//Scheduler
function shouldTrigger(schedule) {
  const now = new Date();
  const startDate = new Date(schedule.startDate);
  const [hour, minute] = schedule.time.split(":").map(Number);

  // Scheduled time on today's date
  const scheduledTime = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hour,
    minute
  );

  if (schedule.frequency === "once") {
    const scheduledOnce = new Date(startDate);
    scheduledOnce.setHours(hour, minute, 0, 0);
    return now >= scheduledOnce;
  }

  if (schedule.frequency === "daily") {
    return now >= scheduledTime;
  }

  if (schedule.frequency === "weekly") {
    const today = now
      .toLocaleString("en-US", { weekday: "long" })
      .toLowerCase();
    const weekDays = schedule.recurring?.weekDays || [];
    return weekDays.includes(today) && now >= scheduledTime;
  }

  if (schedule.frequency === "monthly") {
    const todayDate = now.getDate();
    const monthDays = schedule.recurring?.monthDays || [];
    return monthDays.includes(todayDate) && now >= scheduledTime;
  }

  return false;
}

//Scheduler
function generateUniqueId() {
  return `snap_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
}

function openDB(name, version, onUpgradeNeeded) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);

    request.onupgradeneeded = (e) => {
      const db = request.result;
      onUpgradeNeeded?.(db);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readAllFromStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function writeToStore(db, storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const request = store.put(value);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function clearStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function copyAndClearMediaDBToPermanentStore(metadata) {
  const TEMP_DB_NAME = "MediaDB";
  const PERMANENT_DB_NAME = "permanentStore";
  const TEMP_STORE_NAME = "media";
  const SNAPSHOT_STORE_NAME = "snapshots";

  try {
    const tempDb = await openDB(TEMP_DB_NAME, 1, (db) => {
      if (!db.objectStoreNames.contains(TEMP_STORE_NAME)) {
        db.createObjectStore(TEMP_STORE_NAME, { keyPath: "key" });
      }
    });

    const mediaItems = await readAllFromStore(tempDb, TEMP_STORE_NAME);

    // if (mediaItems.length === 0) {
    //   console.warn("⚠️ No media to archive. Skipping.");
    //   tempDb.close();
    //   return;
    // }

    const permanentDb = await openDB(PERMANENT_DB_NAME, 1, (db) => {
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE_NAME)) {
        db.createObjectStore(SNAPSHOT_STORE_NAME, { keyPath: "id" });
      }
    });

    const snapshotId = generateUniqueId();

    const snapshotEntry = {
      id: snapshotId,
      createdAt: new Date().toISOString(),
      metadata,
      items: mediaItems || [],
    };

    await writeToStore(permanentDb, SNAPSHOT_STORE_NAME, snapshotEntry);

    await clearStore(tempDb, TEMP_STORE_NAME);
    tempDb.close();
    permanentDb.close();
  } catch (error) {
    // console.error("❌ [Error] Failed during archive process:", error);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "schedulePost") {
    copyAndClearMediaDBToPermanentStore(msg.payload || {});
    sendResponse({ success: true });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "getScheduledPosts") {
    (async () => {
      try {
        const db = await openDB("permanentStore", 1, (db) => {
          if (!db.objectStoreNames.contains("snapshots")) {
            db.createObjectStore("snapshots", { keyPath: "id" });
          }
        });

        const snapshots = await readAllFromStore(db, "snapshots");

        sendResponse({ success: true, snapshots }); // ✅ resolve properly
        db.close();
      } catch (err) {
        sendResponse({ success: false, error: err.message }); // ✅ fail properly
      }
    })();

    return true; // ✅ MUST return true for async
  }
});

let isScheduleCronRunning = false;
async function startScheduleCronJob() {
  setInterval(async () => {
    if (isScheduleCronRunning) {
      return;
    }

    isScheduleCronRunning = true;
    let db = null;
    try {
      db = await openDB("permanentStore", 1);
      const tx = db.transaction("snapshots", "readonly");
      const store = tx.objectStore("snapshots");
      const snapshots = await new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error("Failed to read snapshots"));
      });

      const now = new Date();

      // CRITICAL FIX: Use for...of instead of forEach to properly await async operations
      for (const snapshot of snapshots) {
        const { id, metadata, items = [] } = snapshot;
        // CRITICAL FIX: Skip snapshots that already completed successfully
        if (!metadata?.schedule || triggeredSet.has(id) || snapshot.status === "success") continue;
        if (isCurrentlyPosting || isStopping) continue;

        const { schedule, content } = metadata;
        const { frequency, startDate, time, recurring } = schedule;
        const [hours, minutes] = time.split(":").map(Number);

        const scheduled = new Date(startDate);
        scheduled.setHours(hours, minutes, 0, 0);

        const todayAtTime = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          hours,
          minutes,
          0,
          0
        );

        let shouldTrigger = false;

        // Map day index to day ID used in CompactScheduleModal
        const getDayId = (dayIndex) => {
          // dayIndex 0 = Sunday (matching JS Date.getDay())
          return dayIndex;
        };

        switch (frequency) {
          case "once":
            shouldTrigger = isWithinNextHour(scheduled, now);
            break;

          case "daily":
            shouldTrigger = isWithinNextHour(todayAtTime, now);
            break;

          case "weekly":
            const currentDayId = getDayId(now.getDay());
            if (recurring?.weekDays?.includes(currentDayId)) {
              shouldTrigger = isWithinNextHour(todayAtTime, now);
            }
            break;

          case "monthly":
            if (recurring?.monthDays?.includes(now.getDate())) {
              shouldTrigger = isWithinNextHour(todayAtTime, now);
            }
            break;

          default:
            console.error("Unknown scheduling frequency:", frequency);
            shouldTrigger = false;
            break;
        }

        if (shouldTrigger) {
          console.log("⏰ TRIGGERED:", id);
          console.log("📄 Content:", content);
          console.log("📎 Media Items:", items);
          trackMixpanel("schedule_triggered", {
            snapshot_id: id,
            frequency,
          });
          captureSentryMessage("schedule_triggered", {
            snapshot_id: id,
            frequency,
          });
          triggeredSet.add(id);
          // CRITICAL FIX: Persist triggeredSet immediately to survive extension reload
          await persistState();
          await triggerPostFromSnapshot(metadata, items, id);
        }
      }
    } catch (error) {
      console.error("❌ Cron job error:", error);
      trackMixpanel("scheduling_failed", {
        source: "cron_iteration",
        reason: error && error.message ? error.message : String(error),
      });
      captureSentryException(error, { phase: "schedule_cron_iteration" });
    } finally {
      if (db) {
        try {
          db.close();
        } catch (e) {
          // Ignore close errors
        }
      }
      isScheduleCronRunning = false;
    }
  }, 30000); // Every 30 seconds (increased from 5s to reduce battery drain)
}

// Delete if done
// function markSnapshotAsDone(snapshotId) {
//   const request = indexedDB.open("permanentStore", 1);
//   request.onsuccess = () => {
//     const db = request.result;
//     const tx = db.transaction("snapshots", "readwrite");
//     const store = tx.objectStore("snapshots");

//     const deleteReq = store.delete(snapshotId);
//     deleteReq.onsuccess = () => {
//       triggeredSet.delete(snapshotId);
//       console.log(
//         `🗑️ Snapshot '${snapshotId}' removed from DB (Marked as Done).`
//       );
//     };
//     deleteReq.onerror = () => {
//       console.error(`❌ Failed to remove '${snapshotId}':`, deleteReq.error);
//     };
//   };
//   request.onerror = () => {
//     console.error("❌ Failed to open DB in markSnapshotAsDone:", request.error);
//   };
// }

// ✅ Manual/External trigger to mark as done
function markSnapshotAsDone(snapshotId) {
  const request = indexedDB.open("permanentStore", 1);

  request.onsuccess = () => {
    const db = request.result;
    const tx = db.transaction("snapshots", "readwrite");
    const store = tx.objectStore("snapshots");

    const getReq = store.get(snapshotId);

    getReq.onsuccess = () => {
      const snapshot = getReq.result;

      if (!snapshot) {
        console.warn(`⚠️ No snapshot found with ID: ${snapshotId}`);
        return;
      }

      // Update status
      snapshot.status = "success";

      const putReq = store.put(snapshot);

      putReq.onsuccess = () => {
        triggeredSet.delete(snapshotId);
      };

      putReq.onerror = () => {
        console.error(
          `❌ Failed to update snapshot '${snapshotId}':`,
          putReq.error
        );
      };
    };

    getReq.onerror = () => {
      console.error(`❌ Failed to get snapshot '${snapshotId}':`, getReq.error);
    };
  };

  request.onerror = () => {
    console.error("❌ Failed to open DB in markSnapshotAsDone:", request.error);
  };
}

function isWithinNextHour(scheduledTime, now) {
  const diff = now.getTime() - scheduledTime.getTime();
  return diff >= 0 && diff <= 60 * 120 * 1000;
}

async function triggerPostFromSnapshot(metadata, items, snapShotId) {
  // SECURITY FIX: Always verify premium status with server, never trust local storage
  let postsRemaining = await chrome.storage.sync.get(["postsRemaining"]);
  let userEmail = await chrome.storage.sync.get(["user"]);
  const email = userEmail.user?.email;
  
  let isPremium = false;
  if (email) {
    const premiumStatus = await verifyPremiumStatus(email);
    isPremium = premiumStatus.isPremium;
  }
  currentIsPremium = !!isPremium;
  currentPostsRemaining =
    typeof postsRemaining?.postsRemaining === "number"
      ? postsRemaining.postsRemaining
      : null;
  
  if (postsRemaining.postsRemaining <= 0 && !isPremium) {
    trackTrialExhaustedIfNeeded("trigger_post_from_snapshot");
    trackMixpanel("scheduled_snapshot_blocked", {
      reason: "trial_exhausted",
      snapshot_id: snapShotId,
    });
    captureSentryMessage("scheduled_snapshot_blocked", {
      reason: "trial_exhausted",
      snapshot_id: snapShotId,
    }, "warning");
    return;
  }

  if (isCurrentlyPosting || isStopping) {
    console.log("[Snapshot] Skipping scheduled run: another posting session is active.");
    trackMixpanel("scheduled_snapshot_blocked", {
      reason: "session_already_running",
      snapshot_id: snapShotId,
    });
    captureSentryMessage("scheduled_snapshot_blocked", {
      reason: "session_already_running",
      snapshot_id: snapShotId,
    }, "warning");
    return;
  }

  const previousStopRequested = state.isStopRequested;
  isCurrentlyPosting = true;
  activeCampaignId = `snapshot_${snapShotId}`;
  await persistState();

  try {
    const groupLinks = metadata?.group?.urls?.slice() || [];
    const timeInSeconds = metadata?.timeInSeconds || 10;

    Object.assign(state, {
      isStopRequested: false,
      postsCompleted: [],
      groupLinks: groupLinks,
      remainingGroups: [],
    });

    updatePostingProgress("started");
    updatePostingStatus(`Starting scheduled post...`);
    trackMixpanel("scheduled_snapshot_started", {
      snapshot_id: snapShotId,
      groups_count: groupLinks.length,
    });
    trackMixpanel("scheduling_used", {
      snapshot_id: snapShotId,
      source: "snapshot",
      groups_count: groupLinks.length,
    });
    captureSentryMessage("scheduled_snapshot_started", {
      snapshot_id: snapShotId,
      groups_count: groupLinks.length,
    });
    chrome.storage.local.set({
      showModal: true,
      modalHiddenByUser: false,
      isPostingInProgress: "started",
    });

    for (let i = 0; i < groupLinks.length; i++) {
      if (state.isStopRequested) break;

      const groupLink = groupLinks[i];
      updatePostingStatus(`Posting to group ${i + 1} / ${groupLinks.length}`);

      // UI overlay
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs.length > 0) {
          chrome.tabs.sendMessage(tabs[0].id, { action: "showOverlay" }, () => {
            if (chrome.runtime.lastError) {
              // Silently ignore - tab might not have content script
            }
          });
        }
      });

      // Open tab and start posting (with retry so one failure doesn't kill the whole run)
      let tab;
      try {
        tab = await createTabWithRetry(groupLink);
        activePostingTabId = tab?.id || null;
      } catch (error) {
        console.error(`[Snapshot] Failed to create tab for ${groupLink}. Skipping this group.`, error);
        state.postsCompleted.push({
          status: "failed",
          groupLink,
          reason: "Tab creation failed after retries",
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      const images = await Promise.all(
        items
          .filter((item) => item?.value?.type?.startsWith("image"))
          .map(async (item) => ({
            type: "image",
            data: await blobToBase64(item.value.blob),
          }))
      );

      // Compose the post action
      const expandedText = expandSpintax(metadata?.content || "");
      const postAction = {
        action: "contentPostPost",
        post: {
          text: expandedText,
          scheduled: true,
          video_id: [],
          snapShotId,
          images,
        },
        background: metadata?.background || null,
      };

      let responseHandled = false;
      try {
        await clearOperationDone();
        await postContent(tab.id, postAction);
        responseHandled = await handleResponse();
      } catch (error) {
        console.error(`[Snapshot] Post flow failed for ${groupLink}:`, error);
      }

      state.postsCompleted.push({
        link: groupLink,
        response: responseHandled ? "successful" : "failed",
      });

      // Credits are consumed in handleResponse() through useCredit(email).
      // Keep this flow single-source-of-truth to avoid double deductions.

      await cleanUpAfterPosting(tab.id);

      if (responseHandled && i + 1 < groupLinks.length) {
        await waitBeforeNextPost(timeInSeconds, i, groupLinks.length, metadata?.deliveryOptions);
      }

      await sleep(1);
    }

    finalizePosting(state.postsCompleted);
    trackMixpanel("scheduling_succeeded", {
      snapshot_id: snapShotId,
      source: "snapshot",
      posts_sent: state.postsCompleted.filter((x) => x && x.response === "successful").length,
      posts_total: state.postsCompleted.length,
    });
    captureSentryMessage("scheduled_snapshot_completed", {
      snapshot_id: snapShotId,
      total_groups: state.postsCompleted.length,
      successful_groups: state.postsCompleted.filter((x) => x?.response === "successful").length,
    });
  } catch (error) {
    console.error("[Snapshot] Scheduled run failed:", error);
    trackMixpanel("scheduling_failed", {
      snapshot_id: snapShotId,
      source: "snapshot",
      reason: error && error.message ? error.message : String(error),
    });
    captureSentryException(error, {
      phase: "trigger_post_from_snapshot",
      snapshot_id: snapShotId,
    });
    chrome.storage.local.set({
      postsCompleted: state.postsCompleted,
      showModal: true,
      modalHiddenByUser: false,
      isPostingInProgress: "done",
    });
    updatePostingStatus(`Scheduled posting failed: ${error?.message || error}`);
    updatePostingProgress("done");
  } finally {
    state.isStopRequested = previousStopRequested;
    isCurrentlyPosting = false;
    isStopping = false;
    activeCampaignId = null;
    await persistState();
  }
}

startScheduleCronJob();

chrome.runtime.onConnect.addListener((port) => {
  // Track when popup / sidepanel opens (any port that is not internal streaming)
  if (port.name !== "video-stream" && port.name !== "snapshotPort") {
    trackMixpanel("session_opened", { port_name: port.name || "unknown" });
  }
  if (port.name === "snapshotPort") {
    port.onMessage.addListener((msg) => {
      if (msg.action === "fetchSnapshotItems") {
        fetchSnapshotItemsInChunks(msg.snapshotId, port);
      }
    });
  }
});

async function fetchSnapshotItemsInChunks(snapshotId, port) {
  const CHUNK_SIZE = 1024 * 1024;

  const dbReq = indexedDB.open("permanentStore", 1);
  dbReq.onsuccess = () => {
    const database = dbReq.result;
    const tx = database.transaction("snapshots", "readonly");
    const store = tx.objectStore("snapshots");

    const request = store.get(snapshotId);

    request.onsuccess = async () => {
      const snapshot = request.result;

      if (!snapshot) {
        port.disconnect();
        return;
      }

      const items = snapshot.items || [];

      for (let i = 0; i < items.length; i++) {
        const { key, value } = items[i];
        const blob = value.blob;
        const arrayBuffer = await blob.arrayBuffer();
        const totalChunks = Math.ceil(arrayBuffer.byteLength / CHUNK_SIZE);

        for (let j = 0; j < totalChunks; j++) {
          const start = j * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, arrayBuffer.byteLength);
          const chunk = arrayBuffer.slice(start, end);

          port.postMessage({
            action: "receiveChunk",
            index: j,
            total: totalChunks,
            key,
            type: value.type,
            itemIndex: i,
            chunk: Array.from(new Uint8Array(chunk)),
          });
        }
      }

      port.postMessage({
        action: "allChunksSent",
        itemsCount: items.length,
      });

      database.close();
    };

    request.onerror = () => {
      database.close();
      port.disconnect();
    };
  };

  dbReq.onerror = () => {
    port.disconnect();
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action == "schedulePostDone") {
    if (typeof msg.snapShotId !== "string" || msg.snapShotId.length === 0) {
      return;
    }
    markSnapshotAsDone(msg.snapShotId);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "fetch-config") {
    (async () => {
      let config = null;
      const version = msg.version;
      const defaultFile = `https://firebasestorage.googleapis.com/v0/b/klyra-c84ad.firebasestorage.app/o/domselector.config.json?alt=media&token=455d1e16-066a-435f-abfa-8d792f33be7b`;

      try {
        const res = await fetch(`${defaultFile}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(res.statusText);
        config = await res.json();
      } catch (e) {
        try {
          const res2 = await fetch(`${defaultFile}`, {
            cache: "no-store",
          });
          if (!res2.ok) throw new Error(res2.statusText);
          config = await res2.json();
        } catch (e2) {
          console.log(e2);
          config = null;
        }
      }

      sendResponse(config); // Always respond with config (or null)
    })();

    return true; // Tell Chrome this is an async response
  }
});

//Firestore calls
importScripts("firebase-app-compat.js", "firebase-firestore-compat.js");

// Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyCDBgRtDLY13s6dVvzcKouK5LYNy8Dqbr0",
  authDomain: "klyra-c84ad.firebaseapp.com",
  projectId: "klyra-c84ad",
  storageBucket: "klyra-c84ad.firebasestorage.app",
  messagingSenderId: "315865406417",
  appId: "1:315865406417:web:ee66e55bc07c042b9e1ef0",
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// Your Firebase project variables
const apiKey = "AIzaSyCDBgRtDLY13s6dVvzcKouK5LYNy8Dqbr0";
const projectId = "klyra-c84ad";
const storageBucket = "klyra-c84ad.firebasestorage.app";
const messagingSenderId = "315865406417";
const appId = "1:315865406417:web:ee66e55bc07c042b9e1ef0";

// Fetch Firestore document using REST API (with caching)
async function fetchSelectorsConfigREST(docId = "selectorsConfig") {
  try {
    const cacheKey = `firestoreConfig_${docId}`;
    const cacheMetaKey = `${cacheKey}_timestamp`;
    const SIX_HOURS = 6 * 60 * 60 * 1000; // 6 hours in ms

    // Check cache
    const cachedConfig = await chrome.storage.local.get([
      cacheKey,
      cacheMetaKey,
    ]);
    const lastFetched = cachedConfig[cacheMetaKey];
    const now = Date.now();

    if (
      cachedConfig[cacheKey] &&
      lastFetched &&
      now - lastFetched < SIX_HOURS
    ) {
      console.log("Config loaded from cache:", cachedConfig[cacheKey]);
      return cachedConfig[cacheKey];
    }

    // Otherwise, fetch from Firestore
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/default/documents/configs/${docId}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    const data = await res.json();

    // Convert Firestore fields format to plain JSON
    const parsedData = {};
    if (data.fields) {
      for (const key in data.fields) {
        const valueObj = data.fields[key];
        if (valueObj.stringValue !== undefined)
          parsedData[key] = valueObj.stringValue;
        else if (valueObj.integerValue !== undefined)
          parsedData[key] = parseInt(valueObj.integerValue, 10);
        else if (valueObj.doubleValue !== undefined)
          parsedData[key] = parseFloat(valueObj.doubleValue);
        else if (valueObj.booleanValue !== undefined)
          parsedData[key] = valueObj.booleanValue;
        else if (valueObj.mapValue)
          parsedData[key] = parseFirestoreMap(valueObj.mapValue);
        else if (valueObj.arrayValue)
          parsedData[key] = parseFirestoreArray(valueObj.arrayValue);
        else parsedData[key] = null;
      }
    }

    // Store in cache
    await chrome.storage.local.set({
      [cacheKey]: parsedData,
      [cacheMetaKey]: now,
    });

    console.log("Config fetched via REST and cached:", parsedData);
    return parsedData;
  } catch (err) {
    console.error("Error fetching config via REST:", err);
    return null;
  }
}

// Helpers remain the same
function parseFirestoreMap(mapValue) {
  const obj = {};
  if (mapValue.fields) {
    for (const key in mapValue.fields) {
      const valueObj = mapValue.fields[key];
      if (valueObj.stringValue !== undefined) obj[key] = valueObj.stringValue;
      else if (valueObj.integerValue !== undefined)
        obj[key] = parseInt(valueObj.integerValue, 10);
      else if (valueObj.doubleValue !== undefined)
        obj[key] = parseFloat(valueObj.doubleValue);
      else if (valueObj.booleanValue !== undefined)
        obj[key] = valueObj.booleanValue;
      else if (valueObj.mapValue)
        obj[key] = parseFirestoreMap(valueObj.mapValue);
      else if (valueObj.arrayValue)
        obj[key] = parseFirestoreArray(valueObj.arrayValue);
      else obj[key] = null;
    }
  }
  return obj;
}

function parseFirestoreArray(arrayValue) {
  const arr = [];
  if (arrayValue.values) {
    for (const valueObj of arrayValue.values) {
      if (valueObj.stringValue !== undefined) arr.push(valueObj.stringValue);
      else if (valueObj.integerValue !== undefined)
        arr.push(parseInt(valueObj.integerValue, 10));
      else if (valueObj.doubleValue !== undefined)
        arr.push(parseFloat(valueObj.doubleValue));
      else if (valueObj.booleanValue !== undefined)
        arr.push(valueObj.booleanValue);
      else if (valueObj.mapValue)
        arr.push(parseFirestoreMap(valueObj.mapValue));
      else if (valueObj.arrayValue)
        arr.push(parseFirestoreArray(valueObj.arrayValue));
      else arr.push(null);
    }
  }
  return arr;
}

// Listener
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "fetch-firebase-config") {
    fetchSelectorsConfigREST("config").then(sendResponse);
    return true; // async
  }
});

// External message listener for webhook notifications from payment server
// This allows the payment server to notify the extension when premium status changes
chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  console.log("External message received:", request, "from:", sender);
  
  if (request.action === "premiumStatusChanged" || request.action === "subscriptionUpdated") {
    console.log("Premium status change notification received for:", request.email);
    
    // Clear the cached premium status to force a fresh fetch
    chrome.storage.sync.remove(["isPremium"], () => {
      console.log("Cleared cached premium status");
      
      // Notify all extension pages (popup, options, etc.) to refresh
      chrome.runtime.sendMessage(
        { action: "premiumStatusChanged", email: request.email },
        () => {
          // Ignore errors if no receivers
          if (chrome.runtime.lastError) {
            console.log("No active receivers for premium status update");
          }
        }
      );
      
      sendResponse({ success: true, message: "Premium status update notification sent" });
    });
    
    return true; // Keep the message channel open for async response
  }
  
  sendResponse({ success: false, message: "Unknown action" });
});
