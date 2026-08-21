import { useState } from "react";
import { CloseIcon } from "../atoms/CloseIcon";
import styles from "./SearchControl.module.css";

// Free-text tag input, used by FilterPanel for filter values the server does
// not enumerate. Enter or Apply adds the term to the tag list.

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
