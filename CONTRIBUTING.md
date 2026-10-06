# Contributing

This repository is **source available, not open source**. The code is published
so that anyone embedding the SDK can read exactly what runs in their candidates'
browsers. Use of the package is governed by [LICENSE](./LICENSE) and the
[EULA](https://proctorlink.com/eula).

## What is most useful to us

**Issues.** Bug reports, documentation gaps, and integration problems are all
welcome in the issue tracker. A report that names the browser, the SDK version
and what you expected to happen is usually enough for us to act on.

**Security problems go elsewhere.** See [SECURITY.md](./SECURITY.md). Please do
not open a public issue for those.

**Questions about using the SDK** are better at
https://proctorlink.com/contact, where the support team sees them. The issue
tracker is for defects in this package.

## Pull requests

- **Documentation and examples:** send them, we are glad to have them.
- **Code:** open an issue first so we can agree on the approach. The enclave is
  the boundary that makes the proctoring signal trustworthy, so changes there
  need discussion before code.

By sending a pull request you confirm that the work is yours to give, and you
grant Take2 Technologies an unrestricted right to use, modify and distribute it
as part of this proprietary package. If your employer owns your work, get their
agreement first.

## Working on the code

```bash
npm ci
npm run build     # esbuild bundles the loader and the enclave
npm run types     # emits the TypeScript declarations
```

Node 20 or later is required. esbuild ships a platform-specific binary, so if
you switch architectures (an Intel Node on an Apple Silicon machine, for
example) the build fails with a message about `@esbuild/darwin-arm64` versus
`@esbuild/darwin-x64`. Delete `node_modules` and run `npm ci` with the Node you
actually intend to build with.

### Layout

| Path | What it is |
|---|---|
| `src/loader/` | The thin public SDK that runs in the host page. Holds no secrets. |
| `src/enclave/` | The isolated cross-origin frame: capture, events and ingest. |
| `src/shared/` | The postMessage protocol shared by both sides. |

The loader and the enclave are version-matched and check the protocol on
connect, so a change to `src/shared/protocol.ts` affects both and needs the
version bump explained in [PUBLISHING.md](./PUBLISHING.md).

## Releases

Maintainers publish by hand, following [PUBLISHING.md](./PUBLISHING.md). Nothing
publishes automatically.
