import { describe, expect, it } from 'vitest'
import { CREATE_FLOW_LEADER_PROTOCOL_SECTION, createFlowLeadSectionText } from '../src/create-flow/leader-prompt.js'

describe('Create Flow Leader protocol', () => {
  it('keeps production stages subordinate to Agent Groups verification', () => {
    const text = createFlowLeadSectionText()

    expect(CREATE_FLOW_LEADER_PROTOCOL_SECTION.name).toBe('agent-groups:create-flow')
    expect(text).toContain('leader_create_flow_status')
    expect(text).toContain('leader_create_flow_upsert_scene')
    expect(text).toContain('leader_create_flow_render_timeline')
    expect(text).toContain('A completed FFmpeg/TTS/ASR job is not mission completion')
    expect(text).toContain('Leader/Verifier')
  })

  it('describes the ordered production gates', () => {
    const text = createFlowLeadSectionText()

    for (const stage of ['TOPIC', 'RESEARCH', 'MATERIALS', 'SCRIPT', 'SCENES', 'VOICE / CAPTIONS', 'RENDER', 'VERIFY']) {
      expect(text).toContain(stage)
    }
  })
})
