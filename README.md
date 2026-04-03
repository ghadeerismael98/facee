# Vela Browser — API & Internals Reference

A privacy-focused native macOS & iOS web browser with a full REST + WebSocket automation API. This document is for developers integrating with Vela via its API — it explains every endpoint and details what the browser does behind the scenes for fingerprint protection, proxy routing, content blocking, and more.

---

## Table of Contents

- [How Fingerprint Protection Works — The Deep Dive](#how-fingerprint-protection-works--the-deep-dive)
  - [What Is Browser Fingerprinting?](#what-is-browser-fingerprinting)
  - [How Vela Defeats It — Architecture Overview](#how-vela-defeats-it--architecture-overview)
  - [Multi-Profile Fingerprinting — How Each Profile Gets Its Own Identity](#multi-profile-fingerprinting--how-each-profile-gets-its-own-identity)
  - [The Seed System](#the-seed-system)
  - [Platform Coherence Engine](#platform-coherence-engine)
  - [Anti-Detection Layer](#anti-detection-layer)
  - [All Spoofed Fingerprint Vectors](#all-spoofed-fingerprint-vectors)
  - [Lazy vs Eager — Performance Strategy](#lazy-vs-eager--performance-strategy)
  - [How It Looks to Fingerprint Tests](#how-it-looks-to-fingerprint-tests)
- [Quick Start](#quick-start)
- [Authentication](#authentication)
- [Operating Modes — Headed, Hidden & Headless](#operating-modes--headed-hidden--headless)
  - [Headed Mode](#headed-mode)
  - [Hidden Mode](#hidden-mode)
  - [Headless Mode](#headless-mode)
  - [Mode Comparison Matrix](#mode-comparison-matrix)
- [API Endpoints](#api-endpoints)
  - [Status](#status)
  - [Tabs](#tabs)
  - [Page Automation](#page-automation)
  - [Windows](#windows)
  - [Profiles](#profiles)
  - [Bookmarks](#bookmarks)
  - [History](#history)
  - [Downloads](#downloads)
  - [User Agents](#user-agents)
  - [Fingerprint Control](#fingerprint-control)
  - [Content Blocking](#content-blocking)
  - [Passwords](#passwords)
  - [Cookies](#cookies)
  - [Redirect Traces](#redirect-traces)
- [WebSocket Events](#websocket-events)
- [What Happens Behind the Scenes](#what-happens-behind-the-scenes)
  - [The Full Page Load Pipeline](#the-full-page-load-pipeline)
  - [WebView Creation & Pooling](#webview-creation--pooling)
  - [Fingerprint Protection — Full Breakdown](#fingerprint-protection--full-breakdown)
    - [The Seeded PRNG Algorithm](#the-seeded-prng-algorithm)
    - [Injection Timing & Lazy Loading](#injection-timing--lazy-loading)
    - [What Gets Spoofed (All 16 Vectors)](#what-gets-spoofed-all-16-vectors)
    - [User Agent Client Hints](#user-agent-client-hints)
    - [CSS Media Query Spoofing](#css-media-query-spoofing)
  - [User Agent — More Than a Header](#user-agent--more-than-a-header)
  - [Proxy & Network Layer](#proxy--network-layer)
  - [Tor Integration — Full Lifecycle](#tor-integration--full-lifecycle)
  - [DNS Routing](#dns-routing)
  - [Profile Isolation — What Gets Separated](#profile-isolation--what-gets-separated)
  - [Profile Switching — What Happens Internally](#profile-switching--what-happens-internally)
  - [Content Blocking Engine — Compilation & Caching](#content-blocking-engine--compilation--caching)
  - [Cookie Consent Automation — How It Actually Works](#cookie-consent-automation--how-it-actually-works)
  - [Native Input Injection — The Coordinate Pipeline](#native-input-injection--the-coordinate-pipeline)
  - [Password Autofill — DOM Analysis & Multi-Step Login](#password-autofill--dom-analysis--multi-step-login)
  - [Download Interception & Management](#download-interception--management)
  - [Redirect Chain Capture](#redirect-chain-capture)
  - [Certificate Validation & HTTPS](#certificate-validation--https)
  - [Permission & Dialog Handling](#permission--dialog-handling)
  - [Session Persistence & Crash Recovery](#session-persistence--crash-recovery)
  - [Memory Management & Tab Suspension](#memory-management--tab-suspension)
  - [Performance Monitoring](#performance-monitoring)
  - [iCloud Sync — Full Mechanics](#icloud-sync--full-mechanics)
  - [Autocomplete & Suggestion Engine](#autocomplete--suggestion-engine)
  - [The Automation Server — Connection Lifecycle](#the-automation-server--connection-lifecycle)
  - [Event Broadcasting — How WebSocket Events Work](#event-broadcasting--how-websocket-events-work)
  - [Background Timers & Scheduled Tasks](#background-timers--scheduled-tasks)
- [Data Models](#data-models)
- [Security Notes](#security-notes)

---

## How Fingerprint Protection Works — The Deep Dive

This section explains the architecture and concepts behind Vela's fingerprint protection system — how it works, why it works, and how multiple profiles create distinct browser identities.

### What Is Browser Fingerprinting?

Browser fingerprinting is a tracking technique that identifies users without cookies. Websites run JavaScript that queries dozens of browser APIs — canvas rendering, WebGL GPU info, audio processing, screen dimensions, installed plugins, timezone, language, hardware specs — and combine all the results into a unique hash. This hash acts like a "digital fingerprint" that's the same every time you visit, even in incognito mode, even if you clear cookies.

The problem: most of these APIs return legitimate information that your browser needs to work properly. You can't just block them or return empty values — sites would break, and returning obviously fake data ("unknown GPU", 0 cores) is itself a fingerprint that screams "this person is hiding."

The challenge is to return **realistic, internally consistent fake values** that look like a real person on a real device — just a different person than you actually are.

### How Vela Defeats It — Architecture Overview

Vela's approach has three layers:

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: Anti-Detection                                         │
│  All overridden functions report [native code] when inspected.   │
│  Detection scripts can't tell anything was modified.             │
├─────────────────────────────────────────────────────────────────┤
│  Layer 2: Platform Coherence                                     │
│  The User Agent determines the platform. ALL spoofed values      │
│  are consistent with that platform — GPU, cores, touch,          │
│  plugins, screen, DPI, Chrome objects — everything matches.      │
├─────────────────────────────────────────────────────────────────┤
│  Layer 3: Seeded Randomization                                   │
│  A single seed drives a deterministic PRNG. Same seed = same     │
│  fingerprint every time. Different seed = different identity.    │
│  Canvas noise, GPU selection, navigator values — all derived.    │
└─────────────────────────────────────────────────────────────────┘
```

The entire system is injected as a single JavaScript payload at `document-start` — before the page's own `<script>` tags execute. By the time any page script checks `navigator.hardwareConcurrency` or draws a canvas, the overrides are already in place.

### Multi-Profile Fingerprinting — How Each Profile Gets Its Own Identity

This is the core design that makes Vela useful for multi-account workflows. Here's how it works:

```
Profile "Work"                    Profile "Shopping"
┌──────────────────────┐          ┌──────────────────────┐
│ Seed: 482917          │          │ Seed: 731204          │
│ UA: Chrome/Windows    │          │ UA: Chrome/macOS      │
│ Proxy: US proxy       │          │ Proxy: UK proxy       │
│ Timezone: New York    │          │ Timezone: London      │
│ Language: en-US       │          │ Language: en-GB       │
│ DNS: Cloudflare       │          │ DNS: Google           │
├──────────────────────┤          ├──────────────────────┤
│ Canvas hash: a3f7...  │          │ Canvas hash: 9c21...  │
│ GPU: RTX 4070 Ti      │          │ GPU: Apple M3 Pro     │
│ Audio hash: b82e...   │          │ Audio hash: 4f1a...   │
│ Cores: 16             │          │ Cores: 12             │
│ Memory: 32GB          │          │ Memory: 16GB          │
│ Screen: 1900x1060     │          │ Screen: 1912x1068     │
│ DPR: 1.25             │          │ DPR: 2                │
│ Platform: Win32       │          │ Platform: MacIntel    │
│ Vendor: Google Inc.   │          │ Vendor: Apple         │
│ Plugins: PDF Viewer   │          │ Plugins: (empty)      │
│ window.chrome: yes    │          │ window.chrome: no     │
│ Touch: 0 points       │          │ Touch: 0 points       │
│ Battery: 78%, charged │          │ Battery: 92%, charged │
├──────────────────────┤          ├──────────────────────┤
│ Cookies: isolated     │          │ Cookies: isolated     │
│ Cache: isolated       │          │ Cache: isolated       │
│ Storage: isolated     │          │ Storage: isolated     │
└──────────────────────┘          └──────────────────────┘
```

**Each profile is a completely separate browser identity.** A website seeing Profile "Work" and Profile "Shopping" has no way to know they're the same person on the same machine. The cookies are stored in separate data stores, the fingerprints are completely different, the IP addresses are different (different proxies), and even the timezone and language differ.

You can have tabs from both profiles open simultaneously. They share nothing.

**What makes it work**:
1. **Data store isolation**: Each profile gets its own isolated data store at the browser engine level. This is a separate cookie jar, HTTP cache, localStorage, sessionStorage, and indexedDB. Complete separation at the engine level — not a wrapper, not a hack, a truly separate data store.
2. **Fingerprint seed**: Each profile has a unique seed that deterministically generates every spoofed value. Same seed always = same identity. Different seed always = different identity.
3. **Network isolation**: Each profile can have its own proxy, Tor, and DNS configuration. Different profiles can exit through different countries.
4. **UA + coherence**: Each profile can have its own User Agent, and the fingerprint engine ensures all values are consistent with that UA's platform.

### The Seed System

The seed is a 6-digit integer (100000-999999) stored per profile. It drives a proprietary deterministic PRNG that generates all spoofed values in a fixed order. The algorithm ensures:

- **Determinism**: Seed `482917` always produces the exact same canvas noise pattern, the same GPU selection, the same core count, the same screen offset — every single time, on every page load, across app restarts
- **Uniformity**: The PRNG has good distribution — values aren't clustered or predictable
- **Independence**: Two seeds that differ by 1 (e.g. 482917 vs 482918) produce completely different fingerprints — there's no pattern to exploit

When you regenerate the seed (`POST /api/fingerprint/regenerate`), the browser generates a new random seed and saves the previous one for one-level undo. Every fingerprint vector changes simultaneously because they all derive from the same source.

### Platform Coherence Engine

The most common way anti-fingerprint tools get caught is **inconsistency**. If you report `navigator.platform = "Win32"` but your WebGL GPU is `Apple M3 Pro`, that's an impossible combination — and a dead giveaway.

Vela prevents this by parsing the active User Agent at script start to determine the target platform (iPhone, iPad, Android phone, Android tablet, Windows, Linux, or macOS). Every subsequent spoofed value is selected from a pool specific to that platform:

| What Gets Matched to Platform | Consistency Guarantee |
|---|---|
| `navigator.platform` string | `"Win32"` for Windows, `"MacIntel"` for Mac, etc. |
| WebGL GPU vendor & renderer | Windows gets NVIDIA/AMD/Intel ANGLE strings; Mac gets Apple M-series; Linux gets Mesa/native strings |
| Hardware concurrency (CPU cores) | Realistic ranges per platform (phones: 4-8, desktops: 4-32) |
| Device memory | Realistic ranges per platform (phones: 4-8GB, desktops: 8-64GB) |
| Device pixel ratio | iPhone=3, iPad=2, Mac=2, Windows=1-1.5 (weighted), etc. |
| Touch points | 0 for desktop, 5 for phones, 10 for tablets |
| Vendor string | `"Google Inc."` for Chrome, `"Apple Computer, Inc."` for non-Chrome Apple UAs |
| Plugins/MIME types | Chrome-style PDF viewers vs empty (non-Chrome style) |
| Screen orientation | `portrait-primary` for mobile, `landscape-primary` for desktop |
| CSS media queries | `pointer: coarse` + `hover: none` for mobile, `pointer: fine` + `hover: hover` for desktop |
| Chrome-only objects | `window.chrome`, `navigator.connection`, `navigator.storage`, `Error.captureStackTrace`, `navigator.userAgentData` — only injected when UA indicates Chrome |
| `performance.memory` | Only injected for Chrome UAs (V8-specific API) |

**When the UA says Chrome on Windows, EVERYTHING says Chrome on Windows.** There are no inconsistencies for fingerprinting services to catch.

### Anti-Detection Layer

Overriding browser APIs is only half the battle. Sophisticated fingerprinting services also check **whether any APIs have been tampered with**. Common detection techniques include:

- Calling `.toString()` on `navigator.hardwareConcurrency`'s getter — if it shows JavaScript code instead of `[native code]`, the override is detected
- Checking `Function.prototype.toString` itself for modifications
- Inspecting function `.name` and `.length` properties
- Checking `instanceof` on objects like `PluginArray`
- Looking for `navigator.webdriver === true` (set by automation tools)
- Checking `Notification.permission === 'denied'` (common in headless browsers)
- Checking for the absence of Chrome-specific APIs (`Error.captureStackTrace`, `window.chrome`, `performance.memory`) when the UA claims to be Chrome

Vela handles all of these:

| Detection Technique | How Vela Defeats It |
|---|---|
| `fn.toString()` inspection | Every overridden function is registered in an internal map. `Function.prototype.toString` is replaced with a version that returns `"function name() { [native code] }"` for all registered functions. The replacement itself is also registered. |
| Function `.name` / `.length` | All overridden functions have their `name` and `length` properties set to match the original they replaced |
| `instanceof PluginArray` | Fake plugin arrays are created with `Object.create(PluginArray.prototype)` so `instanceof` checks pass |
| `navigator.webdriver` | Overridden to always return `false` |
| `Notification.permission` | Overridden to return `'default'` (what real browsers show) |
| `navigator.permissions.query()` | Returns `'prompt'` for common permissions (real behavior) instead of `'denied'` (automation behavior) |
| Missing Chrome APIs | `Error.captureStackTrace`, `window.chrome`, `performance.memory`, `navigator.connection`, `navigator.storage`, `navigator.userAgentData` — all injected when UA indicates Chrome |
| WebRTC IP leak | `RTCPeerConnection` wrapped to strip ICE servers, `getStats()` filtered |

### All Spoofed Fingerprint Vectors

Here is every browser API that Vela overrides, grouped by category:

**Pixel-level noise** (produces unique hashes per seed):
| Vector | What It Does |
|---|---|
| Canvas 2D (`toDataURL`, `toBlob`) | Applies imperceptible pixel noise before data extraction. Visually identical, completely different hash. |
| WebGL (`readPixels`) | Same noise technique applied to WebGL pixel reads |
| AudioContext (`getChannelData`, `startRendering`) | Injects sub-audible noise into audio buffers. Changes the audio fingerprint hash. |

**Navigator properties** (deterministic per seed, platform-aware):
| Vector | What It Returns |
|---|---|
| `hardwareConcurrency` | CPU core count from platform-specific pool |
| `deviceMemory` | RAM in GB from platform-specific pool |
| `platform` | Platform string matching UA |
| `maxTouchPoints` | 0 (desktop) or 5/10 (mobile) |
| `vendor` | Browser vendor matching UA |
| `webdriver` | Always `false` |
| `pdfViewerEnabled` | `true` for Chrome UAs |
| `language` / `languages` | Profile override (e.g. `"en-US"`) |

**Screen & display**:
| Vector | What It Returns |
|---|---|
| `screen.width/height` | Real value minus small seeded offset (0-19px) |
| `screen.availWidth/availHeight` | Derived from spoofed dimensions |
| `window.devicePixelRatio` | Platform-specific value (iPhone=3, Mac=2, Windows=1-1.5, etc.) |
| `screen.orientation` | `portrait-primary` (mobile) or `landscape-primary` (desktop) |

**Layout measurements**:
| Vector | What It Does |
|---|---|
| `getBoundingClientRect()` | Adds tiny seeded offset to all measurements (UI elements excluded) |
| `getClientRects()` | Same offset applied to all rects in the list |
| `measureText()` | Same offset applied to text width measurements |

**Chrome-specific APIs** (only when UA indicates Chrome):
| Vector | What It Provides |
|---|---|
| `window.chrome` | Full runtime, app, csi(), loadTimes() mock |
| `navigator.connection` | Network type, downlink speed, RTT from seeded pools |
| `navigator.storage` | StorageManager with realistic quota/usage |
| `navigator.userAgentData` | Client Hints with brands, platform, high-entropy values |
| `Error.captureStackTrace` | V8-compatible stack trace method |
| `performance.memory` | Heap size info with realistic seeded values |

**Privacy & permissions**:
| Vector | What It Does |
|---|---|
| `RTCPeerConnection` | ICE servers stripped to prevent IP leak |
| `Notification.permission` | Returns `'default'` |
| `navigator.permissions.query()` | Returns `'prompt'` for standard permissions |

**Environment overrides** (optional, per-profile):
| Vector | What It Does |
|---|---|
| `Intl.DateTimeFormat` | Forces spoofed timezone on all formatters |
| `Date.getTimezoneOffset()` | Returns correct UTC offset for spoofed timezone |
| `matchMedia()` | Returns correct pointer/hover for mobile vs desktop |
| Plugins / MIME types | Chrome-style PDF viewers or empty (non-Chrome style) |
| Battery API | Realistic charging state, level, and times |

### Lazy vs Eager — Performance Strategy

Not all overrides need to run immediately. Most pages never call `OfflineAudioContext` or `navigator.getBattery()`. Loading all overrides eagerly would slow down every page start for APIs that are rarely used.

Vela splits overrides into two categories:

**Eager** (runs immediately at document-start, ~2ms):
- Function.toString masking (must be first)
- Navigator properties (lightweight getters)
- Screen dimensions (lightweight getters)
- Client rectangle offsets
- WebRTC wrapping
- Error.captureStackTrace
- Canvas toDataURL/toBlob hooks

**Lazy** (installs a lightweight trap, full override only runs on first API access):
- WebGL GPU spoofing — only selects and returns a GPU on first `getParameter()` call
- AudioContext noise — only patches on first `OfflineAudioContext` construction, then restores the original constructor
- Battery API — override is pre-built but only resolves on first `.getBattery()` call
- Plugins/MIME types — full plugin array is only constructed on first `navigator.plugins` access
- Chrome navigator.connection/storage — lazy getter, object built on first access
- User Agent Client Hints — lazy getter

This lazy strategy gives **60-70% faster page start times** compared to loading everything eagerly.

### How It Looks to Fingerprint Tests

When you run a fingerprint test site (CreepJS, BrowserLeaks, FingerprintJS, etc.) against a Vela profile:

| What They Test | What They See | Why It Passes |
|---|---|---|
| Canvas hash | Unique hash, consistent across tests | Pixel noise changes the hash but is visually invisible |
| WebGL renderer | Real GPU name from correct platform | Platform-matched GPU pool |
| WebGL image hash | Unique per seed | readPixels noise |
| AudioContext hash | Unique per seed | Sub-audible buffer noise |
| Navigator properties | All values match the platform | Platform coherence engine |
| Screen dimensions | Consistent, slightly different from common values | Fixed seeded offset |
| Client rects / fonts | Consistent small offset | Seeded offset value |
| Battery API | Realistic state | Seeded charging/level |
| WebRTC IP leak | No IP discovered | ICE servers stripped |
| Plugins | Correct for browser type | Platform-aware |
| Chrome APIs | Present when expected, absent when not | UA-conditional injection |
| Function.toString() | All report `[native code]` | Anti-detection layer |
| navigator.webdriver | `false` | Getter override |
| Timezone | Matches profile setting | Three-way override (DateTimeFormat, resolvedOptions, getTimezoneOffset) |
| CSS pointer/hover | Matches device type | matchMedia override |
| Consistency checks | No contradictions found | Everything derives from one UA + one seed |

**The bottom line**: To a fingerprinting service, each Vela profile looks like a real person on a real device. Two profiles on the same machine look like two completely different people on completely different computers in potentially different countries. There's nothing linking them.

---

## Quick Start

The Automation API runs as a TCP server bound to localhost. All communication is standard HTTP/1.1 with JSON request/response bodies, plus optional WebSocket upgrade for real-time events.

```bash
# Check if the API is running
curl -H "X-API-Key: YOUR_KEY" http://127.0.0.1:PORT/api/status

# Open a new tab
curl -X POST -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}' \
  http://127.0.0.1:PORT/api/tabs

# Execute JavaScript in a tab
curl -X POST -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"script": "document.title"}' \
  http://127.0.0.1:PORT/api/tabs/TAB_ID/execute
```

---

## Authentication

Every request must include the API key header:

```
X-API-Key: <32-character-random-token>
```

The key is auto-generated when the API server first starts. Requests without a valid key receive `401 Unauthorized`.

---

## Operating Modes — Headed, Hidden & Headless

The browser can run in three distinct modes. All three expose the exact same API surface — every endpoint works the same way. The difference is in how WebViews are hosted, how input events are dispatched, and what resources are consumed.

### Headed Mode

**What it is**: Normal GUI mode. Browser windows are visible on screen with full tab bar, address bar, and all UI elements.

**How it works internally**:
- Each window is a real macOS `NSWindow` (or iOS `UIWindow`) with a SwiftUI view hierarchy
- Each tab's web view is attached to the window's view tree and renders normally
- Input events (clicks, keyboard) go through the standard macOS/iOS event pipeline
- All UI features work: themes, sidebar, bookmarks bar, new tab page, etc.
- WebViews are rendered at the window's resolution with full GPU acceleration

**When to use**: When you want to see what the browser is doing, or when you need to interact with it both via API and manually.

**Resource usage**: Highest — full GUI rendering, GPU compositing, window management.

### Hidden Mode

**What it is**: The GUI exists internally but all windows are invisible. The browser is running a full windowing environment that you can't see.

**How it works internally**:
- Each browser window creates an **offscreen `NSWindow`** — a real macOS window that is positioned off-screen or has its `isVisible` set to `false`
- The web view is still attached to this offscreen window's view hierarchy, so it **renders normally** — JavaScript executes, layouts compute, CSS animations run
- Because the web view has a real hosting window, **native input injection works fully**:
  - `CGEvent` mouse clicks are posted to the process and land on the offscreen window
  - `NSEvent` keyboard events are dispatched directly to the WebView
  - Events produce `isTrusted: true` in JavaScript — undetectable by anti-bot systems
- The offscreen `NSWindow` maintains proper focus and responder chain, so tab focus, keyboard navigation, and form interactions work correctly
- File drag & drop works via `DataTransfer` API injection — the browser synthesizes the drop event with file data

**Clipboard handling in Hidden mode**:
- When the automation needs to paste text, the browser uses a pasteboard lock (`NSLock`) to prevent race conditions
- It saves the user's current clipboard contents, writes the automation data, performs the paste, then restores the original clipboard
- This means your clipboard is never permanently corrupted by automation running in the background

**When to use**: When you need full-fidelity automation (native events, file uploads, clipboard) but don't want windows cluttering the screen. Best for automation on developer machines.

**Resource usage**: Medium — WebViews render into offscreen surfaces, GPU is used but no compositing to display.

### Headless Mode

**What it is**: No GUI at all. No windows, no view hierarchy. Pure API-driven automation.

**How it works internally**:
- There are **no `NSWindow` objects** — WebViews are created standalone without a hosting window
- All web views in a window share a single process pool to limit memory usage (normally each window gets its own process pool)
- Because there is no hosting window, **native input injection does NOT work** — there's no `NSWindow` to receive `CGEvent`/`NSEvent` dispatches
- All page interaction happens through **JavaScript injection only**:
  - Clicks: `element.click()` or `element.dispatchEvent(new MouseEvent('click'))`
  - Typing: Value is set via property descriptor setter + `input`/`change` events dispatched
  - These produce `isTrusted: false` events — some anti-bot systems can detect this
- WebViews still execute JavaScript, compute layouts, and process network requests normally
- Pages render internally (the engine still computes layout and paints to an off-screen buffer) even without a window — this is needed for JavaScript APIs that depend on layout (e.g. `getBoundingClientRect()`, `IntersectionObserver`)

**Limitations compared to Hidden mode**:
- No native mouse/keyboard events (`isTrusted` will be `false` for dispatched events)
- No file drag & drop (no `DataTransfer` synthesis without a window)
- No clipboard integration
- Some JavaScript APIs that depend on window focus may behave differently (`document.hasFocus()` may return `false`)
- `window.innerWidth` / `window.innerHeight` may report default values since there's no real viewport

**When to use**: Server-side automation, CI/CD pipelines, environments without a display. When you don't need native-level input fidelity.

**Resource usage**: Lowest — no window management, no GPU compositing, shared process pools.

### Mode Comparison Matrix

| Feature | Headed | Hidden | Headless |
|---|---|---|---|
| Windows visible | Yes | No | No |
| Real `NSWindow` exists | Yes | Yes (offscreen) | No |
| Native mouse events (`isTrusted: true`) | Yes | Yes | No |
| Native keyboard events (`isTrusted: true`) | Yes | Yes | No |
| File drag & drop upload | Yes | Yes | No |
| Clipboard integration | Yes | Yes (with lock) | No |
| `document.hasFocus()` | Yes | Yes | May be false |
| JavaScript execution | Yes | Yes | Yes |
| CSS/layout computation | Yes | Yes | Yes |
| Network requests (XHR, fetch) | Yes | Yes | Yes |
| Fingerprint protection | Yes | Yes | Yes |
| Proxy/Tor routing | Yes | Yes | Yes |
| Content blocking | Yes | Yes | Yes |
| WebView pool pre-warming | Yes | No | No |
| Shared process pool | No | No | Yes (per window) |
| GPU compositing | Yes | Minimal | None |
| Memory usage | High | Medium | Low |
| API surface | Full | Full | Full |

---

## API Endpoints

### Status

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/status` | Returns server uptime, open window/tab counts, browser version |
| `GET` | `/api/docs` | Returns interactive HTML documentation you can open in a browser |

**Response** (`/api/status`):
```json
{
  "uptime": 3600,
  "windows": 2,
  "tabs": 7,
  "version": "1.0.0"
}
```

---

### Tabs

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tabs` | List all open tabs. Filter with `?windowId=<uuid>` |
| `GET` | `/api/tabs/:id` | Get details for one tab |
| `POST` | `/api/tabs` | Create a new tab |
| `DELETE` | `/api/tabs/:id` | Close a tab |
| `POST` | `/api/tabs/:id/navigate` | Navigate to a URL |
| `POST` | `/api/tabs/:id/reload` | Reload the page |
| `POST` | `/api/tabs/:id/hard-reload` | Reload bypassing cache |
| `POST` | `/api/tabs/:id/back` | Go back in history |
| `POST` | `/api/tabs/:id/forward` | Go forward in history |
| `POST` | `/api/tabs/:id/stop` | Stop page loading |
| `POST` | `/api/tabs/:id/activate` | Bring tab into focus |
| `POST` | `/api/tabs/:id/duplicate` | Duplicate the tab |
| `POST` | `/api/tabs/:id/pin` | Pin or unpin the tab |
| `POST` | `/api/tabs/:id/mute` | Mute or unmute tab audio |
| `GET` | `/api/tabs/:id/source` | Get the raw HTML source of the page |

**Create tab**:
```json
POST /api/tabs
{
  "url": "https://example.com",
  "windowId": "uuid",
  "profileId": "uuid",
  "private": false
}
```
All fields are optional. Omit `url` for a blank tab, `windowId` for the current window, `profileId` for the active profile.

**Navigate**:
```json
POST /api/tabs/:id/navigate
{
  "url": "https://example.com"
}
```

**Tab response model**:
```json
{
  "id": "uuid",
  "title": "Example Domain",
  "url": "https://example.com",
  "isLoading": false,
  "loadProgress": 1.0,
  "isSecure": true,
  "isPinned": false,
  "isMuted": false,
  "isPlayingAudio": false,
  "hasCrashed": false,
  "isPrivate": false,
  "profileId": "uuid",
  "windowId": "uuid"
}
```

---

### Page Automation

These endpoints let you interact with page content — click buttons, fill forms, extract data, and run arbitrary JavaScript.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/tabs/:id/execute` | Execute arbitrary JavaScript and return the result |
| `POST` | `/api/tabs/:id/click` | Click an element by CSS selector |
| `POST` | `/api/tabs/:id/fill` | Set the value of an input field |
| `POST` | `/api/tabs/:id/type` | Type text character-by-character with human-like delay |
| `POST` | `/api/tabs/:id/select` | Set a `<select>` dropdown value |
| `POST` | `/api/tabs/:id/check` | Set a checkbox or radio button state |
| `POST` | `/api/tabs/:id/extract` | Extract text, HTML, or attributes from an element |
| `POST` | `/api/tabs/:id/scroll` | Scroll to coordinates or to a specific element |
| `POST` | `/api/tabs/:id/wait-selector` | Wait for an element to appear in the DOM (with timeout) |
| `POST` | `/api/tabs/:id/login` | Auto-fill a login form using saved credentials for the domain |

**Execute JavaScript**:
```json
POST /api/tabs/:id/execute
{
  "script": "document.querySelectorAll('.item').length"
}
// Response: { "result": 42 }
```

**Click**:
```json
POST /api/tabs/:id/click
{
  "selector": "#submit-button"
}
```

**Fill**:
```json
POST /api/tabs/:id/fill
{
  "selector": "input[name='email']",
  "value": "user@example.com"
}
```

**Type** (simulates human typing with per-keystroke delay):
```json
POST /api/tabs/:id/type
{
  "selector": "input[name='search']",
  "text": "hello world",
  "delay": 50
}
```

**Select dropdown**:
```json
POST /api/tabs/:id/select
{
  "selector": "select[name='country']",
  "value": "US"
}
```

**Check/uncheck**:
```json
POST /api/tabs/:id/check
{
  "selector": "input[name='agree']",
  "checked": true
}
```

**Extract content**:
```json
POST /api/tabs/:id/extract
{
  "selector": "h1.title",
  "attribute": "innerText"
}
// Response: { "result": "Welcome" }
```

You can extract `innerText`, `innerHTML`, `outerHTML`, or any HTML attribute (e.g. `href`, `src`, `data-id`).

**Wait for selector**:
```json
POST /api/tabs/:id/wait-selector
{
  "selector": ".results-loaded",
  "timeout": 5000
}
```

Returns success when the element appears, or an error if the timeout (ms) is exceeded.

**Login**:
```json
POST /api/tabs/:id/login
{
  "domain": "example.com"
}
```

---

### Windows

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/windows` | List all windows |
| `GET` | `/api/windows/:id` | Get window details |
| `POST` | `/api/windows` | Create a new window |
| `DELETE` | `/api/windows/:id` | Close a window (and all its tabs) |

**Window response**:
```json
{
  "id": "uuid",
  "tabCount": 3,
  "profileId": "uuid",
  "isPrivate": false
}
```

---

### Profiles

Profiles are isolated browsing environments. Each profile has its own cookies, storage, fingerprint, proxy, DNS, User Agent, and content blocking settings. Switching profiles or creating tabs with a specific `profileId` gives you a completely separate browser identity.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/profiles` | List all profiles |
| `GET` | `/api/profiles/:id` | Get full profile configuration |
| `POST` | `/api/profiles` | Create a new profile |
| `PUT` | `/api/profiles/:id` | Update profile settings |
| `DELETE` | `/api/profiles/:id` | Delete a profile (default profile cannot be deleted) |
| `POST` | `/api/profiles/:id/activate` | Switch the active profile |

**Create/update profile**:
```json
POST /api/profiles
{
  "name": "Shopping",
  "icon": "cart",
  "color": "#10B981",
  "fingerprintEnabled": true,
  "spoofLanguage": "en-US,en",
  "spoofTimezone": "America/New_York",
  "userAgentId": "chrome-windows-latest",
  "dnsProvider": "cloudflare",
  "torEnabled": false,
  "proxyConfig": {
    "type": "socks5",
    "host": "proxy.example.com",
    "port": 1080,
    "username": "user",
    "password": "pass",
    "isEnabled": true,
    "selectionMode": "Manual",
    "proxyList": [],
    "selectedIndex": 0
  },
  "contentBlockerEnabled": true,
  "blockTrackers": true,
  "blockAds": true,
  "blockPopups": true,
  "automaticCookieConsent": true
}
```

Any field set to `null` inherits the global setting.

**Profile response**:
```json
{
  "id": "uuid",
  "name": "Shopping",
  "icon": "cart",
  "color": "#10B981",
  "fingerprintEnabled": true,
  "fingerprintSeed": 482917,
  "spoofLanguage": "en-US,en",
  "spoofTimezone": "America/New_York",
  "userAgentId": "chrome-windows-latest",
  "dnsProvider": "cloudflare",
  "proxyConfig": { ... },
  "contentBlockerEnabled": true,
  "blockTrackers": true,
  "blockAds": true
}
```

**Available icons**: `person.circle`, `briefcase`, `house`, `cart`, `gamecontroller`, `graduationcap`, `building.2`, `heart`, `star`, `bolt`, `globe`, `lock.shield`, `airplane`, `leaf`, `music.note`

**Available colors**: `#4A90D9`, `#10B981`, `#F59E0B`, `#EF4444`, `#8B5CF6`, `#EC4899`, `#06B6D4`, `#F97316`, `#14B8A6`, `#6366F1`, `#84CC16`, `#A855F7`

---

### Bookmarks

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/bookmarks` | List all bookmarks (flat or nested) |
| `POST` | `/api/bookmarks` | Create a bookmark |
| `DELETE` | `/api/bookmarks/:id` | Delete a bookmark |
| `POST` | `/api/bookmarks/folders` | Create a bookmark folder |
| `DELETE` | `/api/bookmarks/folders/:id` | Delete a folder and its contents |

---

### History

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/history` | Get browsing history. Query params: `?search=term&limit=50` |
| `DELETE` | `/api/history/:id` | Delete a single history entry |
| `POST` | `/api/history/clear` | Clear all browsing history |

**History response**:
```json
{
  "id": "uuid",
  "url": "https://example.com",
  "title": "Example",
  "visitCount": 3,
  "lastVisited": "2026-04-01T15:30:00Z"
}
```

---

### Downloads

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/downloads` | List all downloads with state and progress |
| `POST` | `/api/downloads/:id/pause` | Pause an active download |
| `POST` | `/api/downloads/:id/resume` | Resume a paused download |
| `POST` | `/api/downloads/:id/cancel` | Cancel a download |

**Download response**:
```json
{
  "id": "uuid",
  "filename": "file.zip",
  "url": "https://example.com/file.zip",
  "state": "downloading",
  "progress": 0.65,
  "totalBytes": 10485760,
  "receivedBytes": 6815744
}
```

---

### User Agents

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/user-agent` | Get the currently active User Agent string |
| `GET` | `/api/user-agents` | List all available UA presets with categories |
| `POST` | `/api/user-agent/set` | Set the User Agent by preset ID |
| `POST` | `/api/user-agent/randomize` | Pick a random User Agent |

**Set UA**:
```json
POST /api/user-agent/set
{
  "id": "chrome-windows-latest"
}
```

---

### Fingerprint Control

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/fingerprint` | Get current fingerprint settings (enabled state + seed) |
| `POST` | `/api/fingerprint` | Update fingerprint settings |
| `POST` | `/api/fingerprint/regenerate` | Generate a completely new fingerprint seed |

**Get fingerprint**:
```json
{
  "enabled": true,
  "seed": 482917
}
```

**Update fingerprint**:
```json
POST /api/fingerprint
{
  "enabled": true,
  "seed": 739201
}
```

**Regenerate**: Generates a new random 6-digit seed. Every fingerprint vector changes simultaneously because they're all derived from this single seed.

---

### Content Blocking

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/content-blocker/enable` | Turn on content blocking |
| `POST` | `/api/content-blocker/disable` | Turn off content blocking |
| `POST` | `/api/content-blocker/toggle-trackers` | Toggle tracker blocking on/off |
| `POST` | `/api/content-blocker/toggle-ads` | Toggle ad blocking on/off |

---

### Passwords

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/passwords` | List saved passwords (passwords are obfuscated in list view) |
| `POST` | `/api/passwords` | Save a new password entry |
| `DELETE` | `/api/passwords/:id` | Delete a password entry |

---

### Cookies

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tabs/:id/cookies` | Get all cookies for the tab's current page |
| `POST` | `/api/tabs/:id/set-cookies` | Set cookies on the tab |

**Set cookies**:
```json
POST /api/tabs/:id/set-cookies
{
  "cookies": [
    {
      "name": "session",
      "value": "abc123",
      "domain": ".example.com",
      "path": "/",
      "secure": true,
      "httpOnly": true
    }
  ]
}
```

Cookies are stored in the profile's isolated data store — they are invisible to tabs running under a different profile.

---

### Redirect Traces

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/redirect-traces/:tabId` | Get the full redirect chain for a tab's current navigation |

Returns every URL the tab was redirected through (HTTP 301/302/307/308 and client-side redirects like `meta refresh` or `window.location`) before reaching the final destination, with timestamps, status codes, headers, and cookies at each hop.

---

## WebSocket Events

Upgrade any connection to WebSocket to receive real-time events. All connected clients receive all events (pub/sub model).

| Event | Payload | When It Fires |
|---|---|---|
| `tab.created` | `{ tabId, windowId, url }` | New tab is opened |
| `tab.closed` | `{ tabId, windowId }` | Tab is closed |
| `tab.activated` | `{ tabId, windowId }` | Tab brought to focus |
| `tab.updated` | `{ tabId, title, url }` | Tab title or URL changed |
| `tab.navigated` | `{ tabId, url, type }` | Tab URL changes |
| `page.loading` | `{ tabId, url }` | Page starts loading |
| `page.loaded` | `{ tabId, url }` | Page finishes loading |
| `page.progress` | `{ tabId, progress }` | Load progress update (throttled 250ms) |
| `window.opened` | `{ windowId }` | New window is created |
| `window.closed` | `{ windowId }` | Window is closed |
| `profile.switched` | `{ profileId, name }` | Active profile changes |
| `download.started` | `{ downloadId, url, filename }` | Download begins |
| `download.completed` | `{ downloadId }` | Download finished |
| `download.failed` | `{ downloadId, error }` | Download failed |
| `console.log` | `{ tabId, message }` | Page `console.log()` output |
| `console.error` | `{ tabId, message }` | Page `console.error()` output |
| `dialog.opened` | `{ tabId, type, message }` | JS alert/confirm/prompt appeared |
| `network.request` | `{ tabId, url, method }` | Network request initiated |
| `network.response` | `{ tabId, url, status }` | Network response received |

**Navigation types** in `tab.navigated`:
- `link` — user clicked a link
- `typed` — URL was typed or navigated via API
- `reload` — page was reloaded
- `formSubmit` — form submission
- `backForward` — back/forward navigation
- `other` — everything else

**Event format**:
```json
{
  "type": "tab.created",
  "data": { "tabId": "uuid", "windowId": "uuid", "url": "https://..." },
  "timestamp": "2026-04-02T12:34:56Z"
}
```

---

## What Happens Behind the Scenes

This section explains everything the browser does internally when you use the API. Most of this is automatic — you configure it once via profiles and the browser handles the rest.

---

### The Full Page Load Pipeline

When a tab navigates to a URL (either via `POST /api/tabs/:id/navigate` or by creating a tab with a URL), here is the complete sequence of what happens internally:

**Phase 1 — WebView Setup** (before any network request)
1. **Data store selection**: The profile's isolated data store is assigned — this determines which cookies, cache, and local storage the page will see
2. **Proxy application**: The proxy config is written to the data store's proxy configuration — all subsequent network traffic will route through it
3. **User script injection**: Fingerprint protection JavaScript is injected as a user script with injection time `atDocumentStart` — this guarantees it runs before the page's own `<script>` tags
4. **Other user scripts**: Form detection script (for password autofill), geolocation bridge, context menu bridge are also injected
5. **Content rules**: The compiled content blocking rules for the active blocker configuration are attached to the content controller
6. **User Agent**: The spoofed UA string is set via `webView.customUserAgent` — applies to all HTTP requests including XHR, fetch, and downloads

**Phase 2 — Navigation Decision** (policy check)
1. The engine calls the navigation policy handler — the browser checks if the URL should open in a new tab (target=_blank), be handled as a download, or proceed normally
2. For auth domains (Google, Microsoft, Yahoo, Apple, Amazon, GitHub), the User Agent is temporarily overridden to a default/common UA to prevent SSO breakage — these providers check UA strings and block unusual ones

**Phase 3 — Network & Redirect Tracking**
1. **Redirect chain begins**: `RedirectTraceService.beginChain(tabId, url)` records the initial URL with timestamp
2. If the server responds with a redirect (301/302/307/308), `didReceiveServerRedirectForProvisionalNavigation` fires and records each hop with status code, headers, and cookies
3. This continues until the final destination is reached

**Phase 4 — Response Decision**
1. The engine calls the response policy handler with the HTTP response
2. The browser checks if this is a download:
   - `Content-Disposition: attachment` header → download
   - The engine can't render the MIME type → download
   - MIME type matches downloadable list (zip, pdf, exe, dmg, audio, video, etc.) → download
3. If it's a download, it's handed to the download manager (on macOS, uses a direct HTTP session with baked-in cookies to avoid engine-level download cancellation bugs)
4. If it's a page, loading continues

**Phase 5 — Page Rendering & Script Execution**
1. HTML parsing begins
2. The fingerprint protection script executes **before any page JavaScript** (it was injected at `atDocumentStart`)
3. Page scripts run with all fingerprint overrides already in place
4. Content blocking rules fire at the network layer — blocked resources never reach JavaScript

**Phase 6 — Page Load Complete** (`didFinish`)
After the engine fires the page-load-complete callback, a timed sequence runs:

| Delay | What Happens |
|---|---|
| **Immediate** | Theme/styling injection, zoom level restoration |
| **+50ms** | Favicon loading via `URLSession`, history recording (URL + title + visit count), certificate probing for HTTPS sites, `<select>` element bootstrapping |
| **+150ms** | Page load timing measurement via `performance.getEntriesByType('navigation')` — JavaScript timing API is more accurate than Swift-side timing |
| **+500ms** | Thumbnail capture (screenshot of the rendered page, stored for tab preview) |

**Phase 7 — Certificate Validation**
- If the page is HTTPS, the browser extracts the TLS certificate chain
- Parses X.509 DER structure to extract subject, issuer, validity dates
- If no TLS challenge was received during loading (common for many sites), a separate `URLSession` request probes the same URL with a custom `CertificateProbeDelegate` to capture the cert
- Certificate info is stored on the tab and available via the API

**Phase 8 — Crash Handling**
- If the browser engine's content process crashes, the browser automatically attempts to reload if a URL is available
- If reload fails, `tab.hasCrashed` is set to `true` and a WebSocket event is broadcast
- The crash count is tracked per tab

---

### WebView Creation & Pooling

**Pre-warming** (Headed mode only): The browser maintains a web view pool that pre-creates instances on a background thread. When a new tab is created, it dequeues from the pool instead of creating a fresh web view — this reduces first-tab latency significantly.

**Pool eligibility**: Only default profile, non-private, non-headless tabs can use pooled web views. Custom profiles need isolated data stores, so they always get fresh instances.

**Web view reuse on tab switch**: When switching between tabs, the browser reuses the existing web view rather than recreating it. This prevents unnecessary reloads and preserves page state (scroll position, form data, JavaScript state).

**Web view recreation**: When a profile's proxy or fingerprint settings change, the tab's web view must be rebuilt. The browser calls the recreation handler which:
1. Releases the old web view
2. Increments an internal generation counter (triggers a full rebuild)
3. The new WebView gets the updated configuration

---

### Fingerprint Protection — Full Breakdown

When fingerprint protection is enabled for a profile, the browser injects ~600+ lines of JavaScript overrides into every page **before any page script runs**. All spoofed values are derived from the profile's 6-digit seed (100000-999999) using a seeded PRNG, so they are:

- **Consistent** — the same seed always produces the same fingerprint across page loads, sessions, and days
- **Unique** — different seeds produce different fingerprints
- **Realistic** — values are platform-aware and internally consistent (a Windows UA gets Windows GPU names, Windows touch points, Windows screen sizes)

#### The Seeded PRNG Algorithm

All randomization uses a linear congruential generator seeded from the profile's fingerprint seed:

```
seed_state = fingerprint_seed
function seeded_random():
    seed_state = (seed_state * 16807 + 0) % 2147483647
    return (seed_state - 1) / 2147483646    // returns 0.0 to 1.0
```

This is deterministic — given the same seed, it produces the exact same sequence of "random" numbers every time. The sequence is consumed in a fixed order as the browser selects spoofed values for canvas noise, WebGL GPU, navigator properties, etc. This means two page loads with seed `482917` will always produce identical fingerprints.

#### Injection Timing & Lazy Loading

The JavaScript is split into two categories:

**Eager (runs immediately at document-start)**:
- `Function.prototype.toString` masking — must be in place before anything checks it
- `Error.captureStackTrace` polyfill — absence is a bot detection signal
- `navigator.platform`, `navigator.vendor`, `navigator.hardwareConcurrency`, `navigator.deviceMemory`
- Screen dimensions, `devicePixelRatio`
- Language and timezone overrides (if configured)
- Client rectangles override
- WebRTC leak prevention
- Permissions API override

**Lazy (runs on first API access)**:
- Canvas fingerprint protection — only hooks `getContext('2d')` on first canvas usage
- WebGL GPU spoofing — only hooks `getParameter()` on first WebGL context
- AudioContext noise — only patches `getChannelData()` on first audio context
- Battery API — only overrides `getBattery()` on first call
- Plugins & MIME types — only overrides getter on first access
- Chrome-specific objects (`window.chrome`, `navigator.connection`, etc.)
- User Agent Client Hints API

Lazy loading gives **60-70% faster page start times** because most pages don't use all of these APIs. The overrides are set up as property getters or `Proxy` wrappers that replace themselves with the full implementation on first access.

#### What Gets Spoofed (All 16 Vectors)

**1. Canvas Fingerprinting**

Pages draw to a hidden `<canvas>` and hash the pixel data. Vela intercepts `toDataURL()` and `toBlob()` and applies per-pixel XOR noise. About 13% of pixels are modified (threshold: `seeded_random() > 0.87`). The noise is visually imperceptible but completely changes the hash.

**2. WebGL GPU Fingerprinting**

Overrides `getParameter(UNMASKED_VENDOR_WEBGL)` and `getParameter(UNMASKED_RENDERER_WEBGL)` with a GPU selected from a platform-aware pool:

| Spoofed Platform | GPU Pool |
|---|---|
| Windows | NVIDIA GeForce RTX 3060/3070/3080/4070/4090, AMD Radeon RX 6800/7900 |
| macOS | Apple M1/M2/M3 GPU, AMD Radeon Pro 5500M |
| Linux | Mesa Intel UHD 630, NVIDIA GeForce GTX 1660 |

Selection: `gpu_pool[floor(seeded_random() * pool_length)]`

**3. AudioContext Fingerprinting**

`OfflineAudioContext` rendering produces floating-point values that vary by platform. Vela injects tiny noise (~1e-7 amplitude, inaudible) into `AudioBuffer.getChannelData()` using the same seeded PRNG. Lazy loaded.

**4. Navigator Properties**

| Property | What Vela Does |
|---|---|
| `navigator.hardwareConcurrency` | Spoofs to a value from platform-specific pool: iPhone 4/6/8, iPad 4/6/8/10, Android 4/6/8, Windows 4/8/12/16/24/32, Mac 4/8/10/12/16 |
| `navigator.deviceMemory` | Spoofs to 4/8/16/32/64 GB (seeded selection) |
| `navigator.platform` | `"Win32"`, `"MacIntel"`, `"Linux x86_64"`, `"Linux armv81"` — matches the spoofed UA |
| `navigator.maxTouchPoints` | 0 for desktop UAs, 5-10 for mobile UAs |
| `navigator.vendor` | `"Google Inc."` for Chrome, `"Apple Computer, Inc."` for non-Chrome Apple UAs, `""` for Firefox |
| `navigator.language` / `languages` | Profile-level override (e.g. `"en-US"`) |

**5. Timezone**

If the profile sets `spoofTimezone`, Vela overrides `Intl.DateTimeFormat.prototype.resolvedOptions()` to return the spoofed timezone. All `new Date().toLocaleString()`, `Intl.DateTimeFormat`, and timezone-dependent operations will report the fake timezone.

**6. WebRTC Leak Prevention**

Strips ICE servers from `RTCPeerConnection` configurations and filters `getStats()` results to exclude local IP candidates. Even behind a proxy or Tor, WebRTC cannot discover the real IP.

**7. Client Rectangles**

Adds small seeded random offsets to `getBoundingClientRect()` and `getClientRects()` return values. Exception: `<select>`, `<option>`, and `<datalist>` elements are excluded so dropdowns position correctly.

**8. Screen Dimensions**

| Property | Behavior |
|---|---|
| `screen.width` / `height` | Randomized with fixed deviation per seed |
| `screen.availWidth` / `availHeight` | Derived from randomized size |
| `screen.colorDepth` / `pixelDepth` | Always 24 |
| `window.devicePixelRatio` | iPhone=3, iPad=2, Android=1.5-3.5, Desktop=1-1.5 |

**9. Battery API**

`navigator.getBattery()` returns spoofed values. Lazy loaded.

| Property | Spoofed Range |
|---|---|
| `charging` | 50% chance true/false (seeded) |
| `level` | 0.5-1.0 |
| `chargingTime` | 0-3600s when charging |
| `dischargingTime` | 1800-5400s when not charging |

**10. Plugins & MIME Types**

| UA Context | Returns |
|---|---|
| Chrome | Fake PDF viewer list: Chrome PDF Viewer, Chromium PDF Viewer, Microsoft Edge PDF Viewer, PDF Viewer, built-in PDF |
| Non-Chrome | Empty `navigator.plugins` and `navigator.mimeTypes` |

**11. Chrome-Specific Objects** (only when UA indicates Chrome)

| Object | What It Does |
|---|---|
| `window.chrome.runtime` | Empty object with `connect()`, `sendMessage()` stubs |
| `window.chrome.app` | `isInstalled: false`, `getIsInstalled()`, `installState()` |
| `window.chrome.csi()` | Fake timing: `pageT`, `startE`, `onloadT`, `tran` |
| `window.chrome.loadTimes()` | Fake connection info, NPN protocol, timing data |
| `navigator.connection` | `effectiveType: "4g"`, `downlink: 10`, `rtt: 50`, `saveData: false` |
| `navigator.storage.estimate()` | `quota: ~2GB`, `usage: 0` |
| `Error.captureStackTrace` | V8-compatible stack trace capture — absence is a Chrome bot detection signal |

**12. Permissions API**

`navigator.permissions.query()` returns `"prompt"` for uncommon permission names that fingerprinters probe.

**13. Function.toString() Masking**

Every overridden function is registered in a `WeakMap`. When `.toString()` is called on any overridden function, it returns `"function <name>() { [native code] }"` instead of the real implementation. The masking function itself is also masked. This prevents detection by scripts that check `typeof Function.prototype.toString.call(navigator.hardwareConcurrency.__lookupGetter__) === ...`.

**14. WebRTC getStats Filtering**

In addition to stripping ICE servers (vector 6), `RTCPeerConnection.getStats()` results are filtered to remove `local-candidate` entries that contain IP address information.

#### User Agent Client Hints

When the UA indicates Chrome, Vela also spoofs the modern User-Agent Client Hints API:

| API | What Gets Spoofed |
|---|---|
| `navigator.userAgentData.brands` | Seeded list of brand/version pairs (e.g. `[{brand: "Chromium", version: "120"}, ...]`) |
| `navigator.userAgentData.mobile` | Matches platform detection (true for phones/tablets) |
| `navigator.userAgentData.platform` | `"Windows"`, `"macOS"`, `"Linux"`, `"Android"` |
| `navigator.userAgentData.getHighEntropyValues()` | Architecture, model, platform version, bitness, full version list |

#### CSS Media Query Spoofing

Vela overrides `window.matchMedia()` results for pointer and hover queries, which fingerprinters use to detect device type:

| Query | Desktop UA | Mobile UA |
|---|---|---|
| `(pointer: fine)` | `true` | `false` |
| `(pointer: coarse)` | `false` | `true` |
| `(hover: hover)` | `true` | `false` |
| `(hover: none)` | `false` | `true` |

---

### User Agent — More Than a Header

Setting a User Agent via the API doesn't just change the `User-Agent` HTTP header. The entire browser identity shifts to match:

| What Changes | Example for Chrome Windows UA |
|---|---|
| HTTP `User-Agent` header | Chrome/120 on Windows 10 string |
| `navigator.userAgent` | Same Chrome string |
| `navigator.platform` | `"Win32"` |
| `navigator.vendor` | `"Google Inc."` |
| `navigator.plugins` | Chrome PDF Viewer list |
| `window.chrome` | Full Chrome runtime mock |
| `navigator.connection` | Network Information API |
| `navigator.storage` | Storage Estimation API |
| `Error.captureStackTrace` | V8 stack trace method |
| `navigator.userAgentData` | Client Hints API |
| WebGL GPU pool | NVIDIA/AMD Windows GPUs |
| Hardware concurrency pool | 4-32 cores (Windows range) |
| Device pixel ratio | 1-1.5 (desktop range) |
| Touch points | 0 (desktop) |
| CSS media queries | `pointer: fine`, `hover: hover` |

**Auth domain protection**: When navigating to login pages (Google, Microsoft, Yahoo, Apple, Amazon, GitHub), the UA is temporarily reverted to a default/common UA. This prevents SSO providers from blocking or showing CAPTCHA for unusual UA strings. The spoofed UA is restored after leaving the auth domain.

**Bot safety**: UAs marked as bot (Googlebot, Bingbot, etc.) are flagged as "unsafe". The `/api/tabs/:id/login` endpoint will refuse to submit forms when a bot UA is active to prevent account lockouts.

**UA categories available**:

| Category | Count | Examples |
|---|---|---|
| Default | 1 | Native platform-default UA (macOS or iOS) |
| Phones | 20+ | iPhone 17 series, Galaxy S25, Pixel, OnePlus, Xiaomi |
| Tablets | 5+ | iPad Pro, iPad Air, Galaxy Tab, Lenovo Tab |
| Desktops | 10+ | Chrome/Firefox/Edge on Windows/macOS/Linux |
| Bots | 5+ | Googlebot, Bingbot, various crawlers |

---

### Proxy & Network Layer

When a tab loads a page, the browser resolves which proxy to use based on this priority chain:

```
1. Tor enabled (profile or global)     -> SOCKS5 to Tor (highest priority)
2. Profile proxy config                -> HTTP or SOCKS5 proxy
3. Global proxy config                 -> HTTP or SOCKS5 proxy
4. Direct connection                   -> No proxy (lowest priority)
```

The proxy is applied at the browser engine level via the data store's proxy configuration. This means **all** traffic from the tab goes through the proxy — HTML, CSS, JS, images, fonts, XHR, fetch, WebSocket, EventSource, everything. There is no DNS leak because the engine resolves DNS through the proxy when configured.

**Proxy credentials** are applied via the `ProxyConfiguration` object and are never exposed in URLs or logged.

**Proxy list modes** for profiles with multiple proxies:

| Mode | Behavior |
|---|---|
| `Manual` | You choose which proxy to use by index |
| `Random` | A random proxy is picked each time a new connection is made |
| `Sequential` | Round-robin through the list. The `lastUsedIndex` is incremented on each profile switch and wraps around at the end of the list |

**Proxy list import format** (one per line):
```
socks5://host:port:username:password
http://host:port
host:port
host:port:username:password
```

**When proxy settings change on a profile**: All tabs using that profile must have their web views recreated. The browser tears down the old web view and builds a new one with the updated proxy configuration.

---

### Tor Integration — Full Lifecycle

When Tor is enabled (per-profile or globally), here's the complete lifecycle:

**Startup (macOS)**:
1. **Binary discovery**: Searches `/opt/homebrew/bin/tor`, `/usr/local/bin/tor`, `/usr/bin/tor`, then the app bundle
2. **Temp directory**: Creates `/tmp/VelaTor_{PID}_{UUID}/` for Tor data
3. **Port selection**: Finds available ports starting from SOCKS 9150 and Control 9151 (probes until a free port is found)
4. **torrc generation**: Writes a config file with `SocksPort`, `DataDirectory`, `ClientOnly 1`, `AvoidDiskWrites 1`, `ControlPort`, `HashedControlPassword`, and GeoIP file paths
5. **Process launch**: Spawns the Tor binary as a child process
6. **Bootstrap monitoring**: Reads stderr in real-time, parsing `"Bootstrapped X%"` messages. UI updates are throttled to max 1 per 0.5 seconds. Also watches for `[err]` and `[warn]` lines

**Startup (iOS)**:
1. Uses embedded `tor.xcframework` — no external binary needed
2. `EmbeddedTorManager.start()` runs on a background task
3. Polls up to 120 times (60s max) checking `isBootstrapped`, `errorMessage`, and `exitIP`

**Circuit verification** (after "Bootstrapped 100%"):
1. Makes a request to `https://check.torproject.org/api/ip` through the SOCKS proxy
2. Checks `response.IsTor == true` and captures the exit IP
3. Updates circuit info: "Connected to Tor (exit_ip)"

**New circuit request** (`requestNewCircuit`):
1. macOS: Opens a TCP connection to the control port, sends `AUTHENTICATE "password"\r\n`, then `SIGNAL NEWNYM\r\n`
2. iOS: Calls `EmbeddedTorManager.shared.requestNewCircuit()`

**Shutdown**:
1. macOS: Sends `SIGINT` (graceful shutdown), waits 2s, sends `SIGTERM`, waits 1s, sends `SIGKILL` if still alive
2. Cleans up the temp data directory on a background thread
3. iOS: Calls `EmbeddedTorManager.shared.stop()`

**Priority**: Tor takes highest priority — when Tor is enabled, profile and global proxy settings are completely ignored. All traffic goes through the Tor SOCKS5 proxy, including DNS.

---

### DNS Routing

Each profile can use a specific DNS provider, independent of the OS resolver:

| Provider | Server | Use Case |
|---|---|---|
| `system` | OS default | No override |
| `cloudflare` | 1.1.1.1 | Privacy-focused, fast |
| `google` | 8.8.8.8 | Reliable, global |
| `quad9` | 9.9.9.9 | Malware blocking |
| `adguard` | 94.140.14.14 | Ad/tracker blocking at DNS level |
| `opendns` | 208.67.222.222 | Content filtering |
| `cleanbrowsing` | 185.228.168.9 | Family-safe filtering |
| `nextdns` | 45.90.28.0 | Customizable filtering |
| `controld` | 76.76.2.0 | Customizable filtering |

**Validation**: Before using a DNS provider, the browser performs a latency probe with a 3.5s timeout. If the provider is unreachable, it falls back to the system resolver.

**Important**: When a proxy or Tor is active, DNS is resolved through the proxy/Tor — the DNS provider setting only applies to direct connections.

---

### Profile Isolation — What Gets Separated

Each profile is a fully isolated browsing identity:

| Resource | How It's Isolated |
|---|---|
| **Cookies & Local Storage** | Separate isolated data store per profile. Default profile uses the engine's default store. Custom profiles use a unique data store keyed by profile ID. Cookies set in one profile are completely invisible to another. |
| **Cache** | Each data store has its own HTTP cache. Cached resources are not shared between profiles. |
| **Fingerprint** | Each profile has a unique 6-digit seed; all 16 fingerprint vectors are derived from it |
| **Proxy** | Independent proxy config — profile A can use SOCKS5 in Germany, profile B can use HTTP in Japan, profile C can use direct |
| **Tor** | Can be enabled/disabled per profile — some profiles go through Tor, others don't |
| **DNS** | Independent DNS provider per profile |
| **User Agent** | Independent UA string per profile, which cascades to all platform-specific overrides |
| **Content Blocking** | Independent tracker/ad blocking rules (set to `null` to inherit global) |
| **Timezone & Language** | Can be spoofed independently per profile |
| **Password Autofill** | Can be enabled/disabled per profile |

When you create a tab with `"profileId": "uuid"`, it gets all of that profile's isolation automatically. You can have tabs from different profiles open simultaneously in the same window — they do not share any state.

---

### Profile Switching — What Happens Internally

When you call `POST /api/profiles/:id/activate`:

1. The `currentProfileId` is updated and saved to UserDefaults
2. If the profile uses sequential proxy selection, `lastUsedIndex` is incremented (mod `proxyList.count`) to advance to the next proxy
3. New tabs will use the new profile's settings
4. **Existing tabs are NOT affected** — they continue running with the profile they were created with. Each tab remembers its `profileId`. To change an existing tab's profile, you'd need to close it and create a new one.

**Profile deletion**:
1. The profile is removed from the profiles array
2. If it was the active profile, `currentProfileId` switches to the default profile
3. A background task runs `deleteProfileData()`:
   - Gets the data store for the deleted profile's UUID
   - Removes **all** website data types (cookies, cache, localStorage, sessionStorage, indexedDB, etc.) since the beginning of time
   - The data store identifier is released

**Profile duplication**: Creates a new profile with a new UUID and position, but copies: fingerprint seed, UA override, proxy config, DNS provider, content blocking settings, cookie consent, language/timezone spoofing. The data stores are NOT copied — the duplicate starts with a clean cookie jar.

---

### Content Blocking Engine — Compilation & Caching

Content blocking uses the engine's native content rule list system — compiled bytecode format for maximum performance. Rules are compiled once and cached.

**The 16 combinations**: Four boolean toggles (trackers, ads, extra trackers, extra ads) create 2^4 = 16 possible configurations. Each is identified by a bitmask hash:

```
hash = (blockTrackers << 0) | (blockAds << 1) | (extraBlockTrackers << 2) | (extraBlockAds << 3)
identifier = "VelaBlocker-v5-{hash}"
```

**Compilation pipeline**:
1. **Startup — active config first**: The currently active configuration is compiled synchronously on the main thread before the first page loads. This ensures content blocking is ready immediately.
2. **Startup — background precompile**: 2 seconds later, on a utility-priority background queue, the remaining 15 combinations are compiled. This means switching blocker settings is instant — the rules are already compiled and cached.
3. **Caching**: Compiled rules are stored in the engine's native rule list store (disk cache) and in an in-memory cache keyed by hash. Version-based invalidation: when rules are updated, the version is bumped and old identifiers are cleaned up.
4. **Cancellation**: If settings change during background precompilation, the work item is cancelled and restarted with the new configuration.

**What gets blocked**:

| Category | Domains/Patterns | Count |
|---|---|---|
| **Trackers** | google-analytics, googletagmanager, facebook.net, doubleclick.net, Mixpanel, Segment, Amplitude, Sentry, Bugsnag | ~14 |
| **Ads (hard block)** | doubleclick.net, googlesyndication, Amazon-ads, moat (blocked on all parties) | ~8 |
| **Ads (third-party)** | OpenX, Rubicon, PubMatic, Criteo, Facebook ads, Microsoft ads, Yahoo ads, Taboola, Outbrain | ~15 |
| **Ads (path patterns)** | `/pagead/`, `/adserver/`, `/ads/banner`, `/adsense/`, `/gampad/ads` | ~10 |
| **Ads (cosmetic)** | CSS rules to hide `.adsbygoogle`, `[id^="google_ads"]`, `[data-ad-slot]`, etc. via `css-display-none` action | ~8 |
| **Extra trackers** | Clarity.ms, LinkedIn ads, Heapanalytics, Mouseflow, Logrocket, data brokers (BlueKai, Taboola), mobile attribution (Branch, Adjust, AppsFlyer) | ~80 |
| **Extra ads** | Yahoo Ads, Media.net, RevContent, Mgid, programmatic exchanges (33Across, Sovrn), video ad platforms (Innovid, Freewheel), native ad platforms (Nativo, Teads) | ~60 |

**How rules apply to each tab**: When a WebView is set up, the browser:
1. Determines the effective blocker settings (profile overrides trump global)
2. Computes the hash
3. Looks up the cached compiled rule list
4. Adds it to the web view's content controller

Blocking happens at the **engine's network layer** — blocked requests never execute, never reach JavaScript, and never consume bandwidth or CPU.

**Statistics**: The browser tracks total blocked resources, estimated bandwidth saved (~50 KB per block), and estimated time saved (~250 ms per block). Per-page average: ~8 blocked resources.

---

### Cookie Consent Automation — How It Actually Works

This is NOT a generic "click the cookie banner" JavaScript hack. For Google domains, Vela uses a much more robust approach — it **injects pre-built consent cookies directly into the data store**, bypassing the consent banner entirely.

**Google domain detection**: Matches 21+ domains including google.com, youtube.com, gstatic.com, google.co.uk, and all regional variants.

**What gets injected**:

1. **SOCS cookie** (modern Google consent):
   - Encoded as a **protobuf message** with: consent_status=2 (EU accepted), service source, ID, language, consent_action=2
   - Base64-encoded with padding stripped
   - Set on `.google.com` domain, 365-day expiry

2. **CONSENT cookie** (legacy Google consent):
   - Format: `YES+cb.YYYYMMDD-17-p0.LANG+FX+NNN`
   - Date: Randomly set to 30-180 days ago (looks like a real historical consent)
   - Language: Random from `[en, pt, es, ro, de, fr]`
   - Set on `.google.com` domain, 365-day expiry

**When it fires**: On every navigation to a Google domain, the browser checks if a SOCS cookie already exists. If not, it injects both cookies into the data store's HTTP cookie store. It also fixes stale `CONSENT=PENDING` cookies left over from old profiles.

**Result**: Google pages load without any consent banner — the cookies are already set before the page even starts rendering.

For non-Google sites, consent automation uses injected JavaScript to detect common consent management frameworks and clicks the appropriate reject/dismiss buttons after page load.

---

### Native Input Injection — The Coordinate Pipeline

On macOS (Headed and Hidden modes), the browser can synthesize native-level input events. This section explains exactly how.

**Why it matters**: JavaScript-dispatched events have `isTrusted: false`. Many anti-bot systems check this property. Native events have `isTrusted: true` because they come from the OS event system, making automation undetectable at the event level.

**The coordinate transformation pipeline**:

When you call `/api/tabs/:id/click` with a CSS selector, here's what happens:

```
1. JavaScript: element.getBoundingClientRect()
   → Gets CSS pixel coordinates (x, y) relative to page viewport

2. Apply zoom/magnification:
   → CSS px × magnification factor = WebView pixels

3. Flip Y axis (NSView uses bottom-left origin):
   → y = webView.frame.height - y

4. Convert to window coordinates:
   → webView.convert(point, to: nil) → NSWindow coordinates

5. Convert to screen coordinates:
   → window.convertPoint(toScreen: point) → macOS screen coordinates

6. Flip Y for CGEvent (screen uses top-left origin):
   → y = screen.frame.height - y
```

**Mouse events**:
- Uses `CGEventPostToPid()` to scope events to the browser process only — clicks won't leak to other apps
- Posts `mouseDown` then `mouseUp` (order matters)
- Double-click: Posts both `clickCount=1` and `clickCount=2` pairs

**Keyboard events**:
- Uses `CGEvent` for OS-level simulation and `NSEvent` for direct WebView injection
- Maps key names to virtual key codes (Enter=0x24, Tab=0x30, etc.)
- Sets `unicodeString` property for character input
- In Hidden mode, creates `NSEvent` directly and posts to `webView.keyDown()`/`webView.keyUp()` — bypasses `CGEvent` entirely, so no visible window is needed

**Clipboard handling**:
- Uses `NSLock` to serialize concurrent paste operations
- Saves current clipboard → writes automation data → performs paste → restores clipboard
- Your personal clipboard is never permanently affected

**File upload via drag & drop**:
- The browser synthesizes a `DataTransfer` object with file data
- Dispatches `dragenter`, `dragover`, `drop` events on the file input element
- The file data is available to the page's JavaScript as if a real file was dropped

**Accessibility requirement**: On macOS, native input injection requires the Accessibility permission (System Settings > Privacy & Security > Accessibility). The browser checks `AXIsProcessTrusted()` at startup.

---

### Password Autofill — DOM Analysis & Multi-Step Login

When `/api/tabs/:id/login` is called, here's the full pipeline:

**Phase 1 — Form detection** (runs at page load via injected script):
1. Query all `<form>` elements on the page
2. For each form containing a password field (`<input type="password">`):
   - Find the username field by checking: `type="email"`, `type="text"`, `name*="user"/"login"/"email"`, `autocomplete="username"`
   - Fallback: use the `<input>` immediately before the password field
3. Also detect standalone password fields (not inside a `<form>`)
4. Report detected forms back to the native browser layer via a message handler

**Phase 2 — Credential lookup**:
1. Look up saved credentials for the domain in the macOS Keychain
2. If multiple credentials exist for the domain, the most recently used one is selected

**Phase 3 — Field filling**:
1. Set the input value using `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value)`
   - This bypasses React/Angular/Vue value setters that would ignore direct `.value` assignment
2. Dispatch `input`, `change`, and `blur` events to trigger framework-level change handlers
3. Hide the credential dropdown if it was showing

**Multi-step login handling**:
Many sites (Google, Microsoft) split login across two pages — username on page 1, password on page 2. Vela handles this:
1. On step 1: Records the username in `sessionStorage._velaUser`
2. On step 2: Looks for the remembered username or scans the page for displayed email patterns (e.g. `#profileIdentifier` or email regex matches)
3. Pairs the remembered username with the password for credential saving

**Submission detection** (3 methods):
1. `<form>` submit event listener
2. Button click interception — watches `<button>` and `[role="button"]` clicks, captures field values at click time
3. Enter key on password fields — intercepts `keydown` on password inputs

**SPA/XHR handling**:
- Intercepts `window.fetch` and `XMLHttpRequest.prototype.send`
- Throttled credential capture (500ms debounce) on XHR/fetch to catch AJAX login submissions
- **Excluded from sensitive auth domains** (Microsoft accounts, Google accounts) to avoid breaking MSAL.js and similar auth libraries

---

### Download Interception & Management

**How downloads are detected**:
1. `Content-Disposition: attachment` header → always a download
2. The engine reports it can't render the MIME type → download
3. MIME type matches downloadable list: `application/zip`, `application/pdf`, `application/x-dmg`, audio/*, video/*, `application/octet-stream`, etc. → download
4. Auth domains (Google, Microsoft) are excluded from URL-based heuristics to avoid treating `.srf`/`.ashx` endpoints as downloads

**macOS download handling**:
- The engine's built-in download handler is prone to `-999 cancellation` bugs, so Vela bypasses it
- Instead, it uses a direct HTTP session with cookies baked into the request headers (extracted from the profile's cookie store for the matching domain)
- This provides reliable downloads even for authenticated resources

**Download lifecycle**:
- States: `downloading` → `paused` → `downloading` → `completed` (or `failed`/`cancelled`)
- **Pause**: Calls `URLSessionDownloadTask.cancel(byProducingResumeData:)` to get a checkpoint
- **Resume**: Creates a new download task with the resume data
- **Progress**: Tracked via `URLSessionDownloadDelegate` with `taskToItem` mapping (task ID → download UUID)
- **Concurrent downloads**: Multiple downloads run simultaneously. `aggregateProgress` sums all active downloads for an overall progress percentage

**Destination conflict** (iOS):
- If a file already exists, the user is prompted to overwrite or keep both
- "Keep both" renames to `filename_copy`, `filename_copy2`, etc.

---

### Redirect Chain Capture

The `RedirectTraceService` captures every hop in a redirect chain for forensic analysis:

**Chain lifecycle**:
1. **Begin**: Initial navigation → creates chain with first entry (URL, timestamp, method)
2. **Server redirects**: Each `didReceiveServerRedirectForProvisionalNavigation` callback records a new entry with the redirect URL
3. **Response recording**: At `didFinish`, the last entry is updated with HTTP status code, response headers, and cookies
4. **Client redirects**: JavaScript navigations (`meta refresh`, `window.location = ...`) are also captured as chain entries
5. **Completion**: `didFinish` marks `chain.isComplete = true`

**What each entry contains**:

| Field | Description |
|---|---|
| `url` | The URL at this hop |
| `statusCode` | HTTP status (301, 302, 307, 308, or null for client redirects) |
| `redirectType` | `.initial`, `.http301`, `.http302`, `.http307`, `.http308`, `.meta`, `.js` |
| `timestamp` | When this hop occurred |
| `duration` | Time since the previous hop |
| `requestHeaders` | Headers sent in the request |
| `responseHeaders` | Headers received in the response |
| `cookies` | Cookies set at this hop (parsed from `Set-Cookie` headers) |
| `method` | HTTP method (`GET`, `POST`, etc.) |

**Cleanup**: Chains are cleared when a tab is closed (`clearChain(tabId)`) to prevent memory buildup.

---

### Certificate Validation & HTTPS

**During page load**: When the engine issues a TLS challenge, the browser:
1. Extracts the full certificate chain from the `URLAuthenticationChallenge`
2. Parses the X.509 DER structure manually to extract: subject, issuer, validity dates (notBefore, notAfter), serial number
3. Stores the certificate info on the tab object

**Post-load probing** (+50ms after `didFinish`):
- Many sites don't trigger a TLS challenge during normal loading
- The browser makes a separate `URLSession` request to the same URL with a custom `CertificateProbeDelegate` that captures the certificate
- This ensures certificate info is available even when the engine didn't surface it during loading

**HTTP Auth challenges**:
- When a site requires HTTP Basic/Digest authentication, the browser can auto-fill credentials if they exist in the password store
- Otherwise, it presents a prompt (in Headed mode) or returns an error (in Headless/Hidden mode)

---

### Permission & Dialog Handling

**JavaScript dialogs**:
- `alert()` → In Headed mode: shows native `NSAlert`. In Hidden/Headless: can be auto-dismissed.
- `confirm()` → Shows YES/NO dialog or auto-responds
- `prompt()` → Shows text input dialog or auto-responds

**File picker** (macOS):
- `<input type="file">` click → Opens `NSOpenPanel` in Headed mode
- In Hidden/Headless mode: file upload must be done via the native input injection drag & drop API

**Media permissions** (iOS 15+):
- Camera/microphone requests → `UIAlertController` prompt
- Decisions are persisted per-origin in UserDefaults

**Geolocation**:
- Custom bridge (`bgLocReq` message handler) → `CLLocationManager`
- Supports one-shot (`getCurrentPosition`) and continuous (`watchPosition`) modes
- Coordinates sent back to JavaScript via `postMessage`
- Rejects with error code 2 if system permission is denied

---

### Session Persistence & Crash Recovery

**Session save**:
- Every time a tab is added, closed, or reordered, a session save is scheduled with a **2-second debounce**
- The save encodes all open tabs as `[TabSessionData]` (id, title, URL, isPrivate, profileId) and writes to UserDefaults key `vela_session_tabs`
- **Private tabs are never saved**

**Session restore**:
- On app launch, `loadSessionOnce()` reads the saved session and recreates tabs
- Each tab gets a fresh WebView with its original profile's configuration
- Tabs that were loading when the app quit will reload their URL

**Crash recovery**:
- When `webViewWebContentProcessDidTerminate` fires, the browser auto-reloads the tab's URL if available
- If auto-reload fails, `tab.hasCrashed = true` and `tab.crashCount` is incremented
- You can detect crashed tabs via the API (`hasCrashed` field) and reload them with `/api/tabs/:id/reload`

**Recently closed tabs**:
- Up to 20 recently closed tabs are tracked with their title, URL, profileId, and close timestamp
- Persisted to UserDefaults `vela_closed_tabs`
- Can be reopened to restore the browsing context

---

### Memory Management & Tab Suspension

**Memory monitoring**:
- A timer fires every **30 seconds** to check the app's memory usage
- Uses `task_info(MACH_TASK_BASIC_INFO)` to get `resident_size` (actual RAM usage)
- Compares against a configurable RAM limit percentage (default: 50% of system RAM)

**Tab suspension** (when memory exceeds the limit):
1. Identifies suspension candidates: tabs that are NOT current, NOT pinned, NOT suspended, NOT loading, NOT playing audio
2. Suspends one tab at a time, rechecking memory after each:
   - Suspension: Stops loading, clears all delegates, releases the web view, sets `isSuspended = true`
   - The tab keeps its metadata: URL, title, favicon, profile ID
3. When you navigate to a suspended tab (or activate it via API), the WebView is automatically recreated with the full profile configuration and the URL is reloaded

**Tab cleanup** (when a tab is closed):
- WebView delegates cleared
- WebView removed from view hierarchy
- Offscreen NSWindow closed (if Hidden mode)
- Favicon and thumbnail released
- Download observer disconnected

---

### Performance Monitoring

The browser tracks real-time performance metrics:

**System-level** (collected every 2 seconds):
| Metric | Source |
|---|---|
| RAM usage | `task_info(MACH_TASK_BASIC_INFO)` → `resident_size` |
| CPU usage | `thread_info()` across all threads, summing `cpu_usage / TH_USAGE_SCALE * 100%` |
| GPU memory | Metal `device.currentAllocatedSize` vs `device.recommendedMaxWorkingSetSize` |

**Per-tab** (via JavaScript evaluation every 2 seconds):
| Metric | Source |
|---|---|
| Resource count | `performance.getEntriesByType('resource').length` |
| Page load time | `performance.timing.loadEventEnd - navigationStart` |
| Media playback | `tab.isPlayingAudio` flag |
| Memory distribution | Proportional to resource count (heavier pages = more memory) |
| GPU distribution | Media-playing tabs get 3x weight vs non-media tabs |

---

### iCloud Sync — Full Mechanics

**What syncs across devices**:

| Data | Details |
|---|---|
| Bookmarks | Full folder hierarchy, all metadata |
| History | Up to 200 most recent entries (favicons stripped to save space) |
| Passwords | Encrypted via Keychain, synced via iCloud Keychain |
| Profiles | All settings including fingerprint seeds, proxy configs, UA overrides |
| App settings | All UserDefaults matching `vela_` or `nova_` prefixes (excluding cache/ephemeral keys) |
| Open tabs | Up to 30 non-private tabs per device, available as "remote tabs" on other devices |

**Backend**: Apple `NSUbiquitousKeyValueStore` (iCloud Key-Value Store, 1MB total limit).

**Sync lifecycle**:

1. **Initial delay** (+2s after launch): Allows UI to appear and avoids TCC (privacy) prompts during startup
2. **Pull from cloud**: Decodes all synced keys from iCloud KVS
3. **Suppress auto-push** (3s after any pull): Prevents immediate push-back that would cause ping-pong between devices
4. **Local change observation** (2s debounce): Watches `@Published` properties on BookmarkStore, HistoryStore, PasswordStore, ProfileManager. Also watches `UserDefaults.didChangeNotification` with a 3s debounce
5. **Auto-sync timer**: Every **120 seconds**, if the suppression window has expired, a full push is triggered
6. **External change notification**: When another device pushes to iCloud, `NSUbiquitousKeyValueStore.didChangeExternallyNotification` fires → suppresses auto-push for 3s → pulls changes

**Conflict resolution** (last-write-wins with nuance):
- **Bookmarks**: If remote bookmark doesn't exist locally, append. If it exists and `remote.modifiedAt > local.modifiedAt`, update. Otherwise keep local.
- **History**: Insert by `visitedAt` order. If remote `visitCount > local.visitCount`, update.
- **Passwords**: Update if `remote.modifiedAt > local.modifiedAt`. Calls both `PasswordKeychainService.save()` and `PasswordFileBackup.save()`.
- **Profiles**: Last-write-wins by `modifiedAt` timestamp.
- **Remote tabs**: Filters out own device, discards entries older than 7 days, sorts by `updatedAt` descending.

**Battery optimization**: Sync pauses during low battery and resumes when battery recovers. Deferred work items are cancelled on app backgrounding.

---

### Autocomplete & Suggestion Engine

The suggestion engine powering the address bar has two paths:

**Fast path — local computation**:
1. **Cache**: Pre-processes all bookmarks + history into normalized entries (lowercased URLs, stripped `http://`/`www.`)
2. **Matching** (single-pass): For each query, checks URL prefix match, host prefix match, and title/URL substring match against both bookmarks and history
3. **Scoring**: Bookmarks get base score 2000, history gets 1000, plus `visitCount` bonus
4. **Deduplication**: By URL
5. **Result**: Top 8 results sorted by relevance score

**Inline completion**: The best-matching entry's remaining URL suffix is returned for visual append in the address bar (e.g. typing `git` → inline shows `hub.com` from `github.com`).

**Slow path — online suggestions** (200ms debounce):
1. Queries the selected search engine's suggestion API (OpenSearch JSON format)
2. Parses `["query", ["suggestion1", "suggestion2", ...]]`
3. Returns up to 4 suggestions

**Merging**: Local and online results are deduplicated by title (lowercased) and combined, sorted by relevance score, capped at 8 total.

**Hidden URLs**: Users can hide specific autocomplete results. These are tracked in a persistent `Set<String>` in UserDefaults `vela_hidden_autocomplete_urls`.

**Cache invalidation**: Observes changes to `BookmarkStore.$bookmarks` and `HistoryStore.$items` with a 200ms debounce, rebuilding the normalized cache.

---

### The Automation Server — Connection Lifecycle

The API server is built on Apple's Network.framework (`NWListener`), not a third-party HTTP server.

**Server startup**:
1. Creates `NWListener` on the configured port
2. Sets TCP parameters: `acceptLocalOnly` based on host binding (true for `127.0.0.1`, false for `0.0.0.0`)
3. State machine: `.ready` → accepting connections

**Connection lifecycle**:
1. **Accept**: Each new connection gets a UUID and is stored in `connections: [UUID: APIConnection]`
2. **Receive loop**: `receiveData()` is called recursively, buffering up to 65KB chunks
3. **Buffer management**: Each connection has a `Data` buffer. Max 10MB — if exceeded, the connection is dropped to prevent memory exhaustion
4. **HTTP parsing**: Custom `HTTPParser` extracts the request from the buffer
5. **WebSocket check**: `HTTPParser.isWebSocketUpgrade(request)` determines if this is an upgrade request
   - **Yes**: Validates API key (from query param or `X-API-Key` header), generates accept response via `HTTPParser.webSocketAcceptResponse()`, sends `101 Switching Protocols`, sets `connection.isWebSocket = true`, registers with `EventBroadcaster`
   - **No**: Routes through `APIRouter.handle(request)` → response JSON → `sendHTTPResponse()`
6. **WebSocket frame processing**: After upgrade, `processWebSocketData()` decodes frames:
   - `text` opcode: Reserved for future bidirectional commands
   - `ping`: Responds with `pong`
   - `close`: Sends close frame, disconnects
   - `pong`: Ignored
7. **Cleanup**: On disconnect, connection is removed from the map and unregistered from `EventBroadcaster`

---

### Event Broadcasting — How WebSocket Events Work

The `EventBroadcaster` uses a Combine-based observation system:

**Observation setup** (1-second timer):
1. Every second, `refreshObservations()` queries `WindowRegistry.shared.allWindows`
2. For each new `BrowserState`, subscribes to its `@Published` properties:
   - `$tabs`: Compares previous/current tab ID sets → emits `tabCreated` / `tabClosed`
   - `$currentTabId`: Emits `tabActivated`
3. For each new `Tab`, subscribes to:
   - `$url`: Emits `navigationChanged` (with `dropFirst` to skip initial value)
   - `$isLoading`: Emits `pageLoading` / `pageLoaded`
   - `$title`: Emits `tabUpdated` (300ms debounce to batch rapid title changes)
   - `$loadProgress`: Emits `pageProgress` (250ms throttle, takes latest value)
4. Cleanup: Removes subscriptions for tabs/windows that no longer exist

**Broadcast**:
```json
{
  "type": "tab.created",
  "data": { "tabId": "...", "windowId": "...", "url": "..." },
  "timestamp": "2026-04-02T12:34:56.789Z"
}
```
- JSON serialized → wrapped in a WebSocket text frame → sent to all connections with `.ready` state
- Stale connections (not `.ready`) are automatically removed from the active set

---

### Background Timers & Scheduled Tasks

The browser runs several background processes on timers:

| Task | Interval | What It Does |
|---|---|---|
| **Session auto-save** | 2s debounce | Saves all open tab metadata to UserDefaults on any tab change |
| **Memory monitoring** | 30s | Checks `resident_size` vs RAM limit, suspends tabs if over |
| **iCloud sync** | 120s | Pushes local changes to iCloud KVS |
| **iCloud change observation** | 2s debounce | Watches local data stores for changes, schedules push |
| **Event observation refresh** | 1s | Scans for new/removed windows and tabs, updates Combine subscriptions |
| **Performance metrics** | 2s | Collects CPU/RAM/GPU and per-tab metrics |
| **Content blocker precompile** | 2s after startup | Compiles remaining 15 blocker configurations in background |
| **Tor bootstrap poll** (iOS) | 0.5s | Polls embedded Tor for bootstrap progress (up to 60s) |
| **Tor stderr monitor** (macOS) | Continuous | Reads Tor process stderr for progress and error messages |
| **Autocomplete cache rebuild** | 200ms debounce | Rebuilds normalized entry cache on bookmark/history change |
| **WebView pool warming** | Startup | Pre-creates WebViews on background thread for instant tab creation |
| **Thumbnail capture** | 500ms after page load | Screenshots the rendered page for tab preview |
| **Favicon loading** | 50ms after page load | Fetches and caches the page's favicon |
| **Certificate probing** | 50ms after page load | Captures TLS certificate for HTTPS pages |
| **Page timing** | 150ms after page load | Reads JavaScript `performance` API for accurate load time |

---

## Data Models

### Tab

```json
{
  "id": "uuid",
  "title": "string",
  "url": "string",
  "isLoading": "boolean",
  "loadProgress": "number (0.0-1.0)",
  "isSecure": "boolean",
  "isPinned": "boolean",
  "isMuted": "boolean",
  "isPlayingAudio": "boolean",
  "hasCrashed": "boolean",
  "isPrivate": "boolean",
  "profileId": "uuid | null",
  "windowId": "uuid"
}
```

### Window

```json
{
  "id": "uuid",
  "tabCount": "number",
  "profileId": "uuid | null",
  "isPrivate": "boolean"
}
```

### Profile

```json
{
  "id": "uuid",
  "name": "string",
  "icon": "string",
  "color": "string (hex)",
  "fingerprintEnabled": "boolean",
  "fingerprintSeed": "number (6-digit)",
  "spoofLanguage": "string | null",
  "spoofTimezone": "string | null",
  "userAgentId": "string | null",
  "dnsProvider": "string | null",
  "torEnabled": "boolean | null",
  "proxyConfig": "ProxyConfig | null",
  "contentBlockerEnabled": "boolean | null",
  "blockTrackers": "boolean | null",
  "blockAds": "boolean | null",
  "blockPopups": "boolean | null",
  "extraBlockTrackers": "boolean | null",
  "extraBlockAds": "boolean | null",
  "automaticCookieConsent": "boolean | null"
}
```

### ProxyConfig

```json
{
  "type": "http | socks5",
  "host": "string",
  "port": "number",
  "username": "string | null",
  "password": "string | null",
  "isEnabled": "boolean",
  "selectionMode": "Manual | Random | Sequential",
  "proxyList": ["ProxyEntry"],
  "selectedIndex": "number",
  "lastUsedIndex": "number"
}
```

### History Entry

```json
{
  "id": "uuid",
  "url": "string",
  "title": "string",
  "visitCount": "number",
  "lastVisited": "ISO 8601 date"
}
```

### Download

```json
{
  "id": "uuid",
  "filename": "string",
  "url": "string",
  "state": "downloading | paused | completed | failed | cancelled",
  "progress": "number (0.0-1.0)",
  "totalBytes": "number",
  "receivedBytes": "number"
}
```

### Redirect Entry

```json
{
  "url": "string",
  "statusCode": "number | null",
  "redirectType": "initial | http301 | http302 | http307 | http308 | meta | js",
  "timestamp": "ISO 8601 date",
  "duration": "number (seconds since previous hop)",
  "requestHeaders": "object",
  "responseHeaders": "object",
  "cookies": "object",
  "method": "GET | POST | ..."
}
```

---

## Security Notes

| Concern | How Vela Handles It |
|---|---|
| **API access** | Localhost-only binding (`127.0.0.1`) with 32-character random API key. Can optionally bind to `0.0.0.0` for network access. |
| **Fingerprint consistency** | Seeded LCG PRNG ensures the same seed always produces the same fingerprint across sessions, page loads, and days |
| **Proxy credential exposure** | Credentials are passed via `ProxyConfiguration` objects, never embedded in URLs or logged |
| **IP leaks via WebRTC** | ICE servers stripped from `RTCPeerConnection` configs + `getStats()` filtered to remove local candidates |
| **DNS leaks** | When a proxy or Tor is active, DNS resolves through the proxy. DNS provider setting only applies to direct connections. |
| **Password storage** | macOS Keychain (encrypted at rest) with biometric gate (Touch ID / Face ID) |
| **Override detection** | All spoofed functions return `[native code]` via `WeakMap`-backed `toString()` masking. The masking function itself is also masked. |
| **Content blocking** | Precompiled rule list bytecode — no runtime regex, no JavaScript interception, blocks at the engine's network layer |
| **Profile separation** | Each profile uses a separate isolated data store with its own UUID — complete cookie, cache, and storage isolation |
| **Bot UA safety** | Login autofill refuses to submit forms when a bot UA is active |
| **Auth domain protection** | UA temporarily reverts to a default/common UA when on Google/Microsoft/Yahoo/Apple/Amazon/GitHub login pages |
| **Clipboard safety** | In Hidden mode, clipboard is saved and restored around paste operations via `NSLock` |
| **isTrusted events** | In Headed/Hidden mode, native input injection produces `isTrusted: true` events — undetectable by anti-bot JavaScript |
| **Tor shutdown** | Graceful SIGINT → SIGTERM → SIGKILL sequence with temp directory cleanup |
| **Sensitive auth domains** | Password autofill scripts exclude Microsoft/Google account pages to avoid breaking MSAL.js auth flows |
