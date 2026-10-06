# @proctorlink/sdk

Browser SDK for [ProctorLink](https://proctorlink.com/?utm_source=npmjs_portal&utm_medium=web&utm_campaign=npmjs_traffic) — add camera-based
proctoring to any web-based assessment. Framework-agnostic (Angular, React, Vue,
or plain HTML), with a tiny (~4 KB) footprint and no secrets in the browser.

The SDK captures identity keyframes and integrity signals during an assessment
and streams them to ProctorLink, which produces the proctoring report. Your app
also receives the live event stream, so you can react or keep your own copy.

**Links:** [Integration guide](https://proctorlink.com/knowledge/proctoring-for-custom-assessment-platforms?utm_source=npmjs_portal&utm_medium=web&utm_campaign=npmjs_traffic) ·
[React](https://proctorlink.com/knowledge/react-proctoring-integration?utm_source=npmjs_portal&utm_medium=web&utm_campaign=npmjs_traffic) ·
[Angular](https://proctorlink.com/knowledge/angular-proctoring-integration?utm_source=npmjs_portal&utm_medium=web&utm_campaign=npmjs_traffic) ·
[LTI 1.3](https://proctorlink.com/knowledge/lti-1-3-proctoring-integration?utm_source=npmjs_portal&utm_medium=web&utm_campaign=npmjs_traffic) ·
[Support](https://proctorlink.com/contact?utm_source=npmjs_portal&utm_medium=web&utm_campaign=npmjs_traffic)

## Installation

```bash
npm install @proctorlink/sdk@^1.0.0
```

No build step? Load the browser bundle from jsDelivr, which exposes a
`ProctorLink` global:

```html
<script src="https://cdn.jsdelivr.net/npm/@proctorlink/sdk@1/dist/proctorlink.js"></script>
<script>
  const session = ProctorLink.createSession({ jwt: sessionJwt, sessionId });
</script>
```

Pin the exact version in production (`@1.0.1` rather than `@1`) so a release
never changes under a running exam.

## Quick start

Integration is two steps: your server mints a session, your page starts the SDK.

### 1. Mint a session (server-side)

Your API key is **server-side only** — never put it in the browser. From your
backend, request a session for each attempt.

**Get your keys:** sign up at
[app.proctorlink.com](https://app.proctorlink.com/?utm_source=npmjs_portal&utm_medium=web&utm_campaign=npmjs_traffic),
then go to **Developers → SDK applications** to create an `access-token` /
`secret-token` pair. The secret is shown once at creation.

```http
POST https://api.proctorlink.com/v1/sessions
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

Runnable versions of the above are in [`examples/`](./examples): a single HTML
file with a 70-line mint server, and a React hook with the lifecycle handled.

## Configuration

`ProctorLink.createSession(options)` takes the two values from your mint response:

| Option        | Default            | Description |
|---------------|--------------------|-------------|
| `jwt`         | **required**       | The `session_jwt` returned by `POST /v1/sessions`. |
| `sessionId`   | decoded from `jwt` | The `session_id` from the same response. Optional — read from the JWT if omitted. |
| `draggable`   | `true`             | Allows candidates to drag and reposition the camera preview anywhere on screen. |
| `showPreview` | `true`             | Show the camera preview pip. Set `false` to hide it completely. |
| `heartbeatIntervalMs` | `15000`    | Liveness cadence. Lowering it does not improve detection (gap size is decided server-side) and multiplies uploaded telemetry. |
| `autoStartCapture` | `true`        | Record keyframes as soon as the camera is granted. Set `false` for a pre-exam photo step, then call `beginCapture()`. |
| `captureAudio` | `false`           | Also capture the microphone. |
| `ingestBaseUrl` | `https://api.proctorlink.com` | Where proctoring data is sent. Defaults to production — see below. |
| `mount`       | floating pip       | Custom container element for the camera preview. |

### Targeting a non-production environment

`ingestBaseUrl` defaults to production, so a normal install needs no
configuration. To point at staging, read your own environment variable at build
time and pass it through — the SDK is a browser bundle and cannot read
environment variables itself:

```ts
ProctorLink.createSession({
  jwt, sessionId,
  ingestBaseUrl: process.env.PROCTORLINK_API_URL,  // unset -> production
});
```

Leaving the variable unset falls back to the default, so one build serves both.

**It must be the same instance that minted the session.** The session JWT is
signed by whichever dashboard issued it and ingest verifies that signature, so
minting on production and ingesting on staging fails every call with `401`.

## API

### `ProctorSession`

| Method | Description |
|--------|-------------|
| `start(): Promise<void>` | Mount the enclave, request the camera, begin capture. Resolves when ready. |
| `on(type, cb): () => void` | Subscribe to `'ready'`, `'permission'`, `'event'`, `'error'` or `'token-expired'`. Returns an unsubscribe function. |
| `onEvent(cb): () => void` | Shorthand for `on('event', …)`. |
| `captureIdentity(): Promise<void>` | Take the identity photo now. Resolves when it is stored; safe to call again for a retake. The image goes straight to ProctorLink and never passes through your page. |
| `beginCapture(): void` | Start recording exam keyframes. Only needed with `autoStartCapture: false`; a no-op otherwise. |
| `updateToken(jwt): void` | Supply a freshly minted token for the **same** session after `'token-expired'`. See below. |
| `pause(): void` | Suspend capture **without ending the attempt**, releasing the camera and hiding the preview. The session stays `active`. |
| `resume(): void` | Resume capture after `pause()`, re-opening the camera. |
| `isPaused: boolean` | Whether the session is currently paused. |
| `stop(): void` | End capture and flush pending data. **Ends the attempt server-side — not reversible.** |
| `destroy(opts?): void` | Tear down camera, preview and iframe. **Ends the attempt by default.** `destroy({ endSession: false })` keeps it `active` so you can resume later. |

### An identity photo before the exam starts

By default the first captured frame is the identity reference, so nothing extra
is needed. For an explicit photo step, bring the camera up without recording:

```ts
const session = ProctorLink.createSession({ jwt, sessionId, autoStartCapture: false });
await session.start();          // camera on, not recording

await session.captureIdentity();  // candidate presses "take photo"
session.beginCapture();           // the exam begins
```

`captureIdentity()` rejects with the reason if the photo cannot be stored, so a
retake can be offered rather than starting an exam with no reference image.

### Exams longer than the session token

Session tokens are short-lived. When one expires mid-attempt the SDK queues
proctoring data instead of discarding it and emits `'token-expired'`. Mint a new
token for the **same** session and hand it over:

```ts
session.on('token-expired', async () => {
  // Same attempt_id as the original mint — the response has resumed: true
  // and the same session_id, with a fresh session_jwt.
  const { session_jwt } = await fetch('/api/proctoring/remint', { method: 'POST' })
    .then((r) => r.json());
  session.updateToken(session_jwt);
});
```

Queued events flush as soon as the new token lands, so nothing from the gap is
lost. Do not call `stop()` and start again: that ends the attempt and the next
mint produces a separate session, a separate report and a separate billed credit.

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

You decide when to pause — the SDK never pauses itself. Use it when you want to
stop capturing but keep the SDK mounted: a modal over the exam, a scheduled
break.

```ts
session.pause();
session.resume();
```

For an **SPA route change**, prefer `destroy({ endSession: false })` above — it
leaves nothing mounted on a page the candidate is no longer on. And do **not**
use `stop()` for either: it ends the attempt server-side, and a re-mint
afterwards creates a *new* session with its own report, its own identity photo
and its own billed credit.

A `session.paused` event is recorded, and `session.resumed` on the way back, so
the gap in the frame timeline is explained rather than looking like the candidate
interfered with the enclave. Neither event counts against the integrity score.

Two behaviours worth knowing:

- **The camera is released while paused** and the preview is hidden, so the
  browser's capture indicator goes out. `resume()` re-opens it.
- **Pausing before capture started keeps it stopped.** If the session was created
  with `autoStartCapture: false` and you pause during the identity step,
  `resume()` restores camera-on-but-not-recording rather than starting the
  recording. Call `beginCapture()` for that, as usual.

Full-page navigation and refresh are already handled without either — the SDK
flushes on `pagehide` but deliberately does not end the session, and returning to
the exam rejoins the same attempt.

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
  frame-src https://enclave.proctorlink.com;
  ```

  This is the enclave host, **not** your API base URL — the two are different
  services. The SDK loads
  `https://enclave.proctorlink.com/<sdk-version>/enclave.html`, so the version
  lives in the path and your policy needs no change when you upgrade.

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

## Versioning and support

[Semantic versioning](https://semver.org/). A major version only changes when an
integration has to be edited, and every release is listed in
[CHANGELOG.md](./CHANGELOG.md).

The current minor version receives fixes. The previous minor keeps security
fixes for six months after its successor ships. Pre-releases go out under the
`next` dist-tag, so `npm install @proctorlink/sdk` always resolves to a stable
release.

The enclave is version-matched to the package: each release loads
`https://enclave.proctorlink.com/<version>/enclave.html`, older enclave versions
stay hosted, and your `Content-Security-Policy` needs no change when you upgrade.

Problems: [open an issue](https://github.com/taketwotech/proctorlink-sdk/issues).
Security: [SECURITY.md](./SECURITY.md). Anything account-related:
[support](https://proctorlink.com/contact?utm_source=npmjs_portal&utm_medium=web&utm_campaign=npmjs_traffic).

## License

Proprietary. © 2026 Take2 Technologies. All rights reserved. See [LICENSE](./LICENSE)
and the [End User License Agreement](https://proctorlink.com/eula?utm_source=npmjs_portal&utm_medium=web&utm_campaign=npmjs_traffic).
Use requires a ProctorLink account.
