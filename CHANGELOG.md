# Changelog

All notable changes to `@proctorlink/sdk`. This project follows
[semantic versioning](https://semver.org/): the major version changes when an
integration has to be edited, the minor version adds capability, and the patch
version fixes behaviour.

The enclave is version-matched to the loader, so every release pins its own
`https://enclave.proctorlink.com/<version>/enclave.html`. Upgrading the package
upgrades the enclave with it, and your `Content-Security-Policy` needs no change.

## 1.0.1 — unreleased

No change to the SDK's behaviour. Packaging and documentation only.

### Changed

- Licence is now declared as `SEE LICENSE IN LICENSE` with the licence text
  shipped in the package, replacing `UNLICENSED`. Dependency scanners that
  block `UNLICENSED` outright will accept this.
- Package description, keywords, homepage, repository and issue links added, so
  the package is findable in npm search and links back to the integration guides.

### Added

- `SECURITY.md` with a private reporting channel and response targets.
- `CONTRIBUTING.md`, and this changelog.

## 1.0.0 — 2026-08-31

First stable release. The API is now covered by semantic versioning.

### Added

- **Session lifecycle.** `ProctorLink.createSession({ jwt, sessionId })`,
  `start()`, `stop()` and `destroy()`, with the session JWT minted server-side
  and never exposed to the host page.
- **Version-pinned enclave.** The loader requests the enclave that matches its
  own version, so a page cannot pair a new loader with an old enclave. A
  protocol check on connect reports a mismatch instead of failing quietly.
- **Pause and resume.** `pause()` stops capture and releases the camera without
  ending the attempt; `resume()` re-opens it. `isPaused` reports the state, and
  `session.paused` / `session.resumed` events explain the gap in the frame
  timeline rather than letting it look like interference.
- **Resuming after navigation.** `destroy({ endSession: false })` tears the SDK
  down while leaving the attempt open, so a single-page app can leave the exam
  route without the preview capturing an empty chair. Re-minting with the same
  `attempt_id` rejoins the same session, keeping sequencing and evidence.
- **Draggable camera preview**, repositionable by the candidate, with
  `draggable` and `showPreview` to control it and `mount` for a container of
  your own.
- **Event stream.** `onEvent` delivers lifecycle, media and integrity events
  (tab visibility, fullscreen, clipboard, context menu, device change, resize)
  with a monotonic sequence number per session.
- **Identity capture** as a reference frame before capture begins, or supplied
  at mint time from a photo you already hold.
- **Decoupled ingest.** `ingestBaseUrl` defaults to production, so a normal
  install needs no configuration, and a staging build can point elsewhere.
- Three bundle formats: ESM, CJS and an IIFE that exposes a `ProctorLink`
  global for pages without a build step.

### Notes

- Heartbeat cadence defaults to 15 seconds. Lowering it does not improve
  detection, since gap size is judged server-side, and it multiplies uploaded
  telemetry.
- Chromium browsers (Chrome, Edge) are supported, over HTTPS, with camera
  permission granted by the candidate.

---

Releases before 1.0.0 were development previews and have been removed from npm.
`1.0.0` is the earliest installable version.
