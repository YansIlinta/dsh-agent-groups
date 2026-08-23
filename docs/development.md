# Development Guide

## Requirements

- Node.js 20+
- npm
- A local DeepSeek Harness installation
- Bash for the provided profile scripts

The host package links against the DSH runtime packages available in the local environment. CI currently installs and verifies against `@deepseek-ai/dsh@0.1.0-rc.6`.

## Install dependencies

From the repository root:

```bash
cd packages/host
npm install
cd ../..
```

The host package `postinstall` script links the DSH packages used for compilation.

## Core commands

```bash
npm run build          # host + native DSH client bundle
npm run typecheck      # source + test typecheck
npm test               # Vitest suite
npm run build:native   # native client bundle only
npm run verify         # complete pre-PR verification chain
```

Useful integration helpers:

```bash
node scripts/verify-durability.mjs
node scripts/demo-v02.mjs
node scripts/demo-v02.mjs --keep
```

## Install into a local DSH web profile

```bash
npm run install-web-profile
npm run relaunch-web
```

`install-web-profile` performs four reversible steps:

1. Builds the native client and host package as needed.
2. Copies `@dsh-agent-groups/host` into the local DSH profile module tree.
3. Copies the `group-leader` and `group-member` presets into the DSH preset directory.
4. Adds an idempotent `agent-groups` plugin row to the DSH web-profile patch.

The default DSH home is `~/.dsh`; set `DSH_HOME` before running the script to target another profile root.

## CI

`.github/workflows/ci.yml` currently runs on Node 22 and:

1. installs the exact DSH compatibility target;
2. installs host dependencies;
3. typechecks;
4. runs tests;
5. builds the host + native client;
6. syntax-checks the generated client bundle.

When changing the compatibility target, update CI and verify the native slot/API assumptions rather than changing the README badge alone.

## Runtime work

Runtime changes should be tested at the normalized session/turn boundary, not only at the provider transport layer.

For Codex, deterministic tests use a fake App Server/JSONL transport. Real-binary smoke testing is credential-gated; the existing Codex smoke path can be enabled with:

```bash
AGENT_GROUPS_CODEX_SMOKE=1 npm test
```

Provider tests should cover failure paths as well as happy paths: malformed messages, disconnects, late turn events, resume failures, steering failures, permission/input requests, interruption, and retry/reconciliation behavior.

## Native client

The native page source lives under `packages/host/src/native-client/`. The build script wraps it into the DSH client-module format and writes `packages/host/lib/client.js`.

The client must remain additive to the DSH shell:

- use registered DSH slots rather than replacing shell internals;
- prefer DSH UI primitives for interactive chrome;
- use `--dsw-alias-*` theme tokens;
- keep local selectors under the `ag-` prefix;
- avoid a second router/app shell or iframe.

See [Native UI](native-ui.md).

## Before opening a pull request

```bash
npm run verify
```

Also run the smallest relevant integration/demo path for the behavior you changed.

## Repository conventions

- Keep the root README product-focused.
- Put implementation notes and investigations under `docs/`.
- Treat runtime lifecycle rules in [Architecture](architecture.md) as invariants.
- Prefer small, auditable changes with regression tests over broad rewrites of `group-host.ts` or provider implementations.
- Never persist credentials, API keys, auth files, or secret-bearing provider payloads.
