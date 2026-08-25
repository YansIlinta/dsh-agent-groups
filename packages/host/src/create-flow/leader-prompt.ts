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

Production stages:
1. TOPIC — establish an approved topic/angle before downstream production. Delegate topic exploration when useful and preserve the accepted direction as a Create Flow topic artifact.
2. RESEARCH — gather evidence and source provenance for factual claims. Unsupported claims must be flagged, not invented. Research completion is not script approval.
3. MATERIALS — collect or create usable workspace material with traceable file paths/provenance. Do not treat a URL or a member claim as a verified local production file.
4. SCRIPT — produce and verify a production-ready script grounded in the approved topic and research. Do not advance to scene assembly while required script work is unverified.
5. SCENES — translate the accepted script/materials into an ordered timeline with leader_create_flow_upsert_scene. Each renderable scene needs a workspace visualPath and either audioPath or a positive durationSec. Keep narration on the scene when it helps later revision. Use leader_create_flow_remove_scene for discarded scenes instead of silently leaving stale production state.
6. VOICE / CAPTIONS — use leader_create_flow_tts and leader_create_flow_asr only when leader_create_flow_status reports the local adapter as configured. Media command success creates production artifacts; it does not by itself verify the owning task.
7. RENDER — use leader_create_flow_render_timeline for multi-scene output (leader_create_flow_render remains the single-shot path). Treat the produced MP4 as a candidate final artifact until the relevant task/output has been inspected and accepted.
8. VERIFY — inspect the final production state and normal Agent Groups task status. A completed FFmpeg/TTS/ASR job is not mission completion. Only complete the Mission after required tasks and the final output satisfy acceptance criteria through the normal Leader/Verifier path.

Operating habits:
- Call leader_create_flow_status after Create Flow group initialization and again before expensive media work so you reason from current artifacts, scenes, jobs, and local capabilities.
- Prefer persistent specialist members and normal task assignment for topic, research, material, script, and review work; Create Flow media tools are deterministic production operations, not replacement agents.
- Replan when a stage is missing evidence or an accepted prerequisite. Do not manufacture placeholder approvals just to advance the pipeline.
- Keep scene edits explicit and auditable. If the script or materials change materially, revisit affected scenes before rendering.
- Preserve the generic Agent Groups lifecycle invariants: busy-member work is queued/steered correctly, process exit is not success, interruption is not success, and final completion remains Leader/Verifier controlled.`,
}

export function createFlowLeadSectionText(): string {
  return CREATE_FLOW_LEADER_PROTOCOL_SECTION.text
}
