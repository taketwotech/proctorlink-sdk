# Security policy

ProctorLink runs inside exams. A flaw here can let a candidate defeat
invigilation, or expose a candidate's camera data. We take reports seriously and
we would rather hear about a problem from you than from a customer.

## Reporting a vulnerability

Email **support@proctorlink.com** with `SECURITY` in the subject line, or use
the form at https://proctorlink.com/contact.

Please do not open a public GitHub issue for a security problem. Use the issue
tracker once a fix is released and we agree it is safe to discuss.

Helpful things to include:

- what the issue is, and what an attacker gains from it
- the steps to reproduce it, including browser and version
- the SDK version (`npm ls @proctorlink/sdk`)
- whether you have reason to think it is already being exploited

## What to expect

| Stage | Target |
|---|---|
| Acknowledgement that we have your report | 3 business days |
| Our assessment, with a severity and a plan | 10 business days |
| Fix released for a confirmed critical issue | as fast as we can, and we will tell you the date |

We will keep you updated while we work, credit you when the fix ships if you
would like to be credited, and tell you if we decide not to act and why.

## Scope

**In scope**
- the `@proctorlink/sdk` package published on npm
- the enclave served from `enclave.proctorlink.com`
- the session and ingest APIs this SDK talks to

**Out of scope**
- findings that require a compromised device, a hostile browser extension, or
  physical access to the candidate's machine, since none of those are defences
  a browser SDK can offer
- reports produced only by automated scanners, with no demonstrated impact
- missing hardening headers with no exploit path

## Testing, please read

Do not test against a live exam, a customer's site, or any session that belongs
to a real candidate. Candidate camera data is involved and an interrupted exam
affects a real person's result. Ask us for an evaluation account and test there.
