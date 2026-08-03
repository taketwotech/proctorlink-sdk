# Publishing `@proctorlink/sdk` to npm

You run every command here. Nothing publishes automatically.

## 0. One-time: does the `@proctorlink` scope belong to you?

The package name is **scoped** (`@proctorlink/…`). npm only lets you publish under
a scope you own. Check https://www.npmjs.com/settings/ :

- If you own an org or user named `proctorlink` → good, continue.
- If not → create a **free org** named `proctorlink` (public packages are free),
  or rename `name` in `package.json` to a scope you own
  (`@yourorg/proctorlink-sdk`) or an unscoped name (`proctorlink-sdk`, if free).

`publishConfig.access` is already set to `public`, so the scoped package
publishes publicly without extra flags.

> If you need it **private** instead, that requires a paid npm plan; set
> `publishConfig.access` to `restricted`, or publish to a private registry
> (GitHub Packages / Verdaccio) via an `.npmrc`.

## 1. Build + inspect what will ship

```bash
npm ci                 # clean install of devDeps (esbuild, typescript)
npm run build          # esbuild bundles (loader iife/esm/cjs + enclave)
npm run types          # emits dist/types/**/*.d.ts
npm pack --dry-run     # lists the exact files the tarball will contain
```

`npm pack --dry-run` should show only `dist/`, `package.json`, `README.md`
(and `LICENSE` if present) — never `src/`, `examples/`, or `node_modules`
(the `files` allowlist enforces this).

> Note: `prepare` and `prepublishOnly` already run the build for you on
> `npm publish`, so the tarball can never contain a stale `dist/`. Running the
> steps above by hand just lets you eyeball the output first.

## 2. Log in and publish

```bash
npm login                       # or: npm adduser
npm whoami                      # confirm the right account
npm publish                     # access:public is baked into publishConfig
```

First publish of a brand-new name can also be forced explicit:
`npm publish --access public`.

## 3. Cutting later versions

```bash
npm version patch               # 0.1.0 -> 0.1.1 (also creates a git tag)
# npm version minor / major     # as appropriate (semver)
npm publish
```

## 4. Verify it's live

```bash
npm view @proctorlink/sdk version
npm view @proctorlink/sdk dist.tarball
```

---

## Using it before it's published (local testing)

The sample app at `../proctorlink-angular-sample` depends on
`file:../proctorlink-sdk`, so it uses your working copy directly — the SDK's
`prepare` script builds `dist/` automatically when the sample runs `npm install`.

If you'd rather test the **exact tarball** that npm would publish:

```bash
npm pack                                   # -> proctorlink-sdk-0.1.0.tgz
cd ../proctorlink-angular-sample
npm install ../proctorlink-sdk/proctorlink-sdk-0.1.0.tgz
```

After you publish for real, switch the sample's dependency from
`file:../proctorlink-sdk` to the registry version:

```bash
npm install @proctorlink/sdk@^0.1.0
```

---

## Pre-publish checklist

- [ ] `name` scope is one you own on npm.
- [ ] `version` bumped (npm rejects re-publishing an existing version).
- [ ] `npm pack --dry-run` shows `dist/` + types, nothing secret.
- [ ] `README.md` renders acceptably (it's the npm landing page).
- [ ] `license` field reflects your intent (currently `UNLICENSED` — change it
      if you mean to open-source, since it publishes publicly).
- [ ] Enclave is hosted somewhere real for production consumers — the published
      package ships `dist/enclave/`, but customers still load it from **your**
      HTTPS origin (`enclaveUrl`), not from npm.
