# Examples

Runnable integrations, smallest first. None of this ships in the npm package.

| Example | What it shows |
|---|---|
| [`vanilla/`](./vanilla) | A single HTML file loading the SDK from a CDN, with a 60-line Node mint proxy. No build step, no framework. |
| [`react/`](./react) | A `useProctorSession` hook with the lifecycle handled, including token refresh and leaving the exam route. |
| `../../proctorlink-angular-sample` | A fuller Angular portal: identity capture, resume, and the report view. Not in this repository. |

## Before you start

You need an `access-token` / `secret-token` pair from
[app.proctorlink.com](https://app.proctorlink.com) under **Developers → SDK
applications**. The secret is shown once.

Both tokens stay on your server. The browser only ever receives a `session_jwt`,
which is scoped to one attempt and expires with it.

## The contract every example follows

**Your server** mints a session when an attempt starts:

```http
POST https://api.proctorlink.com/v1/sessions
access-token: <ACCESS_TOKEN>
secret-token: <SECRET_TOKEN>
content-type: application/json

{
  "external_user_id": "candidate-123",
  "exam_id": "math-11",
  "attempt_id": "attempt-789",
  "allowed_origins": ["https://exams.yourcompany.com"]
}
```

Two fields decide whether the integration behaves well:

- **`attempt_id` must be the stable primary key of your attempt record.** Minting
  again with the same one resumes the same session, which is what makes token
  refresh and reconnect work. A fresh id means a second session, a second report
  and a second billed credit.
- **`allowed_origins` must list the origin your exam page is served from**, or
  ingest fails CORS and nothing is recorded.

**Your page** passes the response to the SDK and starts it. That is the whole
browser integration.
