import { useEffect, useMemo, useRef, useState } from "react";
import type { Filter } from "../../../../../types/reely";
import { Tr } from "../atoms/Tr";
import { CloseIcon } from "../atoms/CloseIcon";
import { SearchControl } from "../molecules/SearchControl";
import { FieldPicker } from "../molecules/FieldPicker";
import { useStore, useDispatch } from "../../store";
import styles from "./FilterPanel.module.css";

interface FilterPanelProps {
  onClose: () => void;
  onApply: (filters: Filter[]) => void;
  isDrawer?: boolean;
  // Re-syncs `draft` from `room.activeFilters` on each false → true
  // transition. Desktop keeps the panel mounted, so without this the draft
  // freezes at whatever activeFilters were on first mount.
  isOpen?: boolean;
}

// Clone so draft edits don't mutate the store's filter objects. Filter is flat,
// so a shallow clone per row is enough.
const cloneActiveFilters = (active: Filter[] | undefined): Filter[] =>
  (active ?? []).map((f) => ({ ...f, value: [...f.value] }));

export const FilterPanel = ({ onClose, onApply, isDrawer = false, isOpen = true }: FilterPanelProps) => {
  const [{ createRoom, room }] = useStore(["createRoom", "room"]);
  const dispatch = useDispatch();
  const [draft, setDraft] = useState<Filter[]>(() => cloneActiveFilters(room?.activeFilters));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  // Keyed by `filter.key`, not draft index: keys survive reorders, so removal
  // needs no index-shifting to stay in sync.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  // No requestFilters dispatch here: Room.tsx prefetches the catalog at mount,
  // and on desktop this panel is mounted alongside it, so both would fire in
  // the same tick and the server would see two requests for one room.

  // Re-sync the draft on each open, so a returning user sees current room
  // state; edits made while open are left alone, even if another user applies
  // filters mid-edit. Also prefetches values for pre-populated rows so the
  // collapsed summary shows titles ("Drama, Action") rather than raw ids.
  const prevIsOpen = useRef(isOpen);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately not depending on room?.activeFilters / createRoom / dispatch; the snap must fire only on the open transition.
  useEffect(() => {
    if (isOpen && !prevIsOpen.current) {
      const fresh = cloneActiveFilters(room?.activeFilters);
      setDraft(fresh);
      setExpandedRows(new Set());
      // Reset the FieldPicker too: on desktop the panel stays mounted while
      // closed, so an open picker and typed query would survive to the next open.
      setPickerOpen(false);
      setPickerSearch("");
      for (const f of fresh) {
        if (!createRoom?.filterValues?.[f.key]) {
          dispatch({ type: "requestFilterValues", payload: { key: f.key } });
        }
      }
    }
    prevIsOpen.current = isOpen;
  }, [isOpen]);

  // Mount-only prefetch for the initial draft; addFilter and the open-
  // transition effect above cover every later row.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only prefetch; adding draft/createRoom/dispatch would re-fire on every state change and duplicate the requestFilterValues dispatches.
  useEffect(() => {
    for (const f of draft) {
      if (!createRoom?.filterValues?.[f.key]) {
        dispatch({ type: "requestFilterValues", payload: { key: f.key } });
      }
    }
  }, []);

  const filters = createRoom?.availableFilters;
  // Memoized so typing in the picker doesn't re-walk filters.filters and
  // rebuild the key Set on every keystroke.
  const usedKeys = useMemo(
    () => new Set(draft.map((d) => d.key)),
    [draft],
  );
  // O(1) row lookup, versus a find() per row per render.
  const fieldsByKey = useMemo(
    () => new Map((filters?.filters ?? []).map((f) => [f.key, f])),
    [filters],
  );
  const availableFields = useMemo(
    () =>
      filters?.filters.filter(
        (f) =>
          !usedKeys.has(f.key) &&
          f.title.toLowerCase().includes(pickerSearch.toLowerCase()),
      ) ?? [],
    [filters, usedKeys, pickerSearch],
  );

  const addFilter = (key: string) => {
    const fieldDef = fieldsByKey.get(key);
    if (!fieldDef) return;
    const firstOp = filters?.filterTypes[fieldDef.type]?.[0]?.key ?? "=";
    const initValue = fieldDef.type === "boolean" ? ["1"] : [];
    setDraft((d) => [...d, { key, operator: firstOp, value: initValue }]);
    setExpandedRows((prev) => new Set(prev).add(key));
    setPickerOpen(false);
    setPickerSearch("");
    if (!createRoom?.filterValues?.[key]) {
      dispatch({ type: "requestFilterValues", payload: { key } });
    }
  };

  const updateFilter = (i: number, patch: Partial<Filter>) =>
    setDraft((d) => d.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const removeFilter = (i: number) => {
    // Capture the key before the updater so expandedRows can be pruned by key.
    const removedKey = draft[i]?.key;
    setDraft((d) => d.filter((_, idx) => idx !== i));
    if (removedKey !== undefined) {
      setExpandedRows((prev) => {
        const next = new Set(prev);
        next.delete(removedKey);
        return next;
      });
    }
  };

  const toggleExpand = (i: number) => {
    const key = draft[i]?.key;
    if (key === undefined) return;
    // Dispatch outside the state updater: updaters must be pure, and React
    // re-invokes them (StrictMode always, production at will), which would
    // duplicate the requestFilterValues frame.
    const willExpand = !expandedRows.has(key);
    if (willExpand && !createRoom?.filterValues?.[key]) {
      dispatch({ type: "requestFilterValues", payload: { key } });
    }
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const getSummary = (filter: Filter): string => {
    const fieldDef = fieldsByKey.get(filter.key);
    if (!fieldDef) return "";
    if (fieldDef.type === "boolean") return filter.value[0] === "1" ? "Yes" : "No";
    if (filter.value.length === 0) return "Any";
    const vals = createRoom?.filterValues?.[filter.key];
    const display = filter.value.map(
      (v) => vals?.find((fv) => fv.value === v)?.title ?? v,
    );
    if (display.length <= 2) return display.join(", ");
    return `${display.slice(0, 2).join(", ")} +${display.length - 2}`;
  };

  const getOpLabel = (filter: Filter): string => {
    const fieldDef = fieldsByKey.get(filter.key);
    if (!fieldDef) return "";
    return (
      filters?.filterTypes[fieldDef.type]?.find((t) => t.key === filter.operator)
        ?.title ?? filter.operator
    );
  };

  // Boolean rows always count; others need at least one selected value. Shared
  // by the canApply gate and handleApply so the two cannot drift.
  const isFilterApplicable = (f: Filter): boolean => {
    const fd = fieldsByKey.get(f.key);
    return fd?.type === "boolean" || f.value.length > 0;
  };

  const canApply = draft.filter(isFilterApplicable).length > 0;

  // "Clear" mode: an empty draft in a filtered room submits the empty set.
  // Without it, a disabled button leaves applied filters unremovable.
  const hasActiveFilters = (room?.activeFilters?.length ?? 0) > 0;
  const isClearing = !canApply && hasActiveFilters;
  const canSubmit = canApply || isClearing;

  const handleApply = () => {
    onApply(draft.filter(isFilterApplicable));
    onClose();
  };

  const fieldCount = filters?.filters.length ?? 0;

  return (
    <div className={isDrawer ? styles.drawerContent : styles.overlay}>
      <div className={isDrawer ? styles.headerDrawer : styles.header}>
        <div className={styles.headerText}>
          <span className={styles.headerLabel}>Filter the room</span>
          <h1 className={styles.title}>
            Build a <span className={styles.titleAccent}>shortlist</span>
          </h1>
          {fieldCount > 0 && (
            <span className={styles.subLabel}>{fieldCount} fields available</span>
          )}
        </div>
        <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
          <CloseIcon />
        </button>
      </div>

      <div className={styles.body}>
        {!filters ? (
          <p className={styles.loading}>
            <Tr name="FILTERS_LOADING" />
          </p>
        ) : (
          <>
            {draft.length === 0 && !pickerOpen && (
              <div className={styles.emptyFilters}>
                No filters yet. Tap below to add one.
              </div>
            )}

            {draft.map((filter, i) => {
              const fieldDef = fieldsByKey.get(filter.key);
              if (!fieldDef) return null;
              const expanded = expandedRows.has(filter.key);
              const operators = filters.filterTypes[fieldDef.type] ?? [];
              // Server-enumerated values. Three states:
              //   undefined  request in flight
              //   [...]      show pills, whatever fieldDef.type says
              //   []         no values; show the free-text SearchControl
              // Do not gate on fieldDef.type: Plex enumerates some integer
              // fields, decade being the canonical case.
              const filterValues = createRoom?.filterValues?.[filter.key];
              const isBoolean = fieldDef.type === "boolean";

              return (
                <div key={filter.key} className={styles.row}>
                  <div className={styles.rowHeader}>
                    <button
                      type="button"
                      className={styles.rowExpandBtn}
                      onClick={() => toggleExpand(i)}
                      aria-expanded={expanded}
                    >
                      <span className={styles.rowIcon}>
                        {fieldDef.title.charAt(0)}
                      </span>
                      <div className={styles.rowMeta}>
                        <span className={styles.rowLabel}>{fieldDef.title}</span>
                        <span className={styles.rowSummary}>
                          {fieldDef.type !== "boolean" && operators.length > 1 && (
                            <span className={styles.rowOp}>
                              {getOpLabel(filter)}{" "}
                            </span>
                          )}
                          {getSummary(filter)}
                        </span>
                      </div>
                    </button>
                    {operators.length > 1 && fieldDef.type !== "boolean" && (
                      <select
                        className={styles.operatorSelect}
                        value={filter.operator}
                        onChange={(e) => updateFilter(i, { operator: e.target.value })}
                      >
                        {operators.map((op) => (
                          <option key={op.key} value={op.key}>
                            {op.title}
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      type="button"
                      className={styles.removeBtn}
                      onClick={() => removeFilter(i)}
                      aria-label="Remove filter"
                    >
                      <CloseIcon size={11} strokeWidth={2.5} />
                    </button>
                  </div>

                  {expanded && (
                    <div className={styles.rowExpanded}>
                      {fieldDef.type === "boolean" && (
                        <div className={styles.boolControl}>
                          {(
                            [
                              ["1", "Yes"],
                              ["0", "No"],
                            ] as const
                          ).map(([v, label]) => (
                            <button
                              type="button"
                              key={v}
                              className={
                                filter.value[0] === v
                                  ? styles.boolBtnActive
                                  : styles.boolBtn
                              }
                              onClick={() => updateFilter(i, { value: [v] })}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      )}

                      {!isBoolean && filterValues === undefined && (
                        <p className={styles.loadingInline}>Loading values…</p>
                      )}

                      {!isBoolean && filterValues && filterValues.length > 0 && (
                        <div className={styles.multiPills}>
                          {filterValues.map((fv) => {
                            const active = filter.value.includes(fv.value);
                            return (
                              <button
                                type="button"
                                key={fv.value}
                                className={
                                  active ? styles.pillActive : styles.pill
                                }
                                onClick={() =>
                                  updateFilter(i, {
                                    value: active
                                      ? filter.value.filter(
                                          (v) => v !== fv.value,
                                        )
                                      : [...filter.value, fv.value],
                                  })
                                }
                              >
                                {fv.title}
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {!isBoolean && filterValues && filterValues.length === 0 && (
                        <SearchControl
                          values={filter.value}
                          placeholder={`Add ${fieldDef.title.toLowerCase()}…`}
                          onChange={(value) => updateFilter(i, { value })}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {pickerOpen ? (
              <FieldPicker
                availableFields={availableFields}
                search={pickerSearch}
                onSearchChange={setPickerSearch}
                onSelect={addFilter}
                onClose={() => {
                  setPickerOpen(false);
                  setPickerSearch("");
                }}
              />
            ) : (
              <button
                type="button"
                className={styles.addBtn}
                onClick={() => setPickerOpen(true)}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M8 3v10M3 8h10"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                Add filter
              </button>
            )}
          </>
        )}
      </div>

      <div className={styles.footer}>
        <p className={styles.footerHint}>
          {isClearing
            ? "CLEARS ALL FILTERS FOR EVERYONE IN THE ROOM"
            : draft.length === 0
            ? "ADD AT LEAST ONE FILTER TO APPLY"
            : "APPLIES FOR EVERYONE IN THE ROOM"}
        </p>
        <button
          type="button"
          className={styles.proposeButton}
          disabled={!canSubmit}
          onClick={handleApply}
        >
          {isClearing ? "Clear filters" : "Apply filters"}
        </button>
      </div>
    </div>
  );
};

// The filter row stays inline: splitting it out needs an 8-prop interface,
// uglier than the row map it would replace.
