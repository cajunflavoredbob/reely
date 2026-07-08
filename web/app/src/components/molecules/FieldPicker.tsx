import type { Filters } from "../../../../../types/reely";
import styles from "./FieldPicker.module.css";

// FieldPicker -- searchable list of available filter fields to add to
// the FilterPanel draft. Renders only when the picker is OPEN -- the
// "Add filter" toggle button stays in FilterPanel so the parent owns
// the open/closed state and there's no `isOpen` prop here.
//
// Extracted from FilterPanel.tsx in 0.4.47 (audit 13 #321, Option B
// split: SearchControl + FieldPicker only -- FilterRow stayed in the
// flat file because its 8-prop interface would have been uglier than
// the inline row). Source semantics unchanged; only the JSX + CSS
// module were lifted into their own files.

// Field-definition shape pulled inline from Filters['filters'][number]
// in types/reely.ts so consumers don't have to reach into Filters.
type FieldDef = Filters["filters"][number];

interface FieldPickerProps {
  availableFields: FieldDef[];
  search: string;
  onSearchChange: (search: string) => void;
  onSelect: (key: string) => void;
  onClose: () => void;
}

export const FieldPicker = ({
  availableFields,
  search,
  onSearchChange,
  onSelect,
  onClose,
}: FieldPickerProps) => (
  <div className={styles.pickerCard}>
    <div className={styles.pickerSearchRow}>
      <input
        className={styles.pickerSearch}
        placeholder="Search fields…"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        // The picker opens in response to a user action ("Add filter"
        // click), so the focus shift is user-initiated and not
        // unexpected. This is the canonical case where autoFocus is
        // acceptable even for screen-reader users (the action implies
        // "I want to type a filter name now").
        // biome-ignore lint/a11y/noAutofocus: user-initiated picker.
        autoFocus
      />
      <button
        type="button"
        className={styles.pickerCancel}
        onClick={onClose}
      >
        Cancel
      </button>
    </div>
    <div className={styles.pickerList}>
      {availableFields.length === 0 && (
        <p className={styles.pickerEmpty}>No more fields.</p>
      )}
      {availableFields.map((f) => (
        <button
          type="button"
          key={f.key}
          className={styles.pickerItem}
          onClick={() => onSelect(f.key)}
        >
          <span className={styles.pickerItemIcon}>
            {f.title.charAt(0)}
          </span>
          <div className={styles.pickerItemMeta}>
            <span className={styles.pickerItemTitle}>{f.title}</span>
            <span className={styles.pickerItemType}>{f.type}</span>
          </div>
          <span className={styles.pickerItemPlus}>+</span>
        </button>
      ))}
    </div>
  </div>
);
