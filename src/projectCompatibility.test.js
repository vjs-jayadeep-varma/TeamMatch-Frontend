import { describe, expect, it } from 'vitest'
import { getProjectCompatibilityLabel } from './projectCompatibility.js'

describe('project compatibility', () => {
  it('scores full skill overlap as 100 percent', () => {
    expect(getProjectCompatibilityLabel(
      { requiredSkills: [{ id: 1 }, { id: 2 }] },
      [{ skillId: 1 }, { skillId: 2 }],
    )).toBe('100% compatible')
  })

  it('rounds partial skill overlap to a whole percent', () => {
    expect(getProjectCompatibilityLabel(
      { requiredSkills: [{ id: 1 }, { id: 2 }, { id: 3 }] },
      [{ skillId: 1 }],
    )).toBe('33% compatible')
  })

  it('shows zero percent when skill data exists but there is no overlap', () => {
    expect(getProjectCompatibilityLabel(
      { requiredSkills: [{ id: 1 }, { id: 2 }] },
      [{ skillId: 3 }],
    )).toBe('0% compatible')
  })

  it('counts duplicate required skills only once by skill identity', () => {
    expect(getProjectCompatibilityLabel(
      { requiredSkills: [{ id: 1 }, { id: 1 }, { id: 2 }] },
      [{ skillId: 1 }],
    )).toBe('50% compatible')
  })

  it('does not fabricate a score when there are no required skills', () => {
    expect(getProjectCompatibilityLabel({ requiredSkills: [] }, [{ skillId: 1 }]))
      .toBe('Not enough skill data')
  })

  it('does not fabricate a score when the student has no persisted skills', () => {
    expect(getProjectCompatibilityLabel({ requiredSkills: [{ id: 1 }] }, []))
      .toBe('Not enough skill data')
  })

  it('recalculates from updated student skills or project requirements', () => {
    const project = { requiredSkills: [{ id: 1 }, { id: 2 }] }
    expect(getProjectCompatibilityLabel(project, [{ skillId: 1 }])).toBe('50% compatible')
    expect(getProjectCompatibilityLabel(project, [{ skillId: 1 }, { skillId: 2 }]))
      .toBe('100% compatible')
    expect(getProjectCompatibilityLabel(
      { requiredSkills: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] },
      [{ skillId: 1 }, { skillId: 2 }],
    )).toBe('50% compatible')
  })
})
