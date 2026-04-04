# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This project has **three components**:

1. **Chrome Extension** (Manifest V3) in `extention/` — the original "Facebook Groups Bulk Poster & Scheduler" (legacy)
2. **Ghost Browser** in `ghost-browser/` — containerized Playwright + Chrome browser engine with fingerprint spoofing (replaces Vela Browser)
3. **Vela Poster Server** in `vela-poster/` — posting orchestration server + dashboard UI

Ghost Browser + Vela Poster are the **active development targets**. The Chrome extension is legacy.

## Repository Structure

### `ghost-browser/` — Browser Engine (active)

- **Dockerfile** — Node.js + Google Chrome + Tor, runs as non-root
- **src/index.ts** — Express server entry, port 1306
- **src/browser/manager.ts** — Launches Chrome with stealth plugin, fallback to Chromium
- **src/browser/context-manager.ts** — Per-profile BrowserContexts with isolated cookies/storage/proxy/Tor
- **src/browser/tab-manager.ts** — One-tab-per-profile enforcement with per-profile locking (prevents OOM)
- **src/fingerprint/** — Seed-based deterministic fingerprinting (18 vectors)
  - `prng.ts` — Mulberry32 seeded PRNG
  - `generator.ts` — Seed → platform-coherent fingerprint config + matching UA
  - `inject.ts` — Builds addInitScript JS payload for all spoofing vectors
- **src/tor/manager.ts** — Per-profile Tor instances with own exit IPs
- **src/profiles/store.ts** — Profile CRUD on disk (JSON files)
- **src/persistence/state-manager.ts** — Cookie + localStorage save/restore
- **src/routes/** — Vela-compatible REST API (tabs, profiles, windows, status)
- **src/middleware/auth.ts** — Timing-safe API key validation

### `vela-poster/` — Posting Server (active)

- **src/server.ts** — Express server with auto-syncing per-profile ports (5001+), port recycling
- **src/vela/client.ts** — HTTP client for Ghost Browser API (same API as Vela)
- **src/orchestrator/** — Posting flow: campaign-runner (one tab at a time, sequential), composer, post-button, uploader, spintax
- **src/routes/extension-messages.ts** — Campaign dispatch, overrides group URLs from server storage
- **src/storage/storage.ts** — File-based storage with ProfileStorageManager
- **ui/chrome-api-shim.js** — Intercepts chrome.* API calls, premium bypass, IndexedDB blocking, crypto.randomUUID polyfill, storage polling for live feedback
- **ui/index.html** — Popup UI with console.error capture for debugging

### `vela-poster/dashboard/` — Command Center (active)

- **dashboard.html** — Full command center UI with profile management (add/delete), FB Login (screenshot viewer), Get Groups (auto-scrape), group sync, unified posting
- **browser-viewer.html** — Screenshot-based remote browser viewer with zoom controls
- **server.js** — Express server with basic auth, browser proxy endpoints, profile CRUD, group sync, get-groups scraper, post-unified with per-profile URL override

### `extention/` — Chrome Extension (legacy)
Note the misspelling — intentional, do not rename.

## Deployment

### Hetzner VPS (77.42.95.15)
- **GitHub**: `ghadeerismael98/facee` (private)
- **Root docker-compose.yml** runs all 3 services
- **Dashboard**: port 4000 (only port exposed to internet, basic auth protected)
- **Ghost Browser**: port 1306 (127.0.0.1 only)
- **Poster**: ports 3333, 5001-5020

```bash
# Deploy
git push && ssh root@77.42.95.15 "cd /opt/facee && git pull && docker compose up --build -d"
```

### Existing services on VPS (DO NOT TOUCH)
- `nevebots-neve` on port 19003
- `nevebots-postgres` on port 5432

## Ghost Browser Architecture

### Fingerprint System (Critical — must maintain coherence)
- A 6-digit seed per profile drives a deterministic PRNG
- The seed determines the platform (windows/mac/linux)
- ALL values must be coherent with that platform:
  - `navigator.userAgent` — generated to match platform
  - `navigator.appVersion` — derived from userAgent
  - `navigator.platform` — Win32/MacIntel/Linux x86_64
  - `navigator.vendor` — Google Inc./Apple Computer, Inc.
  - `window.devicePixelRatio` — 1-1.5 (Windows), 2 (Mac), 1 (Linux)
  - WebGL GPU — platform-specific pool
  - Canvas noise, AudioContext noise, screen dimensions, etc.
- **Never let real Chrome UA leak through** — override in fingerprint injection

### Tab Management
- One tab per profile maximum (enforced by per-profile lock)
- Campaign runner posts sequentially: open → post → close → wait → next group
- Never multiple tabs open simultaneously for same profile

### Profile Isolation
- Each profile = separate BrowserContext (cookies, storage, cache fully isolated)
- Optional Tor circuit per profile (own exit IP)
- Optional proxy per profile
- Persistent cookies saved to /data/profiles/{id}/cookies.json

## Chrome API Shim (ui/chrome-api-shim.js)

Key behaviors:
- **IndexedDB blocked** — forces popup to use chrome.storage.local (our shim) instead of empty IndexedDB
- **crypto.randomUUID polyfill** — not available on HTTP (non-secure context)
- **Premium bypass** — intercepts fbgroupbulkposter.com requests, returns fake premium
- **Storage polling** — polls posting status every 2s for live feedback
- **Pre-seeds group data** — fires onChanged after profile detection to populate Zustand state

## Development Notes

- The popup UI bundle (`main-BRMGV53A.js`) is a pre-built artifact — do not edit it. Modify behavior via the shim or server-side routes.
- Facebook DOM selectors must be multi-language — see `src/orchestrator/selectors.ts`
- Facebook is an SPA — wait for content to render after load event
- Post Selected reads each profile's own group URLs from server storage (not dashboard's group list)
- Profile ports auto-sync every 10 seconds — no restart needed for new/deleted profiles
- Deleted profile ports are recycled (lowest available reused)

## Security

- Dashboard protected by basic auth (DASH_USER/DASH_PASS in .env)
- API key comparison uses crypto.timingSafeEqual
- Ghost Browser API bound to 127.0.0.1 only
- Profile IDs validated (alphanumeric only, prevents path traversal)
- File upload filenames sanitized (path.basename)
- Navigate endpoint validates URLs (http/https only)
- Scroll endpoint sanitizes deltaY (parseInt, prevents code injection)
- Tab IDs validated on all browser proxy endpoints
- JSON body limit: 10MB
