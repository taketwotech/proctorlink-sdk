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

export interface CreateSessionOptions {
  /** Full URL to the hosted enclave document, e.g. https://enclave.proctorlink.com/enclave.html */
  enclaveUrl: string;
  /** Short-lived session JWT minted by the dashboard's POST /v1/sessions. */
  jwt: string;
  /** Session id. If omitted, it is decoded from the JWT payload (sid/sub). */
  sessionId?: string;
  /** Ingest API base URL. Defaults to the origin of `enclaveUrl`. */
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
  private destroyRequested = false;
  private destroyTimer = 0;

  private readonly listeners: { [K in keyof SessionEventMap]: Set<Listener<SessionEventMap[K]>> } = {
    ready: new Set(),
    permission: new Set(),
    event: new Set(),
    error: new Set(),
  };

  private readonly onMessage = (e: MessageEvent) => this.handleEnclaveMessage(e);
  private readonly hostHandlers: Array<[EventTarget, string, EventListener]> = [];

  constructor(options: CreateSessionOptions) {
    const enclaveOrigin = new URL(options.enclaveUrl).origin;
    const sessionId = options.sessionId || decodeSessionIdFromJwt(options.jwt);
    if (!sessionId) {
      throw new Error('[ProctorLink] sessionId is required (pass it explicitly or use a JWT that carries sid/session_id/sub).');
    }
    this.enclaveOrigin = enclaveOrigin;
    this.sessionId = sessionId;
    this.opts = {
      enclaveUrl: options.enclaveUrl,
      jwt: options.jwt,
      sessionId,
      ingestBaseUrl: options.ingestBaseUrl || enclaveOrigin,
      frameIntervalMs: options.frameIntervalMs ?? 60000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 5000,
      captureAudio: options.captureAudio ?? false,
      showPreview: options.showPreview ?? true,
      mount: options.mount,
    };
  }

  /** Mounts the enclave, requests the camera and begins capture. Resolves when the enclave is ready. */
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

  /** Signals the enclave to end capture and flush its queue. Keeps the iframe for a graceful stop. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.postToEnclave({ kind: 'pl:stop' });
    this.detachHostHandlers();
  }

  /**
   * Tears everything down. Signals the enclave to stop, then waits for it to
   * flush events + send `/end` (the `pl:stopped` ack) before removing the iframe.
   * Falls back to removing after 3s if no ack arrives, so it can never hang.
   */
  destroy(): void {
    if (this.destroyRequested) return;
    this.destroyRequested = true;
    this.stop();
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
    window.removeEventListener('message', this.onMessage);
    if (this.iframe) {
      const pip = this.iframe.parentElement;
      this.iframe.remove();
      if (pip && pip.dataset.plPip === '1') pip.remove();
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
    pip.dataset.plPip = '1';
    pip.style.cssText =
      'position:fixed;bottom:16px;right:16px;z-index:2147483647;box-shadow:0 4px 16px rgba(0,0,0,.25);border-radius:8px;overflow:hidden;background:#000;';
    document.body.appendChild(pip);
    return pip;
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
        this.postToEnclave({
          kind: 'pl:init',
          version: PROTOCOL_VERSION,
          config: this.initConfig(),
        });
        this.attachHostHandlers();
        this.emit('ready', undefined);
        break;
      case MSG.PERMISSION:
        this.emit('permission', { camera: msg.camera, error: msg.error });
        break;
      case MSG.EVENT:
        this.emit('event', msg.event);
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
