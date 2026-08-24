/**
 * ProctorLink loader — the thin, secret-free public SDK that runs in the host
 * page (e.g. an Angular quiz component).
 *
 * Responsibilities:
 *   - mount the cross-origin enclave iframe (which owns the camera + JWT)
 *   - bridge postMessage between host page and enclave, with origin checks
 *   - detect host-context integrity signals (tab switch, blur, fullscreen exit)
 *     and forward them to the enclave for uploading
 *   - surface a single, ordered event stream to the host application
 *
 * The loader holds NO secrets. The session JWT is passed straight through to the
 * enclave and is never read or persisted here.
 */

import {
  PROTOCOL_VERSION,
  SDK_VERSION,
  MSG,
  type EnclaveInitConfig,
  type EnclaveToHost,
  type HostRawEvent,
  type HostToEnclave,
  type ProctorEvent,
} from '../shared/protocol';

/**
 * Where ProctorLink hosts the enclave. Customers can omit `enclaveUrl` and get
 * this automatically; override it only for self-hosting or a different region.
 *
 * The path is pinned to this loader's own version. Loader and enclave speak a
 * private postMessage protocol, and a mismatched pair fails silently — the
 * loader posts messages an older enclave has never heard of and simply drops.
 * Pinning makes that pairing structural rather than something a deploy has to
 * remember to keep in step.
 */
export const DEFAULT_ENCLAVE_URL = `https://enclave.proctorlink.com/${SDK_VERSION}/enclave.html`;

/**
 * Where the enclave sends events and frames.
 *
 * Kept separate from the enclave origin: the enclave is a static asset on a CDN
 * and the ingest API is a server, so they are no longer the same host. When a
 * caller overrides `enclaveUrl` without naming an ingest URL we still fall back
 * to that origin, which keeps local development (both served by a dashboard on
 * localhost) working unchanged.
 */
export const DEFAULT_INGEST_BASE_URL = 'https://app-dev.proctorlink.com';

export interface CreateSessionOptions {
  /** Full URL to the hosted enclave document. Defaults to ProctorLink's hosted enclave. */
  enclaveUrl?: string;
  /** Short-lived session JWT minted by the dashboard's POST /v1/sessions. */
  jwt: string;
  /** Session id. If omitted, it is decoded from the JWT payload (sid/sub). */
  sessionId?: string;
  /**
   * Ingest API base URL. Defaults to ProctorLink's API — or, if you passed your
   * own `enclaveUrl`, to that origin.
   */
  ingestBaseUrl?: string;
  /** Container for the small camera preview. Defaults to a floating bottom-right pip. */
  mount?: HTMLElement;
  /** Keyframe cadence (ms). Default 60000 (one frame/minute — the impersonation preset). */
  frameIntervalMs?: number;
  /** Heartbeat cadence (ms). Default 5000. */
  heartbeatIntervalMs?: number;
  /** Also capture the microphone. Default false. */
  captureAudio?: boolean;
  /** Show the camera preview pip. Default true. When false the iframe is 1×1 and hidden. */
  showPreview?: boolean;
  /**
   * Allow candidate to drag and reposition the camera preview anywhere on screen.
   * Default true when using the default floating pip preview.
   */
  draggable?: boolean;
  /**
   * Begin recording keyframes as soon as the camera is granted. Default true.
   *
   * Leave it alone for the usual flow: `start()` and the exam is being recorded,
   * with the first captured frame acting as the identity reference.
   *
   * Set false when you want a pre-exam photo step. `start()` then brings the
   * camera up without recording, so you can call `captureIdentity()` and begin
   * the exam with `beginCapture()` when the candidate is ready.
   */
  autoStartCapture?: boolean;
}

export type SessionEventMap = {
  /** Enclave document loaded and handshake complete. */
  ready: void;
  /** Camera permission resolved. */
  permission: { camera: 'granted' | 'denied'; error?: string };
  /** A sequenced proctoring event. This is the stream the host app stores. */
  event: ProctorEvent;
  /** A non-fatal SDK error. */
  error: { message: string };
  /**
   * The session token is no longer accepted — it has expired, or was revoked.
   *
   * Proctoring data is being queued, not delivered. Mint a fresh token for the
   * SAME session and pass it to `updateToken()`; do not stop the session and
   * start a new one, which would split the attempt into two reports.
   */
  'token-expired': { message: string };
};

type Listener<T> = (payload: T) => void;

function decodeSessionIdFromJwt(jwt: string): string | undefined {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.sid || payload.session_id || payload.sub;
  } catch {
    return undefined;
  }
}

export class ProctorSession {
  private readonly opts: Required<Omit<CreateSessionOptions, 'mount'>> & { mount?: HTMLElement };
  private readonly enclaveOrigin: string;
  private readonly sessionId: string;

  private iframe: HTMLIFrameElement | null = null;
  private ready = false;
  private stopped = false;
  private paused = false;
  private destroyRequested = false;
  /** In-flight captureIdentity() calls, keyed by the id sent to the enclave. */
  private readonly pendingCaptures = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void; timer: number }
  >();
  private captureSeq = 0;
  private destroyTimer = 0;
  private pipCleanup: (() => void) | null = null;

  private readonly listeners: { [K in keyof SessionEventMap]: Set<Listener<SessionEventMap[K]>> } = {
    ready: new Set(),
    permission: new Set(),
    event: new Set(),
    error: new Set(),
    'token-expired': new Set(),
  };

  private readonly onMessage = (e: MessageEvent) => this.handleEnclaveMessage(e);
  private readonly hostHandlers: Array<[EventTarget, string, EventListener]> = [];

  constructor(options: CreateSessionOptions) {
    const enclaveUrl = options.enclaveUrl || DEFAULT_ENCLAVE_URL;
    const enclaveOrigin = new URL(enclaveUrl).origin;
    const sessionId = options.sessionId || decodeSessionIdFromJwt(options.jwt);
    if (!sessionId) {
      throw new Error('[ProctorLink] sessionId is required (pass it explicitly or use a JWT that carries sid/session_id/sub).');
    }
    this.enclaveOrigin = enclaveOrigin;
    this.sessionId = sessionId;
    this.opts = {
      enclaveUrl,
      jwt: options.jwt,
      sessionId,
      // Three cases, in order. An explicit ingest URL always wins. Otherwise a
      // caller who named their own enclave gets ingest on that same origin —
      // that is the local-development case, where one dashboard serves both.
      // Only when both are defaulted do the two split apart, because the hosted
      // enclave is a CDN asset and the API is somewhere else entirely.
      ingestBaseUrl:
        options.ingestBaseUrl ||
        (options.enclaveUrl ? enclaveOrigin : DEFAULT_INGEST_BASE_URL),
      frameIntervalMs: options.frameIntervalMs ?? 60000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 5000,
      captureAudio: options.captureAudio ?? false,
      showPreview: options.showPreview ?? true,
      draggable: options.draggable ?? true,
      // Default true keeps the existing one-call flow working unchanged.
      autoStartCapture: options.autoStartCapture ?? true,
      mount: options.mount,
    };
  }

  /**
   * Mounts the enclave and requests the camera. Resolves when the enclave is
   * ready. Recording starts here too, unless the session was created with
   * `autoStartCapture: false` — then call `beginCapture()` when the exam begins.
   */
  start(): Promise<void> {
    if (this.iframe) {
      return Promise.reject(new Error('[ProctorLink] session already started'));
    }
    window.addEventListener('message', this.onMessage);
    const iframe = this.buildIframe();
    (this.opts.mount || this.defaultPip()).appendChild(iframe);
    this.iframe = iframe;

    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error('[ProctorLink] enclave did not become ready in time'));
      }, 15000);

      const off = this.on('ready', () => {
        window.clearTimeout(timeout);
        off();
        resolve();
      });
    });
  }

  /** Subscribe to a session event. Returns an unsubscribe function. */
  on<K extends keyof SessionEventMap>(type: K, cb: Listener<SessionEventMap[K]>): () => void {
    this.listeners[type].add(cb);
    return () => this.listeners[type].delete(cb);
  }

  /** Convenience alias for `on('event', cb)`. */
  onEvent(cb: Listener<ProctorEvent>): () => void {
    return this.on('event', cb);
  }

  /**
   * Capture the candidate's identity photo — the baseline every exam frame is
   * matched against. Call it from your pre-exam "take your photo" step, after
   * `start()` has resolved so the camera is live.
   *
   * Without this (and without a `reference_image_url` at mint) the first frame
   * captured during the exam becomes the baseline, which only detects someone
   * swapping in mid-exam — not an impostor who sat the whole thing.
   *
   * Safe to call again for a retake: the previous photo is replaced. The image
   * goes straight from the browser to ProctorLink storage; it never passes
   * through your page.
   *
   * @returns resolves when the photo is stored, rejects with the reason if not.
   */
  captureIdentity(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('session already stopped'));
    if (!this.iframe) return Promise.reject(new Error('session not started'));

    const id = `cap-${++this.captureSeq}`;
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingCaptures.delete(id);
        reject(new Error('identity capture timed out'));
      }, 20000);
      this.pendingCaptures.set(id, { resolve, reject, timer });
      this.postToEnclave({ kind: 'pl:capture-identity', id });
    });
  }

  /**
   * Start recording exam keyframes. Only needed when the session was created
   * with `autoStartCapture: false` — otherwise recording is already running and
   * this is a no-op.
   *
   * Call it when the exam actually begins, typically right after the candidate's
   * identity photo has been accepted.
   */
  beginCapture(): void {
    if (this.stopped || !this.iframe) return;
    this.postToEnclave({ kind: 'pl:begin-capture' });
  }

  /** True between pause() and resume(). */
  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Suspend proctoring without ending the attempt.
   *
   * Stops keyframe capture and stops forwarding host-page signals (tab switches,
   * clipboard, fullscreen, right-click, resize). The session stays `active`
   * server-side — no `/end` is sent — and heartbeats keep flowing, so the
   * abandonment sweep will not close it while paused.
   *
   * Call it when the candidate leaves the exam surface but the attempt is still
   * open: a back-button route change in a single-page app, a modal that navigates
   * away, a deliberate "take a break" step. Pair every pause() with resume().
   *
   * Why this is not just stop(): stop() ends the attempt server-side and cannot
   * be undone. A re-mint after stop() creates a NEW session with its own report
   * and its own billed credit, fragmenting one attempt into several.
   *
   * A `session.paused` event is recorded, so the resulting gap in the frame
   * timeline is explained rather than looking like enclave interference. Neither
   * `session.paused` nor `session.resumed` counts against the integrity score.
   *
   * The camera stays open while paused (the browser's capture indicator will
   * remain lit) so that resume() is instant and cannot re-prompt for permission
   * mid-attempt. Use destroy() if you need the camera released.
   *
   * No-op if the session has stopped, has not started, or is already paused.
   */
  pause(): void {
    if (this.stopped || this.paused || !this.iframe) return;
    this.paused = true;
    // Detach first: a tab.hidden or clipboard event fired between the postMessage
    // and the enclave handling it would still be recorded, and those types are
    // exactly the ones the integrity score penalises.
    this.detachHostHandlers();
    this.postToEnclave({ kind: 'pl:pause' });
    // Hide the preview too. The enclave releases the camera, so leaving the box
    // on screen would show a dead black rectangle and still read as "watching".
    this.setPreviewVisible(false);
  }

  /**
   * Resume after pause(). Re-attaches host-page listeners and restarts keyframe
   * capture, recording a `session.resumed` event.
   *
   * If the session was paused before capture had ever begun (created with
   * `autoStartCapture: false`, paused during the identity step), this restores
   * the camera-on-but-not-recording state rather than starting the recording —
   * call beginCapture() for that, as usual.
   *
   * No-op if the session has stopped or is not paused.
   */
  resume(): void {
    if (this.stopped || !this.paused || !this.iframe) return;
    this.paused = false;
    this.attachHostHandlers();
    this.postToEnclave({ kind: 'pl:resume' });
    this.setPreviewVisible(true);
  }

  /**
   * Show/hide the camera preview. Targets the pip we created, or the host's own
   * `mount` element when one was supplied — in the mount case we toggle the
   * iframe rather than the container, since the container belongs to the host and
   * may hold their own chrome.
   */
  private setPreviewVisible(visible: boolean): void {
    if (!this.iframe) return;
    const pip = this.iframe.parentElement;
    const target =
      pip && pip.dataset['plPip'] === '1' ? (pip as HTMLElement) : this.iframe;
    target.style.display = visible ? '' : 'none';
  }

  /**
   * Replace the session token without interrupting the attempt.
   *
   * Use this when you receive `token-expired`, or proactively before a long
   * exam outruns its token. Mint a new token for the **same** session — call
   * `POST /v1/sessions` again with the same `attempt_id` and it resumes,
   * returning the same `session_id` with a fresh `session_jwt`.
   *
   * Queued events that failed under the old token are flushed straight away, so
   * nothing recorded during the gap is lost.
   *
   * Do NOT stop the session and start a new one instead: that ends the attempt
   * server-side, and the next mint creates a separate session and report.
   */
  updateToken(jwt: string): void {
    if (!jwt) throw new Error('[ProctorLink] updateToken requires a token');

    // A re-mint only resumes while the session is still active. If it had
    // already ended (e.g. the abandonment sweep closed it after a long outage),
    // the mint created a NEW session and this token is bound to that one.
    // Feeding it here would make every ingest call fail with 403 "session token
    // does not match", which in turn raises another token-expired — a loop.
    // Fail loudly instead, so the integrator sees the real problem.
    const tokenSessionId = decodeSessionIdFromJwt(jwt);
    if (tokenSessionId && tokenSessionId !== this.sessionId) {
      throw new Error(
        `[ProctorLink] updateToken received a token for session ${tokenSessionId}, ` +
          `but this session is ${this.sessionId}. The re-mint did not resume — ` +
          `check that "resumed" was true and that attempt_id matched.`,
      );
    }

    if (this.stopped || !this.iframe) return;
    this.opts.jwt = jwt;   // so a later re-init uses the current token
    this.postToEnclave({ kind: 'pl:update-token', jwt });
  }

  /**
   * Ends the attempt. Signals the enclave to end capture, flush its queue and
   * POST /end. Terminal — a later re-mint creates a NEW session, not a resume.
   */
  stop(): void {
    this.teardown(true);
  }

  private teardown(endSession: boolean): void {
    if (this.stopped) return;
    this.stopped = true;
    // Settle any in-flight captureIdentity() now rather than leaving the caller
    // waiting on its 20s timeout for a session that is already shutting down.
    for (const [, pending] of this.pendingCaptures) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error('session stopped before the photo was stored'));
    }
    this.pendingCaptures.clear();
    this.postToEnclave({ kind: 'pl:stop', endSession });
    this.detachHostHandlers();
  }

  /**
   * Tears everything down — camera released, preview removed, iframe removed.
   * Waits for the enclave to flush (the `pl:stopped` ack) before removing the
   * iframe, falling back after 3s so it can never hang.
   *
   * `endSession` defaults to true, which also POSTs `/end` and closes the attempt.
   *
   * ```ts
   * session.destroy({ endSession: false });
   * ```
   *
   * keeps the attempt **active** while removing everything from the page. Use it
   * when your own component unmounts but the candidate has not finished — an SPA
   * route change, a back button. It is the same outcome a page refresh already
   * produces, which is why returning works the same way:
   *
   *   1. re-mint with the same `attempt_id` → `resumed: true`, same `session_id`
   *   2. `createSession()` + `start()` → the enclave rejoins and continues
   *      sequencing from where it left off
   *
   * The identity reference and all recorded evidence survive; nothing is
   * re-captured and no second report or credit is created.
   *
   * Plain `destroy()` ends the attempt. A re-mint after that creates a NEW
   * session, splitting one attempt into several reports.
   */
  destroy(opts?: { endSession?: boolean }): void {
    if (this.destroyRequested) return;
    this.destroyRequested = true;
    this.teardown(opts?.endSession !== false);
    if (!this.iframe) {
      this.finalizeDestroy();
      return;
    }
    this.destroyTimer = window.setTimeout(() => this.finalizeDestroy(), 3000);
  }

  private finalizeDestroy(): void {
    if (this.destroyTimer) {
      window.clearTimeout(this.destroyTimer);
      this.destroyTimer = 0;
    }
    if (this.pipCleanup) {
      this.pipCleanup();
      this.pipCleanup = null;
    }
    window.removeEventListener('message', this.onMessage);
    if (this.iframe) {
      const pip = this.iframe.parentElement;
      this.iframe.remove();
      if (pip && pip.dataset['plPip'] === '1') pip.remove();
      this.iframe = null;
    }
  }

  // ---- internals -------------------------------------------------------------

  private buildIframe(): HTMLIFrameElement {
    const iframe = document.createElement('iframe');
    iframe.src = this.opts.enclaveUrl;
    iframe.title = 'ProctorLink';
    iframe.allow = this.opts.captureAudio ? 'camera; microphone' : 'camera';
    iframe.setAttribute('aria-hidden', this.opts.showPreview ? 'false' : 'true');
    if (this.opts.showPreview) {
      iframe.style.cssText = 'width:180px;height:135px;border:0;border-radius:8px;display:block;';
    } else {
      iframe.style.cssText = 'width:1px;height:1px;border:0;position:absolute;left:-9999px;';
    }
    return iframe;
  }

  private defaultPip(): HTMLElement {
    const pip = document.createElement('div');
    pip.dataset['plPip'] = '1';

    if (this.opts.showPreview) {
      pip.style.cssText =
        'position:fixed;bottom:16px;right:16px;width:180px;height:135px;z-index:2147483647;box-shadow:0 4px 16px rgba(0,0,0,.25);border-radius:8px;overflow:hidden;background:#000;';

      if (this.opts.draggable) {
        const handle = document.createElement('div');
        handle.dataset['plDrag'] = '1';
        handle.style.cssText =
          'position:absolute;inset:0;z-index:10;cursor:grab;touch-action:none;user-select:none;';
        pip.appendChild(handle);
        this.pipCleanup = this.makeDraggable(pip, handle);
      }
    } else {
      pip.style.cssText = 'position:fixed;width:1px;height:1px;border:0;left:-9999px;';
    }

    document.body.appendChild(pip);
    return pip;
  }

  private makeDraggable(pip: HTMLElement, handle: HTMLElement): () => void {
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;
    let isDragging = false;
    let activePointerId: number | null = null;

    const onPointerMove = (e: PointerEvent) => {
      if (!isDragging || (activePointerId !== null && e.pointerId !== activePointerId)) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const maxLeft = Math.max(0, window.innerWidth - pip.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - pip.offsetHeight);

      const nextLeft = Math.max(0, Math.min(initialLeft + dx, maxLeft));
      const nextTop = Math.max(0, Math.min(initialTop + dy, maxTop));

      pip.style.left = `${nextLeft}px`;
      pip.style.top = `${nextTop}px`;
      e.preventDefault();
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!isDragging || (activePointerId !== null && e.pointerId !== activePointerId)) return;
      isDragging = false;
      activePointerId = null;

      handle.style.cursor = 'grab';
      try {
        if (handle.hasPointerCapture(e.pointerId)) {
          handle.releasePointerCapture(e.pointerId);
        }
      } catch {
        // ignore
      }

      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;

      const rect = pip.getBoundingClientRect();
      // Lock rendered coordinates to left/top before dragging starts
      pip.style.bottom = 'auto';
      pip.style.right = 'auto';
      pip.style.left = `${rect.left}px`;
      pip.style.top = `${rect.top}px`;

      startX = e.clientX;
      startY = e.clientY;
      initialLeft = rect.left;
      initialTop = rect.top;
      isDragging = true;
      activePointerId = e.pointerId;

      handle.style.cursor = 'grabbing';
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        // capture may fail in non-standard environments; window listeners handle it
      }

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
      e.preventDefault();
    };

    const onResize = () => {
      if (!pip.parentElement) return;
      const rect = pip.getBoundingClientRect();
      const maxLeft = Math.max(0, window.innerWidth - rect.width);
      const maxTop = Math.max(0, window.innerHeight - rect.height);

      if (rect.left > maxLeft || rect.top > maxTop) {
        pip.style.left = `${Math.max(0, Math.min(rect.left, maxLeft))}px`;
        pip.style.top = `${Math.max(0, Math.min(rect.top, maxTop))}px`;
      }
    };

    handle.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onResize);

    return () => {
      handle.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('resize', onResize);
    };
  }

  private handleEnclaveMessage(e: MessageEvent) {
    // Origin + source binding: only trust the enclave we mounted.
    if (e.origin !== this.enclaveOrigin) return;
    if (!this.iframe || e.source !== this.iframe.contentWindow) return;

    const msg = e.data as EnclaveToHost;
    if (!msg || typeof msg !== 'object') return;

    switch (msg.kind) {
      case MSG.READY:
        this.ready = true;
        // Loader and enclave ship independently — npm install vs our CDN — so a
        // pair that does not match is entirely possible. Say so loudly: the
        // alternative is what happened before, where a newer loader posted
        // messages an older enclave had never heard of and dropped in silence,
        // for months, with no error anywhere.
        if (msg.version !== PROTOCOL_VERSION) {
          this.emit('error', {
            message:
              `[ProctorLink] enclave protocol v${msg.version} does not match loader v${PROTOCOL_VERSION}. ` +
              `The enclave at ${this.opts.enclaveUrl} is not the one this SDK (${SDK_VERSION}) expects — ` +
              `features may silently do nothing. Check any enclaveUrl override.`,
          });
        }
        this.postToEnclave({
          kind: 'pl:init',
          version: PROTOCOL_VERSION,
          config: this.initConfig(),
        });
        // Not while paused: pause() can land before the handshake completes (a
        // route change during enclave load), and attaching here would leave a
        // paused session forwarding tab/clipboard events. resume() attaches.
        if (!this.paused) this.attachHostHandlers();
        // Re-assert the pause to the enclave, which had no config to act on when
        // the original pl:pause arrived and dropped it.
        if (this.paused) this.postToEnclave({ kind: 'pl:pause' });
        this.emit('ready', undefined);
        break;
      case MSG.PERMISSION:
        this.emit('permission', { camera: msg.camera, error: msg.error });
        break;
      case MSG.EVENT:
        this.emit('event', msg.event);
        break;
      case MSG.IDENTITY_CAPTURED: {
        const pending = this.pendingCaptures.get(msg.id);
        if (pending) {
          window.clearTimeout(pending.timer);
          this.pendingCaptures.delete(msg.id);
          if (msg.ok) pending.resolve();
          else pending.reject(new Error(msg.error || 'identity capture failed'));
        }
        break;
      }
      case MSG.AUTH_EXPIRED:
        this.emit('token-expired', { message: msg.message });
        break;
      case MSG.STOPPED:
        // Enclave finished flushing + ending — safe to remove the iframe now.
        if (this.destroyRequested) this.finalizeDestroy();
        break;
      case MSG.ERROR:
        this.emit('error', { message: msg.message });
        break;
    }
  }

  private initConfig(): EnclaveInitConfig {
    return {
      jwt: this.opts.jwt,
      sessionId: this.sessionId,
      ingestBaseUrl: this.opts.ingestBaseUrl,
      frameIntervalMs: this.opts.frameIntervalMs,
      heartbeatIntervalMs: this.opts.heartbeatIntervalMs,
      captureAudio: this.opts.captureAudio,
      autoStartCapture: this.opts.autoStartCapture,
    };
  }

  private postToEnclave(msg: HostToEnclave) {
    if (!this.iframe?.contentWindow || !this.ready) return;
    this.iframe.contentWindow.postMessage(msg, this.enclaveOrigin);
  }

  /**
   * Host-context integrity signals. These MUST be observed in the top-level quiz
   * page — an iframe cannot reliably see the parent's fullscreen state or window
   * focus. We forward them down so the enclave assigns a sequence number, uploads,
   * and echoes the canonical event back up (keeping one ordered stream).
   */
  private attachHostHandlers() {
    const forward = (type: HostRawEvent['type'], data?: Record<string, unknown>) =>
      this.postToEnclave({ kind: 'pl:host-event', event: { type, ts: Date.now(), data } });

    const add = (target: EventTarget, name: string, handler: EventListener) => {
      target.addEventListener(name, handler);
      this.hostHandlers.push([target, name, handler]);
    };

    add(document, 'visibilitychange', () =>
      forward(document.hidden ? 'tab.hidden' : 'tab.visible'),
    );
    add(document, 'fullscreenchange', () =>
      forward(document.fullscreenElement ? 'fullscreen.entered' : 'fullscreen.exited'),
    );

    // Clipboard + right-click must be observed in the host document — the enclave
    // iframe cannot see copy/paste/contextmenu happening on the quiz page.
    add(document, 'copy', () => forward('clipboard.copy'));
    add(document, 'cut', () => forward('clipboard.cut'));
    add(document, 'paste', () => forward('clipboard.paste'));
    add(document, 'contextmenu', () => forward('context.menu'));
    add(window, 'pagehide', () => forward('page.unload'));

    // Window resize as a split-screen / snap heuristic (debounced).
    let resizeTimer = 0;
    add(window, 'resize', () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(
        () => forward('window.resized', { w: window.innerWidth, h: window.innerHeight }),
        400,
      );
    });
  }

  private detachHostHandlers() {
    for (const [target, name, handler] of this.hostHandlers) {
      target.removeEventListener(name, handler);
    }
    this.hostHandlers.length = 0;
  }

  private emit<K extends keyof SessionEventMap>(type: K, payload: SessionEventMap[K]) {
    for (const cb of this.listeners[type]) {
      try {
        cb(payload);
      } catch (err) {
        // Never let a host callback break the SDK loop.
        console.error('[ProctorLink] listener threw', err);
      }
    }
  }
}

export const ProctorLink = {
  version: SDK_VERSION,
  /** Create (but do not start) a proctoring session. Call `.start()` to begin. */
  createSession(options: CreateSessionOptions): ProctorSession {
    return new ProctorSession(options);
  },
};

export type { ProctorEvent, ProctorEventType } from '../shared/protocol';
export default ProctorLink;
