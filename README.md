# @proctorlink/sdk

Platform-agnostic browser SDK for ProctorLink. It drops into **any** web app —
Angular, React, plain HTML — and adds camera-based proctoring to an assessment
without the host app touching the camera, the session secret, or the backend.

This is the **Tier-1 / no-live-proctoring** build: it captures camera keyframes
and integrity events during a session and streams them to (a) your backend for
report generation and (b) the host application, which may store its own copy.
Live invigilation, screen-share and the desktop lockdown agent are out of scope
here (see [Roadmap](#roadmap)).

---

## How it works

```
  Host page (e.g. Angular quiz component)
  ┌───────────────────────────────────────────────┐
  │  import { ProctorLink } from '@proctorlink/sdk'│
  │                                                │
  │   loader  ──mounts──►  ┌──────────────────────┐│
  │   (no secrets)         │  enclave iframe      ││
  │   detects tab/blur/    │  (served from OUR    ││
  │   fullscreen ─────────►│   domain)            ││
  │                        │  • holds session JWT ││
  │   ◄──event stream──────│  • camera + keyframes││
  │   (you store this)     │  • heartbeat         ││
  │                        │  • uploads to ingest ││
  │                        └──────────┬───────────┘│
  └───────────────────────────────────┼────────────┘
                                       │ HTTPS + Bearer JWT
                                       ▼
                            Ingest API  (events + frames)
```

Why the iframe (the "secure enclave", see `CLAUDE.md` §2):

- **Camera permission binds to _our_ origin**, so it persists across customer
  sites instead of re-prompting per LMS.
- **The session JWT never enters the host page's JS context.**
- **SDK updates ship without the customer redeploying** their app.
- No CSS / global collisions with the host framework.

The loader itself holds no secrets and is tiny (~4 KB min, well under the 50 KB
budget).

---

## Quick start (the demo)

```bash
nvm use 24        # or any Node >= 20
npm install
npm run demo      # builds + serves the end-to-end demo
```

Open **http://localhost:4599/** and click **Start proctoring**. You'll see:

- the enclave iframe mount bottom-right (loaded from `127.0.0.1`, a different
  origin than the `localhost` host page — real cross-origin path),
- a live event stream (`session.started`, `heartbeat`, `frame.captured`,
  `window.blur`, `tab.hidden`, …),
- keyframes written to `examples/demo/.captures/` (the "share images later"
  story),
- the mock server log showing event batches arriving at the ingest API.

The demo's `mock-ingest.mjs` fakes **both** backend surfaces you own — the
dashboard's session mint and the ingest API — so nothing else is needed to run
it.

---

## Integrating in the customer's app

### 1. Their backend mints a session (never the browser)

The session API key is server-side only. The customer's backend calls the
dashboard:

```
POST https://dashboard.proctorlink.com/v1/sessions
Authorization: Bearer <TENANT_API_KEY>
{ "external_user_id": "candidate-123", "exam_id": "math-final",
  "allowed_origins": ["https://exams.customer.com"], "ttl": 7200 }

200 -> { "session_id": "…", "session_jwt": "…" }   // JWT lifetime <= exam + buffer
```

They hand `{ session_id, session_jwt }` to their frontend.

### 2. The frontend starts the SDK

```ts
import { ProctorLink } from '@proctorlink/sdk';

const session = ProctorLink.createSession({
  enclaveUrl: 'https://enclave.proctorlink.com/enclave.html',
  jwt: sessionJwt,
  sessionId,
  frameIntervalMs: 5000,
});

session.on('permission', (p) => { /* p.camera === 'granted' | 'denied' */ });

// The event stream. Store it, forward it, ignore it — your choice.
session.onEvent((evt) => saveOnMyBackend(evt));

await session.start();     // requests camera, begins capture
// … later …
session.stop();            // ends capture, flushes
session.destroy();         // removes the iframe
```

An Angular service + component example is in
[`examples/angular.md`](examples/angular.md).

### 3. Their CSP + iframe requirements (document this to the customer)

- Allow our enclave in their `Content-Security-Policy`: `frame-src
  https://enclave.proctorlink.com`.
- The SDK sets `allow="camera; microphone"` on the iframe automatically; the
  host page must not strip it.

---

## API

### `ProctorLink.createSession(options)` → `ProctorSession`

| option                | default              | notes |
|-----------------------|----------------------|-------|
| `enclaveUrl`          | —                    | Hosted enclave document URL. |
| `jwt`                 | —                    | Short-lived session JWT from the dashboard. |
| `sessionId`           | decoded from JWT     | `sid` / `session_id` / `sub` claim. |
| `ingestBaseUrl`       | enclave origin       | Where the enclave uploads events + frames. |
| `mount`               | floating pip         | Container for the camera preview. |
| `frameIntervalMs`     | `5000`               | Keyframe cadence. |
| `heartbeatIntervalMs` | `5000`               | Heartbeat cadence. |
| `captureAudio`        | `false`              | Also capture the mic. |
| `showPreview`         | `true`               | `false` → hidden 1×1 iframe. |

### `ProctorSession`

- `start(): Promise<void>` — mount, request camera, begin capture.
- `on(type, cb): () => void` — `'ready' | 'permission' | 'event' | 'error'`.
- `onEvent(cb): () => void` — alias for `on('event', …)`.
- `stop(): void` — end capture, flush the queue.
- `destroy(): void` — tear down and remove the iframe.

### Event shape

```ts
interface ProctorEvent {
  type: ProctorEventType;   // see below
  ts: number;               // epoch ms
  seq: number;              // monotonic per session; gaps => loss/tamper
  sessionId: string;
  source: 'enclave' | 'host';
  data?: Record<string, unknown>;
}
```

Event types:

- **lifecycle / media:** `session.started`, `session.stopped`, `camera.granted`,
  `camera.denied`, `frame.captured`, `heartbeat`
- **JS integrity alerts (no AI):** `tab.hidden`, `tab.visible`, `window.blur`,
  `window.focus`, `fullscreen.entered`, `fullscreen.exited`, `window.resized`
  (split-screen heuristic), `clipboard.copy`, `clipboard.cut`, `clipboard.paste`,
  `context.menu` (right-click), `device.changed` (e.g. camera unplugged),
  `page.unload`
- **reserved for the vision layer (server-side / later validation):**
  `face.absent`, `face.multiple`

Every frame is uploaded for **deferred** validation — no synchronous per-frame AI
call. Run identity/face analysis after the session by feeding stored frames to
the Python `/process_images` service off the critical path.

> **A missing heartbeat is the highest-severity signal.** A client that goes
> silent must score worse than one reporting violations. Fusion of events into a
> verdict is always server-side; the client can never influence it.

---

## Backend contract you still need to build

The SDK is done; two backend surfaces it talks to are **yours** to provide
(mocked in the demo):

1. **`POST /v1/sessions`** on the dashboard — mint `{ session_id, session_jwt }`
   from a tenant API key, binding `allowed_origins` and `ttl` to the session.
2. **Ingest API** the enclave uploads to:
   - `POST /v1/ingest/events` — `{ sessionId, events: ProctorEvent[] }`
   - `POST /v1/ingest/frames` — `{ sessionId, seq, ts, image }` (JPEG data URL)
   - both authenticated by `Authorization: Bearer <session_jwt>`.

Report generation and sharing images/verdicts with the customer happen after the
session ends and are out of this SDK's scope.

---

## Security notes (MVP → Phase 1)

Honestly flagged, not hidden:

- The enclave currently pins the **first** parent origin that sends `pl:init`.
  Phase 1 must validate the parent origin against the `allowed_origins` bound to
  the session server-side (from JWT mint), per `CLAUDE.md` §3.
- The enclave does **not** yet verify the JWT signature client-side; the ingest
  API must reject invalid/expired JWTs. The mock JWT is unsigned.
- Retry is in-memory only. Phase 1 adds the IndexedDB offline queue so a
  mid-exam network drop cannot silently lose evidence.
- On-device face detection is not wired in this MVP — frames are uploaded for
  server-side analysis (ArcFace identity match etc.), matching the AI split in
  `CLAUDE.md` §4.

---

## Roadmap

- **Now (this repo):** iframe enclave, keyframe capture, event stream, offline
  path stub, demo.
- **Phase 1:** IndexedDB offline queue, on-device face presence (MediaPipe, as
  already used by the Moodle plugin), consent screen, pre-flight system check,
  signed webhook of the verdict, npm + CDN with SRI.
- **Later:** screen-share signals, browser-extension tier, live proctoring.

---

## Layout

```
src/
  shared/protocol.ts     # message + event contract (imported by both sides)
  loader/index.ts        # host-side SDK (ProctorLink / ProctorSession)
  enclave/enclave.ts     # iframe app: camera, capture, heartbeat, upload
  enclave/ingest.ts      # ingest client (events batched, frames streamed)
  enclave/enclave.html   # iframe shell
examples/
  angular.md             # Angular integration example
  demo/                  # runnable end-to-end demo + mock backend
build.mjs                # esbuild: loader (iife/esm/cjs) + enclave (iife)
```
