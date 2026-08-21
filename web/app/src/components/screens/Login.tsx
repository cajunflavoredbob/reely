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

  // Lazy initializers so localStorage and URLSearchParams are read once, on
  // mount, rather than on every render.
  const [userName, setUserName] = useState(() => localStorage.getItem("userName") ?? "");
  const [nameEditing, setNameEditing] = useState(() => (localStorage.getItem("userName") ?? "") === "");
  const [userNameError, setUserNameError] = useState<string | undefined>();
  const [roomName, setRoomName] = useState(() => new URLSearchParams(location.search).get("roomName") ?? "");
  const [roomNameError, setRoomNameError] = useState<string | undefined>();

  // Holds the room name as of the submit click. The input stays editable until
  // the room exists, so anything read later reflects continued typing rather
  // than what the user submitted.
  const pendingJoinRoom = useRef<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const roomInputRef = useRef<HTMLInputElement>(null);

  // Chip→edit: flags that the layout effect should select-all next render, and
  // keeps the pre-edit value for ESC to restore.
  const selectOnEditMount = useRef(false);
  const preEditName = useRef("");

  const trimmedUser = userName.trim();
  const trimmedRoom = roomName.trim();

  // Once login resolves, fire the deferred join with the name captured at submit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dispatch is stable; the join must fire on the user transition, not on dispatch identity changes.
  useEffect(() => {
    if (!user || pendingJoinRoom.current === null) return;
    const roomName = pendingJoinRoom.current;
    pendingJoinRoom.current = null;
    dispatch({
      type: "joinOrCreateRoom",
      payload: { roomName },
    });
  }, [user]);

  // Clear the deferred-join slot on error, so a later auto-set of `user` (a WS
  // reconnect restoring the cached session) can't fire a stale join.
  useEffect(() => {
    if (error) pendingJoinRoom.current = null;
  }, [error]);

  // useLayoutEffect, not an effect or setTimeout(0): selecting after paint
  // flashes an unfocused, unselected field.
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
      // Not logged in, or the cached username was edited via the chip.
      // (Re-)login first, or the join lands under the stale server-side name.
      //
      // Snapshot the room name now: the user can keep typing during the login
      // round-trip, and the deferred join must use what they clicked with.
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
                  // Empty userName at mount means no stored session, so this is
                  // the screen's primary input and the user's next action.
                  // biome-ignore lint/a11y/noAutofocus: primary input on first boot.
                  autoFocus={!userName}
                  // Mirrors the server's 64-char sanitizeInput slice, so longer
                  // names aren't silently truncated server-side.
                  maxLength={64}
                  value={userName}
                  onChange={(e) => {
                    // Same cap here so the bound holds if maxLength is dropped.
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
                  // Same cap here so the bound holds if maxLength is dropped.
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
