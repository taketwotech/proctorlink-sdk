/**
 * ProctorLink enclave — runs inside the cross-origin iframe served from our
 * domain. This is where camera capture, keyframe upload, heartbeat and event
 * sequencing happen. It is the single producer of canonical, sequenced events.
 *
 * Trust model:
 *   - The enclave binds to exactly one parent origin: whoever sends the first
 *     valid `pl:init`. All later messages must come from that same origin.
 *   - The session JWT lives only here, never in the host page.
 *
 * Security TODO (Phase 1): the parent origin must be validated against the
 * `allowed_origins` bound to the session server-side (returned when the JWT was
 * minted), not merely pinned to the first caller. See CLAUDE.md §3.
 */

import {
  PROTOCOL_VERSION,
  MSG,
  type EnclaveInitConfig,
  type EnclaveToHost,
  type HostToEnclave,
  type ProctorEvent,
  type ProctorEventType,
} from '../shared/protocol';
import { IngestClient } from './ingest';

// Slightly higher res/quality than a liveness thumbnail: these frames feed
// server-side identity matching (impersonation), which needs a usable face crop.
const JPEG_QUALITY = 0.75;
const FRAME_MAX_WIDTH = 720;
const EVENT_FLUSH_INTERVAL_MS = 3000;

class Enclave {
  private config: EnclaveInitConfig | null = null;
  /** Guards against emitting one auth-expiry notice per failed request. */
  private authFailureNotified = false;
  private parentOrigin: string | null = null;
  private ingest: IngestClient | null = null;

  private seq = 0;
  private stream: MediaStream | null = null;
  private frameTimer = 0;
  private heartbeatTimer = 0;
  private flushTimer = 0;

  private readonly video: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly statusEl: HTMLElement;

  constructor() {
    this.video = document.getElementById('pl-video') as HTMLVideoElement;
    this.canvas = document.getElementById('pl-canvas') as HTMLCanvasElement;
    this.statusEl = document.getElementById('pl-status') as HTMLElement;

    window.addEventListener('message', (e) => this.onMessage(e));
    document.addEventListener('visibilitychange', () => {
      // visibilityState is inherited from the top-level tab, so this fires on tab switch.
      this.emit(document.hidden ? 'tab.hidden' : 'tab.visible', 'enclave');
    });

    // Safety net: whenever the enclave is torn down (Stop, navigation, tab close,
    // or the iframe being removed), end the session. The keepalive fetch in
    // endSession() survives unload, and /end is idempotent, so this can double
    // up harmlessly with the explicit stop() path — a session never stays 'active'.
    window.addEventListener('pagehide', () => {
      if (this.config) void this.ingest?.endSession();
    });

    // The enclave owns the media devices, so it is the place to notice a camera
    // being unplugged / a virtual camera being switched in mid-exam.
    navigator.mediaDevices?.addEventListener('devicechange', () => {
      if (!this.config) return;
      navigator.mediaDevices
        .enumerateDevices()
        .then((devices) => {
          const cameras = devices.filter((d) => d.kind === 'videoinput').length;
          this.emit('device.changed', 'enclave', { cameras });
        })
        .catch(() => this.emit('device.changed', 'enclave'));
    });

    // Announce readiness. The parent replies with pl:init.
    this.postUp({ kind: 'pl:ready', version: PROTOCOL_VERSION });
    this.setStatus('waiting for host…');
  }

  private onMessage(e: MessageEvent) {
    const msg = e.data as HostToEnclave;
    if (!msg || typeof msg !== 'object' || !('kind' in msg)) return;

    // First init pins the trusted parent origin.
    if (msg.kind === MSG.INIT) {
      if (this.config) return; // already initialised; ignore re-init
      if (e.source !== window.parent) return;
      this.parentOrigin = e.origin;
      void this.init(msg.config);
      return;
    }

    // Every later message must come from the pinned parent.
    if (e.origin !== this.parentOrigin || e.source !== window.parent) return;

    if (msg.kind === MSG.HOST_EVENT) {
      const evt = msg.event;
      this.emit(evt.type, 'host', evt.data, evt.ts);
    } else if (msg.kind === MSG.CAPTURE_IDENTITY) {
      void this.captureIdentity(msg.id);
    } else if (msg.kind === MSG.BEGIN_CAPTURE) {
      this.beginCapture();
    } else if (msg.kind === MSG.UPDATE_TOKEN) {
      this.ingest?.setToken(msg.jwt);
      // Re-arm so a later expiry is reported again, and flush straight away:
      // the queue holds everything that failed while the old token was dead.
      this.authFailureNotified = false;
      void this.ingest?.flushEvents();
    } else if (msg.kind === MSG.STOP) {
      void this.stop();
    }
  }

  /**
   * Take the pre-exam identity photo — the baseline every exam frame is matched
   * against. Uploaded through the same presigned path as keyframes, so the bytes
   * go straight from the browser to storage and never touch the host page.
   *
   * Callable more than once: a retake replaces the previous photo, which is what
   * a "the picture is blurry, try again" step needs.
   */
  private async captureIdentity(id: string): Promise<void> {
    const fail = (error: string) =>
      this.postUp({ kind: MSG.IDENTITY_CAPTURED, id, ok: false, error });

    if (!this.config || !this.ingest) return fail('session not initialised');
    if (!this.stream) return fail('camera not available');
    if (this.video.videoWidth === 0) return fail('camera not ready');

    const blob = await this.snapshot();
    if (!blob) return fail('could not capture an image');

    const key = await this.ingest.uploadFrame(0, Date.now(), blob, 'identity');
    if (!key) return fail('upload failed');

    this.postUp({ kind: MSG.IDENTITY_CAPTURED, id, ok: true });
  }

  /**
   * Tell the host its token is no longer accepted, once per failure streak.
   *
   * Events fire every few seconds and frames every minute, so notifying per
   * request would flood the host with duplicates for a single expiry. The flag
   * clears when a new token arrives, so a second expiry is reported again.
   */
  private onAuthFailure(status: number): void {
    if (this.authFailureNotified) return;
    this.authFailureNotified = true;
    const message =
      status === 401
        ? 'Session token expired or invalid — proctoring data is no longer being accepted.'
        : `Ingest rejected with ${status} — proctoring data is no longer being accepted.`;
    this.postUp({ kind: MSG.AUTH_EXPIRED, message });
    this.emit('error', 'enclave', { code: 'auth_expired', status });
  }

  /**
   * Start periodic keyframe capture. Idempotent — calling it twice will not
   * stack two timers, which matters because the host may call beginCapture()
   * without knowing whether autoStartCapture already did.
   */
  private beginCapture(): void {
    // frameTimer is 0 when unset (window.setInterval never returns 0), so a
    // truthiness check is the correct "already running" test — `!= null` would
    // be true for 0 and capture would never start.
    if (this.frameTimer || !this.stream) return;
    this.setStatus('recording');
    this.frameTimer = window.setInterval(
      () => this.captureFrame(),
      this.config!.frameIntervalMs,
    );
    // Capture the first frame only once the camera is actually producing
    // pixels — otherwise it's a black warm-up frame.
    this.captureFirstFrameWhenReady();
  }

  /** Draw the current video frame to the canvas and return it as a JPEG blob. */
  private snapshot(): Promise<Blob | null> {
    const scale = Math.min(1, FRAME_MAX_WIDTH / this.video.videoWidth);
    const w = Math.round(this.video.videoWidth * scale);
    const h = Math.round(this.video.videoHeight * scale);
    this.canvas.width = w;
    this.canvas.height = h;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return Promise.resolve(null);
    ctx.drawImage(this.video, 0, 0, w, h);
    return new Promise((resolve) =>
      this.canvas.toBlob((blob) => resolve(blob), 'image/jpeg', JPEG_QUALITY),
    );
  }

  private async init(config: EnclaveInitConfig) {
    this.config = config;
    this.ingest = new IngestClient(
      config.ingestBaseUrl,
      config.jwt,
      config.sessionId,
      (status) => this.onAuthFailure(status),
    );

    this.emit('session.started', 'enclave', { sdkProtocol: PROTOCOL_VERSION });

    // Event flush loop (runs regardless of camera outcome).
    this.flushTimer = window.setInterval(() => void this.ingest?.flushEvents(), EVENT_FLUSH_INTERVAL_MS);

    // Heartbeat loop — a missing heartbeat is the primary anti-tamper signal.
    this.heartbeatTimer = window.setInterval(
      () => this.emit('heartbeat', 'enclave'),
      config.heartbeatIntervalMs,
    );
    this.emit('heartbeat', 'enclave');

    await this.requestCamera();
  }

  private async requestCamera() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: this.config!.captureAudio,
      });
      this.video.srcObject = this.stream;
      await this.video.play().catch(() => undefined);

      this.postUp({ kind: 'pl:permission', camera: 'granted' });
      this.emit('camera.granted', 'enclave');
      this.setStatus('recording');

      // With autoStartCapture false the camera comes up but nothing is recorded
      // yet — the host is running a pre-exam identity step and will call
      // beginCapture() when the exam actually starts.
      if (this.config!.autoStartCapture !== false) {
        this.beginCapture();
      } else {
        this.setStatus('ready — waiting to start');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postUp({ kind: 'pl:permission', camera: 'denied', error: message });
      this.emit('camera.denied', 'enclave', { error: message });
      this.setStatus('camera unavailable');
      // We keep heartbeat + host-event detection running so the session still
      // produces an integrity signal even without video.
    }
  }

  /**
   * Wait until the camera has painted a real frame before the first capture, so
   * the reference/impersonation frame isn't a black warm-up shot. Uses
   * requestVideoFrameCallback (Chrome) with a readyState polling fallback and a
   * hard cap so it always fires.
   */
  private captureFirstFrameWhenReady() {
    const video = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    let done = false;
    const capture = () => {
      if (done) return;
      done = true;
      this.captureFrame();
    };
    if (typeof video.requestVideoFrameCallback === 'function') {
      // fires when a real frame is presented; small settle for auto-exposure
      video.requestVideoFrameCallback(() => window.setTimeout(capture, 250));
    }
    const poll = (tries: number) => {
      if (done) return;
      if (this.video.videoWidth > 0 && this.video.readyState >= 2) {
        window.setTimeout(capture, 400);
      } else if (tries > 0) {
        window.setTimeout(() => poll(tries - 1), 100);
      } else {
        capture(); // give up waiting after ~3s and capture whatever we have
      }
    };
    poll(30);
  }

  private captureFrame() {
    if (!this.stream || this.video.videoWidth === 0) return;
    const scale = Math.min(1, FRAME_MAX_WIDTH / this.video.videoWidth);
    const w = Math.round(this.video.videoWidth * scale);
    const h = Math.round(this.video.videoHeight * scale);
    this.canvas.width = w;
    this.canvas.height = h;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(this.video, 0, 0, w, h);

    const seq = ++this.seq;
    const ts = Date.now();
    // toBlob keeps the JPEG as raw bytes for a direct S3 PUT (no base64 bloat).
    this.canvas.toBlob(
      (blob) => {
        if (!blob) return;
        void this.ingest?.uploadFrame(seq, ts, blob);
        this.emitRaw({
          type: 'frame.captured',
          ts,
          seq,
          sessionId: this.config!.sessionId,
          source: 'enclave',
          data: { w, h, bytes: blob.size },
        });
      },
      'image/jpeg',
      JPEG_QUALITY,
    );
  }

  private async stop() {
    window.clearInterval(this.frameTimer);
    window.clearInterval(this.heartbeatTimer);
    window.clearInterval(this.flushTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.setStatus('stopped');
    this.emit('session.stopped', 'enclave');
    await this.ingest?.flushEvents();
    await this.ingest?.endSession();
    // Tell the loader we've flushed + ended, so it can safely remove the iframe.
    this.postUp({ kind: 'pl:stopped' });
  }

  // ---- event helpers ---------------------------------------------------------

  private emit(
    type: ProctorEventType,
    source: 'enclave' | 'host',
    data?: Record<string, unknown>,
    ts?: number,
  ) {
    this.emitRaw({
      type,
      ts: ts ?? Date.now(),
      seq: ++this.seq,
      sessionId: this.config?.sessionId ?? 'unknown',
      source,
      data,
    });
  }

  private emitRaw(event: ProctorEvent) {
    this.ingest?.queueEvent(event);
    this.postUp({ kind: 'pl:event', event });
  }

  private postUp(msg: EnclaveToHost) {
    window.parent.postMessage(msg, this.parentOrigin ?? '*');
  }

  private setStatus(text: string) {
    if (this.statusEl) this.statusEl.textContent = text;
  }
}

// Boot once the document is ready.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new Enclave());
} else {
  new Enclave();
}
