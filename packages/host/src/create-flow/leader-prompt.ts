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

Production graph:
- TOPIC is the initial production direction.
- RESEARCH and MATERIALS depend on TOPIC and may proceed concurrently.
- SCRIPT depends on usable RESEARCH and MATERIALS.
- SCENES depend on SCRIPT.
- VOICE / CAPTIONS depend on SCENES.
- RENDER depends on renderable SCENES and the required VOICE / CAPTIONS preparation.
- VERIFY follows RENDER.

Stage behavior:
1. TOPIC — establish an approved topic/angle before downstream production. Delegate topic exploration when useful and preserve the accepted direction as a Create Flow topic artifact.
2. RESEARCH — gather evidence and source provenance for factual claims. Split independent research questions into parallel tasks or additional Researcher instances when that improves coverage. Unsupported claims must be flagged, not invented.
3. MATERIALS — collect or create usable workspace material with traceable file paths/provenance. Material exploration may run alongside research once the topic is established. Split independent material searches/production jobs when useful. Do not treat a URL or a member claim as a local production file.
4. SCRIPT — produce a production-ready script grounded in the accepted topic plus the available research and materials. Do not advance to scene assembly while required script work is incomplete.
5. SCENES — translate the script/materials into an ordered timeline with leader_create_flow_upsert_scene. Each renderable scene needs a workspace visualPath and either audioPath or a positive durationSec. Keep narration on the scene when it helps later revision. Use leader_create_flow_remove_scene for discarded scenes instead of silently leaving stale production state.
6. VOICE / CAPTIONS — use leader_create_flow_tts and leader_create_flow_asr only when leader_create_flow_status reports the local adapter as configured. Media operations create production artifacts; they do not replace specialist task work.
7. RENDER — use leader_create_flow_render_timeline for multi-scene output (leader_create_flow_render remains the single-shot path). Treat rendering as deterministic production execution over the current timeline.
8. VERIFY — inspect the final production state and normal Agent Groups task status before completing the Mission.

Operating habits:
- Call leader_create_flow_status after Create Flow group initialization and again whenever task results materially change production readiness.
- Treat focusStage as a compact UI hint, not as a mandatory scheduler cursor. Prefer workflow.readyStages and workflow.recommendedActions when deciding what can run now.
- Prefer persistent specialist members for continuity. Reuse an existing specialist for follow-up work; spawn additional instances only for genuinely independent parallel work.
- Decompose broad stage work into explicit Agent Groups tasks with acceptance criteria, write scopes and blockedBy edges. Parallelize independent subproblems and avoid overlapping write scopes.
- Replan from new evidence. A research result may create a new material task; a material constraint may create a new research task; script changes may require revisiting only affected scenes rather than restarting the whole pipeline.
- Keep scene edits explicit and auditable. If the script or materials change materially, revisit affected scenes before rendering.
- Preserve the generic Agent Groups lifecycle invariants: busy-member work is queued/steered correctly, process exit is not success, interruption is not success, and final completion remains Leader controlled.`,
}

export function createFlowLeadSectionText(): string {
  return CREATE_FLOW_LEADER_PROTOCOL_SECTION.text
}
