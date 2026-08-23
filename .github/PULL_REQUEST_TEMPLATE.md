## What changed

<!-- Describe the smallest user/runtime behavior this PR changes. -->

## Why

<!-- What was incorrect, missing, or hard to use before? -->

## Invariants / provider semantics

<!-- For runtime/state-machine changes, state the invariant that must remain true. -->

- [ ] This PR does not conflate process / session / turn / task lifetime.
- [ ] Active and queued work remain distinguishable.
- [ ] Unsupported provider behavior is surfaced truthfully rather than silently emulated.
- [ ] No credentials or secret-bearing payloads are persisted or logged.
- [ ] Not applicable (documentation / non-runtime change).

## Validation

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `node --check packages/host/lib/client.js`
- [ ] Relevant real-runtime / integration path tested, or limitation explained below

### Runtime / compatibility checked

<!-- Example: DSH 0.1.0-rc.6; Codex app-server x.y; Claude Agent SDK x.y -->

## UI / screenshots

<!-- Required for visible UI changes when practical. -->

## Known limitations

<!-- State anything that was not verified or intentionally remains unsupported. -->
