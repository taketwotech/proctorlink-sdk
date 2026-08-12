/**
 * Shared contract between the loader (host-page side) and the enclave (iframe side).
 *
 * The loader and enclave live on DIFFERENT origins and talk only via
 * `window.postMessage`. This file is the single source of truth for the message
 * shapes and the proctoring event taxonomy. Both bundles import it, so the two
 * sides can never drift.
 */

export const PROTOCOL_VERSION = 1;
export const SDK_VERSION = '0.1.0';

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
  | { kind: 'pl:stop' };

/** enclave -> loader */
export type EnclaveToHost =
  | { kind: 'pl:ready'; version: number }
  | { kind: 'pl:permission'; camera: 'granted' | 'denied'; error?: string }
  | { kind: 'pl:event'; event: ProctorEvent }
  | { kind: 'pl:stopped' }
  /** Result of a pl:capture-identity request, matched by `id`. */
  | { kind: 'pl:identity-captured'; id: string; ok: boolean; error?: string }
  | { kind: 'pl:error'; message: string };

export const MSG = {
  INIT: 'pl:init',
  HOST_EVENT: 'pl:host-event',
  STOP: 'pl:stop',
  CAPTURE_IDENTITY: 'pl:capture-identity',
  BEGIN_CAPTURE: 'pl:begin-capture',
  IDENTITY_CAPTURED: 'pl:identity-captured',
  READY: 'pl:ready',
  PERMISSION: 'pl:permission',
  EVENT: 'pl:event',
  STOPPED: 'pl:stopped',
  ERROR: 'pl:error',
} as const;
