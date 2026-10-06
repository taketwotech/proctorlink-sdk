/**
 * A React hook that owns a ProctorLink session for the lifetime of an exam
 * screen.
 *
 * The three things that are easy to get wrong, all handled here:
 *
 *   1. Leaving the exam route must not end the attempt. The camera preview is
 *      attached to document.body, outside your router outlet, so without a
 *      teardown it keeps capturing an empty chair and those frames are scored
 *      against the candidate.
 *   2. A token that expires mid-exam has to be replaced, not restarted. Minting
 *      again with the same attempt_id resumes the same session; a new id splits
 *      the attempt into two reports and bills twice.
 *   3. React 18 runs effects twice in development. Start has to be guarded or
 *      two enclaves mount.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ProctorLink, type ProctorEvent, type ProctorSession } from '@proctorlink/sdk';

type Attempt = {
  externalUserId: string;
  examId: string;
  /** The stable primary key of your attempt record. */
  attemptId: string;
};

type MintResponse = { session_id: string; session_jwt: string };

export type ProctorState = {
  status: 'idle' | 'starting' | 'active' | 'denied' | 'error';
  error?: string;
  /** Ends the attempt server-side. Call it when the candidate submits. */
  finish: () => void;
};

/** Asks your own backend to mint. The API key stays there. */
async function mint(attempt: Attempt): Promise<MintResponse> {
  const res = await fetch('/api/proctoring/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      external_user_id: attempt.externalUserId,
      exam_id: attempt.examId,
      attempt_id: attempt.attemptId,
    }),
  });
  if (!res.ok) throw new Error(`mint failed with ${res.status}`);
  return res.json();
}

export function useProctorSession(
  attempt: Attempt,
  onEvent?: (event: ProctorEvent) => void,
): ProctorState {
  const [status, setStatus] = useState<ProctorState['status']>('idle');
  const [error, setError] = useState<string>();

  const sessionRef = useRef<ProctorSession | null>(null);
  const startedRef = useRef(false);
  // Keep the callback in a ref so a new function identity on every render does
  // not restart the session.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (startedRef.current) return; // React 18 double-invokes effects in dev
    startedRef.current = true;

    let cancelled = false;

    (async () => {
      setStatus('starting');
      try {
        const { session_id, session_jwt } = await mint(attempt);
        if (cancelled) return;

        const session = ProctorLink.createSession({
          jwt: session_jwt,
          sessionId: session_id,
        });
        sessionRef.current = session;

        session.on('permission', ({ camera }) => {
          setStatus(camera === 'denied' ? 'denied' : 'active');
        });

        session.on('error', ({ message }) => setError(message));

        session.on('token-expired', async () => {
          try {
            // Same attempt_id, so this resumes rather than starting a second session.
            const fresh = await mint(attempt);
            session.updateToken(fresh.session_jwt);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'could not refresh token');
          }
        });

        session.onEvent((event) => onEventRef.current?.(event));

        await session.start();
        if (!cancelled) setStatus((s) => (s === 'denied' ? s : 'active'));
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
      // Tear down without ending the attempt, so returning to this route
      // rejoins the same session instead of opening a second one.
      sessionRef.current?.destroy({ endSession: false });
      sessionRef.current = null;
      startedRef.current = false;
    };
    // attemptId identifies the attempt; the other fields travel with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt.attemptId]);

  const finish = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    session.stop();      // ends the attempt server-side, not reversible
    session.destroy();
    sessionRef.current = null;
    setStatus('idle');
  }, []);

  return { status, error, finish };
}
