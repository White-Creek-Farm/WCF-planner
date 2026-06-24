// Shared To Do List — the To Do side of the Task Center toggle.
//
// Three fixed sections (General / Chicken & Pigs / Cattle & Sheep) with
// manual priority order, a persisted section filter (All + each section), a
// manager-only Pending-approval filter, whole-row open into the
// /tasks/todo/<id> record page, photo thumbnails, an Awaiting-approval badge
// for non-manager completions, and a collapsed Completed section at the
// bottom (kept forever, newest first). converted/removed items never render
// here by design.
//
// Manager controls (management/admin): HTML5 drag within a section
// (EquipmentWebformsAdmin pattern), explicit ▲/▼ move buttons (the
// touch/mobile path), a move-to-section select, Approve / Reject on pending
// items, Convert-to-Task, and Remove (typed DeleteModal confirm). All
// permission checks are server-enforced by the mig 115 RPCs; the UI only
// hides what a role cannot do.

import React from 'react';
import {useNavigate} from 'react-router-dom';
import InlineNotice from '../shared/InlineNotice.jsx';
import DeleteModal from '../shared/DeleteModal.jsx';
import {openableProps} from '../shared/openable.js';
import {fmt, centralISOFor} from '../lib/dateUtils.js';
import {loadTaskAssignableProfilesById} from '../lib/tasksCenterApi.js';
import {
  TODO_SECTIONS,
  TODO_CHANGE_EVENT,
  todoSectionLabel,
  isTodoManager,
  listTodoItems,
  approveTodoCompletion,
  reorderTodoItems,
  moveTodoItem,
  removeTodoItem,
  readTodoSectionFilter,
  writeTodoSectionFilter,
  formatDaysSinceListed,
  fireTodoChangeEvent,
  friendlyTodoError,
} from '../lib/todoApi.js';
import TodoPhotoThumbs from './TodoPhotoThumbs.jsx';
import NewTodoModal from './NewTodoModal.jsx';
import TodoCompleteModal from './TodoCompleteModal.jsx';
import TodoRejectModal from './TodoRejectModal.jsx';
import ConvertTodoModal from './ConvertTodoModal.jsx';
import TodoHowTo from './TodoHowTo.jsx';

const CHIP_BASE = {
  padding: '7px 14px',
  borderRadius: 999,
  border: '1px solid var(--border-strong)',
  background: 'white',
  color: '#000000',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  fontFamily: 'inherit',
};
const CHIP_ACTIVE = {
  ...CHIP_BASE,
  border: '1px solid #085041',
  background: '#085041',
  color: '#ffffff',
};
const SMALL_BTN = {
  padding: '6px 10px',
  borderRadius: 10,
  border: '1px solid var(--border-strong)',
  background: 'white',
  color: 'var(--ink)',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
  fontFamily: 'inherit',
};
const PRIMARY_SMALL_BTN = {
  ...SMALL_BTN,
  border: '1px solid #085041',
  background: '#085041',
  color: 'white',
};
const PENDING_BADGE = {
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 999,
  background: '#fef3c7',
  border: '1px solid #fde68a',
  color: '#92400e',
  fontSize: 11,
  fontWeight: 700,
};

function dueCue(item, todayStr) {
  if (!item.due_date) return null;
  const overdue = todayStr && item.due_date < todayStr;
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: overdue ? '#b45309' : '#6b7280',
        border: `1px solid ${overdue ? '#fde68a' : '#e5e7eb'}`,
        background: overdue ? '#fffbeb' : '#f9fafb',
        borderRadius: 999,
        padding: '2px 8px',
      }}
    >
      Due {fmt(item.due_date)}
    </span>
  );
}

function TodoRow({
  sb,
  item,
  index,
  sectionCount,
  todayStr,
  canManage,
  dragging,
  dragOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onOpen,
  onComplete,
  onApprove,
  onReject,
  onConvert,
  onRemove,
  onMoveUp,
  onMoveDown,
  onMoveSection,
}) {
  const pending = item.status === 'pending_approval';
  return (
    <div
      className="hoverable-tile"
      data-todo-row={item.id}
      {...openableProps(onOpen)}
      aria-label={`Open to do: ${item.title}`}
      draggable={canManage}
      onDragStart={canManage ? onDragStart : undefined}
      onDragOver={canManage ? onDragOver : undefined}
      onDrop={canManage ? onDrop : undefined}
      onDragEnd={canManage ? onDragEnd : undefined}
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        background: dragOver ? '#fef3c7' : 'white',
        border: dragOver ? '1px dashed #f59e0b' : '1px solid var(--border)',
        borderRadius: 10,
        padding: '10px 12px',
        opacity: dragging ? 0.4 : 1,
      }}
    >
      {canManage ? (
        <span
          aria-hidden="true"
          title="Drag to reorder"
          style={{cursor: 'grab', color: 'var(--ink-faint)', fontSize: 15, lineHeight: '20px', userSelect: 'none'}}
          onClick={(e) => e.stopPropagation()}
        >
          ≡
        </span>
      ) : null}

      <div style={{flex: 1, minWidth: 0}}>
        <div style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap'}}>
          <span style={{fontSize: 14, fontWeight: 600, color: 'var(--ink)'}}>{item.title}</span>
          {pending ? (
            <span style={PENDING_BADGE} data-todo-pending-badge="1">
              Awaiting approval
            </span>
          ) : null}
          {dueCue(item, todayStr)}
        </div>
        {item.description ? (
          <div
            style={{
              fontSize: 13,
              color: 'var(--ink-muted)',
              marginTop: 2,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {item.description}
          </div>
        ) : null}
        <div style={{fontSize: 12, color: 'var(--ink-muted)', marginTop: 4}}>
          {item.created_by_name} · {formatDaysSinceListed(item.created_at)}
          {pending && item.completion_submitted_by_name
            ? ` · Done by ${item.completion_submitted_by_name}, needs manager sign-off`
            : ''}
        </div>
        {!pending && item.rejection_note ? (
          <div style={{fontSize: 12, color: '#b45309', marginTop: 2}} data-todo-rejected-cue="1">
            Sent back: {item.rejection_note}
          </div>
        ) : null}
        {Array.isArray(item.photos) && item.photos.length > 0 ? (
          <div style={{marginTop: 6}} onClick={(e) => e.stopPropagation()}>
            <TodoPhotoThumbs sb={sb} photos={item.photos} />
          </div>
        ) : null}
      </div>

      <div
        style={{display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end', flexShrink: 0}}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end'}}>
          {pending && canManage ? (
            <>
              <button type="button" data-todo-approve={item.id} style={PRIMARY_SMALL_BTN} onClick={onApprove}>
                Approve
              </button>
              <button type="button" data-todo-reject={item.id} style={SMALL_BTN} onClick={onReject}>
                Reject
              </button>
            </>
          ) : null}
          {!pending ? (
            <button type="button" data-todo-complete={item.id} style={PRIMARY_SMALL_BTN} onClick={onComplete}>
              Complete
            </button>
          ) : null}
          {canManage && !pending ? (
            <button type="button" data-todo-convert={item.id} style={SMALL_BTN} onClick={onConvert}>
              To Task
            </button>
          ) : null}
          {canManage ? (
            <button type="button" data-todo-remove={item.id} style={SMALL_BTN} onClick={onRemove}>
              Remove
            </button>
          ) : null}
        </div>
        {canManage ? (
          <div style={{display: 'flex', gap: 6, alignItems: 'center'}}>
            <button
              type="button"
              aria-label="Move up"
              data-todo-move-up={item.id}
              style={{...SMALL_BTN, padding: '4px 8px'}}
              disabled={index === 0}
              onClick={onMoveUp}
            >
              ▲
            </button>
            <button
              type="button"
              aria-label="Move down"
              data-todo-move-down={item.id}
              style={{...SMALL_BTN, padding: '4px 8px'}}
              disabled={index >= sectionCount - 1}
              onClick={onMoveDown}
            >
              ▼
            </button>
            <select
              aria-label="Move to section"
              data-todo-move-section={item.id}
              value={item.section}
              onChange={(e) => onMoveSection(e.target.value)}
              style={{...SMALL_BTN, padding: '4px 6px', cursor: 'pointer'}}
            >
              {TODO_SECTIONS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function TodoListTab({sb, authState}) {
  const navigate = useNavigate();
  const canManage = isTodoManager(authState && authState.role);
  const todayStr = new Date().toLocaleDateString('en-CA', {timeZone: 'America/Chicago'});

  const [items, setItems] = React.useState([]);
  const [completed, setCompleted] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const [sectionFilter, setSectionFilter] = React.useState(readTodoSectionFilter());
  const [pendingOnly, setPendingOnly] = React.useState(false);
  const [completedOpen, setCompletedOpen] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);

  const [newOpen, setNewOpen] = React.useState(false);
  const [howToOpen, setHowToOpen] = React.useState(false);
  const [completeTarget, setCompleteTarget] = React.useState(null);
  const [rejectTarget, setRejectTarget] = React.useState(null);
  const [convertTarget, setConvertTarget] = React.useState(null);
  const [removeTarget, setRemoveTarget] = React.useState(null);
  const [assignableProfiles, setAssignableProfiles] = React.useState({});

  const [dragSource, setDragSource] = React.useState(null); // {section, index}
  const [dragTarget, setDragTarget] = React.useState(null); // {section, index}

  // Inline load with a cancelled flag (MyTasksTab pattern) so two quick
  // change events resolving out of order can never render the older snapshot.
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const data = await listTodoItems(sb, {includeCompleted: true});
        if (cancelled) return;
        setItems(data.items);
        setCompleted(data.completed);
      } catch (e) {
        if (cancelled) return;
        // Fail closed: clear stale rows so an error never renders as data.
        setItems([]);
        setCompleted([]);
        setLoadError({kind: 'error', message: 'Could not load the To Do List: ' + friendlyTodoError(e)});
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sb, reloadKey]);

  React.useEffect(() => {
    function onChange() {
      setReloadKey((k) => k + 1);
    }
    window.addEventListener(TODO_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(TODO_CHANGE_EVENT, onChange);
  }, []);

  // Convert modal needs the assignable map; managers only, loaded lazily.
  React.useEffect(() => {
    if (!canManage || !sb) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const map = await loadTaskAssignableProfilesById(sb);
        if (!cancelled) setAssignableProfiles(map);
      } catch (_e) {
        /* soft-fail; convert modal shows an empty assignee list */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sb, canManage]);

  function setFilter(next) {
    setSectionFilter(next);
    writeTodoSectionFilter(next);
  }

  const bySection = React.useMemo(() => {
    const map = new Map(TODO_SECTIONS.map((s) => [s.key, []]));
    for (const item of items) {
      if (pendingOnly && item.status !== 'pending_approval') continue;
      if (!map.has(item.section)) map.set(item.section, []);
      map.get(item.section).push(item);
    }
    return map;
  }, [items, pendingOnly]);

  const pendingCount = items.filter((i) => i.status === 'pending_approval').length;
  const visibleSections =
    sectionFilter === 'all' ? TODO_SECTIONS : TODO_SECTIONS.filter((s) => s.key === sectionFilter);
  const completedVisible = sectionFilter === 'all' ? completed : completed.filter((c) => c.section === sectionFilter);

  async function run(action, failLabel) {
    setNotice(null);
    try {
      await action();
      fireTodoChangeEvent();
    } catch (e) {
      setNotice({kind: 'error', message: `${failLabel}: ${friendlyTodoError(e)}`});
      setReloadKey((k) => k + 1);
    }
  }

  // Persist a full-section order; optimistic local apply, reload on failure.
  async function persistSectionOrder(sectionKey, orderedIds) {
    const next = [];
    const sectionSet = new Set(orderedIds);
    const reordered = orderedIds
      .map((id) => items.find((i) => i.id === id))
      .filter(Boolean)
      .map((item, i) => ({...item, sort_order: i}));
    for (const item of items) {
      if (item.section === sectionKey && sectionSet.has(item.id)) continue;
      next.push(item);
    }
    const merged = [...next, ...reordered].sort((a, b) =>
      a.section === b.section ? a.sort_order - b.sort_order : a.section.localeCompare(b.section),
    );
    setItems(merged);
    await run(() => reorderTodoItems(sb, sectionKey, orderedIds), 'Reorder failed');
  }

  function sectionOrderedIds(sectionKey) {
    // Reorders always operate on the UNFILTERED section list so the RPC's
    // full-list validation holds even while the pending filter is on.
    return items.filter((i) => i.section === sectionKey).map((i) => i.id);
  }

  function moveWithinSection(sectionKey, fromIdx, toIdx) {
    const ids = sectionOrderedIds(sectionKey);
    if (fromIdx < 0 || toIdx < 0 || fromIdx >= ids.length || toIdx >= ids.length || fromIdx === toIdx) return;
    const [moved] = ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, moved);
    persistSectionOrder(sectionKey, ids);
  }

  // Stale-while-revalidate: the Loading placeholder only renders when there
  // is nothing on screen yet. Success-path refetches (after an optimistic
  // reorder/approve/move) keep the current rows mounted so consecutive ▲/▼
  // clicks are possible and the list never flashes.
  const body =
    loading && items.length === 0 && completed.length === 0 ? (
      <div style={{padding: 24, color: 'var(--ink-muted)', fontSize: 13}}>Loading…</div>
    ) : loadError ? (
      <div style={{maxWidth: 560}}>
        <InlineNotice notice={loadError} onDismiss={() => setLoadError(null)} />
        <button type="button" style={{...SMALL_BTN, marginTop: 8}} onClick={() => setReloadKey((k) => k + 1)}>
          Retry
        </button>
      </div>
    ) : (
      <>
        {visibleSections.map((s) => {
          const sectionItems = bySection.get(s.key) || [];
          // Index math for ▲/▼ and drag uses the item's position in the FULL
          // section list, not the pending-filtered view.
          const fullIds = sectionOrderedIds(s.key);
          return (
            <div key={s.key} data-todo-section={s.key} style={{marginBottom: 18}}>
              <div style={{display: 'flex', alignItems: 'baseline', gap: 8, margin: '0 0 8px'}}>
                <h2 style={{fontSize: 15, fontWeight: 700, color: '#085041', margin: 0}}>{s.label}</h2>
                <span style={{fontSize: 12, color: 'var(--ink-muted)'}}>
                  {sectionItems.length} item{sectionItems.length === 1 ? '' : 's'}
                </span>
              </div>
              {sectionItems.length === 0 ? (
                <div style={{fontSize: 13, color: 'var(--ink-faint)', padding: '6px 2px 2px'}}>
                  {pendingOnly ? 'Nothing awaiting approval here.' : 'Nothing here yet — add the first item.'}
                </div>
              ) : (
                <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
                  {sectionItems.map((item, visIdx) => {
                    const fullIdx = fullIds.indexOf(item.id);
                    return (
                      <TodoRow
                        key={item.id}
                        sb={sb}
                        item={item}
                        index={fullIdx}
                        sectionCount={fullIds.length}
                        todayStr={todayStr}
                        canManage={canManage}
                        dragging={!!dragSource && dragSource.section === s.key && dragSource.index === visIdx}
                        dragOver={
                          !!dragTarget &&
                          dragTarget.section === s.key &&
                          dragTarget.index === visIdx &&
                          !!dragSource &&
                          dragSource.index !== visIdx
                        }
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move';
                          try {
                            e.dataTransfer.setData('text/plain', String(visIdx));
                          } catch (_err) {
                            /* older browsers */
                          }
                          setDragSource({section: s.key, index: visIdx});
                        }}
                        onDragOver={(e) => {
                          if (!dragSource || dragSource.section !== s.key) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                          if (!dragTarget || dragTarget.section !== s.key || dragTarget.index !== visIdx) {
                            setDragTarget({section: s.key, index: visIdx});
                          }
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (dragSource && dragSource.section === s.key && dragSource.index !== visIdx) {
                            const fromId = sectionItems[dragSource.index] && sectionItems[dragSource.index].id;
                            const toId = item.id;
                            const ids = fullIds.slice();
                            const fromFull = ids.indexOf(fromId);
                            const toFull = ids.indexOf(toId);
                            if (fromFull >= 0 && toFull >= 0) {
                              const [moved] = ids.splice(fromFull, 1);
                              ids.splice(toFull, 0, moved);
                              persistSectionOrder(s.key, ids);
                            }
                          }
                          setDragSource(null);
                          setDragTarget(null);
                        }}
                        onDragEnd={() => {
                          setDragSource(null);
                          setDragTarget(null);
                        }}
                        onOpen={() => navigate('/tasks/todo/' + encodeURIComponent(item.id))}
                        onComplete={() => setCompleteTarget(item)}
                        onApprove={() => run(() => approveTodoCompletion(sb, item.id), 'Approve failed')}
                        onReject={() => setRejectTarget(item)}
                        onConvert={() => setConvertTarget(item)}
                        onRemove={() => setRemoveTarget(item)}
                        onMoveUp={() => moveWithinSection(s.key, fullIdx, fullIdx - 1)}
                        onMoveDown={() => moveWithinSection(s.key, fullIdx, fullIdx + 1)}
                        onMoveSection={(toSection) => run(() => moveTodoItem(sb, item.id, toSection), 'Move failed')}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        <div
          data-todo-completed-section="1"
          style={{marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 12}}
        >
          <button
            type="button"
            data-todo-completed-toggle="1"
            onClick={() => setCompletedOpen(!completedOpen)}
            aria-expanded={completedOpen}
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 14,
              fontWeight: 700,
              color: 'var(--ink)',
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span style={{fontSize: 12}}>{completedOpen ? '▾' : '▸'}</span>
            Completed ({completedVisible.length})
          </button>
          {completedOpen ? (
            <div style={{display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10}}>
              {completedVisible.length === 0 ? (
                <div style={{fontSize: 13, color: 'var(--ink-faint)'}}>No completed items yet.</div>
              ) : (
                completedVisible.map((item) => (
                  <div
                    key={item.id}
                    className="hoverable-tile"
                    data-todo-completed-row={item.id}
                    {...openableProps(() => navigate('/tasks/todo/' + encodeURIComponent(item.id)))}
                    aria-label={`Open completed to do: ${item.title}`}
                    style={{
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border)',
                      borderRadius: 10,
                      padding: '8px 12px',
                    }}
                  >
                    <div style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap'}}>
                      <span style={{fontSize: 14, fontWeight: 600, color: 'var(--ink)'}}>{item.title}</span>
                      <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>{todoSectionLabel(item.section)}</span>
                    </div>
                    <div style={{fontSize: 12, color: 'var(--ink-muted)', marginTop: 2}}>
                      Done by {item.completion_submitted_by_name || 'Unknown'}
                      {item.approved_by_name ? ` · approved by ${item.approved_by_name}` : ''}
                      {item.approved_at ? ` · ${fmt(centralISOFor(item.approved_at))}` : ''}
                    </div>
                    {item.completion_note ? (
                      <div style={{fontSize: 12, color: 'var(--ink-muted)', marginTop: 2}}>{item.completion_note}</div>
                    ) : null}
                    {Array.isArray(item.photos) && item.photos.length > 0 ? (
                      <div style={{marginTop: 6}} onClick={(e) => e.stopPropagation()}>
                        <TodoPhotoThumbs sb={sb} photos={item.photos} />
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>
      </>
    );

  return (
    <div data-todo-list-loaded={loading ? undefined : '1'}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
          marginBottom: 12,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1 style={{fontSize: 20, margin: 0, color: 'var(--ink)'}}>To Do List</h1>
          <div style={{fontSize: 12, color: 'var(--ink-muted)'}}>
            Shared open work anyone can pick up. Order is priority — managers arrange the list.
          </div>
        </div>
        <div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
          <button type="button" data-todo-howto="1" style={SMALL_BTN} onClick={() => setHowToOpen(true)}>
            How to Use
          </button>
          <button
            type="button"
            data-todo-new-button="1"
            onClick={() => setNewOpen(true)}
            style={{
              padding: '8px 14px',
              borderRadius: 10,
              border: '1px solid #085041',
              background: '#085041',
              color: 'white',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'inherit',
              whiteSpace: 'nowrap',
            }}
          >
            + New To Do
          </button>
        </div>
      </div>

      <div
        role="group"
        aria-label="To do section filter"
        data-todo-section-filter="1"
        style={{display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14}}
      >
        {[{key: 'all', label: 'All'}, ...TODO_SECTIONS].map((s) => (
          <button
            key={s.key}
            type="button"
            data-todo-section-chip={s.key}
            aria-pressed={sectionFilter === s.key}
            onClick={() => setFilter(s.key)}
            style={sectionFilter === s.key ? CHIP_ACTIVE : CHIP_BASE}
          >
            {s.label}
          </button>
        ))}
        {canManage ? (
          <button
            type="button"
            data-todo-pending-filter="1"
            aria-pressed={pendingOnly}
            onClick={() => setPendingOnly(!pendingOnly)}
            style={{
              ...(pendingOnly ? CHIP_ACTIVE : CHIP_BASE),
              ...(pendingOnly
                ? {background: '#b45309', border: '1px solid #b45309', color: '#ffffff'}
                : {color: '#92400e', border: '1px solid #fde68a', background: '#fffbeb'}),
              marginLeft: 'auto',
            }}
          >
            Pending approval ({pendingCount})
          </button>
        ) : null}
      </div>

      {notice ? <InlineNotice notice={notice} onDismiss={() => setNotice(null)} /> : null}

      {body}

      <NewTodoModal
        sb={sb}
        isOpen={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={() => {}}
        defaultSection={sectionFilter}
      />
      <TodoCompleteModal
        sb={sb}
        authState={authState}
        item={completeTarget}
        isOpen={!!completeTarget}
        onClose={() => setCompleteTarget(null)}
        onCompleted={() => {}}
      />
      <TodoRejectModal
        sb={sb}
        item={rejectTarget}
        isOpen={!!rejectTarget}
        onClose={() => setRejectTarget(null)}
        onRejected={() => {}}
      />
      <ConvertTodoModal
        sb={sb}
        item={convertTarget}
        profilesById={assignableProfiles}
        isOpen={!!convertTarget}
        onClose={() => setConvertTarget(null)}
        onConverted={() => {}}
      />
      {removeTarget ? (
        <DeleteModal
          msg={`Remove "${removeTarget.title}" from the To Do List? Its history stays in Activity.`}
          onConfirm={async () => {
            const target = removeTarget;
            setRemoveTarget(null);
            await run(() => removeTodoItem(sb, target.id), 'Remove failed');
          }}
          onCancel={() => setRemoveTarget(null)}
        />
      ) : null}
      {howToOpen ? <TodoHowTo onClose={() => setHowToOpen(false)} canManage={canManage} /> : null}
    </div>
  );
}
