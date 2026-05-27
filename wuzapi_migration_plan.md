# Migration: whatsgoapi → wuzapi

## Overview

Migrates `ravena-ai` from its custom `whatsgoapi` Go submodule to [wuzapi](https://github.com/asternic/wuzapi) — a maintained REST API for WhatsApp using the same whatsmeow library. Work happens on a dedicated `wuzapi` branch.

---

## Design Decisions (All Resolved)

| Decision | Choice |
|---|---|
| Instance model | One wuzapi **user per bot**. Token stored in `bots.json`. A setup script auto-generates entries. |
| Session migration | Use Postgres for wuzapi. Attempt migration — re-scan QR as fallback. |
| Webhook format | `WEBHOOK_FORMAT=json` always |
| Media delivery | `both` — wuzapi sends base64 + S3 URL in webhooks |
| Health check | Keep, update to `GET /health` |
| Port | `9810` for wuzapi |
| `DISABLE_ACTIVITY` | Retained — lets users scan QR without bot sending messages |
| Block/unblock | **Skip for now (Option D)** — revisit later |

---

## Confirmed Feature Matrix (from `routes.go` source)

> [!NOTE]
> `API.md` is severely outdated. The actual source has many more endpoints than documented.

### ✅ All features you use that ARE in wuzapi

| Your whatsgoapi endpoint | wuzapi endpoint | Notes |
|---|---|---|
| `POST /instance/connect` | `POST /session/connect` | Payload changes |
| `GET /instance/status` | `GET /session/status` | |
| `GET /instance/qr` | `GET /session/qr` | |
| `DELETE /instance/logout` | `POST /session/logout` | Method changes |
| `POST /instance/pair` | `POST /session/pairphone` | |
| `POST /send/text` | `POST /chat/send/text` | `number→Phone`, `text→Body` |
| `POST /send/media` (URL) | `POST /chat/send/image\|video\|audio\|document` | Pick by mimetype; base64 or S3 URL |
| `POST /send/sticker` | `POST /chat/send/sticker` | |
| `POST /send/location` | `POST /chat/send/location` | |
| `POST /send/contact` | `POST /chat/send/contact` | |
| `POST /send/poll` | `POST /chat/send/poll` | |
| `POST /message/react` | `POST /chat/react` | |
| `POST /message/delete` | `POST /chat/delete` | ✅ Exists (undocumented) |
| `POST /message/downloadmedia` | `POST /chat/download{image\|video\|audio\|document\|sticker}` | Different field structure |
| `POST /user/info` | `POST /user/info` | `number[]→Phone[]` |
| `POST /user/profileStatus` | `POST /status/set/text` | Different endpoint name |
| `GET /group/list` | `GET /group/list` | Response: `data.Groups[]` |
| `GET /group/myall` | `GET /group/list` | wuzapi only lists subscribed groups |
| `POST /group/info` | `GET /group/info` | Method changes to GET |
| `POST /group/leave` | `POST /group/leave` | ✅ Exists (undocumented) |
| `POST /group/join` | `POST /group/join` | ✅ Exists (undocumented) |
| `POST /group/invite-info` | `POST /group/inviteinfo` | ✅ Exists (undocumented) |
| `POST /group/name` | `POST /group/name` | Same |
| `POST /group/photo` | `POST /group/photo` | Base64 only (no URL) |
| `POST /group/participant` | `POST /group/updateparticipants` | Actions: `add\|remove\|promote\|demote` |
| `GET /instance/all` | `GET /admin/users` | Admin token |
| `POST /instance/create` | `POST /admin/users` | Different payload |
| `DELETE /instance/delete/:id` | `DELETE /admin/users/:id` | |
| Health check | `GET /health` | ✅ Exists (undocumented) |

### ❌ True gaps (graceful no-op)

| Feature | Mitigation |
|---|---|
| `GET /user/blocklist`, `POST /user/block\|unblock` | No-op + warn. Revisit later. |
| `POST /user/photo` (profile picture) | No-op + warn |
| `GET /group/myall` (bot-only groups) | Alias to `/group/list` |
| `POST /chat/commonGroups` | Return `[]` |

### ✅ Additional wuzapi endpoints (not in whatsgoapi, available for future use)

| wuzapi endpoint | Description |
|---|---|
| `POST /chat/markread` | Mark messages as read |
| `POST /chat/presence` | Set presence state (composing/paused) |
| `POST /user/avatar` | Get user avatar |
| `GET /user/contacts` | Get all contacts |
| `GET /user/lid/{jid}` | Get LID for a phone JID |
| `POST /user/presence` | Subscribe to user presence |
| `POST /group/invitelink` | Get group invite link |
| `POST /group/topic` | Update group topic/description |
| `POST /group/announce` | Toggle announce mode |
| `POST /group/locked` | Toggle locked mode |
| `POST /group/ephemeral` | Set ephemeral mode |
| `POST /group/create` | Create a new group |
| `POST /group/photo/remove` | Remove group photo |
| `POST /call/reject` | Reject incoming call |
| `POST /session/disconnect` | Disconnect websocket, keep session |
| `DELETE /admin/users/:id/full` | Delete user + session data |

---

## Webhook Event Translation

### Payload format changes

| Field | whatsgoapi | wuzapi (`WEBHOOK_FORMAT=json`) |
|---|---|---|
| Event name | `payload.event` | `payload.type` |

### Event type mapping

| whatsgoapi event | wuzapi type |
|---|---|
| `Message` | `Message` |
| `Connection` | `Connected` / `Disconnected` |
| `GroupInfo` | `GroupInfo` |
| `JoinedGroup` | `JoinedGroup` |
| `ChatPresence` | `ChatPresence` |
| `Receipt` | `ReadReceipt` |
| `QRCODE` | `QR` |
| `PushName` | Embedded inside `Message` event |

### Global webhook routing

wuzapi's global hook sends all events to one URL with a `token` field identifying the bot. The new `WuzapiEventHandler.js` maps `token → bot instance` and dispatches accordingly.

---

## Environment Variable Changes

### Add to `.env`
```env
WUZAPI_URL=http://wuzapi:8080
WUZAPI_ADMIN_TOKEN=<strong-random-token>
WUZAPI_PORT=9810
WUZAPI_GLOBAL_WEBHOOK=http://ravena-ai:5000/webhook/wuzapi
WEBHOOK_FORMAT=json
```

### Remove from `.env`
```env
WHATS_GO_API_URL
WHATS_GO_API_KEY
WHATSGO_WEBHOOK_HOST
WHATSGO_WEBHOOK_PORT
WEBHOOK_PORT_WHATSGO
GLOBAL_API_KEY
```

### New `bots.json` fields per bot
```json
{
  "useWuzapi": true,
  "wuzapiUserName": "ravena1",
  "wuzapiUserToken": "auto-generated-uuid-per-bot"
}
```

---

## Migration Strategy: Parallel Mode

**Both** whatsgoapi and wuzapi will run simultaneously during migration. Bots are assigned to one backend via `bots.json`:

- `useWuzapi: false` (default, implicit) → `WhatsAppBotGo` + whatsgoapi
- `useWuzapi: true` → `WhatsAppBotWuzapi` + wuzapi

This allows incremental migration: move bots one at a time, verify each works, then proceed. No big-bang cutover.

**Docker Compose** runs **both** `whatsgoapi` and `wuzapi` services. The `whatsgoapi` service is **not** removed — it coexists until all bots are migrated.

---

## Batch Plan

### Batch 1 — Branch + Documentation ✅ COMPLETE

Create the `wuzapi` git branch. Document all endpoint mappings in `wuzapi-endpoints.md`.

**Files:**
- `[NEW]` `wuzapi-endpoints.md` — ✅ full endpoint reference with request/response examples

---

### Batch 2 — Docker Compose + Environment ✅ COMPLETE

**Files:**
- `[MODIFY]` `docker-compose.yml` — ✅
  - Add `wuzapi` service (`asternic/wuzapi:latest`) on port `9810`
  - Keep `postgres` — wuzapi uses it via `DB_HOST`, `DB_USER`, etc.
  - Keep `minio` — reused for S3-compatible media delivery
  - **Keep** `whatsgoapi` service (parallel mode — not removed)
  - Update `ravena-ai` env block: add `WUZAPI_URL`, `WUZAPI_ADMIN_TOKEN`, `WUZAPI_GLOBAL_WEBHOOK`
  - Add wuzapi health check to `health-check` service
- `[MODIFY]` `.env.example` — ✅ add all new variables, keep old ones
- `[NEW]` `setup-wuzapi-bots.js` — ✅ CLI script: reads `bots.json`, creates wuzapi users via admin API, writes tokens back

---

### Batch 3 — WuzapiClient + WhatsAppBotWuzapi (Core) ✅ COMPLETE

**Files:**
- `[NEW]` `src/services/WuzapiClient.js` — ✅
  - Auth: `Authorization: <userToken>` header (not `apikey`/`instance`)
  - Methods: `get()`, `post()`, `adminGet()`, `adminPost()`, `adminDelete()`
  - Error handling mirroring `WhatsgoClient.js`

- `[NEW]` `src/WhatsAppBotWuzapi.js` — ✅
  - Same public interface as `WhatsAppBotGo.js`
  - Uses `WuzapiClient` internally
  - **No per-instance webhook server** (global webhook only)
  - All key methods implemented:
    - `initialize()` — `POST /session/connect` + subscribe events
    - `sendMessage()` — routes to correct `/chat/send/*` by content type/mimetype
    - `_downloadMedia()` — calls `/chat/download{type}` with message fields
    - `getChatDetails()` — `GET /group/info` (note: GET not POST)
    - `getContactDetails()` — `POST /user/info`
    - `listGroups()` — `GET /group/list`, normalize `data.Groups[]`
    - `removeFromGroup()` / `addToGroup()` — `POST /group/updateparticipants`
    - `leaveGroup()` — `POST /group/leave`
    - `acceptInviteCode()` — `POST /group/join`
    - `inviteInfo()` — `POST /group/inviteinfo`
    - `sendReaction()` — `POST /chat/react`
    - `deleteMessageByKey()` — `POST /chat/delete`
    - `updateProfileStatus()` — `POST /status/set/text`
    - `setCttBlockStatus()` — no-op + warn
    - `fetchAndPrepareBlockedContacts()` — returns `[]`
    - `updateProfilePicture()` — no-op + warn
    - `_checkInstanceStatusAndConnect()` — `GET /session/status` + connect if needed
    - `createInstance()` — `POST /admin/users` + `POST /session/connect`

---

### Batch 4 — Global Webhook Handler + BotAPI Updates ✅ COMPLETE

**Files:**
- `[MODIFY]` `src/BotAPI.js` — ✅
  - Register `POST /webhook/wuzapi` → inline wuzapi webhook handler
  - Translates wuzapi payload (`type`, `token`, `event`) → existing bot event format
  - Routes to correct bot by matching `token → bot.wuzapiUserToken`
  - Dispatches to `eventHandler.onMessage()`, `onGroupJoin()`, etc.
  - Update `checkServices()` — call `GET /health` on wuzapi (in addition to whatsgoapi)
  - Update `/qrcode/:botId` — detect wuzapi bots, call `GET /session/qr` on wuzapi

---

### Batch 5 — index.js + bots.json + Tooling ✅ COMPLETE

**Files:**
- `[MODIFY]` `index.js` — ✅ Detect `bot.useWuzapi === true` → instantiate `WhatsAppBotWuzapi`
  - Pass `wuzapiUrl` + `wuzapiAdminToken` from env; `wuzapiUserToken` + `wuzapiUserName` from bot config
  - Keep existing `WhatsAppBotGo` path for bots not yet migrated

- `[MODIFY]` `bots.json.example` — ✅
  - Add `useWuzapi`, `wuzapiUserName`, `wuzapiUserToken` fields
  - Document which old fields are no longer needed

- `[NEW]` `query-wuzapi.js` — ✅
  - CLI debug tool equivalent of `whatsgoapi/query-whatsgo.js`
  - Functions: `sessionStatus`, `sessionConnect`, `sessionQR`, `sessionLogout`, `sessionPairphone`, `adminListUsers`, `adminAddUser`, `adminDeleteUser`, `setWebhook`, `getWebhook`, `listGroups`, `groupInfo`, `groupUpdateParticipants`, `groupLeave`, `groupJoin`, `groupName`, `groupPhoto`, `userInfo`, `userCheck`, `sendText`, `sendImage`, `sendVideo`, `sendAudio`, `sendDocument`, `sendSticker`, `sendLocation`, `sendContact`, `react`, `markRead`, `deleteMessage`, `downloadMedia`, `configS3`

- `[NEW]` `migrate-sessions.js` — ⏳ Deferred
  - Reads whatsgoapi Postgres schema (whatsmeow device tables)
  - Maps instance names → wuzapi user IDs
  - Dumps + restores session data into wuzapi's Postgres
  - Falls back gracefully if schemas don't align (re-scan QR)

---

### Batch 6 — Testing Infrastructure ✅ COMPLETE

The existing `run-testes.js` + `FakeBot` + `TestRunner` infrastructure is updated and expanded to fully support wuzapi testing. The `FakeBot` already implements the interface expected by the pipeline (EventHandler → CommandHandler → functions), so the core approach remains the same. The key change is ensuring all wuzapi-specific code paths are exercisable through the test harness.

The testing strategy uses a **single comprehensive `run-testes.js`** file organized in logical sections. Each section can be independently commented/uncommented to focus on specific areas. The `bots.json` file used during testing can be empty `[]` since `FakeBot` bypasses real connections entirely — the pipeline (EventHandler → CommandHandler → functions) only needs the `FakeBot` interface.

#### Testing Architecture

```
run-testes.js                    ← Entry point, organized test sections
  └── TestRunner.js              ← Executor (already exists, handles polling + timing)
        └── FakeBot.js           ← Bot stub (already exists, captures ReturnMessages)
              └── helpers.js     ← Message factory (msgTexto, msgMedia, msgComQuote, msgCustom)
                    └── FakeMessage.js  ← Message builder (already exists)
```

#### Test Categories in run-testes.js

The run-testes.js is organized into the following sections, each clearly delimited with comments:

1. **Basic Commands** — `!ping`, `!status`, `!help`, `!uptime` — verify the pipeline works
2. **AI Commands** — `!chat`, `!resumo`, `!traduza` — test LLM integration paths (may be slow)
3. **Media Commands** — `!yt`, `!s` (sticker from image), `!s` (sticker from audio) — test media download + processing
4. **Image Manipulation** — `!meme`, `!rembg`, `!sd` — test image generation/editing
5. **Search Commands** — `!google`, `!wiki`, `!imdb` — test external API calls
6. **Group Commands** — `!ban`, `!unban`, `!mute`, `!unmute`, `!promover`, `!rebaixar` — test group management
7. **Game Commands** — `!dado`, `!roleta`, `!slot`, `!anagrama` — test game logic
8. **Reaction Tests** — Test reaction sending via quoted messages
9. **Private Message Tests** — Test PV-specific behavior (ignorePV, pvAI, whitelist)
10. **Error Handling** — Test malformed commands, missing media, API failures
11. **Wuzapi Webhook Payload Tests** — Test wuzapi-specific webhook event translation

#### Wuzapi-Specific Testing

Since wuzapi changes the webhook payload format (`payload.type` vs `payload.event`, `payload.token` vs `payload.instance`), the webhook translation layer must be tested with realistic payloads. This is done through:

- **`src/testing/wuzapi-fixtures.js`** — ✅ Pre-built wuzapi webhook payloads that can be fed to the translation layer
- **Inline tests in run-testes.js** — Section 11 above tests the translation directly
- **`src/testing/FakeWuzapiClient.js`** — ✅ Mock client with all wuzapi endpoints simulated

**Files:**
- `[MODIFY]` `run-testes.js` — ✅ Reorganized into 11 categories with `// === CATEGORY NAME ===` delimiters
  - Add comprehensive tests for all commonly used commands
  - Include wuzapi webhook payload translation tests
  - Use `bots.json` = `[]` (empty) since FakeBot is used

- `[MODIFY]` `src/testing/FakeBot.js` — ✅
  - Added `useWuzapi`, `wuzapiUserToken`, `wuzapiUserName` properties
  - Added `markRead()`, `setPresence()` stubs (new wuzapi capabilities)

- `[NEW]` `src/testing/FakeWuzapiClient.js` — ✅
  - Mock client that simulates wuzapi API responses without a real server
  - Predefined responses for: session/connect, session/status, chat/send/*, group/*, user/*
  - Supports "record/replay" mode: record real wuzapi responses, replay in tests
  - Configurable error modes for testing error handling
  - All endpoints from wuzapi-endpoints.md implemented

- `[NEW]` `src/testing/wuzapi-fixtures.js` — ✅
  - Collection of realistic wuzapi webhook payloads for testing event translation
  - Text message, media message (with base64 + S3), reaction, group events, read receipts
  - Connection events: Connected, Disconnected, QR

- `[MODIFY]` `Makefile` — ✅
  - Added `make test-wuzapi` target that runs the wuzapi-focused test suite
  - Added `make restart-wuzapi` and `make logs-wuzapi` targets
  - `make test` runs both whatsgo and wuzapi tests (configurable via env)

---

### Batch 7 — Decommission whatsgoapi (Future)

**Only after all bots are verified on wuzapi:**

- `[MODIFY]` `docker-compose.yml` — remove `whatsgoapi` service
- `[MODIFY]` `.env.example` — remove whatsgoapi variables
- `[DELETE]` `src/services/WhatsgoApiClient.js`
- `[DELETE]` `src/services/WhatsgoClient.js`
- `[DELETE]` `src/WhatsAppBotGo.js`
- `[DELETE]` `whatsgoapi/` submodule
- `[MODIFY]` `index.js` — remove whatsgoapi code paths
- `[MODIFY]` `src/BotAPI.js` — remove whatsgoapi references
- `[MODIFY]` `Makefile` — remove whatsgoapi targets

