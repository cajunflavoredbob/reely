import styles from "./Loading.module.css";

// Full-viewport branded loader: the wordmark pulses in opacity and scale.
export const Loading = () => (
  <div className={styles.root} role="status" aria-label="Loading reely">
    <span className={styles.wordmark} aria-hidden="true">reely</span>
  </div>
);
