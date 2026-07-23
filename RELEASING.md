# Releasing codeoid

Releases are automated. Pushing a `vX.Y.Z` tag publishes `codeoid` to npm with
[provenance](https://docs.npmjs.com/generating-provenance-statements) and opens a
GitHub Release — see [`.github/workflows/release.yml`](.github/workflows/release.yml).

## One-time setup

Add an **`NPM_TOKEN`** repository secret (Settings → Secrets and variables →
Actions → New repository secret):

1. On npmjs.com → **Access Tokens** → create a **Granular** (or Automation) token
   with publish rights for the `codeoid` package.
2. Save it as `NPM_TOKEN`.

## Cutting a release

1. Bump `version` in [`package.json`](package.json) (SemVer).
2. Move the `## [Unreleased]` notes into a new `## [X.Y.Z]` section in
   [`CHANGELOG.md`](CHANGELOG.md).
3. Open a PR, get CI green, merge to `main`.
4. Tag from `main` and push (tags are not branch-protected):

   ```bash
   git checkout main && git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The workflow then builds the web UI, runs the test suite, verifies the tag matches
`package.json`, `npm publish`es, and creates the GitHub Release. Install with:

```bash
bun install -g codeoid   # or: bunx codeoid
```

## Notes

- **codeoid runs under [Bun](https://bun.sh).** The published package ships `src/`
  plus the prebuilt `web/dist`, and points `bin` at `src/cli.ts` (Bun executes
  TypeScript directly — no bundling step, and the web UI path resolves inside the
  package).
- The **wire protocol** is versioned independently via `PROTOCOL_VERSION` in
  [`src/protocol/types.ts`](src/protocol/types.ts). Bump it only on wire-breaking
  changes, and keep it in lockstep with the `codeoid-protocol` crate in
  [codeoid-ui](https://github.com/highflame-ai/codeoid-ui). App versions and the protocol
  version move independently; the handshake negotiates compatibility.
