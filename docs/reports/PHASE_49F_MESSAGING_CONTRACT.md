# Phase 49F — Internal Messaging: Contract

Frozen before implementation. Every route/event below is implemented exactly as
written; nothing outside this document is added.

## Scope guards

- No Kafka, no Redis Pub/Sub, no Bull, no Socket.IO. Transport is
  `@nestjs/platform-ws` (raw `ws`).
- Postgres (Core, `CORE_DATABASE_URL`) is authoritative. WebSocket is a delivery
  optimisation only: a message is persisted **before** it is fanned out, so a
  client that never receives the push still recovers it via HTTP.
- Auth/JWT/RBAC/Tenant/Audit/Notification architecture is unchanged. The gateway
  reuses the same JWT secret/audience/issuer and the same `tokenVersion` check
  `jwt.strategy.ts` performs.
- Identity is always derived from the JWT subject. No route or event accepts a
  `userId`, `senderId` or `tenantId` from the client.

## HTTP surface (`/api/v1`, all `JwtAuthGuard`)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/conversations` | Caller's conversations, cursor page, newest activity first |
| GET | `/conversations/unread-count` | Total unread across the caller's conversations |
| POST | `/conversations` | Create/return a DIRECT conversation, or create a GROUP |
| GET | `/conversations/:id` | One conversation the caller belongs to |
| GET | `/conversations/:id/messages` | Cursor page of messages, newest first |
| POST | `/conversations/:id/messages` | HTTP fallback for sending (same path as WS) |
| POST | `/conversations/:id/read` | Advance the caller's `lastReadAt` |
| POST | `/conversations/:id/attachments` | Upload one file, returns an attachment ref |
| GET | `/conversations/attachments/:id` | Authorized download (302 to storage URL) |

Literal segments (`unread-count`, `attachments`) are declared before any
parameterised path, per the Nest route-order trap documented on
`UsersController`.

Pagination: `{ cursor?, limit? }` in, `{ items, hasMore }` out. Default 30, max
100. Same shape as Directory (49D-1) and Notifications (49E).

## WebSocket surface

Endpoint: `/ws/messaging`. Token supplied as `?token=` on the handshake
(browsers cannot set headers on `WebSocket`). Unauthenticated or stale-version
tokens are closed with `4401` before any event is processed.

Client → server:

| Event | Payload | Effect |
| --- | --- | --- |
| `conversation.subscribe` | `{ conversationId }` | Membership-checked; joins the room |
| `conversation.unsubscribe` | `{ conversationId }` | Leaves the room |
| `message.send` | `{ conversationId, body, clientMessageId?, attachmentIds? }` | Persist, then fan out |
| `message.read` | `{ conversationId }` | Advance `lastReadAt`, then fan out |
| `typing.start` / `typing.stop` | `{ conversationId }` | Ephemeral, never persisted |

Server → client:

| Event | Payload |
| --- | --- |
| `message.created` | The persisted message projection |
| `message.read` | `{ conversationId, userId, lastReadAt }` |
| `conversation.updated` | `{ id, lastMessageAt, lastMessage, unreadCount }` |
| `presence.changed` | `{ userId, status: 'online' \| 'offline' }` |
| `typing.changed` | `{ conversationId, userId, isTyping }` |
| `error` | `{ event, message }` — never a stack trace |

Send throttling is a bounded in-gateway counter (30 messages / 10 s per
connection); `rate-limit.middleware.ts` is HTTP-only and stays untouched.

Fan-out goes through `ConnectionRegistry`, an interface with a single in-process
implementation. A future multi-node adapter replaces that class only — no
service or gateway change.

## Data model (Core schema only)

- `Conversation` — `type` (DIRECT|GROUP), `tenantId`, `name`, `createdBy`,
  `directKey` (unique, `sorted(a,b)` for 1:1 dedupe), `lastMessageAt`.
- `ConversationMember` — `lastReadAt` holds conversation-level read state, so no
  per-message receipt table exists. Unique on `(conversationId, userId)`.
- `Message` — `body`, `clientMessageId` (unique per sender+conversation, for
  idempotent retries), no edit/delete columns.
- `MessageAttachment` — `fileName`, `mimeType`, `size`, `storageKey`. Reuses
  `IStorageProvider` (MinIO) and the store-then-cleanup-on-failure pattern from
  `MediaService`. 10 MB cap, MIME allowlist.

## Deferred (explicitly not built)

- Organization/department broadcast messaging (§10): Core has no department or
  group membership model — `User.department` is a free-text label, not a
  membership edge. Building it would require inventing an org-structure domain.
- Message edit/delete/reactions/threads, pinned messages, message search,
  voice/video, read receipts per message, external federation.
