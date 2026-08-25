# Create Flow

Create Flow is the content-production specialization of DSH Agent Groups.

It deliberately reuses the existing durable Agent Groups runtime instead of introducing a second orchestrator. A Create Flow group therefore keeps the same long-lived member identities, provider sessions, task attempts, channel history, workspace state, runtime recovery and verification semantics as any other group.

## Production team

The built-in `content-team` template is presented as **Create Flow** and materializes three persistent production roles:

1. **Topic Strategist** — explores candidate subjects and selects a viable angle.
2. **Researcher** — gathers and organizes evidence for the approved direction.
3. **Scriptwriter** — turns the approved direction and evidence into a production-ready script.

The Leader is presented as **Create Flow Lead** and remains the authority for task assignment, stage transitions and final verification.

## Why this is a specialization, not a new runtime

The useful boundary already exists in Agent Groups:

- Group = one durable production workspace.
- Member = one long-lived teammate identity.
- Runtime Session = the provider conversation that can survive multiple tasks and follow-ups.
- Task / Task Attempt = the work item and each execution attempt.
- Workspace / artifacts / activity = shared production state and audit trail.

Create Flow changes the domain vocabulary and default team composition while preserving those lifecycle guarantees.

## MVP workflow

The first working slice intentionally stays small:

`Topic selection -> Research -> Script`

A production run should keep evidence and deliverables in the existing task/artifact surfaces rather than passing opaque one-shot text between agents. The next domain layer can add first-class stage records, structured topic candidates, research-source objects and script versions without changing the runtime/session model.

## Planned next layer

The next implementation step is a Create Flow lens in the native workspace that projects existing group/task data into three production columns and exposes stage-specific artifacts. Later stages can be appended, for example storyboard, asset collection, edit and publish, without changing the durable member/runtime design.
