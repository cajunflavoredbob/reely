import styles from "./Loading.module.css";

// Full-viewport branded loader: the lowercase "reely" wordmark gently
// pulses in opacity + scale. Uses the same gradient + display italic
// styling as the Logo wordmark so the brand reads identically here.
export const Loading = () => (
  <div className={styles.root} role="status" aria-label="Loading reely">
    <span className={styles.wordmark} aria-hidden="true">reely</span>
  </div>
);
