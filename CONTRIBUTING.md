# Contributing

Thanks for helping improve DSH Agent Groups.

The project is still evolving quickly, so focused changes with clear regression coverage are easier to review and safer to merge than broad rewrites.

## Before you start

Read:

- [README](README.md) for the current product surface
- [Architecture](docs/architecture.md) for lifecycle invariants
- [Development guide](docs/development.md) for setup and validation
- [AGENTS.md](AGENTS.md) if you are using a coding agent

For larger behavioral changes, opening an issue or a small design PR first is preferred so runtime semantics can be agreed before implementation spreads across providers and UI.

## Development setup

```bash
cd packages/host
npm install
cd ../..

npm run typecheck
npm test
npm run build
```

The project currently verifies CI against DeepSeek Harness `0.1.0-rc.6`. If your change targets another DSH release, include the exact version and what you verified.

## Pull requests

A good pull request should explain:

- the user/runtime behavior being changed;
- why the current behavior is incorrect or insufficient;
- the invariant that must remain true;
- regression tests added or updated;
- local/real-runtime validation performed;
- any known limitations or provider differences.

Keep unrelated formatting/refactors out of behavior fixes when possible.

## Runtime/provider changes

Runtime work is state-machine work. Tests should cover race/failure paths, not only successful output.

Pay particular attention to:

- task/turn correlation;
- active vs queued work;
- reconnect/resume behavior;
- interruption;
- approvals/input;
- provider crashes and malformed messages;
- late events;
- persistence/restart reconciliation;
- safe handling of credentials.

Do not make unsupported provider behavior look supported in the shared abstraction. For example, if a provider cannot steer an active request, surface truthful queued-next-turn semantics instead.

## UI changes

Agent Groups is a native DSH client plugin. UI changes should retain the DSH shell and use existing primitives/theme tokens where possible.

When changing integration slots or shell-static dependencies, document the DSH version you inspected.

## Documentation

Keep `README.md` concise and product-facing. Put deeper engineering material under `docs/` and link it from the documentation index.

Avoid duplicating historical V0.x changelogs in the README; Git history and pull requests are the source of truth for implementation history.

## Validation checklist

Before opening a PR:

```bash
npm run typecheck
npm test
npm run build
node --check packages/host/lib/client.js
```

Then run the narrowest relevant integration/demo path. If any validation cannot run because it requires local credentials or a real provider binary, state that explicitly in the PR.
