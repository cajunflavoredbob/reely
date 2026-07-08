import { Layout } from "../layout/Layout";
import styles from "./Config.module.css";

// Shown when the server has no Plex provider configured. Deliberately has no
// inputs -- Plex credentials are supplied only through environment variables,
// so there is no way (and no need) to submit configuration from the browser.
// The container log carries the actionable detail for whoever runs the server.
export const ConfigScreen = () => (
  <Layout>
    <div className={styles.notice}>
      <h1 className={styles.heading}>reely isn't set up yet</h1>
      <p className={styles.body}>
        This reely server hasn't been configured. Check back once it's ready.
      </p>
    </div>
  </Layout>
);
