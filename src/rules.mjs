export function reviewedFinding(finding, text, decision, actor, now) {
  const changed = text.trim() !== finding.edited_text;
  return {...finding, edited_text:text.trim(), decision:changed ? 'pending' : decision,
    revision:finding.revision + 1, reviewer_id:changed || decision === 'pending' ? null : actor,
    reviewed_at:changed || decision === 'pending' ? null : now};
}
export function reportSnapshot(project, findings, sources) {
  const approved = findings.filter(f => f.project_id === project.id && f.decision === 'accepted');
  const sourceIds = new Set(approved.map(f => f.source_id));
  return structuredClone({project,findings:approved,sources:sources.filter(s => sourceIds.has(s.id)),
    limitations:['Only human-approved findings are included. Missing information means insufficient evidence, not absence of competitor activity.', ...project.errors]});
}
