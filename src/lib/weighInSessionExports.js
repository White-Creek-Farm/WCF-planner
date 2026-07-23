export function roundToHundredths(value) {
  return Math.round(value * 100) / 100;
}

export function averageEntryWeight(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const average = entries.reduce((sum, entry) => sum + (parseFloat(entry.weight) || 0), 0) / entries.length;
  return roundToHundredths(average);
}

export function buildRuminantWeighInSessionColumns({
  groupHeader,
  groupLabels,
  entriesBySession,
  tagQ,
  entryMatchesTag,
}) {
  return [
    {header: 'Date', value: (session) => session.date || ''},
    {header: groupHeader, value: (session) => groupLabels[session.herd] || session.herd || ''},
    {header: 'Status', value: (session) => session.status || ''},
    {header: 'Team member', value: (session) => session.team_member || ''},
    {header: 'Entry count', value: (session) => (entriesBySession[session.id] || []).length},
    {
      header: 'Matching tag entries',
      value: (session) =>
        tagQ && typeof entryMatchesTag === 'function'
          ? (entriesBySession[session.id] || []).filter(entryMatchesTag).length
          : '',
    },
    {
      header: 'New tag count',
      value: (session) => (entriesBySession[session.id] || []).filter((entry) => entry.new_tag_flag).length,
    },
    {header: 'Started at', value: (session) => session.started_at || ''},
    {header: 'Session ID', value: (session) => session.id || ''},
  ];
}

export function buildLivestockWeighInSessionColumns({species, speciesLabel, entriesBySession}) {
  return [
    {header: 'Date', value: (session) => session.date || ''},
    {header: 'Species', value: () => speciesLabel},
    {header: 'Batch ID', value: (session) => session.batch_id || ''},
    {header: 'Broiler week', value: (session) => (species === 'broiler' ? session.broiler_week || '' : '')},
    {header: 'Status', value: (session) => session.status || ''},
    {header: 'Team member', value: (session) => session.team_member || ''},
    {header: 'Entry count', value: (session) => (entriesBySession[session.id] || []).length},
    {header: 'Average weight', value: (session) => averageEntryWeight(entriesBySession[session.id] || [])},
    {header: 'Started at', value: (session) => session.started_at || ''},
    {header: 'Session ID', value: (session) => session.id || ''},
  ];
}
