# React

[`useProctorSession.ts`](./useProctorSession.ts) is a hook that owns the session
for the lifetime of an exam screen. Drop it into your project and use it:

```tsx
import { useProctorSession } from './useProctorSession';

export function ExamScreen({ attemptId, examId, userId }: Props) {
  const { status, error, finish } = useProctorSession(
    { attemptId, examId, externalUserId: userId },
    (event) => console.debug('[proctor]', event.seq, event.type),
  );

  if (status === 'denied') {
    return <Blocked reason="Camera access is required for this exam." />;
  }

  return (
    <>
      {status === 'starting' && <Banner>Setting up proctoring…</Banner>}
      {error && <Banner tone="warn">{error}</Banner>}
      <Questions onSubmit={() => { finish(); submitAnswers(); }} />
    </>
  );
}
```

It expects one endpoint on your backend, `POST /api/proctoring/session`, which
mints with your API key and returns `{ session_id, session_jwt }` unchanged.
[`../vanilla/server.mjs`](../vanilla/server.mjs) is a working implementation of
exactly that in 70 lines.

## Why the hook looks the way it does

**Route changes.** The camera preview is mounted on `document.body`, outside your
router outlet, so it survives a route change that does not reload the page. The
cleanup calls `destroy({ endSession: false })`: the SDK is removed, the attempt
stays open, and coming back to the route rejoins the same session with its
sequencing and evidence intact.

**`finish()` is the only thing that ends the attempt.** `stop()` is terminal
server-side. A re-mint afterwards creates a different session with its own report
and its own billed credit, so it belongs on submit, not on unmount.

**Token refresh.** Exams outlast session tokens. On `'token-expired'` the hook
mints again with the same `attempt_id`, which resumes the session, and passes the
new token to `updateToken()`. Data queued during the gap flushes immediately.

**The double-invoke guard.** React 18 runs effects twice in development. Without
`startedRef` that mounts two enclaves and requests the camera twice.
