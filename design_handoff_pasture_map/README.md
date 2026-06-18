# Handoff: WCF Pasture Map Redesign

## Overview
A single-page **grazing planning cockpit** for the WCF Planner app, at the route `/pasture-map`. It combines a large satellite map with a docked side panel, organized into five **modes** (tabs): **View / Map, Plan, Field, Setup, Reports**. The product's primary job is grazing planning — next moves, rest tracking, and rotation decisions — for an office manager (Nick) on desktop and a farm team executing on a phone in poor service.

The design replaces a crowded legacy page where a small map competed with side lists, reports, and forms. The redesign makes the map the hero, reserves the word "Move" for animal movement only, and pushes admin/reporting tools out of the planning flow.

## About the Design Files
The file in this bundle (`Pasture Map.dc.html`) is a **design reference created in HTML** — a working, interactive prototype showing the intended look and behavior. It is **not production code to copy directly**. It is authored in a small internal HTML-template runtime (the "DC" format, with a `support.js` runtime and `<x-dc>` / `<sc-for>` / `<sc-if>` template tags); **do not** port that runtime.

The task is to **recreate this design in the target codebase's existing environment** (React/Vue/etc.) using its established component patterns, state library, and conventions. The map is real **Leaflet + Esri World Imagery** — that part is directly reusable. All UI styling here is inline; in the real app, map it onto the existing **"Crisp" design system** (`modern-base.css` + `modern-themes.css`, `.theme-crisp`, `.header-green`) rather than re-hardcoding hex values.

## Fidelity
**High-fidelity (hifi).** Final colors, typography (Hanken Grotesk), spacing, layout, and interactions are all intended as shown. Recreate pixel-faithfully using the codebase's existing libraries — but consume Crisp design tokens (`--brand`, `--ok-*`, `--warn-*`, `--danger`, `--border`, etc.) instead of the literal hex values inlined in the prototype. Status/grazing-state colors are semantic and must stay regardless of program accent.

---

## Global Layout

```
┌──────────────────────────────────────────────────────────┐
│ TOP BAR  (56px, green gradient chrome)                   │  z-30
│  WCF mark + "WCF Planner / PASTURE MAP"  |  Online pill · user pill
├──────────────────────────────────────────────────────────┤
│ MODE TABS (52px, white)                                  │  z-20
│  [View/Map] [Plan] [Field] [Setup] [Reports]  | mode hint · last sync
├───────────────────────────────────┬──────────────────────┤
│                                   │  SIDE PANEL (392px)  │  z-10
│   MAP (Leaflet, flex:1)           │  scrolls; content    │
│   - Fit Farm / Zoom Sel / My Loc  │  swaps per mode:     │
│   - collapsible Legend (bottom-L) │  View / Plan /       │
│   - add/draw banner (top-center)  │  Setup / Reports     │
│                                   │                      │
└───────────────────────────────────┴──────────────────────┘
   FIELD mode = full-screen dark overlay (z-900) with a phone mock
```

- App shell: `height:100vh; display:flex; flex-direction:column; overflow:hidden`.
- Main row: `flex:1; display:flex`. Map is `flex:1; position:relative`; the `#cockpit-map` div is `position:absolute; inset:0`.
- Side panel: fixed `392px`, `border-left:1px solid #E6E8EB`, internal `overflow-y:auto; padding:16px; gap:14px`.
- **Panel side is tweakable** via a `planLayout` prop (`right` default | `left`) — flips `flex-direction` to `row-reverse` and the border side.
- **Field mode** is a separate `position:fixed; inset:0; top:108px; z-index:900` overlay (so it covers the map controls, which sit at z-600). On desktop it shows an explanatory caption beside a 372×744 phone mock; the phone contains its own Leaflet map (`#field-map`).

### Default behavior
Page opens in **View / Map** mode (neutral browse), **never** "Move." Reserve "Move" exclusively for animal-movement actions.

---

## The Map (shared by View/Plan/Field)

- **Library:** Leaflet 1.9.4.
- **Imagery:** Esri World Imagery — tile URL
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`
  with `maxNativeZoom: 18, maxZoom: 21` (allows blurry over-zoom but avoids broken/blank tiles — this fixes the legacy USGS `maxNativeZoom` bug). Attribution: "Esri World Imagery · Maxar". **No manual basemap switcher.** In production, fall back to NAIP/USGS/offline tiles when Esri is unavailable.
- **Controls (top-right, z-600):** Fit Farm (`map.fitBounds(farmBounds)`), Zoom Selected (fit selected polygon, padded; falls back to farm), My Location (drops an accuracy circle + dot, `setView(here, 17.5)`). In Field mode these repeat as large touch buttons.
- **Scale control:** imperial, bottom-right.
- **Polygons:** each pasture is an `L.polygon`. Fill = **grazing state** (semantic, always wins). Outline weight/dash = **type**. A name label (`L.divIcon`) sits at each polygon center. Clicking a polygon selects it (or, in add/draw modes, adds a rotation stop / drops a draw vertex).
- **GPS boundary trace:** a dashed cyan polyline (`#16B7C9`, `dashArray:'2,7'`) to the SE, representing an in-progress GPS-walked boundary.
- **Rotation overlay (Plan/Field):** the active group's rotation drawn as a species-colored dashed polyline (`dashArray:'1,8'`) through stop centers, with numbered circular markers (1 = current/now).

### Grazing-state colors (semantic — the primary visual language)
| State | Meaning | Fill hex | Ink/border hex | Soft bg | Outline/marker notes |
|---|---|---|---|---|---|
| Occupied | A group is grazing it now | `#2E6FB5` | `#23578f` | `#E7EEF7` | fillOpacity .68 (.78 selected) |
| Resting | Recovering, rest < target | `#C7920A` | `#8A6A1E` | `#F8F0DA` | fillOpacity .5 |
| Ready | Ready to graze | `#3F9B5B` | `#2f7a46` | `#E6F4EC` | fillOpacity .5 |
| No history | Unknown / unclassified | `#9AA1AB` | `#6B7280` | `#F1F3F4` | dashArray `3,5` |
| Invalid | Self-intersecting / needs setup | `#C0452F` | `#C0452F` | `#FBE7E3` | dashArray `6,6`, fill `rgba(192,69,47,.12)` |
| Selected | (any state) | — | outline `#0f1a14`, weight 3.5 | — | thick dark outline |

Occupancy is **derived**: a pasture is "occupied" iff some group's rotation[0] equals it. Resting vs ready is derived from `rest` vs `target`.

### Polygon type → outline only (fill stays state-colored)
| Type | Outline | Set where |
|---|---|---|
| Paddock (default) | solid, weight 1.5 | Setup → Pastures → type select |
| Pasture | dashed `10,5`, weight 2.5 | " |
| Temp | dashed green `5,4`, green dashed label | created via Plan "Draw temp paddock", or type select |

### Legend (collapsible, bottom-left of map)
Toggles open/closed (chevron rotates). Rows: the 5 grazing states, Selected pasture, Active group rotation (numbered, by species), Temp paddock (drawn), GPS boundary trace. **Default-open is tweakable** via `legendDefaultOpen` prop.

---

## Animal Groups & Rotation Model (core data)

The farm runs **8 animal groups**, each with its own ordered **rotation** (a list of pasture IDs; no fixed dates — sequence only):

| id | Name | Species | Code | Size | Day/Planned | Rotation |
|---|---|---|---|---|---|---|
| main | Main Herd | cattle | MH | 86 cow-calf pairs | 2/3 | N4→S2→N3→E1→S1→N1 |
| stock | Stockers | cattle | ST | 120 yearlings | 1/2 | E3→E1→N3→N2 |
| sowA | Sow Group A | pig | A | 18 sows | 4/5 | N5→N2→N1 |
| sowB | Sow Group B | pig | B | 16 sows | 2/5 | S3→S2→S1 |
| sowC | Sow Group C | pig | C | 15 sows | 3/5 | E2→E1 |
| sowD | Sow Group D | pig | D | 17 sows | 1/5 | E4→E3 |
| ewe | Ewe Flock | sheep | EW | 140 ewes | 5/7 | S1→N1→N3 |
| ram | Ram & Repl. | sheep | RM | 45 head | 2/6 | S4→S2 |

**Species accent colors** (used for group avatars, the active rotation path, and the active-group cards — NOT for pasture fills):
- Cattle: `#9A3B2E` (ink `#7C3023`, soft `#F4E5E2`)
- Pig: `#A8418A` (ink `#852F6D`, soft `#F3E3EE`)
- Sheep: `#1E8A8A` (ink `#166A6A`, soft `#DEF0F0`)

**Pastures** (14 base): N1–N5, E1–E4, S1–S4, W1. Each has `id`, editable `name` (defaults to id), `acres`, optional `rest`/`target`/`lastGrazed`, `type`, and an `invalid` flag (W1 is invalid by default). Geometry in the prototype is procedurally generated in a 4-column grid around lat 35.5236, lng −86.4492; in production these come from real KML/boundary data.

---

## Modes (side-panel content)

### 1. View / Map
Neutral browse/select. Eyebrow "VIEW · MAP", title "Whole farm" (or "Pasture detail" when something is selected).
- **No selection:** "Farm status" card — 2×2 metric grid counting Occupied / Resting / Ready / No-history pastures (derived). Below it an info banner: "{N} animal groups on rotation … Open **Plan** to build moves." Hint: "Select any pasture on the map to inspect it."
- **Selection:** a card with a top color stripe (state color), pasture name, a state badge, and a key/value table. For occupied: Group, Head, Day x of y, Acres, Species. For resting: Rest progress, Acres, Last grazed, Status. Etc. Buttons: "◎ Zoom to this pasture", "Clear selection".

### 2. Plan (the cockpit — main workspace)
Eyebrow "PLAN · GRAZING COCKPIT", title "Move planner".
- **Animal groups switcher** — grouped by species (Cattle / Pigs / Sheep sections, each with a count). Each group is a pill: species-colored avatar (code) + name + size. Active pill = species soft bg + species border + species ink. Selecting sets the active group (and clears selection).
- **Active group · Now card** — top stripe in species color; avatar + name + "{species} · {size} · in {nowPasture}"; a "Day x/y" badge; a "Move in Nd / Move due now" line with a progress bar (day/planned).
- **Now → Next card** — species-tinted gradient; shows Now pasture → Next pasture and the next pasture's rested-days; CTA "Mark {code} moved → {next}" which **advances** the rotation (drops current, next becomes now, resets day to 1).
- **Rotation editor** — header with a Chips/List segmented toggle.
  - *Chips view:* the rotation as draggable pills (numbered; now-pill ringed in species color), each with a small `×` to remove. **HTML5 drag-and-drop** reorders (dragstart stores index, dragover preventDefault, drop splices).
  - *List view:* detailed rows — drag handle `⋮⋮`, number, name + "NOW" tag, state label · acres, "Remove".
  - *Suggestion row:* "Longest-rested ready: {pasture} · {n}d rested" with "+ Add".
  - *Add controls:* "＋ Add from map" (toggles add-mode: tapping pastures appends them; a top-center map banner shows "Tap paddocks to add to {group}" + Done) and "✎ Draw temp paddock" (enters draw-mode: tap the map to drop vertices, banner shows count + Finish/Cancel; ≥3 points closes into a temp pasture appended to the rotation).

### 3. Field (phone-first execution, read-only plan)
Full-screen dark overlay (radial `#1b2620`→`#0d1411`). Desktop: caption on the left, 372×744 phone mock on the right with its own Leaflet map.
- **Top:** offline/online status pill + active group name; a horizontally-scrolling group selector (compact pills; selecting switches the active group — shared with Plan).
- **Bottom sheet stack:**
  - *Now / Next card* — split: "NOW {pasture}, Day x/y, {group}" | "NEXT {pasture}, {rested}" (species-colored). A "Then" strip lists the remaining rotation (read-only chips).
  - *Offline queue sheet* — title reflects state ("Queued offline (n)" / "Syncing (n)" / "All synced"); each row: status dot, label, time, and Queued/Syncing/Synced. A Sync button ("Waiting" when offline, "Sync now" when online+pending, "Done").
  - *Big control row:* My Location / Zoom Sel. / Fit Farm (54px tall).
  - *Primary button:* "＋ Confirm move → {next}" (species-colored) — logs a move to the queue. The plan itself is **not editable** in Field.
- **Offline is mandatory.** A demo toggle ("Simulate signal returning / going offline") flips state: offline = amber pill `#8A6A1E`, queued items hold; online = green `#2f7a46`, Sync clears them. Field state and offline trust are the point of this mode.

### 4. Setup (manager/admin only)
Eyebrow "SETUP · MANAGER ONLY", title "Land & boundaries".
- **Animal groups editor** — per group: avatar, name input, remove (×); row 2: map-code input (≤3 chars, uppercased), species `<select>` (Cattle/Pigs/Sheep), size input; row 3: "Day [n] of [n] days in paddock". "＋ Add group" (dashed green) appends a new group and makes it active. Min 1 group (can't remove the last).
- **Pastures editor** — subtitle + an inline legend of the 5 state dots. Each row: state dot, name input, acres input + "ac", and an expand chevron (▾/▴). **Expanded** reveals: Type `<select>` (Paddock/Pasture/Temp), Rest days + Rest target inputs (side by side), and an actions row [Mark valid/invalid][Redraw] plus a full-width **🗑 Delete area** button. Deleting removes the polygon from the map and from every group's rotation. (Last-grazed is intentionally NOT here — it shows in the selected-pasture info box and the Rest report.)
- **Classification** — live counter "{classified} of 44 land areas classified" + "{n} left" + progress bar. A queue list; "Classify ›" removes an item and decrements the count; the W1 row shows "Fix ›". "View all 40 unclassified".
- **Boundary tools** — 2×2 grid; renamed for clarity (the legacy names are shown as captions): **Map / Pan** (was "Move", exits draw modes), **GPS Boundary** (was "Track", starts a trace/draw), **Edit Boundary** (was "Edit", redraws the selected pasture), **Close Outline** (finish polygon). Below: **⬆ Import KML** (adds areas to the classify queue).
- **Invalid banner** (only while W1 invalid): "1 invalid outline — W1 … Mark it valid or redraw it" with a **Mark W1 valid** button. Hides once fixed.

### 5. Reports (secondary — deliberately deprioritized)
Eyebrow "REPORTS · SECONDARY", title "Grazing reports". Three collapsible cards that expand inline to real data tables:
- **Rest & recovery history** — resting/ready pastures with days rested vs target.
- **Stocking rate** — head per group on rotation.
- **Grazing days log** — recorded moves (from the queue).
Kept available but never competes with map + planning.

---

## Interactions & Behavior
- **Tabs** switch mode (active = filled brand pill `#1C8A5F`/white + soft shadow; inactive = transparent + muted, hover light gray). Switching modes invalidates the relevant Leaflet map size and redraws the rotation overlay.
- **Selection** drives Zoom Selected, the View detail card, and chip highlight; clicking a polygon in Reports mode jumps to View.
- **Rotation editing** (Plan only): drag-reorder (chips & list), append from map, remove stop, draw/append temp paddock, advance ("Mark moved"). Occupancy + map fills recompute live from rotations.
- **Setup editing** mutates groups (name/code/species/size/day/planned, add/remove) and pastures (name/acres/type/rest/target/invalid, redraw, delete). Changes propagate to map labels, fills, Plan, Field, and Reports immediately.
- **Field**: read-only plan; group switching, record move (queues), offline/sync simulation.
- **Drawing**: map `click` adds a vertex while in draw-mode; polygon `click` is suppressed in draw-mode so it doesn't select.
- Hover lift on buttons (`translateY(-1px)`), row hover `#F1F3F4`.
- No real animations beyond a subtle pulse on the herd marker and chevron rotations.

## State Management
Single component state:
- `mode` ('view'|'plan'|'field'|'setup'|'reports'), `selectedId`, `legendOpen`.
- `groups[]` (id, name, species, short, size, day, plannedDays) and `rotations{}` (groupId → ordered pasture-id array) — kept separate so rotations survive group edits.
- `activeGroup`.
- Editing/UX flags: `addMode`, `drawMode`, `drawCount`, `listView`, `expandedPasture`, `openReport`.
- Setup: `unclassified` count + `classifyQueue[]`.
- Field: `offline`, `queue[]`.
- Pastures (`PADDOCKS[]`) hold id/name/acres/rest/target/type/invalid; map layers and label markers are tracked in a registry for live restyle/relabel/removal.
Derived each render: occupancy, per-pasture state, status counts, rest suggestion, report rows.
Real app: pull groups/rotations/pastures from the backend; persist edits via API; persist offline queue locally and sync when online.

## Design Tokens
- **Type:** Hanken Grotesk 400/500/600/700/800 (`system-ui` fallback), tabular-nums for figures. Page title 22/750 `-.02em`; card heading 16/750; metric 28–30/750 `-.025em`; body 13–14/600–700; eyebrow 10.5–12/700 uppercase `.08–.12em`.
- **Neutrals:** bg `#F8F9FA`, surface `#FFFFFF`, surface-2 `#F1F3F4`, border `#E6E8EB`, border-strong `#D2D6DB`, divider `#ECEEF0`, text `#222933`, muted `#6B7280`, faint `#9AA1AB`, label `#7A828D`.
- **Brand:** `#1C8A5F`; brand-soft `#E6F4EC`; on-brand `#fff`. Header gradient `linear-gradient(102deg, oklch(0.355 0.058 166), oklch(0.435 0.078 170))`.
- **Status:** ok `#3F7A5B`/`#E6F4EC`, warn `#8A6A1E`/`#F8F0DA`, danger `#C0452F`/`#FBE7E3`, info `#3B6CB7`/`#E7EDF8`. (Grazing-state and species colors listed in their tables above.)
- **Radius:** cards 14px, controls/inputs 8–10px, chips/pills 999px. **Shadow:** card `0 1px 2px rgba(20,30,40,.045)`, hover `0 7px 20px rgba(20,30,40,.10)`. **Spacing:** panel padding 16, card padding 15–16, block gap 14.
- **Tweakable props on the root:** `planLayout` (right|left), `showRotationPath` (bool), `legendDefaultOpen` (bool).

## Assets
- **None to ship.** Map imagery is loaded live from Esri World Imagery tiles. Icons in the prototype are Unicode glyphs/emoji placeholders (🗺 ◷ 📡 ⚙ ▤ ⤢ ◎ 📍 🗑 etc.) — replace with the codebase's existing icon set. Pasture geometry is placeholder-generated; use real KML/boundary data in production.

## Files
- `Pasture Map.dc.html` — the full interactive design (all five modes, the Leaflet map, and every editing flow). Open in a browser to explore. It depends on an internal `support.js` runtime that is **not** part of the handoff — treat the file as a visual/behavioral reference, not code to import.
- `screenshots/` — reference captures of each mode: `1-view-map.png`, `2-plan.png`, `3-field.png` (phone map intentionally blanked so the UI reads clearly), `4-setup.png`, `5-reports.png`. These are DOM re-render captures; fonts/map tiles may differ slightly from the live render — the running HTML is the source of truth.
