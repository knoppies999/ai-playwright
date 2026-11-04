# Releasing to npm

All packages share one version and are published together by CI: `aipw` (what users install), `create-aipw`
(`npm init aipw`), and `@aipw/core`, `@aipw/test`, `@aipw/cli` and the four `@aipw/provider-*` packages.

## Each release

```bash
git checkout -b release-0.2.0
node scripts/release-version.mjs 0.2.0      # or patch | minor | major
git commit -am "Release 0.2.0" && git push -u origin release-0.2.0
gh pr create --fill
```

Merging the PR runs [.github/workflows/release.yml](../../.github/workflows/release.yml): build, unit tests and the
no-AI e2e suites, then [scripts/publish.mjs](../../scripts/publish.mjs) publishes every package whose version isn't on
npm yet (dependencies first) and tags `v0.2.0`. A version with a pre-release part (`0.2.0-beta.1`) goes to the
`next` dist-tag instead of `latest`. Merges that leave the version alone publish nothing, and a failed run can be
re-run from the Actions tab (already published packages are skipped).

Check locally first: `npm run build && node scripts/publish.mjs --dry-run`.

## One-time setup

1. **The name.** `aipw` is still a working name. Once a version is published, the name sticks: rename first if you
   want a different one (package names, the `aipw` bin, imports in `aipw init` and `aipw try` templates, docs).
2. **npm account and scope.** Sign in on npmjs.com and create the free organisation `aipw`, so the `@aipw/*` scope is
   yours. `aipw` and `create-aipw` are unscoped.
3. **License: done.** MIT ([LICENSE](../../LICENSE)). Every package has `"license": "MIT"` and copies the root
   `LICENSE` into its tarball when packed (`prepack`). `publish.mjs` refuses to publish a package without a license.
   A new package needs both.
4. **First publish.** npm's trusted publishing can only be set up for packages that already exist, so publish the
   first version with a token: a granular access token on npmjs.com with **Read and write** on all packages (not
   "Read and write (stage only)", which can only stage a publish for approval: CI then fails with E404 on
   `PUT @aipw/core`) and **Bypass 2FA**. Save it as the repository secret `NPM_TOKEN`. npm plans to stop direct
   publishing with bypass-2FA tokens (announced for around January 2027), so move to trusted publishing next.
5. **Then, optionally, trusted publishing.** For each package on npmjs.com: Settings → Trusted publishing → GitHub
   Actions, repository `knoppies999/ai-playwright`, workflow `release.yml`. CI then publishes through OIDC with no
   token, and you can delete `NPM_TOKEN`. If the repository is public, releases also get provenance statements.
