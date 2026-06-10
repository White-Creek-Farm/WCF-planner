function text(value) {
  if (value == null) return '';
  return String(value);
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : '';
}

function rounded(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return Math.round(n * 10 ** digits) / 10 ** digits;
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return '$' + n.toFixed(2);
}

function dateValue(fmt, value) {
  if (!value) return '';
  return typeof fmt === 'function' ? fmt(value) : value;
}

export function buildActivityLogExportColumns({entityTypeLabels = {}, eventTypeLabels = {}} = {}) {
  return [
    {header: 'Created at', value: (r) => r.created_at || ''},
    {header: 'Actor', value: (r) => r.actor_display_name || ''},
    {header: 'Event', value: (r) => eventTypeLabels[r.event_type] || r.event_type || ''},
    {header: 'Entity type', value: (r) => entityTypeLabels[r.entity_type] || r.entity_type || ''},
    {header: 'Entity label', value: (r) => r.entity_label || r.entity_id || ''},
    {header: 'Body', value: (r) => (r.deleted_at ? '(comment deleted)' : r.body || '')},
    {
      header: 'Mentions',
      value: (r) =>
        Array.isArray(r.mentioned_profile_names) ? r.mentioned_profile_names.filter(Boolean).join(', ') : '',
    },
    {header: 'Record ID', value: (r) => r.id || ''},
  ];
}

export function buildEquipmentFleetExportColumns({fmt, fmtReading} = {}) {
  return [
    {header: 'Equipment name', value: (r) => r.name || ''},
    {header: 'Category', value: (r) => r.category || ''},
    {header: 'Status', value: (r) => r.status || ''},
    {header: 'Fuel type', value: (r) => r.fuel_type || ''},
    {header: 'Tracking unit', value: (r) => r.tracking_unit || ''},
    {
      header: 'Current reading',
      value: (r) =>
        typeof fmtReading === 'function'
          ? fmtReading(r.current_reading, r.tracking_unit)
          : r.current_reading != null
            ? r.current_reading
            : '',
    },
    {header: 'Last fueling date', value: (r) => dateValue(fmt, r.last_fueling_date)},
    {header: 'Serial number', value: (r) => r.serial_number || ''},
    {header: 'Record ID', value: (r) => r.id || ''},
  ];
}

export function buildProcessingBatchExportColumns({fmt, animalLabel = 'Animal'} = {}) {
  return [
    {header: 'Batch', value: (r) => r.name || ''},
    {header: 'Status', value: (r) => r.status || ''},
    {header: 'Planned process date', value: (r) => dateValue(fmt, r.planned_process_date)},
    {header: 'Actual process date', value: (r) => dateValue(fmt, r.actual_process_date)},
    {header: animalLabel + ' count', value: (r) => number(r.animal_count)},
    {header: 'Total live weight', value: (r) => rounded(r.total_live_weight, 1)},
    {header: 'Total hanging weight', value: (r) => rounded(r.total_hanging_weight, 1)},
    {header: 'Yield %', value: (r) => rounded(r.yield_pct, 1)},
    {header: 'Notes', value: (r) => r.notes || ''},
    {header: 'Record ID', value: (r) => r.id || ''},
  ];
}

export function buildBroilerBatchExportColumns({fmt} = {}) {
  return [
    {header: 'Batch', value: (r) => r.name || ''},
    {header: 'Status', value: (r) => r.export_status || r.status || ''},
    {header: 'Breed', value: (r) => r.breed || ''},
    {header: 'Hatchery', value: (r) => r.hatchery || ''},
    {header: 'Hatch date', value: (r) => dateValue(fmt, r.hatchDate)},
    {header: 'Processing date', value: (r) => dateValue(fmt, r.processingDate)},
    {header: 'Time on farm', value: (r) => r.time_on_farm || ''},
    {header: 'Schooner', value: (r) => r.schooner || ''},
    {header: 'Birds ordered', value: (r) => number(r.birdCount)},
    {header: 'Birds arrived', value: (r) => number(r.birdCountActual)},
    {header: 'To processor', value: (r) => number(r.totalToProcessor)},
    {header: 'Mortality', value: (r) => number(r.export_mortality)},
    {header: 'Starter feed lbs', value: (r) => rounded(r.export_starter_lbs, 1)},
    {header: 'Grower feed lbs', value: (r) => rounded(r.export_grower_lbs, 1)},
    {header: 'Total feed lbs', value: (r) => rounded(r.export_total_feed_lbs, 1)},
    {header: 'Feed per processed bird', value: (r) => rounded(r.export_feed_per_processed_bird, 2)},
    {header: 'Avg dressed lbs', value: (r) => rounded(r.avgDressedLbs, 2)},
    {header: 'Record ID', value: (r) => r.id || ''},
  ];
}

export function buildLayerBatchExportColumns({fmt} = {}) {
  return [
    {header: 'Batch', value: (r) => r.name || ''},
    {header: 'Status', value: (r) => r.status || ''},
    {header: 'Arrival date', value: (r) => dateValue(fmt, r.arrival_date)},
    {header: 'Active housings', value: (r) => r.active_housing_names || ''},
    {header: 'Current hens', value: (r) => number(r.current_hens)},
    {header: 'Feed lbs', value: (r) => rounded(r.total_feed_lbs, 1)},
    {header: 'Mortality', value: (r) => number(r.total_mortality)},
    {header: 'Dozens', value: (r) => number(r.total_dozens)},
    {header: 'Feed cost', value: (r) => money(r.feed_cost)},
    {header: 'Record ID', value: (r) => r.id || ''},
  ];
}

export function buildPigBatchExportColumns({fmt} = {}) {
  return [
    {header: 'Batch', value: (r) => r.batchName || ''},
    {header: 'Status', value: (r) => r.status || ''},
    {header: 'Start date', value: (r) => dateValue(fmt, r.startDate)},
    {header: 'Started Head', value: (r) => number(r.started_head)},
    {header: 'Current Head', value: (r) => number(r.current_head)},
    {header: 'Total Feed', value: (r) => rounded(r.total_feed_lbs, 1)},
    {header: 'Feed / Pig', value: (r) => rounded(r.feed_per_pig, 1)},
    {header: 'Gilts Started', value: (r) => number(r.gilts_started)},
    {header: 'Gilts Current', value: (r) => number(r.gilts_current)},
    {header: 'Gilts Total Feed', value: (r) => rounded(r.gilts_total_feed_lbs, 1)},
    {header: 'Gilts Feed / Pig', value: (r) => rounded(r.gilts_feed_per_pig, 1)},
    {header: 'Boars Started', value: (r) => number(r.boars_started)},
    {header: 'Boars Current', value: (r) => number(r.boars_current)},
    {header: 'Boars Total Feed', value: (r) => rounded(r.boars_total_feed_lbs, 1)},
    {header: 'Boars Feed / Pig', value: (r) => rounded(r.boars_feed_per_pig, 1)},
    {header: 'Cycle', value: (r) => text(r.cycle_label)},
    {header: 'Record ID', value: (r) => r.id || ''},
  ];
}
