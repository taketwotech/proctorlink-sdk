# Angular integration

A minimal, copy-pasteable example for the customer's Angular quiz portal. Two
pieces: a thin service that wraps the SDK, and a component that starts/stops a
session around the quiz.

Install:

```bash
npm install @proctorlink/sdk
```

## 1. Service

```ts
// proctoring.service.ts
import { Injectable, NgZone } from '@angular/core';
import { Subject } from 'rxjs';
import { ProctorLink, ProctorSession, ProctorEvent } from '@proctorlink/sdk';

@Injectable({ providedIn: 'root' })
export class ProctoringService {
  private session: ProctorSession | null = null;
  readonly events$ = new Subject<ProctorEvent>();
  readonly permission$ = new Subject<{ camera: 'granted' | 'denied' }>();

  constructor(private zone: NgZone) {}

  async start(sessionId: string, jwt: string) {
    this.session = ProctorLink.createSession({
      enclaveUrl: 'https://enclave.proctorlink.com/enclave.html',
      jwt,
      sessionId,
      frameIntervalMs: 5000,
    });

    // SDK callbacks fire outside Angular's zone — re-enter so bindings update.
    this.session.on('permission', (p) => this.zone.run(() => this.permission$.next(p)));
    this.session.onEvent((e) => this.zone.run(() => this.events$.next(e)));

    await this.session.start();
  }

  stop() {
    this.session?.stop();
    this.session?.destroy();
    this.session = null;
  }
}
```

## 2. Component

```ts
// quiz.component.ts
import { Component, OnDestroy, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ProctoringService } from './proctoring.service';

@Component({
  selector: 'app-quiz',
  template: `
    <div *ngIf="cameraDenied" class="warning">
      Camera access is required to take this exam.
    </div>
    <!-- your quiz UI -->
  `,
})
export class QuizComponent implements OnInit, OnDestroy {
  cameraDenied = false;

  constructor(private http: HttpClient, private proctoring: ProctoringService) {}

  async ngOnInit() {
    // Your OWN backend mints the session (it holds the tenant API key).
    const { session_id, session_jwt } = await firstValueFrom(
      this.http.post<{ session_id: string; session_jwt: string }>(
        '/api/proctoring/session',
        { exam_id: 'math-final' },
      ),
    );

    this.proctoring.permission$.subscribe((p) => (this.cameraDenied = p.camera === 'denied'));
    this.proctoring.events$.subscribe((evt) => {
      // Store the event on your side if you want your own copy.
      this.http.post('/api/proctoring/events', evt).subscribe();
    });

    await this.proctoring.start(session_id, session_jwt);
  }

  ngOnDestroy() {
    this.proctoring.stop();
  }
}
```

## 3. Your Angular backend endpoint (mints the session)

Keep the tenant API key server-side. This proxies to the ProctorLink dashboard:

```ts
// POST /api/proctoring/session  (Node/Express sketch)
app.post('/api/proctoring/session', async (req, res) => {
  const r = await fetch('https://dashboard.proctorlink.com/v1/sessions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.PROCTORLINK_API_KEY}`,
    },
    body: JSON.stringify({
      external_user_id: req.user.id,
      exam_id: req.body.exam_id,
      allowed_origins: ['https://exams.customer.com'],
      ttl: 7200,
    }),
  });
  res.json(await r.json()); // { session_id, session_jwt }
});
```

## Notes

- Add our enclave origin to the app's CSP: `frame-src https://enclave.proctorlink.com`.
- SDK callbacks run outside Angular's zone; wrap state updates in `NgZone.run`
  (done in the service above) or use `ChangeDetectorRef`.
- The camera preview mounts as a floating pip by default. Pass `mount:
  someElement` to place it inside your layout, or `showPreview: false` to hide it.
```
