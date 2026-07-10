# Un-nest — exclude items — Design

Date: 2026-07-09
Area: Un-nest feature — `plugin/index.html` (Settings → Un-nest panel),
`plugin/main.js` (`expandViaClone` + Un-nest settings wiring), `plugin/styles.css`.
Related: [2026-07-03-unnest-revamp-design.md](2026-07-03-unnest-revamp-design.md),
[2026-07-09-unnest-overflow-clamp-design.md](2026-07-09-unnest-overflow-clamp-design.md).

## Problem

Un-nest currently clones every inner clip of the selected nested sequence (subject to
the mode filter). The user wants to keep specific items **inside** the nest — i.e.,
exclude chosen project items from being cloned out — configured once and reused.

## Goal

In Settings → Un-nest, let the user build a per-project **exclusion list** of project
items via a searchable dropdown. When un-nesting, any inner clip whose source project
item is on the list is skipped (left inside the nested sequence). Excluded items are
shown in a separate collapsible panel.

## Decisions (from brainstorming)

- **Match key:** project-item **id** (`item.getId()`), not name. Store `{ id, name }` —
  id for matching, name for display. Precise even with duplicate names.
- **Dropdown source:** all **media items and sequences** in the project (recursively via
  `sacCollectBinItems`); bins/folders excluded from the list.
- **Persistence:** **per-project**, keyed by `sacCurrentProjectKey()`, mirroring the
  Autocut bind memory (`sac_binds_v1`).

## Data / storage

`localStorage['unnest_exclude_v1']` = `{ [projKey]: [ { id, name }, … ] }`.

- `projKey` = `await sacCurrentProjectKey()` (project name-based, as used by Autocut binds).
- Helpers: `unnestLoadExcludes(projKey)` → array; `unnestSaveExcludes(projKey, arr)`.
- All reads tolerate missing / malformed JSON (try/catch → `{}` / `[]`).

## UI (Settings → Un-nest, `#tab-unnest`)

New block under the mode rows, above the "Chạy trên clip đang chọn" / run button:

```
Loại trừ khi bung
[ 🔍  Thêm item loại trừ…            ▾ ]   [ Đã loại trừ (N) ▾ ]
<add-dropdown panel>        <excluded-list panel>
```

- **Add dropdown** (`#unExcludeAddBtn` → panel `#unExcludePanel`): a text input
  (typeahead) + a scrollable list. Typing filters to the closest name matches
  (case-insensitive substring, same behavior as the Voice Gen `vg-dropSearch`). Each row
  is a project item name; clicking it adds `{ id, name }` to the list (no-op if id already
  present) and refreshes the count. A small **↻** refresh control rebuilds the item list.
- **Excluded list** (`#unExcludeListBtn` showing `Đã loại trừ (N)` → panel
  `#unExcludeListPanel`): collapsed by default; expands to list excluded items by name,
  each with an `×` to remove. `N` = current count.
- Only one panel open at a time; opening one closes the other.
- Reuse existing dropdown/panel/search styles where possible; add `un-exclude*` classes
  scoped to the Un-nest panel.

## Building the item list

Lazily, when the add-dropdown is first opened (cached in memory for the session):

1. `proj = await getActiveProject()`; get its root item.
2. `items = await sacCollectBinItems(rootItem)`.
3. Keep entries where `!isFolder` (media + sequences; bins dropped).
4. For each, `id = await un(item.getId())`; build `{ id, name }`. Skip entries whose id
   can't be read.
5. Sort by name (natural order) for display.

A **↻ refresh** in the panel re-runs this (e.g. after switching projects or importing).
On refresh, **auto-prune** the saved exclusion list: drop any saved id not present in the
freshly-scanned project (stale after delete/re-import), and update the saved names to the
current names.

## Behavior (`expandViaClone`)

- At the start of `expandViaClone` (or `run`, passed down), load the excluded id-set for
  the current project into a `Set`-like object once.
- In the **video** pick loop and the **audio** pick loop, after resolving each inner
  clip's project item, compute `pid = await un(clip.getProjectItem().getId())`. If
  `pid` is in the excluded set → skip (do not push to `picked`/`apick`), increment an
  `excludedCount`.
- The mode filter (`classifyVideoClip`) still applies independently.
- Log summary addition: `· bỏ N item loại trừ` (only when `excludedCount > 0`).
- Excluded clips remain inside the nested sequence (which is disabled after un-nest per
  existing behavior), so they simply don't appear on the parent timeline.

## Error handling

- Project/bridge unavailable when opening the dropdown → empty list, no exclusions
  (fail-open); un-nest behaves as today.
- `getId()` failure on an inner clip during un-nest → treat as **not excluded**
  (fail-open — never drop a clip we can't identify).
- `getId()` failure while building the list → skip that entry.
- Malformed localStorage → treated as empty.
- Two projects sharing a name → their lists collide (accepted, same limitation as Autocut
  binds).

## Out of scope

- Excluding by name or by timeline label (id-only, per the decision).
- Excluding whole bins/folders (only individual media items + sequences).
- Auto-selecting items from the currently-selected nest (the list is the whole project).
- Any change to the overflow-clamp / placement logic.

## Testing (manual, Premiere 25+)

1. Open Settings → Un-nest → add-dropdown; type a partial name → list narrows to matches.
2. Add 1–2 items; "Đã loại trừ (N)" shows the right count; expand → items listed; `×`
   removes one.
3. Un-nest a nested sequence containing an excluded item → that item is NOT cloned to the
   parent timeline; non-excluded items are. Log shows `· bỏ N item loại trừ`.
4. Reload the plugin (same project) → exclusion list restored. Open a different project →
   its own (empty or different) list shows.
5. Delete an excluded item from the project, hit ↻ refresh → stale entry pruned.
