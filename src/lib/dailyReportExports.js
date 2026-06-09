export function dailyExportYesNo(value) {
  return value === false ? 'no' : 'yes';
}

export function dailyReportSourceLabel(value) {
  return value === 'add_feed_webform' ? 'Add Feed' : 'Daily Report';
}

export function dailyPhotoCount(row) {
  return Array.isArray(row.photos) ? row.photos.length : 0;
}

export function dailyFeedSummary(row) {
  return Array.isArray(row.feeds)
    ? row.feeds
        .map((feed) => (feed.feed_name || '?') + (feed.qty != null ? ' ' + feed.qty + ' ' + (feed.unit || '') : ''))
        .join(', ')
    : '';
}

export function dailyMineralSummary(row) {
  return Array.isArray(row.minerals)
    ? row.minerals
        .map((mineral) => {
          const parts = [mineral.name || '?'];
          if (mineral.lbs != null) parts.push(mineral.lbs + ' lb');
          return parts.join(' ');
        })
        .join(', ')
    : '';
}

export function dailyFeedLbsAsFed(row) {
  return Array.isArray(row.feeds)
    ? row.feeds.reduce((sum, feed) => sum + (parseFloat(feed.lbs_as_fed) || 0), 0).toFixed(2)
    : '';
}

export function dailyMineralLbs(row) {
  return Array.isArray(row.minerals)
    ? row.minerals.reduce((sum, mineral) => sum + (parseFloat(mineral.lbs) || 0), 0).toFixed(2)
    : '';
}

export function dailyHayBales(row) {
  return Array.isArray(row.feeds)
    ? row.feeds
        .reduce(
          (sum, feed) => sum + (feed.category === 'hay' && feed.unit === 'bale' ? parseFloat(feed.qty) || 0 : 0),
          0,
        )
        .toFixed(2)
    : '';
}

export function isDefaultSentinelComment(value) {
  if (value == null) return true;
  const text = String(value).trim().toLowerCase();
  return text === '' || text === 'none' || text === '0' || text === 'n/a' || text === 'na' || text === '-';
}

export function eggDailyTotalForRow(row) {
  return (
    (parseInt(row.group1_count) || 0) +
    (parseInt(row.group2_count) || 0) +
    (parseInt(row.group3_count) || 0) +
    (parseInt(row.group4_count) || 0)
  );
}

export function buildBroilerDailyExportColumns() {
  return [
    {header: 'Date', value: (row) => row.date || ''},
    {header: 'Broiler group', value: (row) => row.batch_label || ''},
    {header: 'Team member', value: (row) => row.team_member || ''},
    {header: 'Source', value: (row) => dailyReportSourceLabel(row.source)},
    {header: 'Feed type', value: (row) => row.feed_type || ''},
    {header: 'Feed lbs', value: (row) => row.feed_lbs ?? ''},
    {header: 'Grit lbs', value: (row) => row.grit_lbs ?? ''},
    {header: 'Mortality count', value: (row) => row.mortality_count ?? ''},
    {header: 'Mortality reason', value: (row) => row.mortality_reason || ''},
    {header: 'Group moved', value: (row) => dailyExportYesNo(row.group_moved)},
    {header: 'Waterer checked', value: (row) => dailyExportYesNo(row.waterer_checked)},
    {header: 'Comments', value: (row) => row.comments || ''},
    {header: 'Photo count', value: dailyPhotoCount},
    {header: 'Record ID', value: (row) => row.id || ''},
  ];
}

export function buildPigDailyExportColumns() {
  return [
    {header: 'Date', value: (row) => row.date || ''},
    {header: 'Pig group', value: (row) => row.batch_label || ''},
    {header: 'Team member', value: (row) => row.team_member || ''},
    {header: 'Source', value: (row) => dailyReportSourceLabel(row.source)},
    {header: 'Feed lbs', value: (row) => row.feed_lbs ?? ''},
    {header: 'Pig count', value: (row) => row.pig_count ?? ''},
    {header: 'Fence voltage', value: (row) => row.fence_voltage ?? ''},
    {header: 'Group moved', value: (row) => dailyExportYesNo(row.group_moved)},
    {header: 'Nipple drinker moved', value: (row) => dailyExportYesNo(row.nipple_drinker_moved)},
    {header: 'Nipple drinker working', value: (row) => dailyExportYesNo(row.nipple_drinker_working)},
    {header: 'Troughs moved', value: (row) => dailyExportYesNo(row.troughs_moved)},
    {header: 'Fence walked', value: (row) => dailyExportYesNo(row.fence_walked)},
    {header: 'Issues', value: (row) => row.issues || ''},
    {header: 'Photo count', value: dailyPhotoCount},
    {header: 'Record ID', value: (row) => row.id || ''},
  ];
}

export function buildCattleDailyExportColumns({herdLabels = {}} = {}) {
  return [
    {header: 'Date', value: (row) => row.date || ''},
    {header: 'Herd', value: (row) => herdLabels[row.herd] || row.herd || ''},
    {header: 'Team member', value: (row) => row.team_member || ''},
    {header: 'Source', value: (row) => dailyReportSourceLabel(row.source)},
    {header: 'Feed summary', value: dailyFeedSummary},
    {header: 'Feed lbs as fed', value: dailyFeedLbsAsFed},
    {header: 'Mineral summary', value: dailyMineralSummary},
    {header: 'Mineral lbs', value: dailyMineralLbs},
    {header: 'Fence voltage', value: (row) => row.fence_voltage ?? ''},
    {header: 'Water checked', value: (row) => dailyExportYesNo(row.water_checked)},
    {header: 'Mortality count', value: (row) => row.mortality_count ?? ''},
    {header: 'Mortality reason', value: (row) => row.mortality_reason || ''},
    {header: 'Issues', value: (row) => row.issues || ''},
    {header: 'Photo count', value: dailyPhotoCount},
    {header: 'Record ID', value: (row) => row.id || ''},
  ];
}

export function buildSheepDailyExportColumns({flockLabels = {}, isSentinelComment = isDefaultSentinelComment} = {}) {
  return [
    {header: 'Date', value: (row) => row.date || ''},
    {header: 'Flock', value: (row) => flockLabels[row.flock] || row.flock || ''},
    {header: 'Team member', value: (row) => row.team_member || ''},
    {header: 'Source', value: (row) => dailyReportSourceLabel(row.source)},
    {header: 'Feed summary', value: dailyFeedSummary},
    {header: 'Feed lbs as fed', value: dailyFeedLbsAsFed},
    {header: 'Hay bales', value: dailyHayBales},
    {header: 'Mineral summary', value: dailyMineralSummary},
    {header: 'Mineral lbs', value: dailyMineralLbs},
    {header: 'Fence voltage kV', value: (row) => row.fence_voltage_kv ?? ''},
    {header: 'Waterers working', value: (row) => dailyExportYesNo(row.waterers_working)},
    {header: 'Mortality count', value: (row) => row.mortality_count ?? ''},
    {header: 'Comments', value: (row) => (isSentinelComment(row.comments) ? '' : row.comments || '')},
    {header: 'Photo count', value: dailyPhotoCount},
    {header: 'Record ID', value: (row) => row.id || ''},
  ];
}

export function buildLayerDailyExportColumns() {
  return [
    {header: 'Date', value: (row) => row.date || ''},
    {header: 'Layer group', value: (row) => row.batch_label || ''},
    {header: 'Team member', value: (row) => row.team_member || ''},
    {header: 'Source', value: (row) => dailyReportSourceLabel(row.source)},
    {header: 'Feed type', value: (row) => row.feed_type || ''},
    {header: 'Feed lbs', value: (row) => row.feed_lbs ?? ''},
    {header: 'Grit lbs', value: (row) => row.grit_lbs ?? ''},
    {header: 'Layer count', value: (row) => row.layer_count ?? ''},
    {header: 'Group moved', value: (row) => dailyExportYesNo(row.group_moved)},
    {header: 'Waterer checked', value: (row) => dailyExportYesNo(row.waterer_checked)},
    {header: 'Mortality count', value: (row) => row.mortality_count ?? ''},
    {header: 'Mortality reason', value: (row) => row.mortality_reason || ''},
    {header: 'Comments', value: (row) => row.comments || ''},
    {header: 'Photo count', value: dailyPhotoCount},
    {header: 'Record ID', value: (row) => row.id || ''},
  ];
}

export function buildEggDailyExportColumns() {
  return [
    {header: 'Date', value: (row) => row.date || ''},
    {header: 'Team member', value: (row) => row.team_member || ''},
    {header: 'Group 1 name', value: (row) => row.group1_name || ''},
    {header: 'Group 1 eggs', value: (row) => row.group1_count ?? ''},
    {header: 'Group 2 name', value: (row) => row.group2_name || ''},
    {header: 'Group 2 eggs', value: (row) => row.group2_count ?? ''},
    {header: 'Group 3 name', value: (row) => row.group3_name || ''},
    {header: 'Group 3 eggs', value: (row) => row.group3_count ?? ''},
    {header: 'Group 4 name', value: (row) => row.group4_name || ''},
    {header: 'Group 4 eggs', value: (row) => row.group4_count ?? ''},
    {header: 'Total eggs', value: eggDailyTotalForRow},
    {header: 'Daily dozens', value: (row) => row.daily_dozen_count ?? ''},
    {header: 'Dozens on hand', value: (row) => row.dozens_on_hand ?? ''},
    {header: 'Comments', value: (row) => row.comments || ''},
    {header: 'Record ID', value: (row) => row.id || ''},
  ];
}
