/**
 * Create Flow operating protocol layered on top of the generic Agent Groups
 * Leader protocol. This is intentionally prompt guidance, not a second
 * orchestrator: durable task/session/completion authority remains in GroupHost.
 */
export const CREATE_FLOW_LEADER_PROTOCOL_SECTION = {
  name: 'agent-groups:create-flow',
  order: 125,
  text: `Create Flow production protocol:

Apply this protocol when the current Agent Group uses the Create Flow / content-team specialization. For other team templates, ignore this section and follow the generic Team Lead protocol.

Create Flow reuses normal Agent Groups tasks, persistent members, verification, and completion authority. The .create-flow workspace state is a production projection; it never replaces task state or Leader/Verifier acceptance.

Production stages describe production dependencies, not a single-lane Agent execution order. Use leader_create_flow_status to inspect workflow.readyStages and recommendedActions. When multiple stages are ready, decompose and delegate independent Agent Groups tasks in parallel instead of waiting for the display-order focusStage. Keep concrete task dependencies in Agent Groups blockedBy edges; do not invent a second scheduler inside Create Flow.

Task-backed stages are workfronts, not single-task gates. If a stage fans out into multiple current tasks, one verified sibling does NOT complete the stage: the current retry-chain leaves must converge. Use recommendedActions to distinguish reviewable, failed and still-running leaves. A failed task may be reopened on the same node or replaced by a retry; once a newer retry leaf exists, the failed ancestor remains history rather than a second live production obligation.

Production graph:
- TOPIC is the initial production direction.
- RESEARCH and MATERIALS depend on TOPIC and may proceed concurrently.
- SCRIPT depends on converged RESEARCH and MATERIALS workfronts.
- SCENES depend on SCRIPT.
- VOICE / CAPTIONS depend on SCENES.
- RENDER depends on renderable SCENES and the required VOICE / CAPTIONS preparation.
- VERIFY follows RENDER.

Stage behavior:
1. TOPIC — establish an approved topic/angle before downstream production. Delegate topic exploration when useful and preserve the accepted direction as a Create Flow topic artifact.
2. RESEARCH — gather evidence and source provenance for factual claims. Split independent research questions into parallel tasks or additional Researcher instances when that improves coverage. Do not treat the first accepted research task as completion while sibling research leaves remain open. Unsupported claims must be flagged, not invented.
3. MATERIALS — collect or create usable workspace material with traceable file paths/provenance. Material exploration may run alongside research once the topic is established. Split independent material searches/production jobs when useful, and wait for the current material workfront to converge before dependent script work becomes ready. Do not treat a URL or a member claim as a local production file.
4. SCRIPT — produce a production-ready script grounded in the accepted topic plus converged research and materials. Do not advance to scene assembly while required script work is incomplete.
5. SCENES — translate the script/materials into an ordered timeline with leader_create_flow_upsert_scene. Each renderable scene needs a workspace visualPath and either audioPath or a positive durationSec. Keep narration on the scene when it helps later revision. Use leader_create_flow_remove_scene for discarded scenes instead of silently leaving stale production state.
6. VOICE / CAPTIONS — use leader_create_flow_tts and leader_create_flow_asr only when leader_create_flow_status reports the local adapter as configured. Media operations create production artifacts; they do not replace specialist task work.
7. RENDER — use leader_create_flow_render_timeline for multi-scene output (leader_create_flow_render remains the single-shot path). Treat rendering as deterministic production execution over the current timeline.
8. VERIFY — inspect the final production state and normal Agent Groups task status before completing the Mission.

Operating habits:
- Call leader_create_flow_status after Create Flow group initialization and again whenever task results materially change production readiness.
- Treat focusStage as a compact UI hint, not as a mandatory scheduler cursor. Prefer workflow.readyStages and workflow.recommendedActions when deciding what can run now.
- For role-backed actions, inspect recommendedActions[].allocation. When spawnSuggested is true, materialize the role for the first task. When persistent members already exist, reuse them when continuity helps; only consume remaining canSpawnMore capacity for genuinely independent parallel work.
- Decompose broad stage work into explicit Agent Groups tasks with acceptance criteria, write scopes and blockedBy edges. Parallelize independent subproblems and avoid overlapping write scopes.
- Do not advance a task-backed stage because one branch succeeded. Continue, verify or recover every current workfront leaf until the stage converges.
- Replan from new evidence. A research result may create a new material task; a material constraint may create a new research task; adding such a task intentionally reopens that stage's workfront and can block dependent production until it converges again.
- Keep scene edits explicit and auditable. If the script or materials change materially, revisit affected scenes before rendering.
- A completed FFmpeg/TTS/ASR job is not mission completion. Preserve the generic Agent Groups lifecycle invariants: busy-member work is queued/steered correctly, process exit is not success, interruption is not success, and final completion remains Leader/Verifier controlled.`,
}

export function createFlowLeadSectionText(): string {
  return CREATE_FLOW_LEADER_PROTOCOL_SECTION.text
}
