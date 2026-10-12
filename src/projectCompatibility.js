export function getProjectCompatibilityLabel(project, studentSkills) {
  const requiredSkillIds = [...new Set(
    (project.requiredSkills ?? [])
      .map((skill) => skill.id)
      .filter((skillId) => skillId !== null && skillId !== undefined)
      .map(String),
  )]
  const studentSkillIds = new Set(
    (studentSkills ?? [])
      .map((skill) => skill.skillId)
      .filter((skillId) => skillId !== null && skillId !== undefined)
      .map(String),
  )
  if (requiredSkillIds.length === 0 || studentSkillIds.size === 0) {
    return 'Not enough skill data'
  }

  const matchedCount = requiredSkillIds.filter((skillId) => studentSkillIds.has(skillId)).length
  return `${Math.round(matchedCount * 100 / requiredSkillIds.length)}% compatible`
}
