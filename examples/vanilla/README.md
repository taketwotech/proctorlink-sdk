# Plain JavaScript, no build step

Two files: an exam page that loads the SDK from a CDN, and a 70-line Node server
that mints sessions.

```bash
export PROCTORLINK_ACCESS_TOKEN=…
export PROCTORLINK_SECRET_TOKEN=…
node server.mjs
# open http://localhost:4300
```

Press **Start attempt**, allow the camera, and the event stream appears on the
page. `http://localhost` is a secure context in Chrome, so the camera works
without TLS here; any other host needs HTTPS.

What to read:

- [`index.html`](./index.html) — the browser side. `createSession`, the
  `permission` and `token-expired` handlers, and the event stream.
- [`server.mjs`](./server.mjs) — the mint. Note that the API key lives here and
  that `allowed_origins` has to name the origin serving the page.

To pin a version instead of following the 1.x line, change the script tag to
`@proctorlink/sdk@1.0.1`. Production integrations should pin.
