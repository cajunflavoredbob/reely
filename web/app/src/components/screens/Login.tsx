import { useEffect, useLayoutEffect, useRef, useState } from "react";
import styles from "./Login.module.css";
import { Logo } from "../atoms/Logo";
import { ProviderIcon } from "../atoms/ProviderIcon";
import { Layout } from "../layout/Layout";
import { useStore } from "../../store";
import { sanitizeUserInput, sanitizeRoomNameDisplay } from "../../utils/sanitize";

export const LoginScreen = () => {
  const [{ user, error, room, config, connectionStatus }, dispatch] =
    useStore(["user", "error", "room", "config", "connectionStatus"]);

  // useState lazy initializers (audit 13 #308): URLSearchParams + localStorage
  // are read ONCE on mount, not on every render. The prior pattern parsed
  // `location.search` and called `localStorage.getItem` synchronously inside
  // the component body, which re-ran on every render even though the result
  // is mount-time-stable (subsequent renders ignore the value anyway because
  // useState only honors its initial-value arg on first run). The lazy form
  // passes a function that React only invokes the first time.
  const [userName, setUserName] = useState(() => localStorage.getItem("userName") ?? "");
  const [nameEditing, setNameEditing] = useState(() => (localStorage.getItem("userName") ?? "") === "");
  const [userNameError, setUserNameError] = useState<string | undefined>();
  const [roomName, setRoomName] = useState(() => new URLSearchParams(location.search).get("roomName") ?? "");
  const [roomNameError, setRoomNameError] = useState<string | undefined>();

  // String | null instead of boolean (audit 12 #216): captures the room
  // name AT the submit moment so a user who keeps typing between submit
  // and the deferred-join firing can't ship a stale roomName. The input
  // isn't disabled until the room exists, so per-render ref updates
  // (the prior 0.4.6 #115 fix) still reflected the latest input value
  // instead of the value the user clicked "join" with.
  const pendingJoinRoom = useRef<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const roomInputRef = useRef<HTMLInputElement>(null);

  // Chip→edit transition: track that the user opened the input via the chip,
  // so the layout effect can select-all on the next render. Also remember the
  // pre-edit value so ESC can restore it.
  const selectOnEditMount = useRef(false);
  const preEditName = useRef("");

  const trimmedUser = userName.trim();
  const trimmedRoom = roomName.trim();

  // Once login resolves, fire the deferred join/create with the room name
  // captured AT submit (pendingJoinRoom.current is set in handleSubmit).
  // biome-ignore lint/correctness/useExhaustiveDependencies: dispatch is stable; the join only fires on the user transition, not on dispatch identity changes.
  useEffect(() => {
    if (!user || pendingJoinRoom.current === null) return;
    const roomName = pendingJoinRoom.current;
    pendingJoinRoom.current = null;
    dispatch({
      type: "joinOrCreateRoom",
      payload: { roomName },
    });
  }, [user]);

  // Clear the deferred-join slot on any login/join error so a later auto-set
  // of `user` (e.g., WS reconnect populating the cached session) doesn't
  // silently fire a stale joinOrCreateRoom on the user's behalf.
  useEffect(() => {
    if (error) pendingJoinRoom.current = null;
  }, [error]);

  // When the user transitions from chip → input, focus and select the text
  // synchronously after the input renders. useLayoutEffect avoids the visible
  // flash of an unfocused, unselected field that setTimeout(0) leaves behind.
  useLayoutEffect(() => {
    if (nameEditing && selectOnEditMount.current) {
      selectOnEditMount.current = false;
      nameInputRef.current?.select();
    }
  }, [nameEditing]);

  const validate = () => {
    let ok = true;
    if (!trimmedUser) {
      setUserNameError("Required");
      setNameEditing(true);
      ok = false;
    }
    if (!trimmedRoom) {
      setRoomNameError("Required");
      ok = false;
    }
    return ok;
  };

  const handleSubmit = () => {
    if (nameEditing && trimmedUser) setNameEditing(false);
    if (!validate()) return;
    if (!user || trimmedUser !== user.userName) {
      // Not logged in yet, OR the cached username was edited via the name
      // chip. Either way (re-)login under the current name first so the
      // server identity matches before joining -- otherwise an edited name
      // would join the room under the stale server-side username.
      //
      // Snapshot the room name at THIS moment (audit 12 #216) -- the user
      // can keep typing while the login round-trip completes, and the
      // deferred-join effect must dispatch the name they clicked with,
      // not whatever the input shows by the time the user-set lands.
      pendingJoinRoom.current = trimmedRoom;
      dispatch({ type: "login", payload: { userName: trimmedUser } });
    } else {
      dispatch({
        type: "joinOrCreateRoom",
        payload: { roomName: trimmedRoom },
      });
    }
  };

  const openChipForEdit = () => {
    preEditName.current = userName;
    selectOnEditMount.current = true;
    setNameEditing(true);
  };

  const isValid = trimmedUser.length > 0 && trimmedRoom.length > 0;
  const isJoining = !!room && !room.joined;

  return (
    <Layout hideLogo className={styles.screen}>
      <div className={styles.inner}>
        <div className={styles.topBar}>
          <Logo size={36} withWord />
          {config?.serverName && (
            <div className={styles.serverChip}>
              <ProviderIcon type={config.providerType} size={18} />
              <span className={styles.serverName}>{config.serverName}</span>
              <span className={styles.serverDot} data-status={connectionStatus} />
            </div>
          )}
        </div>

        <div className={styles.spacer} />

        <h1 className={styles.headline}>pick tonight's screening.</h1>
        <p className={styles.subline}>pick a room. anyone with the room name joins you.</p>

        {error && (
          <div className={styles.errorBox}>
            {error.message ?? "Something went wrong"}
          </div>
        )}

        <form
          className={styles.form}
          onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}
        >
          <div className={styles.fieldGroup}>
            <span className={styles.fieldLabel}>User Name</span>
            {!nameEditing && userName ? (
              <button
                type="button"
                className={styles.nameChip}
                onClick={openChipForEdit}
              >
                <span className={styles.nameChipAvatar}>
                  {userName.charAt(0).toUpperCase()}
                </span>
                <span className={styles.nameChipText}>{userName}</span>
                <span className={styles.nameChipSep} aria-hidden />
                <span className={styles.nameChipChange}>Change</span>
              </button>
            ) : (
              <div className={styles.nameInputWrapper}>
                <span className={styles.nameInputAvatar} aria-hidden>
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <circle cx="10" cy="10" r="9" stroke="var(--ry-line-strong)" strokeWidth="1.5" strokeDasharray="3 2" fill="none" />
                    <circle cx="10" cy="8" r="3" fill="var(--ry-text-3)" />
                    <path d="M3.5 17.5c0-3.5 2.9-6 6.5-6s6.5 2.5 6.5 6" stroke="var(--ry-text-3)" strokeWidth="1.5" strokeLinecap="round" fill="none" />
                  </svg>
                </span>
                <input
                  ref={nameInputRef}
                  className={styles.nameInput}
                  type="text"
                  aria-label="Your name"
                  placeholder="what should we call you?"
                  autoComplete="given-name"
                  // userName is seeded from localStorage at mount; an empty
                  // userName at mount means no stored session, so autoFocus
                  // the field. Subsequent renders' value doesn't affect the
                  // DOM autofocus behavior anyway -- it's consulted at
                  // element insertion only. This is the login screen's
                  // primary input on a no-stored-session boot; auto-focusing
                  // matches the user's clear next action.
                  // biome-ignore lint/a11y/noAutofocus: primary input on first boot.
                  autoFocus={!userName}
                  // Mirror the server's 64-char sanitizeInput slice so a
                  // longer name isn't silently truncated server-side.
                  maxLength={64}
                  value={userName}
                  onChange={(e) => {
                    // Pass the same 64-char cap to the sanitizer so the
                    // length bound holds even if the JSX maxLength above
                    // ever drops out.
                    setUserName(sanitizeUserInput(e.target.value, 64));
                    setUserNameError(undefined);
                  }}
                  onBlur={() => {
                    if (trimmedUser) setNameEditing(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (trimmedUser) {
                        setNameEditing(false);
                        roomInputRef.current?.focus();
                      }
                    } else if (e.key === "Escape" && preEditName.current) {
                      e.preventDefault();
                      setUserName(preEditName.current);
                      setUserNameError(undefined);
                      setNameEditing(false);
                    }
                  }}
                />
              </div>
            )}
            {userNameError && <span className={styles.fieldError}>{userNameError}</span>}
          </div>

          <div className={styles.fieldGroup}>
            <span className={styles.fieldLabel}>Room Name</span>
            <div className={styles.roomInputWrapper}>
              <span className={styles.roomHash} aria-hidden>#</span>
              <input
                ref={roomInputRef}
                className={styles.roomInput}
                type="text"
                aria-label="Room name"
                placeholder="name your room"
                // Mirrors the server's ROOM_NAME_MAX_LEN (util/sanitize.ts).
                maxLength={48}
                value={roomName}
                onChange={(e) => {
                  // Same belt-and-suspenders length bound as the userName
                  // input -- mirrors server's ROOM_NAME_MAX_LEN.
                  setRoomName(sanitizeRoomNameDisplay(e.target.value, 48));
                  setRoomNameError(undefined);
                }}
              />
            </div>
            {roomNameError && <span className={styles.fieldError}>{roomNameError}</span>}
          </div>

          <button
            type="submit"
            className={styles.ctaButton}
            disabled={!isValid || isJoining}
            data-test-handle="join-room"
          >
            {isJoining ? "joining…" : "start screening"}
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </form>

        <p className={styles.footer}>rooms expire 6h after last swipe</p>
      </div>
    </Layout>
  );
};
