# Guru CLI

JSON-first CLI for Guru Protocol operations.

## SDK / CLI Development Workflow

- SDK changes live in `/Users/luan/Documents/GitHub/guru-sdk`.
- During local smoke testing, point `@guru-fund/sdk` at the sibling checkout with a `file:` dependency.
- Before publishing, switch `@guru-fund/sdk` back to the published npm version and refresh `pnpm-lock.yaml`.
- Publish the SDK first, then update and publish the CLI against that SDK version.

## Publishing

Use the repo-local helper instead of bare `npm publish`:

```sh
NODE_AUTH_TOKEN=... node .local/npm-publish-public.mjs
```

If pnpm blocks `prepack` because the just-published SDK is inside the minimum release-age window, build first and publish the already-built package with npm scripts skipped. Do not commit npm tokens or temporary `.npmrc` files.
