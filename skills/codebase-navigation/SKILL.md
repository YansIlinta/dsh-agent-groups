# Codebase navigation

Use this skill when the requested change is described in product terms and the owning source boundary is not obvious.

## Goal

Find the smallest first entry before reading or editing large orchestration files.

## Procedure

1. Read `packages/host/src/README.md`.
2. Map the request to one owning boundary: domain service, runtime provider, Create Flow, native client, web API, persistence, or profiles.
3. Read the first-entry file plus at most one layer of direct callers/callees before broadening the search.
4. If the task touches process/session/turn/task lifetime, verification, recovery, credentials, or communication policy, also read `docs/architecture.md` and keep the root `AGENTS.md` invariants active.
5. Prefer adding behavior to the owning module instead of extending `group-host.ts` simply because it is central.

## Useful maps

- Host source map: `packages/host/src/README.md`
- Create Flow map: `packages/host/src/create-flow/README.md`
- Documentation index: `docs/README.md`
- Product architecture: `docs/architecture.md`

## Stop conditions

Do not keep scanning the repository once the owning module and its contract are identified. Move to the smallest relevant test or implementation path.
