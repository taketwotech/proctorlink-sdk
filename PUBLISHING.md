# Releasing `@proctorlink/sdk`

You run every command here. Nothing publishes automatically.

## The order that matters

The loader asks for an enclave pinned to its own version
(`https://enclave.proctorlink.com/<version>/enclave.html`). **Deploy the enclave
before you publish to npm.** Publish first and the next customer to upgrade loads
a 404, and no session starts.

Check it before every publish:

```bash
version=$(node -p "require('./package.json').version")
curl -sI "https://enclave.proctorlink.com/$version/enclave.html" | head -1
# expect: HTTP/2 200
```

## Cutting a release

```bash
# 1. CHANGELOG.md: give the new version a date and list what changed.

# 2. Bump. This commits and tags.
npm version patch                # or minor / major

# 3. Build and look at what will ship.
npm ci
npm run build && npm run types
npm pack --dry-run               # expect dist/, package.json, README.md, LICENSE

# 4. Deploy dist/enclave to enclave.proctorlink.com/<new version>/ and confirm
#    the URL above answers 200.

# 5. Publish.
npm whoami                       # confirm the account
npm publish                      # access:public is baked into publishConfig

# 6. Push the commit and the tag.
git push --follow-tags
```

`prepare` and `prepublishOnly` rebuild on `npm publish`, so the tarball can never
carry a stale `dist/`. Step 3 just lets you eyeball it first.

### Pre-releases

Keep `latest` stable by putting anything unfinished on the `next` dist-tag:

```bash
npm version 1.1.0-beta.1
npm publish --tag next
# installs with: npm install @proctorlink/sdk@next
```

Without `--tag`, npm moves `latest` to whatever you just published, including a
beta.

## Verify

```bash
npm view @proctorlink/sdk version
npm view @proctorlink/sdk dist-tags
npm view @proctorlink/sdk license      # should be: SEE LICENSE IN LICENSE
curl -sI https://cdn.jsdelivr.net/npm/@proctorlink/sdk@latest/dist/proctorlink.js | head -1
```

Then install it somewhere clean and start a session against the production
enclave. The npm page is worth a look too: description, keywords and links all
come from this release.

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
- [ ] Enclave deployed to `enclave.proctorlink.com/<version>/enclave.html`, and
      the URL answers 200.
- [ ] `npm pack --dry-run` shows `dist/` and types, and nothing from `src/`.
- [ ] README renders acceptably. It is the npm landing page.
- [ ] Breaking change? Then it is a major version, and the migration note
      belongs in the changelog.
