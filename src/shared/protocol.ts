/**
 * Shared contract between the loader (host-page side) and the enclave (iframe side).
 *
 * The loader and enclave live on DIFFERENT origins and talk only via
 * `window.postMessage`. This file is the single source of truth for the message
 * shapes and the proctoring event taxonomy. Both bundles import it, so the two
 * sides can never drift.
 */

/**
 * Bump whenever a message is added, removed, or changes shape. The loader checks
 * this against the value the enclave reports in `pl:ready`, because the two are
 * deployed independently — the loader from the customer's npm install, the
 * enclave from our CDN — and a mismatched pair otherwise fails in total silence.
 *
 * History: 1 = initial. 2 = added pl:capture-identity / pl:begin-capture /
 * pl:update-token / pl:identity-captured / pl:auth-expired (shipped in 0.1.3,
 * without a bump — which is how a 0.1.2 enclave came to be silently dropping
 * them in production).
 */
export const PROTOCOL_VERSION = 2;

/**
 * Injected at build time from package.json, so there is exactly one place a
 * version is declared. It also selects the enclave build the loader will load.
 */
declare const __SDK_VERSION__: string;
export const SDK_VERSION = __SDK_VERSION__;

/**
 * The canonical proctoring event taxonomy.
 *
 * Keep this list append-only and versioned — the dashboard, the ingest API and
 * the customer's own storage all key off these strings.
 */
export type ProctorEventType =
  // lifecycle
  | 'session.started'
  | 'session.stopped'
  // camera / media
  | 'camera.granted'
  | 'camera.denied'
  | 'frame.captured'
  // liveness — a missing heartbeat is the highest-severity signal (see CLAUDE.md §3)
  | 'heartbeat'
  // host-context integrity signals (pure JS, no AI)
  | 'tab.hidden'
  | 'tab.visible'
  | 'fullscreen.entered'
  | 'fullscreen.exited'
  | 'window.resized'       // possible split-screen / window resize
  | 'clipboard.copy'
  | 'clipboard.cut'
  | 'clipboard.paste'
  | 'context.menu'         // right-click
  | 'device.changed'       // a media device was added/removed mid-exam (e.g. camera unplugged)
  | 'page.unload'          // candidate is navigating away / closing the tab
  // reserved for on-device / server-side vision (not emitted by the MVP detector)
  | 'face.absent'
  | 'face.multiple'
  | 'error';

/** A fully-formed, sequenced event. The enclave is the only producer of these. */
export interface ProctorEvent {
  type: ProctorEventType;
  /** epoch milliseconds */
  ts: number;
  /** monotonic per-session sequence number; gaps => tamper/loss */
  seq: number;
  sessionId: string;
  /** where the signal was observed */
  source: 'enclave' | 'host';
  data?: Record<string, unknown>;
}

/** Config the loader hands the enclave once, at init. */
export interface EnclaveInitConfig {
  jwt: string;
  sessionId: string;
  /** Base URL of the ingest API the enclave uploads to (events + frames). */
  ingestBaseUrl: string;
  /** Keyframe capture cadence in ms. */
  frameIntervalMs: number;
  /** Heartbeat cadence in ms. */
  heartbeatIntervalMs: number;
  /** Capture the mic as well as the camera. */
  captureAudio: boolean;
  /**
   * Start periodic keyframe capture as soon as the camera is granted (default).
   * Set false to bring the camera up without recording, so an identity photo can
   * be taken first; call `beginCapture()` to start the exam.
   */
  autoStartCapture: boolean;
}

/** A raw, unsequenced signal detected in the host page and forwarded down for uploading. */
export interface HostRawEvent {
  type: ProctorEventType;
  ts: number;
  data?: Record<string, unknown>;
}

/** loader -> enclave */
export type HostToEnclave =
  | { kind: 'pl:init'; version: number; config: EnclaveInitConfig }
  | { kind: 'pl:host-event'; event: HostRawEvent }
  /** Capture the pre-exam identity photo. `id` correlates the reply. */
  | { kind: 'pl:capture-identity'; id: string }
  /** Begin periodic keyframe capture (only needed when autoStartCapture is false). */
  | { kind: 'pl:begin-capture' }
  /** Replace the session token the enclave authenticates ingest with. */
  | { kind: 'pl:update-token'; jwt: string }
  | { kind: 'pl:stop' };

/** enclave -> loader */
export type EnclaveToHost =
  | { kind: 'pl:ready'; version: number }
  | { kind: 'pl:permission'; camera: 'granted' | 'denied'; error?: string }
  | { kind: 'pl:event'; event: ProctorEvent }
  | { kind: 'pl:stopped' }
  /** Result of a pl:capture-identity request, matched by `id`. */
  | { kind: 'pl:identity-captured'; id: string; ok: boolean; error?: string }
  /**
   * Ingest was rejected as unauthenticated — almost always an expired session
   * token. Raised once per auth failure streak, not per request, so the host is
   * told promptly without being flooded.
   */
  | { kind: 'pl:auth-expired'; message: string }
  | { kind: 'pl:error'; message: string };

export const MSG = {
  INIT: 'pl:init',
  HOST_EVENT: 'pl:host-event',
  STOP: 'pl:stop',
  CAPTURE_IDENTITY: 'pl:capture-identity',
  BEGIN_CAPTURE: 'pl:begin-capture',
  UPDATE_TOKEN: 'pl:update-token',
  AUTH_EXPIRED: 'pl:auth-expired',
  IDENTITY_CAPTURED: 'pl:identity-captured',
  READY: 'pl:ready',
  PERMISSION: 'pl:permission',
  EVENT: 'pl:event',
  STOPPED: 'pl:stopped',
  ERROR: 'pl:error',
} as const;
