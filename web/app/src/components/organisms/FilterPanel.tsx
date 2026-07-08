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
  // Whether the panel is currently visible. Used to re-sync `draft` from
  // `room.activeFilters` on each false → true transition. Desktop keeps the
  // panel permanently mounted, so without this the draft would stay frozen
  // at whatever activeFilters were when the component first mounted.
  // Mobile mounts conditionally, so isOpen=true matches mount; the re-sync
  // is harmless in that case.
  isOpen?: boolean;
}

// Clone activeFilters so the draft state doesn't share references with the
// store (a setDraft(d => d.map(...)) on a row would otherwise also mutate
// the underlying array's filter objects). Filter is a flat shape so a shallow
// clone per row is enough.
const cloneActiveFilters = (active: Filter[] | undefined): Filter[] =>
  (active ?? []).map((f) => ({ ...f, value: [...f.value] }));

export const FilterPanel = ({ onClose, onApply, isDrawer = false, isOpen = true }: FilterPanelProps) => {
  const [{ createRoom, room }] = useStore(["createRoom", "room"]);
  const dispatch = useDispatch();
  const [draft, setDraft] = useState<Filter[]>(() => cloneActiveFilters(room?.activeFilters));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  // Keyed by `filter.key` (audit 11 #183 + #184). The prior `Set<number>`
  // was indexed into the draft array and removeFilter had to manually
  // shift indices to keep the set in sync. Keying on the (stable, React-
  // key-identical) filter.key eliminates the shift dance AND the
  // addFilter setState-updater-inside-updater pattern (#183), because we
  // no longer need to compute the new row's index inside the setter.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  // Room.tsx already prefetches the filter catalog at mount so the
  // filterChangeApplied toast can resolve titles even before the panel
  // opens. Audit 12 #242 caught us double-dispatching on desktop (where
  // FilterPanel is permanently mounted alongside Room): both effects
  // fired in the same render tick, both guard checks passed, and the
  // server saw two `requestFilters` for one room. Dropping the dispatch
  // here is safe because Room's prefetch covers every code path that
  // reaches FilterPanel.

  // Re-sync draft from activeFilters on every false → true transition of
  // isOpen. While the panel is open we keep the user's in-progress edits
  // (do NOT overwrite when activeFilters changes mid-edit -- e.g. another
  // user applies filters). Snapping on each open means the panel reflects
  // current room state when the user comes back to it. Also fires the
  // requestFilterValues prefetch for any pre-populated rows so the
  // collapsed-row summary can render real value titles ("Drama, Action")
  // instead of raw ids.
  const prevIsOpen = useRef(isOpen);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally NOT depending on room?.activeFilters / createRoom / dispatch -- mid-edit changes shouldn't blow away the user's in-progress draft; the snap only fires on the open transition.
  useEffect(() => {
    if (isOpen && !prevIsOpen.current) {
      const fresh = cloneActiveFilters(room?.activeFilters);
      setDraft(fresh);
      setExpandedRows(new Set());
      // Also reset the FieldPicker (audit 16 #454): on desktop the panel
      // stays mounted while closed, so an open picker + typed query
      // otherwise survived the close and greeted the next open with
      // stale state -- defeating this re-sync's purpose.
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

  // Mount-only prefetch for the initial draft (lazy-init from activeFilters).
  // Subsequent rows added via addFilter dispatch on their own; the open-
  // transition effect above handles the re-sync case.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only prefetch -- adding draft/createRoom/dispatch as deps would re-fire on every state change and double up the requestFilterValues dispatches.
  useEffect(() => {
    for (const f of draft) {
      if (!createRoom?.filterValues?.[f.key]) {
        dispatch({ type: "requestFilterValues", payload: { key: f.key } });
      }
    }
  }, []);

  const filters = createRoom?.availableFilters;
  // Memoize the three computed values that recompute per keystroke
  // (audit 13 #331): usedKeys reads `draft`, fieldsByKey reads
  // `filters`, and availableFields reads all three (plus pickerSearch).
  // Without memo, typing in the picker re-walked filters.filters and
  // rebuilt the usedKeys Set on every keystroke -- modest cost today
  // but the kind of thing that compounds with React.memo on the
  // child rows (#334).
  const usedKeys = useMemo(
    () => new Set(draft.map((d) => d.key)),
    [draft],
  );
  // fieldsByKey is the precomputed lookup map (audit 13 #332). The
  // prior code did `filters?.filters.find((f) => f.key === filter.key)`
  // per filter row per render -- O(rows * fields). With ~6 fields and
  // a few rows it's tiny, but the find() loop scales poorly if either
  // grows. Map lookup is O(1) per row.
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
    // expandedRows is now keyed by filter.key (stable across reorders),
    // so the expand toggle is a simple Set update -- no stale-index
    // hazard, no nested setter (audit 11 #183 / #184).
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
    // Capture the row's key BEFORE the setDraft updater so we can prune
    // expandedRows by key (no index-shift dance needed).
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
    // Dispatch OUTSIDE the state updater (audit 16 #456): updaters must be
    // pure -- StrictMode double-invokes them in dev, which sent a
    // duplicate requestFilterValues WS frame per row expansion, and React
    // reserves the right to re-invoke in production too. Mirrors the
    // shape addFilter already uses (audit 11 #183/#184).
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

  // Single source of truth for "is this filter row applicable" (audit 13
  // #327). A boolean filter is applicable whether or not it has a value;
  // a non-boolean filter needs at least one selected value to count. The
  // prior code inlined this predicate twice (canApply gate + handleApply
  // serialization) which made it easy to drift one out of sync with the
  // other.
  const isFilterApplicable = (f: Filter): boolean => {
    const fd = fieldsByKey.get(f.key);
    return fd?.type === "boolean" || f.value.length > 0;
  };

  const canApply = draft.filter(isFilterApplicable).length > 0;

  // "Clear" mode: the draft has no applicable filters but the room currently
  // has filters applied -- submitting an empty set clears them. Without this
  // an applied filter set could never be removed from the UI (the button was
  // simply disabled with an empty draft).
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
              // Server-returned enumerated values for this field. Three states:
              //   undefined  -- request in flight (show "Loading values...")
              //   [...]      -- has values (show pills, regardless of fieldDef.type)
              //   []         -- confirmed no values (show free-text SearchControl)
              // The previous gate used fieldDef.type === "tag" || "string", which
              // missed integer-typed fields that Plex actually enumerates -- decade
              // being the canonical case (1900s, 1910s, ...).
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

// SearchControl extracted to molecules/SearchControl.tsx in 0.4.47
// (audit 13 #321, Option B split). FieldPicker extracted alongside it
// to molecules/FieldPicker.tsx. FilterRow stayed inline -- the 8-prop
// interface required for a useful split would have been uglier than
// the current inline row map.
