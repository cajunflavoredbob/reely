import type { Filters } from "../../../../../types/reely";
import styles from "./FieldPicker.module.css";

// Searchable list of filter fields to add to the FilterPanel draft. FilterPanel
// owns the open/closed state and only mounts this when open, hence no `isOpen`.

// Named alias so consumers don't reach into Filters.
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
        // Only opens on an "Add filter" click, so the focus shift is expected,
        // screen readers included.
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
