import { useState } from "react";
import { CloseIcon } from "../atoms/CloseIcon";
import styles from "./SearchControl.module.css";

// SearchControl -- free-text tag input used by FilterPanel for
// enumerated-but-not-server-supplied filter values. The user types a
// term, hits Enter (or clicks Apply), and the value is added to a
// tag list. Each tag has its own remove button.
//
// Extracted from FilterPanel.tsx in 0.4.47 (audit 13 #321, Option B
// split: SearchControl + FieldPicker only -- FilterRow stayed in the
// flat file because its 8-prop interface would have been uglier than
// the inline row). Source semantics unchanged; the component is a
// straight lift with its CSS module co-located.

interface SearchControlProps {
  values: string[];
  placeholder: string;
  onChange: (values: string[]) => void;
}

export const SearchControl = ({ values, placeholder, onChange }: SearchControlProps) => {
  const [q, setQ] = useState("");

  const add = (v: string) => {
    if (v.trim() && !values.includes(v.trim())) {
      onChange([...values, v.trim()]);
    }
    setQ("");
  };

  return (
    <div className={styles.searchControl}>
      <div className={styles.searchRow}>
        <input
          className={styles.searchInput}
          placeholder={placeholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(q);
            }
          }}
        />
        <button
          type="button"
          className={styles.applyBtn}
          onClick={() => add(q)}
          disabled={!q.trim()}
        >
          Apply
        </button>
      </div>
      {values.length > 0 && (
        <div className={styles.searchTags}>
          {values.map((v) => (
            <span key={v} className={styles.searchTag}>
              {v}
              <button
                type="button"
                className={styles.searchTagRemove}
                onClick={() => onChange(values.filter((x) => x !== v))}
              >
                <CloseIcon size={9} strokeWidth={2.5} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};
