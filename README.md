# @proctorlink/sdk

Browser SDK for [ProctorLink](https://proctorlink.com/?utm_source=npmjs_portal&utm_medium=web&utm_campaign=npmjs_traffic) — add camera-based
proctoring to any web-based assessment. Framework-agnostic (Angular, React, Vue,
or plain HTML), with a tiny (~4 KB) footprint and no secrets in the browser.

The SDK captures identity keyframes and integrity signals during an assessment
and streams them to ProctorLink, which produces the proctoring report. Your app
also receives the live event stream, so you can react or keep your own copy.

## Installation

```bash
npm install @proctorlink/sdk@^0.4.0
```


## Quick start

Integration is two steps: your server mints a session, your page starts the SDK.

### 1. Mint a session (server-side)

Your API key is **server-side only** — never put it in the browser. From your
backend, request a session for each attempt. Get your `access-token` /
`secret-token` from the ProctorLink dashboard (**Developers → SDK applications**).

```http
POST https://app-dev.proctorlink.com/v1/sessions
access-token: <ACCESS_TOKEN>
secret-token: <SECRET_TOKEN>
content-type: application/json

{
  "external_user_id": "candidate-123",
  "exam_id": "math-11",
  "attempt_id": "attempt-789",
  "allowed_origins": ["https://exams.yourcompany.com"]
}
```

```json
200 OK
{ "session_id": "…", "session_jwt": "…", "expires_at": 1730000000 }
```

Return `{ session_id, session_jwt }` to your frontend. The JWT is short-lived and
scoped to this one attempt — it is safe to expose to the browser.

### 2. Start the SDK (browser)

```ts
import { ProctorLink } from '@proctorlink/sdk';

const session = ProctorLink.createSession({
  jwt: sessionJwt,
  sessionId,
});

// Camera permission result.
session.on('permission', ({ camera }) => {
  if (camera === 'denied') { /* block the attempt */ }
});

// The live event stream — store it, forward it, or ignore it.
session.onEvent((event) => console.log(event.type, event));

await session.start();   // mounts the enclave, requests the camera, begins capture

// When the attempt ends:
session.stop();          // ends capture and flushes
session.destroy();       // removes the camera preview
```

That's the entire browser integration. Everything else — hosting the camera
enclave, storing frames, running face analysis, generating the report — is
handled by ProctorLink.

## Configuration

`ProctorLink.createSession(options)` takes the two values from your mint response:

| Option        | Default            | Description |
|---------------|--------------------|-------------|
| `jwt`         | **required**       | The `session_jwt` returned by `POST /v1/sessions`. |
| `sessionId`   | decoded from `jwt` | The `session_id` from the same response. Optional — read from the JWT if omitted. |
| `draggable`   | `true`             | Allows candidates to drag and reposition the camera preview anywhere on screen. |
| `showPreview` | `true`             | Show the camera preview pip. Set `false` to hide it completely. |
| `mount`       | floating pip       | Custom container element for the camera preview. |

## API

### `ProctorSession`

| Method | Description |
|--------|-------------|
| `start(): Promise<void>` | Mount the enclave, request the camera, begin capture. Resolves when ready. |
| `on(type, cb): () => void` | Subscribe to `'ready'`, `'permission'`, `'event'`, or `'error'`. Returns an unsubscribe function. |
| `onEvent(cb): () => void` | Shorthand for `on('event', …)`. |
| `pause(): void` | Suspend capture **without ending the attempt**, releasing the camera and hiding the preview. The session stays `active`. |
| `resume(): void` | Resume capture after `pause()`, re-opening the camera. |
| `isPaused: boolean` | Whether the session is currently paused. |
| `stop(): void` | End capture and flush pending data. **Ends the attempt server-side — not reversible.** |
| `destroy(opts?): void` | Tear down camera, preview and iframe. **Ends the attempt by default.** `destroy({ endSession: false })` keeps it `active` so you can resume later. |

### Leaving the exam page without ending the attempt

In a single-page app the candidate can navigate off the exam route without the
page unloading. The preview is attached to `document.body`, outside your router
outlet, so it survives and keeps capturing an empty chair — and those frames are
scored against the candidate.

Tear everything down, but keep the attempt open:

```ts
// e.g. Angular ngOnDestroy, React cleanup, router leave guard
session.destroy({ endSession: false });
```

On return, mint with the **same `attempt_id`** (you get `resumed: true` and the
same `session_id`) and call `createSession()` + `start()` again. The SDK rejoins,
sequencing continues, and the identity reference and earlier evidence survive.

`stop()` and a bare `destroy()` both end the attempt — a re-mint after either
creates a *new* session with its own report and billed credit.

### Pausing an attempt

`pause()` stops keyframe capture and stops forwarding host-page signals (tab
switches, clipboard, fullscreen, right-click, resize). It does **not** end the
attempt: no `/end` is sent, heartbeats keep flowing, and the session stays
`active`, so the server-side abandonment sweep will not close it while paused.

You decide when to pause — the SDK never pauses itself. The common case is a
single-page app where the candidate navigates off the exam route:

```ts
// your router — you choose the trigger
router.on('leave', '/exam', () => session.pause());
router.on('enter', '/exam', () => session.resume());
```

Do **not** use `stop()` for this. `stop()` ends the attempt server-side, and a
re-mint afterwards creates a *new* session with its own report, its own identity
photo and its own billed credit — one attempt fragments into several.

A `session.paused` event is recorded, and `session.resumed` on the way back, so
the gap in the frame timeline is explained rather than looking like the candidate
interfered with the enclave. Neither event counts against the integrity score.

Two behaviours worth knowing:

- **The camera is released while paused** and the preview is hidden, so the
  browser's capture indicator goes out. `resume()` re-opens it. (Before 0.4.0 the
  stream was left open; it is not any more.)
- **Pausing before capture started keeps it stopped.** If the session was created
  with `autoStartCapture: false` and you pause during the identity step,
  `resume()` restores camera-on-but-not-recording rather than starting the
  recording. Call `beginCapture()` for that, as usual.

Full-page navigation is already handled without `pause()` — the enclave flushes on
`pagehide` but deliberately does not end the session, and returning to the exam
rejoins the same attempt. `pause()` is for the in-page case, where the enclave is
never torn down.

### Event shape

Every event delivered to `onEvent` has this shape:

```ts
interface ProctorEvent {
  type: ProctorEventType;
  ts: number;                 // epoch milliseconds
  seq: number;                // monotonic per session
  sessionId: string;
  source: 'enclave' | 'host';
  data?: Record<string, unknown>;
}
```

### Event types

- **Lifecycle & media** — `session.started`, `session.stopped`, `session.paused`, `session.resumed`, `camera.granted`,
  `camera.denied`, `frame.captured`, `heartbeat`
- **Integrity signals** — `tab.hidden`, `tab.visible`, `fullscreen.entered`,
  `fullscreen.exited`, `window.resized`, `clipboard.copy`, `clipboard.cut`,
  `clipboard.paste`, `context.menu` (right-click), `device.changed` (e.g. camera
  unplugged), `page.unload`

Face analysis (identity match, no-face, multiple faces) is performed by
ProctorLink after the session and appears in the report — it is not a browser
event.

## Browser support & requirements

- **Chromium browsers** (Chrome, Edge) are fully supported. The camera requires a
  **secure context (HTTPS)** and the user granting camera permission.
- The SDK mounts a cross-origin iframe with `allow="camera"` automatically. If
  your page sets a `Content-Security-Policy`, allow the enclave:

  ```
  frame-src https://app-dev.proctorlink.com;
  ```

## How it works

The SDK is split into a public **loader** (this package) and a **camera enclave**
hosted by ProctorLink:

```
  Your page (e.g. an exam component)
  ┌──────────────────────────────────────────────┐
  │  import { ProctorLink } from '@proctorlink/sdk'│
  │                                                │
  │   loader ──mounts──►  ┌───────────────────────┐│
  │   (no secrets)        │  enclave iframe        ││
  │   detects tab switch, │  (ProctorLink origin)  ││
  │   fullscreen exit ───►│  • holds the session   ││
  │                       │    JWT                 ││
  │   ◄──event stream─────│  • camera + keyframes  ││
  │   (your callback)     │  • uploads to API      ││
  │                       └───────────┬────────────┘│
  └────────────────────────────────────┼────────────┘
                                        │ HTTPS
                                        ▼
                                 ProctorLink API
```

Serving the enclave from ProctorLink's origin means the camera permission binds
to that origin (no re-prompting per site), the session JWT never enters your
page's JavaScript, and SDK improvements ship without you redeploying.

## Security & privacy

- The loader holds **no secrets**. Your API key stays on your server; the browser
  only ever sees a short-lived, single-attempt session JWT.
- Every event carries a monotonic sequence number, and the session emits a
  regular heartbeat, so tampering or dropped connections are detectable
  server-side. The verdict is computed by ProctorLink and cannot be influenced by
  the client.
- Camera keyframes are captured at a low cadence (one per minute by default) — no
  continuous video or audio is recorded.
- Facial images are biometric data. Obtain the candidate's consent before
  starting a session and honor your data-retention obligations. ProctorLink
  provides configurable retention and deletion.

## License

Proprietary. © ProctorLink. All rights reserved.
