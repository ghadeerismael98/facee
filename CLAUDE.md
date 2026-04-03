# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This project has **two components**:

1. **Chrome Extension** (Manifest V3) in `extention/` — the original "Facebook Groups Bulk Poster & Scheduler"
2. **Vela Poster Server** in `vela-poster/` — a standalone Node.js server that does the same thing via the Vela Browser API, running in Docker

The Vela server is the **active development target**. The Chrome extension is legacy.

## Repository Structure

### `extention/` — Chrome Extension (legacy)
Note the misspelling — intentional, do not rename.

- **manifest.json** — MV3 manifest
- **background.js** — Service worker: posting orchestration, Spintax, credits
- **content.js** — Content script: Facebook DOM interaction
- **assets/main-BRMGV53A.js** — Pre-built popup UI (Vite + React + TS), source lives elsewhere

### `vela-poster/` — Vela Browser Server (active)

- **Dockerfile / docker-compose.yml** — Docker setup with poster + dashboard services
- **src/server.ts** — Express server with profile-aware storage, per-profile campaign runners, per-profile ports (5001+)
- **src/vela/client.ts** — HTTP client for Vela Browser API (port 1306)
- **src/orchestrator/** — Posting flow: campaign-runner (global posting lock), composer (execCommand), post-button, uploader, spintax
- **src/routes/** — API routes: extension-messages (per-profile event queues), storage (per-profile), profiles
- **src/storage/storage.ts** — File-based storage with `ProfileStorageManager` for per-profile isolation
- **ui/chrome-api-shim.js** — Intercepts `chrome.*` API calls, handles profile detection (URL param or title-nonce), premium bypass, storage sync
- **ui/index.html** — Serves the popup UI with shim injected before the bundle
- **ui/assets/main-BRMGV53A.js** — Same popup bundle as the extension (reused via shim)
- **dashboard/** — Separate service: command center UI on port 4000

### `vela-poster/dashboard/` — Enhanced Command Center

- **dashboard.html** — Full command center: unified post editor, group management, profile selection, smart scheduling, collapsible profiles grid with iframe popup UIs
- **server.js** — Express server with endpoints: post-unified (with scheduling strategies), sync-groups (Zustand format), schedule-status, upload-video, stop-all
- **Dockerfile / package.json** — Separate Docker service

## Vela Poster Architecture

### Three Services (Docker)
- **Poster** (port 3333) — main server, configure groups/posts here
- **Per-profile ports** (5001, 5002, ...) — same poster app, auto-set X-Vela-Profile, used by dashboard iframes for origin isolation
- **Dashboard** (port 4000) — enhanced command center with unified posting, group sync, smart time distribution, profile selection

### Posting Flow
1. JS `.click()` on composer trigger (multi-language text match, search ALL dialogs)
2. `document.execCommand('insertText')` via `executeScript` — works without window focus
3. JS `.click()` on post button (multi-language aria-label match, search ALL dialogs)
4. Global posting lock serializes inject+post step across profiles

### Profile Isolation
- Shim detects Vela profileId via URL param `?profile=` or title-nonce trick
- `X-Vela-Profile` header on all requests
- Per-profile storage: `~/.face-poster/profiles/{profileId}/`
- Per-profile campaign runners — multiple profiles post with global posting lock
- Per-profile event queues for real-time UI updates
- Per-profile ports (5001+) for dashboard iframes — different origins = isolated browser storage

### Premium Bypass
- `chrome-api-shim.js` intercepts all `fetch()` to `fbgroupbulkposter.com`
- Returns fake premium/subscription/credits responses
- Storage always overrides `isPremium: true`, `postsRemaining: 999999`
- Protects group lists from empty overwrites during hydration

### Vela API Quirks
- `executeScript` expects `{ script: "..." }` not `{ expression: "..." }`, returns `{ result: ... }`
- `createTab` with `profileId` (camelCase) creates tab in correct Vela profile
- `nativeClick`/`keyboard/insert-text` need window focus — unusable for parallel posting
- `document.execCommand('insertText')` via executeScript works without focus — use this
- Don't retry execCommand — causes double text
- Facebook pages have multiple `[role="dialog"]` — always search ALL, never querySelector first match

### Docker
- Multi-stage build, runs as non-root, volume `poster-data` for persistence
- `VELA_API_URL=http://host.docker.internal:1306` to reach Vela from container
- `.env` has `VELA_API_URL`, `VELA_API_KEY`, `PORT`
- Rebuild: `cd vela-poster && docker compose up --build -d`
- Logs: `docker compose logs -f`

### Command Center Features
- **Unified Post & Groups** (collapsible): Rich text editor (contenteditable) with B/I/U/H1/H2/lists toolbar, spintax editor with save/load templates (`spintax_templates_v1` localStorage key shared with popup), emoji picker (`emoji-picker-element` web component), image/video upload, delivery pacing, group URL management with sync-to-selected
- **Profile Selection**: Checkboxes on cards + dropdown (Select/Deselect All), persisted to localStorage
- **Smart Time Distribution**: 5 strategies — Immediate, Sequential (safest), Staggered, Time Window, Group Spread (split groups across profiles). Live time estimate preview.
- **Collapsible Profiles**: Profile grid with iframes in collapsible section
- **Schedule Status**: Polls `/api/dashboard/schedule-status` for countdown timers on waiting profiles
- **Port 3333 = "default" profile** — synced groups from dashboard only go to UUID-based profiles (5001+). Use Command Center (4000) or per-profile ports for posting.

## Development Notes

- The popup UI bundle (`main-BRMGV53A.js`) is a pre-built artifact — do not edit it. Modify behavior via the shim or server-side routes.
- When replicating popup UI features in the dashboard, search the bundle source (`grep`) and copy the exact structure/labels/behavior — don't approximate.
- Facebook DOM selectors must be multi-language (Arabic, English, Spanish, French, etc.) — see `src/orchestrator/selectors.ts`
- Facebook is an SPA — wait for content to render after load event, not just page load
- When modifying posting logic in the Chrome extension, keep content.js unchanged (harden background.js only)
- Configure groups via Command Center (port 4000) or per-profile ports (5001+). Port 3333 is the unconfigured default profile.
