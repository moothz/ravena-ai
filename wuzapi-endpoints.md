# wuzapi Endpoint Reference

> Source of truth: `routes.go` from https://github.com/asternic/wuzapi  
> **Note:** `API.md` in that repo is severely outdated. Many endpoints exist but are undocumented.

## Authentication

- **Admin endpoints** (`/admin/*`): `Authorization: <WUZAPI_ADMIN_TOKEN>`  
- **User endpoints** (all others): `Authorization: <user-token>` (per-bot token)  
- **No** `apikey` or `instance` headers (unlike whatsgoapi)

---

## Migration Map: whatsgoapi → wuzapi

| whatsgoapi endpoint | wuzapi endpoint | Method change | Payload changes |
|---|---|---|---|
| `POST /instance/connect` | `POST /session/connect` | — | `Subscribe[]` not `subscribe[]`; `Immediate` bool |
| `GET /instance/status` | `GET /session/status` | — | — |
| `GET /instance/qr` | `GET /session/qr` | — | Response: `data.QRCode` (base64 png) |
| `DELETE /instance/logout` | `POST /session/logout` | DELETE→POST | — |
| `POST /instance/pair` | `POST /session/pairphone` | — | `{Phone: "5599..."}` |
| `GET /instance/all` | `GET /admin/users` | — | Admin token required |
| `POST /instance/create` | `POST /admin/users` | — | `{name, token, webhook, events}` |
| `DELETE /instance/delete/:id` | `DELETE /admin/users/:id` | — | Admin token required |
| `POST /send/text` | `POST /chat/send/text` | — | `number→Phone`, `text→Body`, quoted→`ContextInfo{StanzaId,Participant}` |
| `POST /send/media` | `POST /chat/send/image\|video\|audio\|document` | — | Pick endpoint by mimetype; `Image\|Video\|Audio\|Document` = base64 data URI |
| `POST /send/sticker` | `POST /chat/send/sticker` | — | `Sticker` = base64 data URI |
| `POST /send/location` | `POST /chat/send/location` | — | Same fields (Latitude, Longitude, Name) |
| `POST /send/contact` | `POST /chat/send/contact` | — | `Name`, `Vcard` (full vcard string) |
| `POST /send/poll` | `POST /chat/send/poll` | — | Same |
| `POST /message/react` | `POST /chat/react` | — | `Phone`, `Body` (emoji), `Id` (prefix `me:` if own msg) |
| `POST /message/delete` | `POST /chat/delete` | — | See below |
| `POST /message/downloadmedia` | `POST /chat/download{image\|video\|audio\|document\|sticker}` | — | `{Url, MediaKey, Mimetype, FileSHA256, FileLength, FileEncSHA256}` |
| `POST /user/info` | `POST /user/info` | — | `number[]→Phone[]` |
| `POST /user/profileStatus` | `POST /status/set/text` | — | `{Text: "status text"}` |
| `GET /group/list` | `GET /group/list` | — | Response: `data.Groups[]` (not `data`) |
| `GET /group/myall` | `GET /group/list` | — | wuzapi only lists joined groups anyway |
| `POST /group/info` | `GET /group/info` | POST→GET | `GroupJID` in request body |
| `POST /group/leave` | `POST /group/leave` | — | `{GroupJID}` |
| `POST /group/join` | `POST /group/join` | — | `{Code}` (invite link or code) |
| `POST /group/invite-info` | `POST /group/inviteinfo` | — | `{Code}` (full invite link) |
| `POST /group/name` | `POST /group/name` | — | `{GroupJID, Name}` |
| `POST /group/photo` | `POST /group/photo` | — | `{GroupJID, Image}` — base64 JPEG only, no URLs |
| `POST /group/participant` | `POST /group/updateparticipants` | — | `{GroupJID, Phone[], Action}` — Action: `add\|remove\|promote\|demote` |
| `POST /webhook` | `POST /webhook` | — | `{webhookURL, events[]}` per user |
| `GET /user/blocklist` | ❌ Not available | — | Return `[]` |
| `POST /user/block\|unblock` | ❌ Not available | — | No-op |
| `POST /user/photo` | ❌ Not available | — | No-op |
| `POST /chat/commonGroups` | ❌ Not available | — | Return `[]` |

---

## Session Endpoints

### `POST /session/connect`
```json
{
  "Subscribe": ["Message", "ReadReceipt", "HistorySync", "ChatPresence"],
  "Immediate": true
}
```
Response: `{ code, data: { details, events, jid, webhook }, success }`

### `GET /session/status`
Response: `{ code, data: { Connected, LoggedIn }, success }`

### `GET /session/qr`
Response: `{ code, data: { QRCode: "data:image/png;base64,..." }, success }`

### `POST /session/pairphone`
```json
{ "Phone": "5599999999999" }
```

### `POST /session/disconnect`
No body. Disconnects websocket, keeps session.

### `POST /session/logout`
No body. Disconnects and deletes session (requires QR rescan).

---

## Admin Endpoints

### `GET /admin/users`
Response: array of user objects `[{ id, name, token, webhook, jid, connected, events }]`

### `POST /admin/users`
```json
{
  "name": "botname",
  "token": "unique-token",
  "webhook": "http://ravena-ai:5000/webhook/wuzapi",
  "events": "Message,ReadReceipt,HistorySync,ChatPresence",
  "s3Config": {
    "enabled": true,
    "endpoint": "http://minio:9000",
    "region": "us-east-1",
    "bucket": "zap-media",
    "access_key": "minioadmin",
    "secret_key": "...",
    "path_style": true,
    "public_url": "http://minio:9000/zap-media",
    "media_delivery": "both",
    "retention_days": 0
  }
}
```
Response: `{ id: <numeric-user-id> }`

### `DELETE /admin/users/:id`
Deletes user. Use `DELETE /admin/users/:id/full` to also delete session data.

---

## Webhook Endpoints

### `POST /webhook`
```json
{ "webhookURL": "http://ravena-ai:5000/webhook/wuzapi" }
```

### `GET /webhook`
Response: `{ code, data: { subscribe: ["Message"], webhook: "..." }, success }`

---

## Chat / Message Endpoints

### `POST /chat/send/text`
```json
{
  "Phone": "5599999999999@s.whatsapp.net",
  "Body": "Hello!",
  "Id": "optional-message-id",
  "ContextInfo": {
    "StanzaId": "QUOTED_MSG_ID",
    "Participant": "5599999@s.whatsapp.net"
  }
}
```

### `POST /chat/send/image`
```json
{
  "Phone": "5599999999999@s.whatsapp.net",
  "Image": "data:image/jpeg;base64,...",
  "Caption": "optional caption"
}
```

### `POST /chat/send/video`
```json
{
  "Phone": "...",
  "Video": "data:video/mp4;base64,...",
  "Caption": "optional"
}
```

### `POST /chat/send/audio`
```json
{
  "Phone": "...",
  "Audio": "data:audio/ogg;base64,..."
}
```

### `POST /chat/send/document`
```json
{
  "Phone": "...",
  "Document": "data:application/octet-stream;base64,...",
  "FileName": "file.pdf"
}
```

### `POST /chat/send/sticker`
```json
{
  "Phone": "...",
  "Sticker": "data:image/webp;base64,..."
}
```
Also supports animated: `data:video/mp4;base64,...`

### `POST /chat/send/location`
```json
{
  "Phone": "...",
  "Latitude": -23.5,
  "Longitude": -46.6,
  "Name": "São Paulo"
}
```

### `POST /chat/send/contact`
```json
{
  "Phone": "...",
  "Name": "John Doe",
  "Vcard": "BEGIN:VCARD\nVERSION:3.0\n..."
}
```

### `POST /chat/send/poll`
```json
{
  "Phone": "...",
  "Name": "Question?",
  "Options": ["Option 1", "Option 2"],
  "SelectableCount": 1
}
```

### `POST /chat/react`
```json
{
  "Phone": "5599999999999@s.whatsapp.net",
  "Body": "❤️",
  "Id": "MSG_ID"
}
```
Prefix `Id` with `me:` if reacting to own message.

### `POST /chat/delete`
```json
{
  "Phone": "5599999999999@s.whatsapp.net",
  "MessageId": "MSG_ID",
  "FromMe": true
}
```

### `POST /chat/markread`
```json
{
  "Id": ["MSG_ID_1", "MSG_ID_2"],
  "ChatPhone": "5599999999999",
  "SenderPhone": "5599999999998"
}
```

### `POST /chat/presence`
```json
{
  "Phone": "...",
  "State": "composing",
  "Media": ""
}
```
States: `composing`, `paused`. Media: `audio` for voice recording indicator.

### `POST /chat/download{image|video|audio|document|sticker}`
```json
{
  "Url": "https://mmg.whatsapp.net/...",
  "MediaKey": "base64key",
  "Mimetype": "image/jpeg",
  "FileSHA256": "base64sha",
  "FileLength": 12345,
  "FileEncSHA256": "base64encsha"
}
```
All fields come from the `Message.imageMessage` (or equivalent) in the webhook event.

---

## User Endpoints

### `POST /user/info`
```json
{ "Phone": ["5599999999999@s.whatsapp.net"] }
```
Response: `data.Users["jid@s.whatsapp.net"]` = `{ Devices, PictureID, Status, VerifiedName }`

### `POST /user/check`
```json
{ "Phone": ["5599999999999"] }
```
Response: `data.Users[]` = `[{ IsInWhatsapp, JID, Query, VerifiedName }]`

### `POST /user/avatar`
```json
{ "Phone": "5599999999999", "Preview": true }
```

### `GET /user/contacts`
No body. Returns all contacts.

### `GET /user/lid/{jid}`
Returns LID for a given phone JID.

### `POST /user/presence`
```json
{ "Subscribe": "5599999999999@s.whatsapp.net" }
```

---

## Group Endpoints

### `GET /group/list`
Response: `data.Groups[]` — each group has `JID, Name, Participants[], IsAnnounce, IsParent, Topic, ...`

### `GET /group/info`
Body: `{ "GroupJID": "120363...@g.us" }`  
Response: same structure as group list item.

### `POST /group/invitelink`
Body: `{ "GroupJID": "120363...@g.us" }`  
Response: `data.InviteLink`

### `POST /group/join`
```json
{ "Code": "https://chat.whatsapp.com/XXXXXXXX" }
```

### `POST /group/inviteinfo`
```json
{ "Code": "https://chat.whatsapp.com/XXXXXXXX" }
```

### `POST /group/leave`
```json
{ "GroupJID": "120363...@g.us" }
```

### `POST /group/updateparticipants`
```json
{
  "GroupJID": "120363...@g.us",
  "Phone": ["5599999999999@s.whatsapp.net"],
  "Action": "add"
}
```
Actions: `add`, `remove`, `promote`, `demote`

### `POST /group/name`
```json
{ "GroupJID": "...", "Name": "New Name" }
```

### `POST /group/topic`
```json
{ "GroupJID": "...", "Topic": "New description" }
```

### `POST /group/photo`
```json
{ "GroupJID": "...", "Image": "data:image/jpeg;base64,..." }
```
JPEG only.

### `POST /group/photo/remove`
```json
{ "groupjid": "..." }
```

### `POST /group/announce`
```json
{ "GroupJID": "...", "Announce": true }
```

### `POST /group/locked`
```json
{ "groupjid": "...", "locked": true }
```

### `POST /group/ephemeral`
```json
{ "groupjid": "...", "duration": "24h" }
```
Values: `24h`, `7d`, `90d`, `off`

### `POST /group/create`
```json
{ "name": "Group Name", "participants": ["5599999999999"] }
```

---

## Misc Endpoints

### `GET /health`
Returns 200 OK when wuzapi is running.

### `POST /status/set/text`
```json
{ "Text": "My new WhatsApp status" }
```

### `POST /call/reject`
Rejects an incoming call.

### `POST /session/s3/config`
```json
{
  "enabled": true,
  "endpoint": "http://minio:9000",
  "region": "us-east-1",
  "bucket": "zap-media",
  "access_key": "minioadmin",
  "secret_key": "...",
  "path_style": true,
  "public_url": "http://minio:9000/zap-media",
  "media_delivery": "both",
  "retention_days": 0
}
```

---

## Webhook Payload (WEBHOOK_FORMAT=json)

```json
{
  "type": "Message",
  "token": "bot-user-token",
  "instanceName": "botname",
  "userID": "1",
  "event": {
    "Info": {
      "ID": "MSG_ID",
      "Chat": "120363...@g.us",
      "Sender": "5599999@s.whatsapp.net",
      "IsGroup": true,
      "IsFromMe": false,
      "Timestamp": "2024-01-01T00:00:00Z",
      "PushName": "John"
    },
    "Message": {
      "conversation": "Hello!"
    }
  }
}
```

**Media webhook (with S3+base64):**
```json
{
  "type": "Message",
  "token": "...",
  "event": {
    "Info": { "..." },
    "Message": { "imageMessage": { "url": "https://mmg...", "mimetype": "image/jpeg", "MediaKey": "...", "..." } }
  },
  "base64": "/9j/4AAQSkZ...",
  "mimeType": "image/jpeg",
  "fileName": "MSG_ID.jpg",
  "s3": {
    "url": "http://minio:9000/zap-media/users/1/inbox/...",
    "key": "users/1/inbox/.../MSG_ID.jpg",
    "bucket": "zap-media",
    "size": 12345,
    "mimeType": "image/jpeg"
  }
}
```

### Event type mapping (whatsgoapi → wuzapi)

| whatsgoapi `event` | wuzapi `type` |
|---|---|
| `Message` | `Message` |
| `Connection` | `Connected` / `Disconnected` |
| `GroupInfo` | `GroupInfo` |
| `JoinedGroup` | `JoinedGroup` |
| `ChatPresence` | `ChatPresence` |
| `Receipt` | `ReadReceipt` |
| `QRCODE` | `QR` |
| `PushName` | embedded in `Message.Info.PushName` |

---

## Missing Features (no-op in JS layer)

| Feature | Status |
|---|---|
| `GET /user/blocklist` | ❌ Return `[]` |
| `POST /user/block\|unblock` | ❌ No-op + log warn |
| `POST /user/photo` | ❌ No-op + log warn |
| `POST /chat/commonGroups` | ❌ Return `[]` |
