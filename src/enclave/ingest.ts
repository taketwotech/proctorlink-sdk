/**
 * Ingest client — the enclave's only outbound channel to the backend.
 *
 * Holds the session JWT. Events are batched and flushed on an interval. Frames
 * are uploaded straight to object storage (S3) via a presigned PUT, so the large
 * image bytes never transit our own API:
 *
 *   1. POST /v1/ingest/frames/presign  -> { uploadUrl, key }   (auth: session JWT)
 *   2. PUT  <uploadUrl>  (the raw JPEG) -> S3                    (auth: presigned)
 *   3. POST /v1/ingest/frames/commit    -> record evidence row   (auth: session JWT)
 *
 * This keeps per-session cost near zero (uploads to S3 are free; we pay only a
 * tiny PUT + storage) and keeps our backend off the image hot path.
 *
 * MVP note: retries are in-memory only. Phase 1 replaces this with the
 * IndexedDB-backed offline queue described in CLAUDE.md §2 so a mid-exam network
 * drop cannot silently lose evidence.
 */

import type { ProctorEvent } from '../shared/protocol';

interface PresignResponse {
  uploadUrl: string;
  key: string;
}

/** Thrown when the backend rejects our credentials (expired/invalid token). */
export class IngestAuthError extends Error {
  constructor(readonly status: number) {
    super(`ingest rejected with ${status}`);
    this.name = 'IngestAuthError';
  }
}

export class IngestClient {
  private queue: ProctorEvent[] = [];
  private flushing = false;
  /** Not readonly: the host can hand us a fresh token mid-session. */
  private jwt: string;
  /**
   * Cap the retained backlog. Every failed flush re-queues its batch, and
   * heartbeats keep arriving — without a cap an expired token would grow this
   * array for the rest of the exam. Oldest events are dropped first; the recent
   * ones matter more for a report, and the sequence numbers make the loss visible.
   */
  private static readonly MAX_QUEUE = 2000;

  constructor(
    private readonly baseUrl: string,
    jwt: string,
    private readonly sessionId: string,
    /** Called when the backend rejects our token, so the enclave can notify the host. */
    private readonly onAuthFailure?: (status: number) => void,
  ) {
    this.jwt = jwt;
  }

  /** Swap in a freshly minted token. Subsequent requests use it immediately. */
  setToken(jwt: string) {
    this.jwt = jwt;
  }

  queueEvent(event: ProctorEvent) {
    this.queue.push(event);
  }

  async flushEvents(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await this.postJson('/v1/ingest/events', { sessionId: this.sessionId, events: batch });
    } catch (err) {
      // Keep the batch for the next attempt, but bound the backlog so a long
      // auth outage cannot grow it without limit.
      this.queue.unshift(...batch);
      if (this.queue.length > IngestClient.MAX_QUEUE) {
        this.queue.splice(0, this.queue.length - IngestClient.MAX_QUEUE);
      }
      console.warn('[ProctorLink][enclave] event flush failed, will retry', err);
    } finally {
      this.flushing = false;
    }
  }

  /** Upload one keyframe to S3 via a presigned PUT. Returns the stored object key. */
  /**
   * @param kind 'identity' is the pre-exam reference photo every later frame is
   * matched against; the server stores it separately and never analyses it as a
   * target. Anything else is a normal exam keyframe.
   */
  async uploadFrame(
    seq: number,
    ts: number,
    blob: Blob,
    kind: 'frame' | 'identity' = 'frame'
  ): Promise<string | null> {
    const contentType = blob.type || 'image/jpeg';
    try {
      const { uploadUrl, key } = await this.postJson<PresignResponse>('/v1/ingest/frames/presign', {
        sessionId: this.sessionId,
        seq,
        ts,
        contentType,
        kind,
      });

      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': contentType },
        body: blob,
      });
      if (!put.ok) throw new Error(`s3 put -> ${put.status}`);

      // Best-effort: tell the backend the object is in place so it can flip the
      // evidence row to "stored". Safe to lose — a sweeper can reconcile from S3.
      await this.postJson('/v1/ingest/frames/commit', {
        sessionId: this.sessionId,
        seq,
        key,
        ts,
        kind,
      }).catch(() => undefined);

      return key;
    } catch (err) {
      console.warn('[ProctorLink][enclave] frame upload failed', err);
      return null;
    }
  }

  /** Marks the session finished so the backend can finalise counts / usage. */
  async endSession(): Promise<void> {
    await this.postJson(`/v1/sessions/${this.sessionId}/end`, {}).catch(() => undefined);
  }

  /**
   * Where to start numbering. 1 for a new session; on a session we are rejoining
   * after a tab close or a host-page navigation, the seq after the last one
   * already recorded — restarting at 1 would upsert over that evidence.
   *
   * Best effort: if this fails we fall back to 1 rather than blocking the exam.
   */
  async resumePoint(): Promise<number> {
    try {
      const res = await fetch(
        `${this.baseUrl.replace(/\/$/, '')}/v1/sessions/${this.sessionId}/resume`,
        { headers: { authorization: `Bearer ${this.jwt}` } },
      );
      if (!res.ok) return 1;
      const body = (await res.json()) as { next_seq?: number };
      return typeof body.next_seq === 'number' && body.next_seq > 0 ? body.next_seq : 1;
    } catch {
      return 1;
    }
  }

  /**
   * Best-effort flush on teardown. Unlike flushEvents() this bypasses the
   * in-flight guard and does not re-queue on failure — the page is going away,
   * so there is no later flush to retry into. `keepalive` lets the request
   * outlive the document.
   */
  flushBeacon(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    void this.postJson('/v1/ingest/events', {
      sessionId: this.sessionId,
      events: batch,
    }).catch(() => undefined);
  }

  private async postJson<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.baseUrl.replace(/\/$/, '') + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.jwt}`,
      },
      body: JSON.stringify(body),
      keepalive: true,
    });
    if (res.status === 401 || res.status === 403) {
      // Distinguished from ordinary failures: retrying with the same token is
      // pointless, and the host needs to know so it can supply a new one.
      this.onAuthFailure?.(res.status);
      throw new IngestAuthError(res.status);
    }
    if (!res.ok) throw new Error(`ingest ${path} -> ${res.status}`);
    return (await res.json().catch(() => ({}))) as T;
  }
}
