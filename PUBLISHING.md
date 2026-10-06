# Releasing `@proctorlink/sdk`

Releases run from GitHub Actions on a version tag. Nothing publishes on a push
to a branch.

## The order that matters

The loader asks for an enclave pinned to its own version
(`https://enclave.proctorlink.com/<version>/enclave.html`). **Deploy the enclave
before the package becomes installable.** Publish first and the next customer to
upgrade loads a 404, and no session starts. `.github/workflows/release.yml`
refuses to publish until that URL answers 200, but the deploy itself is still a
manual step.

## Cutting a release

```bash
# 1. Update CHANGELOG.md: give the new version a date and list what changed.
# 2. Bump the version. This commits and tags.
npm version patch            # or minor / major
# 3. Deploy dist/enclave to enclave.proctorlink.com/<new version>/
# 4. Push the commit and the tag. The tag is what triggers the release.
git push origin main --follow-tags
```

Watch the **Release** workflow. It builds, refuses a version that is already on
npm, refuses a tag that disagrees with `package.json`, checks the enclave is
live, then publishes with `--provenance`.

Provenance puts a verified badge on the npm page linking the tarball to the
workflow run that built it. It needs the repository to be public and
`id-token: write` in the workflow, both of which are in place.

### One-time setup

- Repository secret **`NPM_TOKEN`**: an npm automation token for an account with
  publish rights on the `@proctorlink` scope. Granular tokens work; classic
  tokens must be of type "Automation" so 2FA does not block CI.
- Environment **`npm-publish`** in repository settings. Add required reviewers
  there if you want a human approval before each publish.

### Pre-releases

A version with a hyphen publishes under the `next` dist-tag automatically, so
`latest` stays stable:

```bash
npm version 1.1.0-beta.1
# installs with: npm install @proctorlink/sdk@next
```

### Publishing by hand

Only when Actions is unavailable. There is no provenance on a local publish.

```bash
npm ci
npm run build && npm run types
npm pack --dry-run          # expect dist/, package.json, README.md, LICENSE
npm whoami                  # confirm the account
npm publish --access public
```

## Verify

```bash
npm view @proctorlink/sdk version
npm view @proctorlink/sdk dist-tags
npm view @proctorlink/sdk license      # should be: SEE LICENSE IN LICENSE
curl -sI https://cdn.jsdelivr.net/npm/@proctorlink/sdk@latest/dist/proctorlink.js | head -1
```

Then install it somewhere clean and start a session against the production
enclave. The npm page is also worth a look: description, keywords, links and
the provenance badge all come from this release.

## Support window

Published in the README so integrators can read it: the current minor version
gets fixes, and the previous minor keeps security fixes for 6 months after its
successor ships. Keep that promise in sync if it changes.

---

## Testing against a working copy

The sample app at `../proctorlink-angular-sample` depends on
`file:../proctorlink-sdk`, so it uses your working tree directly. The SDK's
`prepare` script builds `dist/` when the sample runs `npm install`.

To test the exact tarball npm would publish:

```bash
npm pack                                   # -> proctorlink-sdk-1.0.1.tgz
cd ../proctorlink-angular-sample
npm install ../proctorlink-sdk/proctorlink-sdk-1.0.1.tgz
```

> esbuild installs a platform-specific binary. If `npm pack` fails complaining
> about `@esbuild/darwin-arm64` versus `@esbuild/darwin-x64`, your `node_modules`
> was installed with a Node of the other architecture. `rm -rf node_modules &&
> npm ci` with the Node you intend to build with.

## Pre-release checklist

- [ ] `CHANGELOG.md` has an entry for this version, with a date.
- [ ] Version bumped; `package.json` and `package-lock.json` agree.
- [ ] Enclave deployed to `enclave.proctorlink.com/<version>/enclave.html`.
- [ ] `npm pack --dry-run` shows `dist/` and types, and nothing from `src/`.
- [ ] README renders acceptably — it is the npm landing page.
- [ ] Breaking change? Then it is a major version, and the migration note
      belongs in the changelog.
