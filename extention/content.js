// ── Sentry (inline wrapper, MV3 content-script safe) ─────────────────────────
(function () {
  const _SENTRY_KEY = '52993512018ff261aa5f0bff24ebf19f';
  const _SENTRY_ENDPOINT = 'https://o4510977686831104.ingest.de.sentry.io/api/4510977712980048/store/';
  const _breadcrumbs = [];
  const _MAX_BC = 30;

  function _addBC(cat, msg, data, lvl) {
    _breadcrumbs.push({ timestamp: Date.now() / 1000, category: cat, message: msg, data: data || {}, level: lvl || 'info' });
    if (_breadcrumbs.length > _MAX_BC) _breadcrumbs.shift();
  }

  function _send(event) {
    try {
      const _ver = (typeof chrome !== 'undefined' && chrome.runtime)
        ? chrome.runtime.getManifest().version : 'unknown';
      fetch(_SENTRY_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentry-Auth': 'Sentry sentry_version=7,sentry_key=' + _SENTRY_KEY,
        },
        body: JSON.stringify(Object.assign({
          timestamp: new Date().toISOString(),
          platform: 'javascript',
          release: _ver,
          environment: 'production',
          breadcrumbs: { values: [].concat(_breadcrumbs) },
          contexts: { browser: { name: 'Chrome Extension Content' } },
        }, event)),
      }).catch(function () {});
    } catch (_) {}
  }

  function _parseStack(stack) {
    return (stack || '').split('\n').slice(1).map(function (l) {
      const m = l.match(/at (.+?) \((.+?):(\d+):(\d+)\)/) || l.match(/at (.+?):(\d+):(\d+)/);
      if (!m) return { filename: l.trim() };
      return { function: m[1], filename: m[2] || m[1], lineno: parseInt(m[3] || m[2]), colno: parseInt(m[4] || m[3]) };
    }).filter(function (f) { return !!f.filename; }).reverse();
  }

  function _captureException(err, context) {
    if (!err) return;
    const e = err instanceof Error ? err : new Error(String(err));
    _send({
      level: 'error',
      exception: { values: [{ type: e.name || 'Error', value: e.message, stacktrace: { frames: _parseStack(e.stack || '') } }] },
      extra: context || {},
      tags: (context && context.tags) || {},
    });
  }

  function _captureMessage(msg, lvl, ctx) {
    _addBC('log', msg, ctx || {}, lvl || 'warning');
    _send({ level: lvl || 'warning', message: msg, extra: ctx || {}, tags: (ctx && ctx.tags) || {} });
  }

  // Auto-capture unhandled promise rejections in content script
  if (typeof self !== 'undefined') {
    self.addEventListener('unhandledrejection', function (e) {
      _captureException(e.reason || new Error('Unhandled Promise Rejection'), {
        tags: { source: 'unhandled_promise', context: 'content' },
      });
    });
  }

  const SentryExt = { addBreadcrumb: _addBC, captureException: _captureException, captureMessage: _captureMessage };
  if (typeof globalThis !== 'undefined') globalThis.SentryExt = SentryExt;
  if (typeof self !== 'undefined') self.SentryExt = SentryExt;
})();

// ── Mixpanel (inline, fire-and-forget, EU endpoint) ──────────────────────────
const _MPTOKEN_CT = 'b9e21ff4a7c6ee5ff5267aa0f3422e8d';
const _MPURL_CT   = 'https://api-eu.mixpanel.com/track';

let MP_DISTINCT_ID = 'anonymous';
(function () {
  try {
    chrome.storage.local.get(['mp_distinct_id'], function (r) {
      if (r && r.mp_distinct_id) {
        MP_DISTINCT_ID = r.mp_distinct_id;
      } else {
        MP_DISTINCT_ID = 'ext_' + Date.now() + '_' + Math.random().toString(36).slice(2);
        chrome.storage.local.set({ mp_distinct_id: MP_DISTINCT_ID });
      }
    });
  } catch (_) {}
})();

function trackMP(event, props) {
  try {
    const _ver = (typeof chrome !== 'undefined' && chrome.runtime)
      ? chrome.runtime.getManifest().version : 'unknown';
    const payload = btoa(JSON.stringify([{
      event: event,
      properties: Object.assign({}, {
        token: _MPTOKEN_CT,
        distinct_id: MP_DISTINCT_ID,
        time: Math.floor(Date.now() / 1000),
        extension_version: _ver,
        source: 'content',
      }, props || {}),
    }]));
    fetch(_MPURL_CT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(payload),
    }).catch(function () {});
  } catch (_) {}
}

/** Convenience: forward to inline SentryExt, never throws */
function maybeCaptureSentryException(error, context) {
  try {
    const sentry = (typeof globalThis !== 'undefined' && globalThis.SentryExt) || null;
    if (!sentry || typeof sentry.captureException !== 'function') return;
    sentry.captureException(error, context || {});
  } catch (_) {}
}

// Load configuration (remote or default) and initialize the script
let config = null;

const DB_NAME = "MediaStore";
const STORE_NAME = "videos";
let receivedItems = {};

// Default selectors and settings in case remote config fails
const defaultConfig = {
  postSelectors: [
    'div[role="feed"] > div > div',
    ".x1lliihq .x1n2onr6.xh8yej3.x1ja2u2z.xod5an3",
  ],
  contentSelectors: [
    'div[data-ad-preview="message"]',
    'div[dir="auto"]',
    'div[data-visualcompletion="ignore-dynamic"]',
  ],
  composerSelectors: [
    ".x1yztbdb .xi81zsa.x1lkfr7t.xkjl1po.x1mzt3pk.xh8yej3.x13faqbe",
    '[data-composer-id="whats-on-your-mind"]',
    ".xi81zsa.x1lkfr7t.xkjl1po.x1mzt3pk.xh8yej3.x13faqbe",
  ],
  composerInputAreaSelectors: [
    '[role="dialog"] [role="presentation"] .notranslate[contenteditable="true"]',
    "div[contenteditable='true'][role='textbox']",
    ".xzsf02u.x1a2a7pz.x1n2onr6.x14wi4xw.notranslate[contenteditable='true']",
    "div[aria-label='Create a public post…'][contenteditable='true'][role='textbox']",
    ".notranslate._5rpu[contenteditable='true']",
    ".notranslate[contenteditable='true']",
    'div[role="textbox"][contenteditable="true"]',
  ],
  buttonClassName: "log-button",
  postButtonSelector: 'div[aria-label="Post"]',
};

// CONTENT SCRIPT READINESS: Respond to ping from background worker
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "ping") {
    sendResponse({ pong: true });
    return;
  }
});

// Listen for a message to show the file picker
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "show_select_files_content") {
    (async () => {
      const result = await showFilePicker(); // <-- your file picker logic
      sendResponse({ selected: result }); // <-- reply with result
    })();

    return true; // ⬅️ VERY IMPORTANT to keep the message port open
  }
});

//Test starts
async function waitForSelectorFromAI(timeoutMs = 10000) {
  let debounceTimeout;
  let selectorResolved = false;
  let foundSelector = null;

  const hostname = window.location.hostname; // full host, e.g., "www.facebook.com"
  const pathname = window.location.pathname;

  if (
    !hostname.includes("facebook.com") ||
    (!pathname.startsWith("/groups/") && document.documentElement.lang == "en")
  ) {
    return;
  }

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (selectorResolved) return;

      clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(() => {
        if (selectorResolved) return;

        const feedRoot =
          document.querySelector("div[role='feed']") || document.body;
        const domSnapshot = feedRoot.innerHTML.slice(0, 20000);

        chrome.runtime.sendMessage(
          {
            action: "callAi",
            payload: { html: domSnapshot },
          },
          (response) => {
            if (response?.selector) {
              const composerEls = document.querySelectorAll(response.selector);
              logTelemetry(
                "composer_open_failed",
                { message: "ai_called", ai_response: response },
                "ERROR"
              );
              if (composerEls.length) {
                for (const el of composerEls) {
                  try {
                    el.click();
                    const rect = el.getBoundingClientRect();
                    const isVisible = rect.width > 0 && rect.height > 0;

                    if (document.activeElement === el || isVisible) {
                      selectorResolved = true;
                      foundSelector = response.selector;
                      observer.disconnect();
                      resolve(foundSelector);
                      return;
                    }
                  } catch (err) {
                    // console.warn("⚠️ Failed to click element:", el, err);
                  }
                }
              } else {
                logTelemetry(
                  "config_load_failed",
                  {
                    message: `⚠️ AI returned selector but no matching element found: ${response.selector}`,
                  },
                  "WARNING"
                );
              }
            } else {
              logTelemetry(
                "config_load_failed",
                {
                  message: `⚠️ No selector or error from AI: ${response?.error}`,
                },
                "WARNING"
              );
            }
          }
        );
      }, 500);
    });

    // Fallback timeout: stop after a certain time
    const failTimeout = setTimeout(() => {
      if (!selectorResolved) {
        observer.disconnect();
        resolve(null);
      }
    }, timeoutMs);

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  });
}

//Test ends

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms * 1000));
}

// Expand spintax patterns in the given text.
// Replaces occurrences like {opt1|opt2|opt3} with a random option.
function expandSpintax(text) {
  if (!text || typeof text !== 'string') return text;
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

  // Parse and expand spintax groups {option1|option2|option3}
  let result = processedText.replace(/\{([^{}]+)\}/g, (match, content) => {
    const options = content.split('|').map((s) => s.trim()).filter(Boolean);
    if (options.length === 0) return match;
    if (options.length === 1) return options[0];
    spintaxGroupCount++;
    return options[Math.floor(Math.random() * options.length)];
  });

  // Restore HTML tags from placeholders
  Object.keys(htmlMap).forEach(id => {
    result = result.replace(placeholder(id), htmlMap[id]);
  });

  if (spintaxGroupCount > 0) {
    maybeCaptureSentryMessage("spintax_expanded", {
      source: "content",
      groups: spintaxGroupCount,
    });
    logTelemetry("spintax_expanded", {
      source: "content",
      groups: spintaxGroupCount,
    }, "INFO");
    // ── Mixpanel: spintax_used + feature_used ──────────────────────────
    trackMP("spintax_used", { groups: spintaxGroupCount });
    trackMP("feature_used", { feature_name: "spintax", spintax_groups: spintaxGroupCount });
  }

  return result;
}
async function openComposerAndInsert(text, images, video_id, scheduled, background, snapShotId = null) {
  const ocaiId = Date.now() + "-" + Math.floor(Math.random() * 10000);
  console.debug("[ocai] openComposerAndInsert called", { id: ocaiId, textPreview: (text || "").substr(0, 120), imagesCount: (images || []).length, video_id, scheduled, background, snapShotId });
  if (text) {
    // Expand spintax before opening composer / inserting
    try {
      text = expandSpintax(text);
    } catch (err) {
      // if expansion fails, fall back to original text
      console.error('Spintax expansion error:', err);
    }

    let t = await openComposer();
    if (!t) {
      console.error("[ocai] ❌ Failed to open composer - marking as failed and stopping");
      showFallbackUI("Failed to open composer.");
      logTelemetry(
        "composer_open_failed",
        { message: "Failed to open composer." },
        "ERROR",
        false
      );
      
      chrome.storage.local.set({ operationDone: "failed" }, () => {
        if (chrome.runtime.lastError) {
          console.error("Storage error:", chrome.runtime.lastError);
        } else {
          console.log("[ocai] ❌ operationDone set to 'failed' - tab should close immediately and move to next");
        }
      });
      // captureAndSendSnapshot("Composer open failed");
      return false; // CRITICAL: Return false to indicate failure so flow can complete immediately
    }

    await sleep(0.5);
    const innerId = ocaiId + "-inner";
    console.debug("[ocai] about to call injectIntoComposer", { id: innerId, textPreview: (text || "").substr(0, 120), imagesCount: (images || []).length, video_id, scheduled });
    let imgs = (Array.isArray(images) ? images : [])
      .filter((element) => element.type === "image")
      .map((element) => element.data);
    const normalizedVideoIds = Array.isArray(video_id)
      ? video_id
      : (!scheduled && typeof video_id === "string" && video_id.trim() ? [video_id] : []);
    const normalizedSnapshotId =
      typeof snapShotId === "string" && snapShotId.trim()
        ? snapShotId
        : (scheduled && typeof video_id === "string" && video_id.trim() ? video_id : null);
    let done = await injectIntoComposer(
      text,
      imgs,
      normalizedVideoIds,
      scheduled,
      background,
      normalizedSnapshotId
    );
    if (!done) {
      chrome.storage.local.set(
        {
          postingStatus: "Posting encounters an error, checking again..",
        },
        function () { }
      );
    } else {
      console.log("[ocai] ✅ Post injection successful - setting operationDone");
      chrome.storage.local.set({ operationDone: "successful" }, () => {
        if (chrome.runtime.lastError) {
          console.error("Storage error:", chrome.runtime.lastError);
        } else {
          console.log("[ocai] ✅ operationDone set to 'successful' - background should now close tab and move to next");
        }
      });
      logTelemetry("post_success", { message: "Post successful." }, "INFO");
      // ── Mixpanel: first_post_success (once-ever via localStorage) ────
      try {
        if (!localStorage.getItem("fbgbp_first_post_done")) {
          localStorage.setItem("fbgbp_first_post_done", "1");
          trackMP("first_post_success");
        }
      } catch (_fpErr) {}
      // Apply background style if provided
      if (background) {
        try {
          console.debug("[ocai] applying background:", background);
        } catch (e) {
          console.warn("[ocai] background apply failed:", e.message);
        }
      }
      return true; // CRITICAL: Return true on success so injection completes
    }
  } else {
    showFallbackUI("[Error] Post content not found.");
    logTelemetry(
      "post_content_not_found",
      { message: "Post content not found. Post unsucessful." },
      "ERROR"
    );
    return false; // Fail on no content
  }
  return false; // Default fail case
}

function getModalButton() {
  // Selector for the modal button, update this if Facebook changes their classes
  const selector =
    'div[class="x1i10hfl x1ejq31n xd10rxx x1sy0etr x17r0tee x972fbf xcfux6l x1qhh985 xm0m39n x9f619 x1ypdohk xe8uvvx xdj266r x11i5rnm xat24cr x1mh8g0r x16tdsg8 x1hl2dhg xggy1nq x87ps6o x1lku1pv x1a2a7pz x6s0dn4 xmjcpbm x107yiy2 xv8uw2v x1tfwpuw x2g32xy x78zum5 x1q0g3np x1iyjqo2 x1nhvcw1 x1n2onr6 xt7dq6l x1ba4aug x1y1aw1k xn6708d xwib8y2 x1ye3gou"]';
  return document.querySelector(selector);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "contentPostPost") {
    sendResponse({ accepted: true });
    // ── first_campaign_created (once-ever via chrome.storage.local) ─────
    try {
      chrome.storage.local.get(["fbgbp_first_campaign_done"], function (r) {
        if (!r || !r.fbgbp_first_campaign_done) {
          chrome.storage.local.set({ fbgbp_first_campaign_done: Date.now() });
          trackMP("first_campaign_created");
        }
      });
    } catch (_fcErr) {}
    // ── delivery_pacing_used (when popup passes custom delivery options) ─
    if (request.deliveryOptions && request.deliveryOptions.isCustom) {
      trackMP("delivery_pacing_used", {
        mode: request.deliveryOptions.mode || "unknown",
        batch_size: request.deliveryOptions.batchSize || null,
      });
      trackMP("feature_used", { feature_name: "delivery_pacing" });
    }
    (async () => {
      try {
        const { post } = request;
        await openComposerAndInsert(
          post.text,
          post.images,
          post.video_id,
          post?.scheduled,
          request.background,
          post?.snapShotId
        );
      } catch (error) {
        chrome.storage.local.set({ operationDone: "failed" }, () => {
          if (chrome.runtime.lastError) {
            console.error("Storage error:", chrome.runtime.lastError);
          }
        });
        showFallbackUI("Failed to open composer and insert text.");
        logTelemetry(
          "composer_injection_failed",
          { message: "Failed to open composer and insert text." },
          "WARNING"
        );
        maybeCaptureSentryException(error, { phase: "contentPostPost_outer" });
      }
    })();
    return false;
  }
});

function getOSType() {
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();

  if (platform.includes("win")) return "Windows";
  if (platform.includes("mac")) return "macOS";
  if (platform.includes("linux")) return "Linux";
  if (/android/.test(userAgent)) return "Android";
  if (/iphone|ipad|ipod/.test(userAgent)) return "iOS";

  return "unknown";
}

function getBrowserName() {
  const userAgent = navigator.userAgent;

  if (
    userAgent.includes("Chrome") &&
    !userAgent.includes("Edg") &&
    !userAgent.includes("OPR")
  )
    return "Chrome";
  if (userAgent.includes("Firefox")) return "Firefox";
  if (userAgent.includes("Safari") && !userAgent.includes("Chrome"))
    return "Safari";
  if (userAgent.includes("Edg")) return "Edge";
  if (userAgent.includes("OPR") || userAgent.includes("Opera")) return "Opera";

  return "unknown";
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

function maybeCaptureSentryMessage(message, extras = {}) {
  try {
    const sentry = globalThis.Sentry || globalThis.SentryExt;
    if (!sentry || typeof sentry.captureMessage !== "function") return;
    if (typeof sentry.withScope === "function") {
      sentry.withScope((scope) => {
        if (scope && typeof scope.setTag === "function") {
          scope.setTag("channel", "content");
        }
        if (scope && typeof scope.setExtra === "function") {
          Object.keys(extras || {}).forEach((key) => {
            scope.setExtra(key, extras[key]);
          });
        }
        sentry.captureMessage(message);
      });
      return;
    }
    sentry.captureMessage(message);
  } catch (_) {
    // Ignore Sentry-only failures.
  }
}

async function getTelemetryIdentity() {
  let email = "";
  try {
    const userResult = await chrome.storage.sync.get(["user"]);
    if (chrome.runtime.lastError) {
      return { email: "unknown", emailHash: "anonymous" };
    }
    email = userResult?.user?.email || "";
  } catch (_) {
    return { email: "unknown", emailHash: "anonymous" };
  }

  const emailHash = (await hashEmail(email)) || "anonymous";
  maybeSetSentryIdentity(emailHash === "anonymous" ? "" : emailHash);
  return { email: email || "unknown", emailHash };
}

// Send telemetry events to backend
async function logTelemetry(
  event,
  data,
  type = "DOM_ERROR",
  supported_group = true
) {
  try {
    if (
      typeof event !== "string" ||
      event.trim() === "" ||
      typeof type !== "string"
    ) {
      return;
    }

    if (Object.keys(data).length === 0) {
      return;
    }

    if (typeof type !== "string" || type.trim() === "") {
      return;
    }

    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return;
    }

    // Send telemetry data
    data["os"] = getOSType();
    data["browser"] = getBrowserName();
    const identity = await getTelemetryIdentity();
    data["email"] = identity.email;
    data["email_hash"] = identity.emailHash;
    data["id"] = crypto.randomUUID();
    data["status"] = "open";
    data["supported_group"] = supported_group;
    chrome.runtime.sendMessage(
      {
        action: "callApi",
        payload: {
          event,
          data,
          time: Date.now(),
          type: type,
          os: getOSType(),
          browser: getBrowserName(),
          email: identity.email,
          email_hash: identity.emailHash,
        },
      },
      (response) => {
        captureAndSendSnapshot(data["id"], type);
        if (chrome.runtime.lastError) {
          return;
        }
      }
    );
  } catch (e) {
    // console.error("Telemetry logging exception:", e.message || e);
  }
}

// --------------------------------------
// 1. DYNAMIC SELECTOR MINING UTILITIES
// --------------------------------------

/**
 * Given an element and sample set, constructs the shortest unique CSS selector path.
 * @param {Element} el - The starting DOM element
 * @param {Element[]} samples - Array of sibling sample elements to match against
 * @returns {string} A minimal unique selector path string
 */
function buildUniquePath(el, samples) {
  let path = "";
  let curr = el;
  while (curr && curr.nodeType === 1) {
    const tag = curr.tagName.toLowerCase();

    // Priority: ID > role > aria-label > meaningful class > tag only
    let segment = tag;

    if (curr.id) {
      // IDs are unique, best selector candidate
      segment += `#${curr.id}`;
    } else if (curr.getAttribute("role")) {
      segment += `[role="${curr.getAttribute("role")}"]`;
    } else if (curr.getAttribute("aria-label")) {
      // Use aria-label if available
      // Escape quotes in aria-label if any
      const ariaLabel = curr.getAttribute("aria-label").replace(/"/g, '\\"');
      segment += `[aria-label="${ariaLabel}"]`;
    } else {
      // fallback to class names: pick first non-numeric, min length 3 class
      const cls = Array.from(curr.classList).find(
        (c) => c.length > 3 && !/\d+/.test(c)
      );
      if (cls) segment += `.${cls}`;
      // else leave as tag only selector segment
    }

    path = path ? `${segment} > ${path}` : segment;

    // Test if this selector matches all sample elements
    const matches = samples.filter((s) => s.matches(path));
    if (matches.length === samples.length) {
      // Found a selector that matches all samples uniquely enough
      break;
    }

    curr = curr.parentElement;
  }
  return path;
}

/**
 * Dynamically mines a selector within a given root container using a few samples.
 * @param {string} rootSel - CSS selector for the root element
 * @param {number} [sampleCount=3] - Number of child samples to use
 * @returns {Promise<string|null>} The best mined selector, or null
 */
async function mineSelector(rootSel, sampleCount = 3) {
  const root = document.querySelector(rootSel);
  if (!root) return null;
  const items = Array.from(root.children).slice(0, sampleCount);
  if (items.length < 2) return null;
  const paths = items.map((it) => buildUniquePath(it, items));
  const valid = paths.filter((p) => p);
  if (!valid.length) return null;
  return valid.sort((a, b) => a.length - b.length)[0];
}

/**
 * Attempts to determine a working selector from a list, with retry logic.
 * On success, writes to config[resultKey].
 * @param {string} arrayKey - Key in config holding candidate selectors
 * @param {string} resultKey - Key to store the chosen selector
 * @param {number} [retries=5] - Number of retry intervals
 * @param {number} [interval=1000] - Time between retries in ms
 * @returns {Promise<void>}
 */
async function determineSelector(
  arrayKey,
  resultKey,
  retries = 5,
  interval = 1000
) {
  const selectors = config[arrayKey] || [];

  // 1. Try static list up front, logging each failure
  for (let i = 0; i < selectors.length; i++) {
    const sel = selectors[i];
    if (document.querySelector(sel)) {
      config[resultKey] = sel;
      return;
    } else {
      // console.log(
      //   `[Selector][${resultKey}] ❌ Static failed (#${i + 1}): "${sel}"`
      // );
    }
  }

  // 2. Retry loop over same list, logging when one finally appears
  let attempts = 0;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      attempts++;
      for (let i = 0; i < selectors.length; i++) {
        const sel = selectors[i];
        if (document.querySelector(sel)) {
          config[resultKey] = sel;
          clearInterval(timer);
          return resolve();
        }
      }
      if (attempts >= retries) {
        // 3. Fallback after retries
        const fallback = selectors[0] || null;
        config[resultKey] = fallback;
        // logTelemetry(
        //   "selector_detection_failed",
        //   { selector_type: arrayKey, retries, fallback_selector: fallback },
        //   "ERROR"
        // );
        clearInterval(timer);
        resolve();
      }
    }, interval);
  });
}

// Fetch remote config; fallback to default
async function loadConfig() {
  const manifest = chrome.runtime.getManifest();
  const version = manifest.version;
  const baseUrl = "https://www.fbgroupbulkposter.com/assets/";
  const versionedFile = `domselector_${version}.config.json`;
  const defaultFile = `domselector.config.json`;

  const fetchConfigFromBackground = () => {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: "fetch-firebase-config" },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else if (!response) {
            reject(new Error("No config received"));
          } else {
            resolve(response);
          }
        }
      );
    });
  };

  try {
    config = await fetchConfigFromBackground();
  } catch (e1) {
    logTelemetry(
      "config_load_failed",
      {
        version,
        message: `(FETCH) ${e1.message}. Using default configuration.`,
      },
      "ERROR"
    );

    // fallback to default file
    try {
      let res2 = await fetch(`${baseUrl}${defaultFile}`);
      if (!res2.ok) throw new Error(res2.statusText);
      config = await res2.json();
    } catch (e2) {
      logTelemetry(
        "config_load_failed_default",
        { version, message: `(FETCH) ${e2.message}. Using default config.` },
        "ERROR"
      );
      config = defaultConfig;
    }
  }

  // Use first content selector
  config.contentSelector = config.contentSelectors[0];

  tagWriteSomethingComposer();
  waitForFeedAndInit();
}

// Locate and tag the "What's on your mind" composer
// Tag the "Write something..." composer box if found
function tagWriteSomethingComposer() {
  const spans = document.querySelectorAll("span");

  for (const span of spans) {
    const text = span.innerText.trim();

    // Match common Facebook composer prompts
    if (
      /What's on your mind, .+\?/i.test(text) ||
      /Write something\.\.\./i.test(text) ||
      /Write something/i.test(text) ||
      /What are you selling/i.test(text) ||
      /Write Napisz coś\.\.\./i.test(text) ||
      /Exprimez-vous\.\.\./i.test(text) ||
      /اكتب شيئًا\.\.\./i.test(text)
    ) {
      const parent = span.closest("div[role='textbox']") || span.parentElement;
      if (parent) {
        parent.setAttribute("data-composer-id", "whats-on-your-mind");
        return parent;
      }
    }
  }

  return false;
}

function findPostContent(post) {
  for (const selector of config.contentSelectors) {
    const content = post.querySelector(selector);
    if (content && content.innerText.trim() !== "") {
      return content;
    }
  }
  return null;
}

// Expand any "See more" links for long posts, with retries
function expandSeeMore(post, retries = 5, interval = 300) {
  let attempts = 0;
  const timer = setInterval(() => {
    const els = Array.from(post.querySelectorAll("div,span,a")).filter(
      (el) => el.innerText.trim() === "See more"
    );
    if (els.length) els.forEach((e) => e.click());
    if (!els.length || ++attempts >= retries) clearInterval(timer);
  }, interval);
}

function autoExpandOnLoad() {
  document
    .querySelectorAll(config.postSelector)
    .forEach((p) => expandSeeMore(p));
}

// Open the Facebook post composer by clicking the appropriate element
async function openComposer() {
  try {
    let activeComposer = null;

    // --- NEW PRIORITIZED LOGIC: Multi-language placeholders (composer prompts) ---
    const multiLangPlaceholders = [
      "write something",
      "what's on your mind",
      "what are you selling",
      "اكتب شيئًا",
      "بماذا تفكر",
      "ماذا تبيع",
      "escribe algo",
      "¿qué estás pensando?",
      "¿qué estás vendiendo?",
      "écrivez quelque chose",
      "à quoi pensez-vous",
      "que vendez-vous",
      "napisz coś",
      "o czym myślisz",
      "co sprzedajesz",
      "कुछ लिखें",
      "आप क्या सोच रहे हैं",
      "आप क्या बेच रहे हैं",
      "何か書く",
      "何を考えていますか",
      "何を売っていますか",
      "写点什么",
      "你在想什么",
      "你在卖什么",
      "寫點什麼",
      "你在想什麼",
      "你在賣什麼",
    ];

    // elements/tags to search for visible text composer-like placeholders
    const selectorsToCheck = ["span", "div"];

    // search by visible text content
    for (const tag of selectorsToCheck) {
      const el = Array.from(document.querySelectorAll(tag)).find((e) => {
        const text = (e.textContent || "").toLowerCase().trim();
        return multiLangPlaceholders.some((kw) =>
          text.includes(kw.toLowerCase())
        );
      });
      if (el) {
        activeComposer = el;
        break;
      }
    }

    // also inspect common input-like elements for placeholder/aria-label/title
    if (!activeComposer) {
      const inputLike = Array.from(
        document.querySelectorAll(
          'textarea, input[placeholder], input[aria-label], input[title], [contenteditable="true"], [role="textbox"]'
        )
      );
      activeComposer = inputLike.find((el) => {
        const attrs = [
          el.getAttribute && el.getAttribute("placeholder"),
          el.getAttribute && el.getAttribute("aria-label"),
          el.getAttribute && el.getAttribute("title"),
          el.textContent,
        ]
          .filter(Boolean)
          .map((s) => String(s).toLowerCase());
        return attrs.some((a) =>
          multiLangPlaceholders.some((kw) => a.includes(kw.toLowerCase()))
        );
      });
    }

    // --- FALLBACK: OLD LOGIC using config.composerSelectors ---
    if (!activeComposer && Array.isArray(config.composerSelectors)) {
      for (const selector of config.composerSelectors) {
        const btn = document.querySelector(selector);
        if (btn) {
          activeComposer = btn;
          break;
        }
      }
    }

    // --- If still not found, check for "Join Group" CTA (multi-language) ---
    if (!activeComposer) {
      const joinGroupKeywords = [
        "join group",
        "join the group",
        "join this group",
        "join",
        // common translations / variants (not exhaustive)
        "unirse al grupo",
        "unirse al grupo",
        "únete al grupo",
        "rejoindre le groupe",
        "rejoindre",
        "pr присоединиться к группе", // slightly odd; included for coverage
        "присоединиться к группе",
        "加入群组",
        "加入群組",
        "加入小组",
        "加入群",
        "加入",
        "ingresar al grupo",
        "ingressar no grupo",
        "ingresar al grupo",
        "gruppe beitreten", // German-ish
        "beitreten", // German 'join'
        "partecipa al gruppo", // Italian-ish
        "加入群聊", // Chinese variant
      ];

      // search common clickable tags for join-group text
      const clickableTags = ["span", "button", "a", "div"];
      let foundJoin = null;
      outer: for (const tag of clickableTags) {
        for (const el of Array.from(document.querySelectorAll(tag))) {
          const text = (el.textContent || "").toLowerCase().trim();
          if (!text) continue;
          for (const kw of joinGroupKeywords) {
            if (text.includes(kw.toLowerCase())) {
              foundJoin = el;
              break outer;
            }
          }
        }
      }

      if (foundJoin) {
        // Found a Join Group CTA — treat as "no composer available"
        logTelemetry(
          "unsupported_grup",
          {
            message:
              "The user may not have sufficient permission to post in the grup.",
          },
          "ERROR",
          false
        );
        return false;
      }
    }

    // --- Handle case if still not found after all checks ---
    if (!activeComposer) {
      logTelemetry(
        "post_composer_not_found",
        {
          message: `[DOM ERROR] Used ${Array.isArray(config.composerSelectors)
            ? config.composerSelectors.join(", ")
            : "composerSelectors missing"
            }`,
        },
        "ERROR"
      );
      return false;
    }

    // --- Click the composer button/element ---
    try {
      activeComposer.click();
    } catch (err) {
      // Sometimes clickable element is nested or not the actual clickable layer
      const clickable =
        activeComposer.querySelector &&
        activeComposer.querySelector("button, a, span");
      if (clickable) {
        clickable.click();
      } else {
        console.warn("Could not click composer element directly:", err);
        return false;
      }
    }
    return true;
  } catch (err) {
    logTelemetry("open_composer_exception", { error: String(err) }, "ERROR");
    return false;
  }
}

/**
 * Convert markdown text to proper HTML for Facebook editor.
 * Supports bold, italic, underline, headings, lists, and line breaks.
 */
function convertMarkdownToHTML(markdown) {
  if (!markdown || typeof markdown !== 'string') return '';

  let html = markdown;

  // Convert headings first (must be at start of line)
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Convert bold (**text** or __text__)
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // Convert italic (*text* or _text_) - be careful not to match ** or __
  html = html.replace(/(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  html = html.replace(/(?<!_)_(?!_)([^_]+)(?<!_)_(?!_)/g, '<em>$1</em>');

  // Convert underline (~~text~~)
  html = html.replace(/~~([^~]+)~~/g, '<u>$1</u>');

  // Convert unordered lists
  html = html.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => {
    return '<ul>' + match + '</ul>';
  });

  // Convert ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  // Wrap consecutive <li> that aren't already in <ul>
  html = html.replace(/(<li>.*<\/li>(?:\n<li>.*<\/li>)*)/g, (match) => {
    if (!match.includes('<ul>') && !match.includes('<ol>')) {
      return '<ol>' + match + '</ol>';
    }
    return match;
  });

  // Convert line breaks
  html = html.replace(/\n\n+/g, '<br><br>');
  html = html.replace(/\n/g, '<br>');

  return html;
}

/**
 * Convert inline markdown (**bold**, *italic*) to DOM nodes,
 * using <strong> for bold and <em> for italic.
 */
function parseMarkdownToNodes(text) {
  const fragment = document.createDocumentFragment();
  let pos = 0;
  // Capture **bold** in group 2, *italic* in group 3
  const regex = /(\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Add any text before this match
    const beforeText = text.substring(pos, match.index);
    if (beforeText) {
      fragment.appendChild(document.createTextNode(beforeText));
    }

    if (match[2]) {
      // **bold** → <strong>
      const strong = document.createElement("strong");
      strong.textContent = match[2];
      fragment.appendChild(strong);
    } else if (match[3]) {
      // *italic* → <em>
      const em = document.createElement("em");
      em.textContent = match[3];
      fragment.appendChild(em);
    }

    pos = regex.lastIndex;
  }

  // Add any trailing text
  const afterText = text.substring(pos);
  if (afterText) {
    fragment.appendChild(document.createTextNode(afterText));
  }

  return fragment;
}

// Attempt to click the Post button, retrying a few times before showing fallback

// Helper function to convert HTML to plain text, preserving line breaks

function smartFind(selectorHint) {
  const hint = selectorHint.toLowerCase();

  // Gather candidate elements: contenteditable textboxes and textareas/inputs
  const candidates = Array.from(
    document.querySelectorAll(
      "div[contenteditable='true'][role='textbox'], textarea, input"
    )
  ).filter((el) => el.offsetParent !== null); // only visible ones

  let best = { el: null, score: 0 };

  for (const el of candidates) {
    const score = computeElementScore(el, hint);
    if (score > best.score) {
      best = { el, score };
    }
  }

  // Only return if it looks good enough (e.g. score > 0.6)
  if (best.score >= 0.6) {
    return best.el;
  }
  return null;
}

/**
 * 2. Scoring heuristic: looks at innerText, aria-label, placeholder, name, title.
 */
function computeElementScore(el, hint) {
  const text = (el.innerText || "").toLowerCase();
  const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
  const placeholder = (el.getAttribute("placeholder") || "").toLowerCase();
  const name = (el.getAttribute("name") || "").toLowerCase();
  const title = (el.getAttribute("title") || "").toLowerCase();

  let score = 0;
  if (text.includes(hint)) score += 1;
  if (ariaLabel.includes(hint)) score += 1;
  if (placeholder.includes(hint)) score += 1;
  if (name.includes(hint)) score += 0.5;
  if (title.includes(hint)) score += 0.5;

  // Normalize by max possible (3.0)
  return Math.min(score / 3, 1);
}

function htmlToPlainTextWithLineBreaks(html) {
  if (typeof html !== "string") return "";

  let tempDiv = document.createElement("div");

  // Replace <br> tags with a unique placeholder
  let Chtml = html.replace(/<br\s*\/?>/gi, "||BR||");
  tempDiv.innerHTML = Chtml;

  let textSegments = [];

  function extractText(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      textSegments.push(node.textContent);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tagName = node.tagName.toLowerCase();

      for (const child of node.childNodes) {
        extractText(child);
      }

      if (
        [
          "p",
          "div",
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
          "li",
          "blockquote",
          "hr",
          "pre",
          "address",
          "article",
          "aside",
          "dd",
          "dl",
          "dt",
          "fieldset",
          "figcaption",
          "figure",
          "footer",
          "form",
          "header",
          "main",
          "nav",
          "ol",
          "section",
          "table",
          "tr",
          "ul",
        ].includes(tagName)
      ) {
        if (
          textSegments.length > 0 &&
          textSegments[textSegments.length - 1] !== "||BR||" &&
          !textSegments[textSegments.length - 1].endsWith("\n")
        ) {
          textSegments.push("\n");
        } else if (
          textSegments.length === 0 ||
          textSegments[textSegments.length - 1] === "||BR||"
        ) {
          textSegments.push("\n");
        }
      }
    }
  }

  extractText(tempDiv);

  let rawText = textSegments.join("");

  // Replace BR placeholder with actual newlines
  rawText = rawText.replace(/\|\|BR\|\|/g, "\n");

  // Decode HTML entities
  tempDiv.innerHTML = rawText;
  let decodedText = tempDiv.textContent;

  // Normalize newlines
  decodedText = decodedText.replace(/(\r\n|\r|\n)\s*(\r\n|\r|\n)+/g, "\n\n");
  decodedText = decodedText.trim();

  // Detect URLs and put each on its own line with blank lines around
  decodedText = decodedText.replace(
    /\bhttps?:\/\/[^\s<>"']+/gi,
    (url) => `\n${url}\n\n`
  );

  return decodedText;
}

function dataURItoBlob(dataURI) {
  const byteString = atob(dataURI.split(",")[1]);
  const mimeString = dataURI.split(",")[0].split(":")[1].split(";")[0];

  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);

  for (let i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i);
  }

  return new Blob([ab], { type: mimeString });
}

/**
 * In content.js
 *
 * Fetch multiple videos from the background’s IndexedDB.
 * Expects your background.js to handle { action: "get_video", id }
 * and respond with { success: true, blob } or { success: false }.
 */
function fetchVideosByIds(ids) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "video-stream" });
    const videos = {};
    const buffers = {};
    const types = {};

    // initialize buffers
    ids.forEach((id) => {
      buffers[id] = [];
    });

    port.onMessage.addListener((msg) => {
      const { id, chunk, type, done, error } = msg;

      if (error) {
        reject(new Error(error));
        port.disconnect();
        return;
      }

      if (chunk) {
        // accumulate
        buffers[id].push(Uint8Array.from(chunk));
        if (!types[id]) types[id] = type; // store MIME type
        // ack to background so it sends next slice
        port.postMessage({ id, received: true });
      }

      if (done) {
        // create Blob using the stored type
        const blobType = types[id] || type || "video/mp4";
        const blob = new Blob(buffers[id], { type: blobType });
        videos[id] = { blob, type: blobType };

        // check if all videos are received
        if (Object.keys(videos).length === ids.length) {
          port.disconnect();
          resolve(videos);
        }
      }
    });

    // kick off video streaming
    port.postMessage({ action: "get_videos_by_ids", ids });
  });
}

/**
 * Map MIME types to file extensions
 * @param {string} mimeType - The MIME type (e.g., "image/jpeg", "image/png")
 * @returns {string} - The file extension (e.g., ".jpg", ".png")
 */
function getFileExtensionFromMime(mimeType) {
  const mimeToExt = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/x-icon': '.ico',
    'image/heif': '.heif',
    'image/heic': '.heic',
    'video/mp4': '.mp4',
    'video/mpeg': '.mpeg',
    'video/quicktime': '.mov',
    'video/x-m4v': '.m4v',
    'video/x-matroska': '.mkv',
    'video/webm': '.webm',
    'video/ogg': '.ogv',
  };
  
  // Return exact match if found
  if (mimeToExt[mimeType]) {
    return mimeToExt[mimeType];
  }
  
  // Fallback: check if it's a video or image and use a generic extension
  if (mimeType.includes('video')) {
    return '.mp4';
  }
  if (mimeType.includes('image')) {
    // Default to jpg for generic image types
    return '.jpg';
  }
  
  // Ultimate fallback
  return '.bin';
}

async function insertImage(imageData, context = "post") {
  try {
    imageData = imageData.base64;

    // Try to find the "Photo/video" button (supporting multilingual)
    const photoVideoButton =
      document.querySelector('div[aria-label="Photo/video"][role="button"]') ||
      document.querySelector('div[aria-label="Fénykép/videó"][role="button"]');

    if (photoVideoButton) {
      photoVideoButton.click();
      await sleep(1);
    }

    // Select the file input element - be more flexible with selectors
    // Support multiple input types and attributes for better compatibility
    let websiteInput = document.querySelector(
      'input[type="file"].x1s85apg[accept="image/*,image/heif,image/heic,video/*,video/mp4,video/x-m4v,video/x-matroska,.mkv"]'
    );
    
    // Fallback: look for any file input that accepts videos or images
    if (!websiteInput) {
      websiteInput = document.querySelector(
        'input[type="file"][accept*="video"], input[type="file"][accept*="image"]'
      );
    }
    
    // Last resort: find any file input in the composer area
    if (!websiteInput) {
      websiteInput = document.querySelector('input[type="file"]');
    }

    if (!websiteInput) {
      console.warn("[insertImage] No file input element found");
      return false;
    }

    await sleep(1);

    try {
      // Convert base64 to Blob
      const blob = dataURItoBlob(imageData);
      await sleep(1);

      // Detect MIME type from base64
      const mime = imageData.split(",")[0].split(":")[1].split(";")[0];
      // Dynamically get the correct file extension based on MIME type
      const ext = getFileExtensionFromMime(mime);

      // Create File from Blob with proper MIME type
      const file = new File([blob], `upload${ext}`, { type: mime });

      // Create DataTransfer and assign the file
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      websiteInput.files = dataTransfer.files;

      // Dispatch multiple events to ensure Facebook processes the file
      websiteInput.dispatchEvent(new Event("change", { bubbles: true }));
      websiteInput.dispatchEvent(new Event("input", { bubbles: true }));
      
      // For videos, wait a bit longer for processing
      if (mime.includes("video")) {
        await sleep(2);
      }
      
      return true; // ✅ Only return true when completely successful
    } catch (error) {
      console.error("[insertImage] Error processing file:", error);
      return false;
    }
  } catch (error) {
    console.error("[insertImage] Outer error:", error);
    return false;
  }
}

// ============================================================
// Helper functions for preview detection and keystroke simulation
// ============================================================

/**
 * Check if a preview exists in the composer
 * Supports images and videos including vertical videos
 */
function previewPresent() {
  try {
    // Look for image/video previews in the composer area
    const previews = document.querySelectorAll(
      'img[src*="data:"], video, [data-testid*="preview"], [role="img"]'
    );
    
    // Check if any previews are visible and non-empty
    for (const preview of previews) {
      const rect = preview.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        // For images, check if they have data
        if (preview.tagName === 'IMG' && preview.src) {
          return true;
        }
        // For videos, check if they have src and are ready
        if (preview.tagName === 'VIDEO' && preview.src) {
          return true;
        }
        // For other preview elements
        if (preview.tagName !== 'IMG' && preview.tagName !== 'VIDEO') {
          const style = window.getComputedStyle(preview);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            return true;
          }
        }
      }
    }
    
    // Additional check for Facebook's specific preview containers
    const fbPreviews = document.querySelectorAll(
      '.x1qx5ct2, .x1beo9mf, [aria-label*="preview"], [data-testid*="attachment"]'
    );
    
    for (const preview of fbPreviews) {
      const rect = preview.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const style = window.getComputedStyle(preview);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          return true;
        }
      }
    }
    
    return false;
  } catch (e) {
    console.warn("[previewPresent] Error checking for preview:", e);
    return false;
  }
}

/**
 * Simulate a keystroke to trigger editor updates
 * Sends space then backspace to nudge the editor without leaving visible changes
 */
function nudgeWithKeystroke(element) {
  try {
    if (!element) return;
    
    // Simulate space press
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: " ",
        code: "Space",
        keyCode: 32,
        bubbles: true,
        cancelable: true,
      })
    );
    
    element.dispatchEvent(
      new KeyboardEvent("keypress", {
        key: " ",
        code: "Space",
        keyCode: 32,
        bubbles: true,
        cancelable: true,
      })
    );
    
    element.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: " ",
        code: "Space",
        keyCode: 32,
        bubbles: true,
        cancelable: true,
      })
    );
    
    // Simulate backspace
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Backspace",
        code: "Backspace",
        keyCode: 8,
        bubbles: true,
        cancelable: true,
      })
    );
    
    element.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Backspace",
        code: "Backspace",
        keyCode: 8,
        bubbles: true,
        cancelable: true,
      })
    );
    
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  } catch (e) {
    console.warn("[nudgeWithKeystroke] Error sending keystroke:", e);
  }
}

/**
 * Add text to an element safely
 * Uses insertText command or fallback to other methods
 */
function addText(element, text) {
  try {
    if (!element || !text) return;
    
    // Try using insertText command first
    if (document.execCommand) {
      try {
        document.execCommand("insertText", false, text);
        return;
      } catch (e) {
        // Fallback if insertText fails
      }
    }
    
    // Fallback: simulate typing by setting value
    if (element.value !== undefined) {
      element.value += text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (element.textContent !== undefined) {
      element.textContent += text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
  } catch (e) {
    console.warn("[addText] Error adding text:", e);
  }
}

/**
 * Check if any video uploads are currently in progress
 * Looks for progress bars and upload indicators in the DOM
 */
function isVideoUploading() {
  try {
    // Check for progress bar with aria-label="Uploading video"
    const progressBars = document.querySelectorAll('[role="progressbar"][aria-label*="Uploading"]');
    for (const bar of progressBars) {
      const progress = parseInt(bar.getAttribute('aria-valuenow') || '0', 10);
      const rect = bar.getBoundingClientRect();
      // If visible and progress < 100, upload is in progress
      if (rect.width > 0 && rect.height > 0 && progress < 100) {
        console.log(`[isVideoUploading] Found uploading video: ${progress}%`);
        return true;
      }
    }
    
    // Check for progress bar class patterns used by Facebook
    const fbProgressBars = document.querySelectorAll('._1_bj[role="progressbar"], .x1ebt8du[role="progressbar"]');
    for (const bar of fbProgressBars) {
      const rect = bar.getBoundingClientRect();
      const opacity = window.getComputedStyle(bar).opacity;
      // If visible (opacity > 0), upload is in progress
      if (rect.width > 0 && rect.height > 0 && parseFloat(opacity) > 0) {
        const progress = parseInt(bar.getAttribute('aria-valuenow') || '0', 10);
        console.log(`[isVideoUploading] Found FB progress bar: ${progress}%`);
        return true;
      }
    }
    
    // Check for video elements with blob URLs (still processing)
    const videoElements = document.querySelectorAll('video[src^="blob:"]');
    for (const video of videoElements) {
      const rect = video.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        // Check if there's a sibling or parent with upload indicators
        const parent = video.closest('.x6s0dn4, .x1mzt3pk, [class*="upload"]');
        if (parent) {
          const progressInParent = parent.querySelector('[role="progressbar"], [class*="progress"]');
          if (progressInParent) {
            console.log('[isVideoUploading] Found video with progress indicator');
            return true;
          }
        }
      }
    }
    
    return false;
  } catch (e) {
    console.warn('[isVideoUploading] Error checking upload status:', e);
    return false;
  }
}

/**
 * Wait for all video uploads to complete
 * Monitors progress bars and upload indicators until all videos are uploaded
 * @param {number} maxWaitSeconds - Maximum time to wait in seconds (default: 300 = 5 minutes)
 * @param {number} pollIntervalMs - How often to check in milliseconds (default: 500ms)
 * @returns {Promise<boolean>} - Returns true if uploads completed, false if timed out
 */
async function waitForVideoUploadsComplete(maxWaitSeconds = 300, pollIntervalMs = 500) {
  const startTime = Date.now();
  const maxWaitMs = maxWaitSeconds * 1000;
  
  console.log('[waitForVideoUploads] Starting to monitor video uploads...');
  
  return new Promise((resolve) => {
    let lastProgress = -1;
    let sameProgressCount = 0;
    
    const checkInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      
      // Check if we've exceeded max wait time
      if (elapsed > maxWaitMs) {
        console.warn(`[waitForVideoUploads] Timeout after ${maxWaitSeconds}s`);
        clearInterval(checkInterval);
        resolve(false);
        return;
      }
      
      // Check if upload is still in progress
      if (!isVideoUploading()) {
        console.log('[waitForVideoUploads] All video uploads complete!');
        clearInterval(checkInterval);
        resolve(true);
        return;
      }
      
      // Get current progress to detect stuck uploads
      const progressBars = document.querySelectorAll('[role="progressbar"][aria-valuenow]');
      let currentProgress = -1;
      for (const bar of progressBars) {
        const progress = parseInt(bar.getAttribute('aria-valuenow') || '0', 10);
        if (progress > currentProgress) {
          currentProgress = progress;
        }
      }
      
      // Detect stuck uploads (same progress for 10+ checks)
      if (currentProgress === lastProgress && currentProgress >= 0) {
        sameProgressCount++;
        if (sameProgressCount > 10) {
          console.warn(`[waitForVideoUploads] Upload appears stuck at ${currentProgress}%`);
          // Continue waiting but log warning
        }
      } else {
        sameProgressCount = 0;
      }
      
      lastProgress = currentProgress;
      
      // Log progress every 2 seconds
      if (elapsed % 2000 < pollIntervalMs) {
        console.log(`[waitForVideoUploads] Still uploading... ${currentProgress}% (${Math.floor(elapsed / 1000)}s elapsed)`);
      }
    }, pollIntervalMs);
  });
}



function reconstructBlobs() {
  const blobs = [];

  Object.values(receivedItems).forEach(({ key, type, chunks }) => {
    const blob = new Blob(chunks, { type });
    blobs.push({ key, blob });
  });

  return blobs;
}

function blobToBase64(blob, type) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res({ base64: reader.result, type });
    reader.onerror = (e) => rej(e);
    reader.readAsDataURL(blob);
  });
}

function fetchSnapshotViaPort(snapshotId) {
  return new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: "snapshotPort" });
    port.postMessage({ action: "fetchSnapshotItems", snapshotId });

    const receivedItems = [];
    let chunksCompleted = 0;
    let totalExpectedItems = null;

    port.onMessage.addListener(async (msg) => {
      if (msg.action === "receiveChunk") {
        const { itemIndex, index, total, key, type, chunk } = msg;

        if (!receivedItems[itemIndex]) {
          receivedItems[itemIndex] = {
            key,
            type,
            chunks: [],
            totalChunks: total,
          };
        }

        receivedItems[itemIndex].chunks[index] = new Uint8Array(chunk);
      }

      if (msg.action === "allChunksSent") {
        totalExpectedItems = msg.itemsCount;

        const blobs = receivedItems.map((item) => ({
          blob: new Blob(item.chunks, { type: item.type }),
          key: item.key,
        }));

        // Process each blob sequentially
        for (const el of blobs) {
          const video = await blobToBase64(el.blob, el.blob.type);
          const success = await insertImage(video, "post");
          await sleep(4);
        }

        resolve(true); // Resolve once all done
      }
    });
  });
}

// content_fixed.js
// Updated: fixes the return-type mismatch between findPublicPostComposer() and injectIntoComposer(),
// and adds defensive checks before calling DOM methods like focus().
async function findPublicPostComposer({
  timeoutMs = 5000,
  root = document.body,
} = {}) {
  const normalize = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\u2026/g, "...") // normalize ellipsis char to three dots
      .replace(/[^\S\r\n]+/g, " ") // collapse whitespace
      .trim();

  const placeholders = [
    "create a public post",
    "what's on your mind",
    "write something",
    "create post",
    "create a post",
    "public post",
    "write a post",
    "post",
    // localized examples
    "créer une publication publique",
    "crear una publicación pública",
    "erstellen sie einen öffentlichen beitrag",
    "criar uma publicação pública",
    "creare un post pubblico",
    "创建公开帖子",
    "建立公開貼文",
    "สร้างโพสต์สาธารณะ",
    "パブリック投稿を作成",
    "공개 게시물 만들기",
    "पब्लिक पोस्ट बनाएँ",
  ].map(normalize);

  const isPlaceholderMatch = (text) => {
    if (!text) return false;
    const n = normalize(text);
    // match if placeholder text contains any of our well-known phrases
    return placeholders.some((ph) => ph.length >= 2 && n.includes(ph));
  };

  // Candidate selectors (comma-separated - valid CSS)
  const editorSelectors = [
    "div[contenteditable='true'][role='textbox'][data-lexical-editor='true']",
    "div[contenteditable='true'][role='textbox'][aria-placeholder]",
    "div[contenteditable='true'][role='textbox']",
    ".notranslate[contenteditable='true']",
  ].join(", ");

  function inspectCandidate(el) {
    try {
      if (!el || el.nodeType !== 1) return null;

      // Require placeholder text to match, not just existence of aria-placeholder
      const ap =
        el.getAttribute("aria-placeholder") || el.getAttribute("aria-label");
      if (ap && isPlaceholderMatch(ap)) {
        return { editor: el, placeholderNode: el, placeholderText: ap };
      }

      // 2) visible placeholder in aria-hidden / sibling nodes
      let ancestor = el;
      for (
        let depth = 0;
        depth < 4 && ancestor;
        depth++, ancestor = ancestor.parentElement
      ) {
        const hiddenCandidates = Array.from(
          ancestor.querySelectorAll(
            '[aria-hidden="true"], [data-testid="placeholder"], .xi81zsa, .placeholder, [role="presentation"]'
          )
        );
        for (const hidden of hiddenCandidates) {
          const txt = (hidden.textContent || hidden.innerText || "").trim();
          if (isPlaceholderMatch(txt)) {
            return {
              editor: el,
              placeholderNode: hidden,
              placeholderText: txt,
            };
          }
        }
      }

      // 3) empty editor + visible sibling placeholder
      if (
        (el.textContent || "").trim() === "" ||
        el.querySelector("p:empty, p > br")
      ) {
        const parent = el.parentElement;
        if (parent) {
          const visibleHint = Array.from(parent.querySelectorAll("div, span"))
            .map((n) => (n.textContent || n.innerText || "").trim())
            .find((txt) => isPlaceholderMatch(txt));
          if (visibleHint) {
            return {
              editor: el,
              placeholderNode: parent,
              placeholderText: visibleHint,
            };
          }
        }
      }
    } catch (err) {
      console.warn("inspectCandidate error", err);
    }
    return null;
  }

  // Fast scan first (in case the element is already present)
  try {
    const candidates = Array.from(document.querySelectorAll(editorSelectors));
    for (const c of candidates) {
      const found = inspectCandidate(c);
      if (found) return found; // returns an object {editor, placeholderNode, placeholderText}
    }

    // Also scan for visible placeholder text nodes anywhere, then walk to nearby editor
    const textHints = Array.from(document.querySelectorAll("div, span")).filter(
      (n) => (n.textContent || "").length < 200
    );
    for (const node of textHints) {
      if (isPlaceholderMatch(node.textContent || node.innerText)) {
        const editable =
          node
            .closest("div")
            ?.querySelector("div[contenteditable='true'][role='textbox']") ||
          node
            .closest("article, section, div")
            ?.querySelector("div[contenteditable='true'][role='textbox']");
        if (editable) {
          const found = inspectCandidate(editable);
          if (found) return found;
        }
      }
    }
  } catch (err) {
    console.warn("initial findPublicPostComposer scan failed", err);
  }

  // If not found: observe for mutations up to timeout
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      // on timeout, resolve null (not a truthy object) so callers can check easily
      observer.disconnect();
      resolve(null);
    }, timeoutMs);

    const observer = new MutationObserver((mutations) => {
      try {
        // prefer cheap queries: look for editors quickly
        const nodes = Array.from(root.querySelectorAll(editorSelectors));
        for (const n of nodes) {
          const ok = inspectCandidate(n);
          if (ok) {
            clearTimeout(timeout);
            observer.disconnect();
            return resolve(ok);
          }
        }

        // incremental: if placeholders appear as text nodes, check near them
        const possibleHints = Array.from(
          root.querySelectorAll('[aria-hidden="true"], div, span')
        ).filter((node) => {
          const text = (node.textContent || node.innerText || "").trim();
          return isPlaceholderMatch(text);
        });
        for (const hint of possibleHints) {
          const editable =
            hint
              .closest("div")
              ?.querySelector("div[contenteditable='true'][role='textbox']") ||
            hint
              .closest("article, section, div")
              ?.querySelector("div[contenteditable='true'][role='textbox']");
          if (editable) {
            const ok = inspectCandidate(editable);
            if (ok) {
              clearTimeout(timeout);
              observer.disconnect();
              return resolve(ok);
            }
          }
        }
      } catch (err) {
        console.warn("MutationObserver callback error", err);
      }
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    // As a safety, do a tiny re-check after starting observation (catch fast renders)
    setTimeout(() => {
      const nodes = Array.from(root.querySelectorAll(editorSelectors));
      for (const n of nodes) {
        const ok = inspectCandidate(n);
        if (ok) {
          clearTimeout(timeout);
          observer.disconnect();
          return resolve(ok);
        }
      }
    }, 50);
  });
}

async function injectIntoComposer(
  html,
  images = [],
  video_ids = [],
  scheduled = false,
  background = null,
  snapShotId = null
) {
  const injectId = Date.now() + "-" + Math.floor(Math.random() * 10000);
  console.debug("[inject] entry", { id: injectId, htmlPreview: (html || "").substr(0, 120), images, video_ids, scheduled });
  console.log("Images", images);
  await sleep(0.5);

  let TimeTaken = 0;
  let inputElement = null; // should be a DOM Element when we're done
  let inputTypeDetected = "unknown";

  // ----- STEP 0: AI-ASSISTED HEURISTIC LOOKUP (awaited) -----
  try {
    let smart = await smartFind?.("post"); // await smartFind if it exists
    if (smart) {
      // smartFind may return {editor: Element, ...} or the Element itself
      if (smart.editor instanceof Element) {
        inputElement = smart.editor;
        inputTypeDetected = "smart_find_object";
      } else if (smart instanceof Element) {
        inputElement = smart;
        inputTypeDetected = "smart_find_element";
      }
    }
  } catch (err) {
    // ignore smartFind errors and proceed to fallback selectors
    inputElement = null;
  }

  // ----- STEP 1: IMAGE SECTION (only if images array has items) -----
  if (
    !inputElement &&
    ((images && images.length > 0) || (Array.isArray(video_ids) && video_ids.length > 0))
  ) {
    // safer selectors for photo/video buttons (locale tolerant)
    const imagesButton = document.querySelector(
      'div[aria-label*="Photo"],div[aria-label*="photo"],button[aria-label*="Photo"],button[aria-label*="photo"], [data-testid="media-attachment"], [aria-label*="video"], [aria-label*="vidéo"]'
    );

    // insert images if we have a button (optional -- depends on how insertImage works)
    for (let i = 0; i < images.length; i++) {
      await sleep(1.2);
      try {
        await insertImage(images[i], "post");
      } catch (e) {
        console.warn("insertImage failed for index", i, e);
      }
    }

    if (scheduled && typeof snapShotId === "string" && snapShotId.length > 0) {
      // make sure receivedItems exists (don't use undeclared variable)
      // if receivedItems should be global, define it somewhere else; otherwise use a local object
      const _receivedItems = {};
      await fetchSnapshotViaPort?.(snapShotId).catch(() => { });
    } else {
      for (let i = 0; i < (video_ids || []).length; i++) {
        await sleep(1.5);
        const videoMap = await fetchVideosByIds?.([video_ids[i]]).catch(
          () => ({})
        );
        const videoList = Object.values(videoMap || {});
        for (const el of videoList) {
          const video = await blobToBase64?.(el.blob, el.type).catch(
            () => null
          );
          if (video) {
            const success = await insertImage(video, "post").catch(() => false);
            // Wait longer for video upload to initialize
            await sleep(2);
          }
        }
      }
    }
  }

  // ----- SEARCH STRATEGIES (kept but safer) -----
  // 1. notranslate specific
  inputElement =
    inputElement ||
    document.querySelector(".notranslate._5rpu[contenteditable='true']");
  if (inputElement) {
    inputTypeDetected = "notranslate_5rpu";
  }

  // 2. specific lexical editor composers (uses findPublicPostComposer)
  if (!inputElement) {
    const composer = await findPublicPostComposer();
    // composer is either null or {editor, placeholderNode, placeholderText}
    if (composer && composer.editor instanceof Element) {
      inputElement = composer.editor;
      inputTypeDetected = "lexical_main_specific_class";
    }
  }

  // 3. general lexical editors prioritized by label and size
  if (!inputElement) {
    const mainPostInputs = Array.from(
      document.querySelectorAll(
        "div[contenteditable='true'][role='textbox'][data-lexical-editor='true'], div[contenteditable='true'][role='textbox']"
      )
    ).filter((el, idx, arr) => arr.indexOf(el) === idx); // remove duplicates (safety)
    let candidateInputs = mainPostInputs.filter(
      (el) =>
        !el.closest('div[aria-label*="comment"], div[aria-label*="Comment"]')
    );
    candidateInputs.sort((a, b) => {
      const aLabel = (a.getAttribute("aria-label") || "").toLowerCase();
      const bLabel = (b.getAttribute("aria-label") || "").toLowerCase();
      const postKeywords = [
        "what's on your mind",
        "create a public post",
        "write something",
        "írj",
      ];
      const aIsPost = postKeywords.some((k) => aLabel.includes(k));
      const bIsPost = postKeywords.some((k) => bLabel.includes(k));
      if (aIsPost && !bIsPost) return -1;
      if (!aIsPost && bIsPost) return 1;
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return bRect.width * bRect.height - aRect.width * aRect.height;
    });
    if (candidateInputs.length) {
      inputElement = candidateInputs[0];
      inputTypeDetected = "lexical_prioritized";
    }
  }

  // 4. fallback selectors (safer, fewer fragile classes)
  if (!inputElement) {
    inputElement =
      document.querySelector(
        "div[aria-label='Create a public post…'][contenteditable='true'][role='textbox'], div[aria-label*='Create a public post'][contenteditable='true'], div[data-lexical-editor='true'][contenteditable='true']"
      ) ||
      document.querySelector("div[contenteditable='true'][role='textbox']");
    if (inputElement) {
      inputTypeDetected =
        inputElement.getAttribute("data-lexical-editor") === "true"
          ? "lexical_fallback"
          : "standard_fallback";
    }
  }

  // 5. last-resort: try to collect multiple possible inputs and pick largest
  if (!inputElement) {
    // collect candidates from multiple selectors
    const selectors = [
      "div[contenteditable='true'][role='textbox'][data-lexical-editor='true'][aria-placeholder]",
      "div[contenteditable='true'][role='textbox'][data-lexical-editor='true']",
      "div[contenteditable='true'][role='textbox']",
    ];
    const nodes = selectors.flatMap((sel) =>
      Array.from(document.querySelectorAll(sel))
    );
    const filtered = nodes.filter(
      (el) =>
        !el.closest('div[aria-label*="comment"], div[aria-label*="Comment"]') &&
        el.offsetParent !== null
    );
    if (filtered.length > 0) {
      inputElement = filtered.reduce((largest, current) => {
        const lr = largest.getBoundingClientRect();
        const cr = current.getBoundingClientRect();
        return cr.width * cr.height > lr.width * lr.height ? current : largest;
      }, filtered[0]);
      inputTypeDetected =
        inputElement.getAttribute("data-lexical-editor") === "true"
          ? "lexical_largest"
          : "standard_largest";
    }
  }

  // timeout guard
  while (!inputElement && TimeTaken <= 15) {
    await sleep(1);
    TimeTaken += 1;
  }
  if (!inputElement || !(inputElement instanceof Element)) return false;

  // ----- PASTE / INSERT -----
  try {
    // Defensive focus: focus might throw if element is detached — guard it
    try {
      inputElement.focus();
    } catch (focusErr) {
      // try to set tabindex and focus again as last resort
      try {
        if (!inputElement.hasAttribute("tabindex"))
          inputElement.setAttribute("tabindex", "-1");
        inputElement.focus();
      } catch (e) {
        console.warn("focus failed on inputElement", e);
      }
    }

    try {
      inputElement.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "nearest",
      });
    } catch (e) {
      // ignore scrolling errors
    }

    await sleep(0.25);

    if (document.activeElement !== inputElement) {
      try {
        inputElement.focus();
        await sleep(0.15);
      } catch (e) {
        // if focus still fails, continue — some editors accept innerHTML changes
      }
    }
    if (document.activeElement !== inputElement) {
      // continue anyway, some editors don't set document.activeElement correctly
      // but we still need to ensure we can paste; so we won't return false yet
    }

    // Dispatch an input event (some editors listen to it)
    try {
      inputElement.dispatchEvent(
        new Event("input", { bubbles: true, composed: true })
      );
    } catch (e) {
      // ignore
    }

    // Content is already HTML with proper tags (strong, em, u, etc.)
    // Clean up any stray anchor tags but preserve all other HTML formatting
    const sanitizedHtml = html.replace(/<a[^>]*>(.*?)<\/a>/gi, "$1");

    // Try ClipboardEvent + DataTransfer first, but fallback gracefully
    let pasteSucceeded = false;
    try {
      // build clipboard payload with proper HTML formatting
      const dataTransfer = new DataTransfer();
      // Set both HTML and plain text for maximum compatibility
      dataTransfer.setData("text/html", sanitizedHtml);
      dataTransfer.setData(
        "text/plain",
        (htmlToPlainTextWithLineBreaks?.(sanitizedHtml) || "").trim()
      );

      console.log('[DEBUG] Clipboard data:', {
        hasHtml: dataTransfer.types.includes('text/html'),
        hasPlain: dataTransfer.types.includes('text/plain'),
        htmlLength: sanitizedHtml.length,
        userAgent: navigator.userAgent
      });

      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true,
      });

      // dispatch paste (do not touch innerHTML anywhere)
      inputElement.dispatchEvent(pasteEvent);
      pasteSucceeded = true;

      console.debug("[inject] paste dispatched", { id: injectId, pasteSucceeded });

      // timing constants (client requested behavior)
      const TOTAL_CAP_MS = 10000; // total cap (≈10s)
      const PRIMARY_TIMER_MS = 8000; // short timer (≈8s) used as safety net
      const NUDGE_WAIT_MS = 2000; // wait after nudge (≈2s)

      // helper: watch for preview using MutationObserver + quick poll (observer is primary)
      const watchForPreview = (timeoutMs) =>
        new Promise((resolve) => {
          if (previewPresent()) {
            resolve(true);
            return;
          }

          let finished = false;
          // primary: MutationObserver
          const mo = new MutationObserver(() => {
            try {
              if (previewPresent()) {
                if (!finished) {
                  finished = true;
                  mo.disconnect();
                  clearInterval(pollInterval);
                  clearTimeout(timer);
                  resolve(true);
                }
              }
            } catch (e) {
              // ignore and let timeout handle it
            }
          });

          // observe broad changes; this should be non-invasive to existing observers
          try {
            mo.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              characterData: true,
            });
          } catch (e) {
            // if observing body fails for some reason, fallback to polling only
          }

          // secondary: short polling (safe fallback, non-invasive)
          const pollInterval = setInterval(() => {
            try {
              if (previewPresent()) {
                if (!finished) {
                  finished = true;
                  mo.disconnect();
                  clearInterval(pollInterval);
                  clearTimeout(timer);
                  resolve(true);
                }
              }
            } catch (e) {
              // ignore
            }
          }, 150);

          // overall timeout for this watcher
          const timer = setTimeout(() => {
            if (!finished) {
              finished = true;
              try {
                mo.disconnect();
              } catch (e) { }
              clearInterval(pollInterval);
              resolve(false);
            }
          }, timeoutMs);
        });

      // Start the primary watcher immediately (it represents the MutationObserver path)
      const primaryWatcher = watchForPreview(TOTAL_CAP_MS);

      // Start a short safety timer (client asked that timer be a safety net, not primary)
      const primaryTimer = new Promise((resolve) =>
        setTimeout(() => resolve(false), PRIMARY_TIMER_MS)
      );

      // Race: if preview detected before primary timer ends -> proceed immediately.
      const previewBeforeTimer = await Promise.race([
        primaryWatcher,
        primaryTimer,
      ]);

      if (previewBeforeTimer) {
        // preview appeared before the 8s safety timer — proceed.
        // primaryWatcher has already resolved true and cleaned up its observer.
      } else {
        // safety timer expired with no preview signal -> perform fallback nudge,
        // but keep the primary watcher running for a short extra window.
        try {
          // nudge with keystroke (space -> backspace) using existing helper
          nudgeWithKeystroke(inputElement);
        } catch (e) {
          // ignore nudge errors — we'll still wait for the observer
        }

        // Wait up to NUDGE_WAIT_MS for preview to appear after nudge.
        // Note: primaryWatcher was started with TOTAL_CAP_MS, so it is still watching.
        // We'll also create a short watcher promise that times out after NUDGE_WAIT_MS.
        const postNudge = await Promise.race([
          primaryWatcher, // may still resolve true if preview appears
          new Promise((resolve) =>
            setTimeout(() => {
              resolve(false);
            }, NUDGE_WAIT_MS)
          ),
        ]);

        if (postNudge) {
          // preview appeared during the nudge window — proceed.
        } else {
          // final fallback: nothing detected within ~10s total (8s timer + 2s nudge window).
          // We intentionally do not mutate innerHTML or force insertion. Keep older logic intact.
          // Optionally, we can attempt the text-insert fallback (non-HTML) once more as a last resort
          // without touching innerHTML — keep this minimal and non-invasive.
          try {
            // Try the safe insertText fallback (will trigger beforeinput/input handlers where supported)
            addText(inputElement, " ");
            // remove the inserted space immediately via nudge to avoid leaving extra character
            nudgeWithKeystroke(inputElement);
          } catch (e) {
            // swallow any errors — we won't alter HTML or throw.
          }
        }
      }
    } catch (err) {
      // fallback - execCommand (deprecated but still works widely)
      try {
        console.debug("[inject] paste failed, trying execCommand", { id: injectId, err: String(err) });
        // document.execCommand("insertHTML", false, sanitizedHtml);
        pasteSucceeded = true;
      } catch (err2) {
        console.warn("Both paste strategies failed", err, err2);
      }
    }

    if (!pasteSucceeded) {
      // last-resort: set innerHTML directly if it's safe for your target editor
      try {
        console.debug("[inject] using innerHTML fallback", { id: injectId });
        // Only do this if inputElement is a plain element and not a complex widget
        if (typeof inputElement.innerHTML === "string") {
          inputElement.innerHTML = sanitizedHtml;
          pasteSucceeded = true;
        }
      } catch (e) {
        console.warn("direct innerHTML fallback failed", e);
      }
    }

    // Let the editor process the paste
    await sleep(pasteSucceeded ? 1.2 : 0.5);
    try {
      inputElement.dispatchEvent(
        new Event("input", { bubbles: true, composed: true })
      );
    } catch (e) { }

    // Optional: store a marker for intermediate progress without touching operationDone
    if (chrome?.storage?.local) {
      chrome.storage.local.set({ operationStage: "composer_prefilled" }, () => {
        if (chrome.runtime.lastError) {
          console.error("Storage error:", chrome.runtime.lastError);
        }
      });
    }

    // TEST MODE: Skip background and button click - just mark successful
    const TEST_MODE = true; // Set to false when uncommenting button click code below

    if (background) {
      await applyBackgroundStyle(background);
      await sleep(2);
    }

    // CRITICAL: Wait for all video uploads to complete before clicking post
    if (Array.isArray(video_ids) && video_ids.length > 0) {
      console.log(`[inject] Detected ${video_ids.length} video(s), waiting for uploads to complete...`);
      const uploadSuccess = await waitForVideoUploadsComplete(300, 500);
      if (!uploadSuccess) {
        console.warn('[inject] Video upload wait timed out, but continuing with post...');
      } else {
        console.log('[inject] All videos uploaded successfully!');
      }
      // Extra safety wait after upload completes
      await sleep(1);
    }

    // PRODUCTION MODE: Uncomment below to enable actual button click
    const clickedPost = await clickPostButtonWithRetry?.();
    if (!clickedPost) {
      console.error("[inject] Post button click failed");
      await new Promise((resolve) => {
        chrome.storage.local.set({ operationDone: "failed" }, resolve);
      });
      return false;
    }
    const completionObserved = await waitForPostCompletion?.(
      500,
      snapShotId,
      clickedPost,
      15000
    );
    if (!completionObserved) {
      console.warn("[inject] waitForPostCompletion timed out; continuing.");
    }

    // Mark as successful and close tab immediately
    console.log("[inject] Setting operationDone to successful");
    await new Promise((resolve) => {
      chrome.storage.local.set({ operationDone: "successful" }, () => {
        console.log("[inject] ✅ operationDone set - closing tab now");
        resolve();
      });
    });

    return true;
  } catch (error) {
    console.error("injectIntoComposer failed:", error);
    maybeCaptureSentryException(error, { phase: "injectIntoComposer" });
    return false;
  }
}

async function waitForPostCompletion(interval = 500, snapShotId, clickedPost, maxWaitMs = 15000) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      const el = document.contains(postButtonDOM);
      if (!el && clickedPost) {
        if (typeof snapShotId === "string" && snapShotId.length > 0) {
          chrome.runtime.sendMessage({
            action: "schedulePostDone",
            snapShotId: snapShotId,
          });
        }
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= maxWaitMs) {
        resolve(false);
        return;
      }
      setTimeout(check, interval);
    };
    check();
  });
}

const POST_TRANSLATIONS = [
  "Post", // English
  "Publier", // French
  "पोस्ट करें", // Hindi
  "Opublikuj", // Polish
  "Publicar", // Spanish
  "Postar", // Portuguese
  "Veröffentlichen", // German
  "Надіслати", // Ukrainian
  "نشر", // Arabic
  "게시", // Korean (Post/Publish)
  "投稿", // Japanese (Post)
  "发布", // Chinese (Publish)
];

function getPostButton() {
  const candidates = document.querySelectorAll('div[role="button"], button');
  for (const el of candidates) {
    const text = el.textContent.trim();
    if (POST_TRANSLATIONS.includes(text)) {
      return el;
    }
  }
  return null;
}

let postButtonDOM = null;

function clickPostButtonWithRetry(attempts = 10, delay = 500) {
  return new Promise((resolve) => {
    let tried = 0;
    const timer = setInterval(() => {
      // Try multiple strategies to find the post button
      let btn = getPostButton();

      // Fallback: look for button with post selector config
      if (!btn && config.postButtonSelector) {
        btn = document.querySelector(config.postButtonSelector);
      }

      // Fallback: look for ANY button with "Post" text (case-insensitive)
      if (!btn) {
        const allButtons = Array.from(document.querySelectorAll('button, div[role="button"]'));
        btn = allButtons.find(b => {
          const text = (b.textContent || b.innerText || '').trim().toLowerCase();
          return text === 'post' || text.includes('post');
        });
      }

      if (btn && !btn.disabled) {
        postButtonDOM = btn;
        console.log('[clickPost] Found post button, clicking it');
        try {
          btn.click();
          clearInterval(timer);
          resolve(true); // ✅ clicked successfully
        } catch (e) {
          console.error('[clickPost] Error clicking button:', e);
          if (++tried >= attempts) {
            clearInterval(timer);
            resolve(false);
          }
        }
      } else if (++tried >= attempts) {
        console.error('[clickPost] Post button not found or disabled after', attempts, 'attempts');
        showFallbackUI("Post button not found. The text may have been pasted but not posted.");
        logTelemetry(
          "post_button_retry_failed",
          { attempts, message: "Post button not found after retries." },
          "ERROR"
        );
        maybeCaptureSentryException(
          new Error("Post button not found after " + attempts + " attempts"),
          { phase: "clickPostButtonWithRetry", attempts: attempts }
        );
        clearInterval(timer);
        chrome.storage.local.set({ operationDone: "failed" }, () => {
          if (chrome.runtime.lastError) {
            console.error("Storage error:", chrome.runtime.lastError);
          }
        });
        resolve(false); // ❌ failed after retries
      }
    }, delay);
  });
}

// Observe for new posts being added and inject buttons and auto-expand
function setupObserver() {
  const observer = new MutationObserver((mutationsList) => {
    for (const mutation of mutationsList) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1) {
          if (node.matches && node.matches(config.postSelector)) {
            // injectLogButton(node);
            expandSeeMore(node);
          } else if (node.querySelector) {
            const posts = node.querySelectorAll(config.postSelector);
            posts.forEach((post) => {
              // injectLogButton(post);
              expandSeeMore(post);
            });
          }
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// Wait for feed element then call init()
function waitForFeedAndInit(retries = 10) {
  if (document.querySelector(config.postSelector)) {
    init();
  } else if (retries > 0) {
    setTimeout(() => waitForFeedAndInit(retries - 1), 500);
  } else {
    // logTelemetry(
    //   "feed_detection_failed",
    //   { message: "Feed element not found after retries." },
    //   "DOM_ERROR"
    // );
  }
}

// Display a fallback UI banner on critical failures
function showFallbackUI(
  message = "An unexpected error occurred. Please try reloading the page."
) {
  const banner = document.createElement("div");
  banner.textContent = message;
  Object.assign(banner.style, {
    position: "fixed",
    top: 0,
    left: 0,
    width: "100%",
    padding: "10px",
    backgroundColor: "#f44336",
    color: "white",
    textAlign: "center",
    zIndex: 99999,
  });
  document.body.appendChild(banner);
  logTelemetry("fallback_ui_displayed", { message }, "ERROR");
}

// Main entry point: inject buttons, auto-expand, and start observer
function init() {
  // injectButtonsIntoPosts();
  autoExpandOnLoad();
  setupObserver();
}

function isFacebookSite() {
  return window.location.hostname.includes("facebook.com");
}

if (isFacebookSite()) {
  // Kick off the script
  (async () => await loadConfig())();
}

// Enhanced minimalistic file picker with intuitive UI and loader
function showFilePicker() {
  // Prevent multiple overlays
  if (document.getElementById("filePickerOverlay")) return;

  // Inject HTML
  const overlayHTML = `
  <div id="filePickerOverlay" style="position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 2147483647; display: flex; align-items: center; justify-content: center;">
    <div style="background: #fff; border-radius: 12px; width: 380px; max-width: 90%; padding: 24px; font-family: 'Segoe UI', sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,0.2); text-align: center;">
      <h2 style="margin: 0 0 16px; font-size: 1.3rem; color: #222; display: flex; align-items: center; justify-content: center;"><svg xmlns=\"http://www.w3.org/2000/svg\" height=\"24\" viewBox=\"0 0 24 24\" width=\"24\" style=\"margin-right:8px;fill:#007bff\"><path d=\"M5 20h14v-2H5v2zm7-18L5.33 9h3.34v4h6.66V9h3.34L12 2z\"/></svg>Select Media</h2>
      <label for="fileInput" style="display: inline-flex; align-items: center; background: #007bff; color: #fff; padding: 10px 18px; border-radius: 6px; font-size: 0.95rem; cursor: pointer; transition: background 0.2s;"><svg xmlns=\"http://www.w3.org/2000/svg\" height=\"20\" viewBox=\"0 0 24 24\" width=\"20\" style=\"margin-right:6px;fill:#fff\"><path d=\"M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z\"/></svg>Choose Files</label>
      <input id="fileInput" type="file" accept="image/*,video/*" multiple style="display: none;" />
      <div id="fileList" style="margin:16px 0; max-height:140px; overflow-y:auto; text-align:left;"></div>
      <div id="statusMessage" style="min-height:24px; font-size:0.9rem; margin-bottom:12px; color:#000;"></div>
      <div style="display:flex; justify-content: space-between;">
        <button id="closeBtn" style="flex:1; margin-right:8px; padding:10px; background:#e0e0e0; color:#000; border:none; border-radius:6px; cursor:pointer; font-size:0.95rem; display:flex; align-items:center; justify-content:center;">
          <svg xmlns=\"http://www.w3.org/2000/svg\" height=\"18\" viewBox=\"0 0 24 24\" width=\"18\" style=\"margin-right:4px;fill:#555\"><path d=\"M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z\"/></svg>
          Close
        </button>
        <button id="selectBtn" style="flex:1; margin-left:8px; padding:10px; background:#28a745; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:0.95rem; display:flex; align-items:center; justify-content:center;">
          <svg xmlns=\"http://www.w3.org/2000/svg\" height=\"18\" viewBox=\"0 0 24 24\" width=\"18\" style=\"margin-right:4px;fill:#fff\"><path d=\"M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z\"/></svg>
          Upload
        </button>
      </div>
      <div id="loader" style="display:none; margin-top:16px;"><svg xmlns="http://www.w3.org/2000/svg" style="margin:auto; background:none; display:block;" width="40px" height="40px" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid">
            <circle cx="50" cy="50" fill="none" stroke="#007bff" stroke-width="10" r="35" stroke-dasharray="164.93361431346415 56.97787143782138"><animateTransform attributeName="transform" type="rotate" repeatCount="indefinite" dur="1s" values="0 50 50;360 50 50" keyTimes="0;1"></animateTransform></circle>
        </svg></div>
    </div>
  </div>
  `;
  document.body.insertAdjacentHTML("beforeend", overlayHTML);

  // References
  const overlay = document.getElementById("filePickerOverlay");
  const input = document.getElementById("fileInput");
  const fileList = document.getElementById("fileList");
  const closeBtn = document.getElementById("closeBtn");
  const selectBtn = document.getElementById("selectBtn");
  const statusMsg = document.getElementById("statusMessage");
  const loader = document.getElementById("loader");

  let selectedFiles = [];

  function dedupeFiles(files) {
    const map = new Map();
    files.forEach((file) => map.set(file.name + file.size, file));
    return Array.from(map.values());
  }

  function renderFileList() {
    fileList.innerHTML = "";
    selectedFiles.forEach((file, idx) => {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.justifyContent = "space-between";
      row.style.padding = "4px 0";
      const info = document.createElement("div");
      info.style.display = "flex";
      info.style.alignItems = "center";
      const icon = document.createElement("span");
      icon.style.marginRight = "8px";
      icon.style.fontSize = "1.2rem";
      icon.textContent = file.type.startsWith("image/") ? "🖼️" : "🎥";
      const name = document.createElement("span");
      name.textContent = file.name;
      name.style.fontSize = "0.9rem";
      name.style.color = "#000";
      info.append(icon, name);
      const remove = document.createElement("button");
      remove.innerHTML = "✖";
      remove.style.background = "none";
      remove.style.border = "none";
      remove.style.cursor = "pointer";
      remove.style.color = "#d00";
      remove.onclick = () => {
        selectedFiles.splice(idx, 1);
        renderFileList();
      };
      row.append(info, remove);
      fileList.append(row);
    });
  }

  function closePicker() {
    overlay?.remove();
  }
  closeBtn.addEventListener("click", closePicker);

  input.addEventListener("change", () => {
    selectedFiles = dedupeFiles(Array.from(input.files));
    renderFileList();
    input.value = "";
  });

  selectBtn.addEventListener("click", async () => {
    if (!selectedFiles.length) return;
    // Disable buttons and show loader
    closeBtn.disabled = true;
    selectBtn.disabled = true;
    closeBtn.style.cursor = "not-allowed";
    selectBtn.style.cursor = "not-allowed";
    loader.style.display = "block";
    statusMsg.textContent = "Uploading...";

    for (const file of selectedFiles) {
      const chunkSize = 1024 * 1024;
      const totalChunks = Math.ceil(file.size / chunkSize);
      const fileId = `${file.name}_${file.size}_${Date.now()}`;
      for (let i = 0; i < totalChunks; i++) {
        const blob = file.slice(i * chunkSize, (i + 1) * chunkSize);
        const base64 = await new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result.split(",")[1]);
          reader.readAsDataURL(blob);
        });
        await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            {
              action: "fileChunk",
              fileId,
              index: i,
              totalChunks,
              name: file.name,
              type: file.type,
              size: file.size,
              data: base64,
            },
            () => resolve()
          );
        });
      }
    }

    // Finished
    statusMsg.textContent =
      "Please open your extension to post. You can now use the media files.";
    loader.style.display = "none";
    selectBtn.style.display = "none";
    closeBtn.disabled = false;
    closeBtn.style.cursor = "pointer";
  });
}

// Function to capture and send a snapshot of the current state
function captureAndSendSnapshot(id, label, meta = {}) {
  chrome.storage.sync.get(["user"], (data) => {
    if (chrome.runtime.lastError) {
      console.error("Storage error (captureAndSendSnapshot):", chrome.runtime.lastError);
    }
    const userEmail = data?.user?.email || null;

    const snapshot = {
      id,
      label,
      timestamp: new Date().toISOString(),
      extensionVersion: chrome.runtime.getManifest().version,
      url: window.location.href,
      user: userEmail,
      keyElements: {
        postBox: document.querySelector("div > div > div")?.outerHTML || null,
        groupName: document.querySelector("h1")?.innerText || null,
      },
      ...meta,
    };

    chrome.runtime.sendMessage({
      action: "snapshot_log",
      payload: snapshot,
    });
  });
}

// ============================================================
// Background Style Application
// ============================================================

/**
 * Apply background/style to the post by clicking the palette and selecting a color.
 * @param {string|array} background - Color name(s) or selector(s) to apply
 */
async function applyBackgroundStyle(background) {
  if (!background) return false;

  const rawList = Array.isArray(background) ? background : [background];
  if (!rawList.length) return false;

  // Normalize incoming background items to friendly labels/strings.
  function normalizeItem(it) {
    if (!it && it !== 0) return "";
    if (typeof it === "string") return it.trim();
    if (typeof it === "number") return String(it);
    if (typeof it === "object") {
      // Prefer explicit `value`, then `id`, then `name`, then fallback to textColor or category
      return (
        (it.value && String(it.value)) ||
        (it.id && String(it.id)) ||
        (it.name && String(it.name)) ||
        (it.category && String(it.category)) ||
        (it.textColor && String(it.textColor)) ||
        ""
      ).trim();
    }
    return String(it).trim();
  }

  const list = rawList.map(normalizeItem).filter(Boolean);
  if (!list.length) return false;

  console.debug('[bg] Starting background application for:', list);

  // Selector mapping for colors
  const COLOR_MAP = {
    'purple-solid': 'div[aria-label*="Solid Purple" i]',
    'red-solid': 'div[aria-label*="Gradient, red blue" i]',
    'black': 'div[aria-label*="Solid black" i]',
    'purple-gradient': 'div[aria-label*="Gradient, purple magenta" i]',
    'orange-pink-gradient': 'div[aria-label*="Yellow and orange and pink" i]',
    'back': 'div[aria-label*="No background" i]'
  };

  // Helper: wait for element
  async function waitForElement(selector, timeout = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await new Promise(r => setTimeout(r, 150));
    }
    return null;
  }

  // Helper: safe click
  function safeClick(el) {
    if (!el) return false;
    try {
      el.click();
      return true;
    } catch (e) {
      try {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      } catch (e2) {
        console.warn('[bg] click failed:', e.message);
        return false;
      }
    }
  }

  // Helper: open palette
  async function openPalette() {
    console.debug('[bg] Attempting to open palette');
    // Try to find and click the palette/style opener button
    let opener = document.querySelector('.x165d6jo.x1kgmq87')?.querySelector('img');
    if (!opener) {
      opener = Array.from(document.querySelectorAll('button, img, div[role="button"]'))
        .find(el => {
          const label = (el.getAttribute('aria-label') || '').toLowerCase();
          return label.includes('style') || label.includes('background') || label.includes('color');
        });
    }
    if (opener) {
      console.debug('[bg] Found palette opener, clicking');
      safeClick(opener);
      await sleep(0.6);
      return true;
    }
    console.warn('[bg] Could not find palette opener');
    return false;
  }

  // Helper: click color
  async function clickColor(colorLabel) {
    console.debug('[bg] Clicking color (raw):', colorLabel);
    const label = (colorLabel || "").toString().trim();

    // Try exact key match (case-insensitive) in COLOR_MAP
    const keyMatch = Object.keys(COLOR_MAP).find(
      (k) => k.toLowerCase() === label.toLowerCase()
    );
    let selector = null;
    if (keyMatch) selector = COLOR_MAP[keyMatch];

    // If not found, try partial matches (either key contains label or label contains key)
    if (!selector) {
      const partial = Object.keys(COLOR_MAP).find((k) =>
        k.toLowerCase().includes(label.toLowerCase()) ||
        label.toLowerCase().includes(k.toLowerCase())
      );
      if (partial) selector = COLOR_MAP[partial];
    }

    // Fallback: build a generic aria-label contains selector using the normalized label
    if (!selector && label) selector = `div[aria-label*="${label}" i]`;

    if (!selector) {
      console.warn('[bg] No selector could be derived for color:', colorLabel);
      return false;
    }

    const el = await waitForElement(selector, 2500);
    if (el) {
      console.debug('[bg] Found color element, clicking using selector:', selector);
      return safeClick(el);
    }
    console.warn('[bg] Color not found for selector:', selector, 'label:', label);
    return false;
  }

  // Apply each color in sequence
  for (let i = 0; i < list.length; i++) {
    const color = String(list[i]).trim();
    if (!color) continue;

    console.debug(`[bg] Applying color ${i + 1}/${list.length}:`, color);

    // Open palette
    const opened = await openPalette();
    if (!opened) {
      console.warn(`[bg] Failed to open palette for color: ${color}`);
    }
    await sleep(0.3);

    // Click color
    const clicked = await clickColor(color);
    if (!clicked) {
      console.warn(`[bg] Failed to click color: ${color}`);
    }
    await sleep(0.5);
  }

  console.debug('[bg] Background application complete');
  return true;
}

// ── campaign_abandoned / feature_used relay from popup ───────────────────
chrome.runtime.onMessage.addListener(function (msg) {
  if (msg.action === "campaign_abandoned") {
    trackMP("campaign_abandoned", {
      reason: msg.reason || "user_closed",
      has_groups: !!msg.has_groups,
      has_content: !!msg.has_content,
    });
  }
  if (msg.action === "feature_used") {
    trackMP("feature_used", { feature_name: msg.feature_name || "unknown" });
  }
});

// Marker
window.__myExtensionContentLoaded = true;
