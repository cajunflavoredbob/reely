import {
  memo,
  type ReactNode,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import type { Media } from "../../../../../types/reely";
import { useGesture } from "@use-gesture/react";
import { animated, Controller } from "@react-spring/web";
import { Tr } from "../atoms/Tr";
import { useStore, useStoreComputed } from "../../store";

import styles from "./CardStack.module.css";
const { abs, sign } = Math;

type Card = Media;

interface CardStackProps {
  cards: Card[];
  renderCard: (card: Card) => ReactNode;
  onCardDismissed: (card: Card, direction: "left" | "right") => void;
}

type Spring = {
  x: number;
  y: number;
  z: number;
  opacity: number;
};

// Geometry constants + helpers live in a sibling module (audit 13 #323).
import {
  INITIAL_COUNT,
  Z_STEP,
  yForIndex,
  springsForIndex,
} from "./cardStackGeometry";

// Module-scope SVG paths for the like / dislike / empty-state heart
// (audit 13 #323). The two button SVGs and the empty-state heart were
// previously inline in the JSX even though their geometry never
// changes; hoisting them keeps the JSX readable and makes the visual
// vocabulary explicit. Used with currentColor / explicit fill so the
// surrounding button styles still control color.
const HEART_PATH = "M12 21s-7-4.5-7-11a4 4 0 017-2.6A4 4 0 0119 10c0 6.5-7 11-7 11z";
const X_PATH = "M6 6l12 12M18 6L6 18";

interface StackItem<T> {
  id: string;
  index: number;
  controller: Controller<Spring>;
  item: T;
  removed: boolean;
}

const useViewportWidth = (transform?: (n: number) => number) => {
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  useEffect(() => {
    const handler = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return transform ? transform(viewportWidth) : viewportWidth;
};

// Measures the ref'd element's own width. Used for the card-stack width that
// feeds the swipe-throw math. The previous version measured firstElementChild,
// which -- with the ref on the stack <div> -- was the dislike <button>, not a
// card, so the throw threshold was computed against a ~44px width.
//
// 0.4.2:
//   - ResizeObserver re-measures on orientation change, responsive
//     desktop<->mobile transitions, and any container resize. The earlier
//     measure-once-on-mount left the throw threshold stuck at the original
//     width across these (audit 8 #87).
//   - The `transform` callback is read via a ref so the effect doesn't
//     re-subscribe just because the parent recreated the fn inline each
//     render. Today no caller passes one, but the dep was latent (audit 9
//     #100).
const useElementWidth = (transform?: (n: number) => number) => {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const transformRef = useRef(transform);
  transformRef.current = transform;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (rect: { width: number }) => {
      const t = transformRef.current;
      setWidth(t ? t(rect.width) : rect.width);
    };
    apply(el.getBoundingClientRect());
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) apply(entry.contentRect);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width] as const;
};

export const CardStack = memo(
  ({ cards, renderCard, onCardDismissed }: CardStackProps) => {
    const vw = useViewportWidth((n) => Math.min(n, 800) / 2);
    const [{ connectionStatus }] = useStore(["connectionStatus"]);
    // Drive the empty-state subtext: when the user has filters applied
    // and runs out of cards, suggest broadening them. Without this hint
    // they just see "That's all folks" and may not realize they're not
    // seeing the full library (audit 16 / 0.5.22).
    //
    // Computed-value subscription, NOT useStore(["room"]) (audit 16 #432):
    // the 0.5.22 form picked the whole room slice for this one boolean,
    // which failed shallow equality -- and re-rendered the gesture-hottest
    // component in the app -- on every userProgress/match/join/leave
    // broadcast, several times a second in an active multi-user room. The
    // boolean only flips when filters apply, which already remounts the
    // stack via key={room.mediaVersion} anyway.
    const hasActiveFilters = useStoreComputed(
      (s) => (s.room?.activeFilters?.length ?? 0) > 0,
    );
    const [elRef, ew] = useElementWidth();

    const [{ items }, dispatch] = useReducer(
      function reducer(
        { items, index }: { items: StackItem<Card>[]; index: number },
        action:
          | { type: "add" }
          | {
            type: "remove";
            payload: { id: string; direction: "left" | "right" };
          }
          | { type: "finalizeRemove"; payload: { id: string } },
      ) {
        // Pragmatic impurity: this reducer kicks off spring animations
        // (controller.start) and resolves them with a .then() that
        // dispatches a follow-up "finalizeRemove" action. Reducers should
        // strictly be pure, but the controller + state are co-located here
        // and moving the animation kickoff to a useEffect would require
        // mirroring item state outside the reducer just to drive springs.
        // Accepting the antipattern deliberately rather than splitting state.
        let newIndex = index;
        let newItems = items;

        switch (action.type) {
          case "add": {
            newIndex = index + 1;
            if (newIndex > cards.length) {
              return { items, index };
            }
            const [newCard] = cards.slice(index, newIndex);
            // Append to the back so the card visually rising during the swipe
            // is the one that actually lands on top -- not a freshly inserted one.
            const backIndex = items.filter((i) => !i.removed).length;
            const controller = new Controller<Spring>({
              x: 0,
              ...springsForIndex(backIndex),
              // Override opacity to 0 so the new card fades in via the
              // settleAll below instead of popping in at full opacity.
              opacity: 0,
            });
            newItems = [
              ...items,
              {
                id: newCard.id,
                item: newCard,
                index: backIndex,
                controller,
                removed: false,
              },
            ];

            // The settle loop below now drives opacity (along with y/z) based
            // on each item's current index, so the unconditional fade-to-1
            // here is no longer needed -- it'd briefly flash a card that
            // belongs hidden in the back of the buffer.
            break;
          }
          case "remove": {
            const item = items.find((_) => _.id === action.payload.id);
            // Gate the entire branch on `x.idle` (audit 13 #309 / audit 14
            // sibling-fold). The prior code marked `removed: true` even
            // when the controller wasn't idle and the .then() chain that
            // dispatches `finalizeRemove` never ran -- leaving a ghost
            // entry that stayed marked `removed: true` forever. The
            // non-idle case is rare (would require a re-dispatch on an
            // already-swiping card, which the !removed filter at the
            // dispatch sites mostly prevents) but the state-transition
            // dead-end was real. Now: either we start the animation AND
            // mark the card removed AND schedule the finalize, or we
            // do nothing. The user's swipe is effectively ignored when
            // we refuse, which is preferable to a ghost.
            if (item?.controller.springs.x.idle) {
              const itemIndex = items.indexOf(item);

              item.controller
                .start({
                  x: (action.payload.direction === "left" ? -1 : 1) *
                    (vw + ew),
                  config: { duration: 150 },
                })
                .then(() => {
                  dispatch({
                    type: "finalizeRemove",
                    payload: { id: action.payload.id },
                  });
                  onCardDismissed(item.item, action.payload.direction);
                });

              newItems = items.map((item, i) =>
                item.id === action.payload.id ? { ...item, removed: true } : {
                  ...item,
                  index: i > itemIndex ? item.index - 1 : item.index,
                }
              );
            }
            break;
          }
          case "finalizeRemove": {
            if (newItems.find((_) => _.id === action.payload.id)) {
              newItems = newItems.filter((_) => _.id !== action.payload.id);
            }
            break;
          }
        }

        // Settle every item to its index's spring values (audit 13 #323).
        // Whether we added, removed, or finalized above, the visible
        // stack now matches the post-action index ordering.
        for (const item of newItems) {
          item.controller.start(springsForIndex(item.index));
        }

        return { index: newIndex, items: newItems };
      },
      undefined,
      // Lazy initializer: React only invokes this once, on mount. The previous
      // form (passing the object directly as arg 2) evaluated the expression
      // on every render, spawning INITIAL_COUNT throwaway Controller<Spring>
      // instances each time even though React only used the first batch.
      () => ({
        items: cards.slice(0, INITIAL_COUNT).map((card, i) => ({
          id: card.id,
          index: i,
          item: card,
          controller: new Controller<Spring>({
            x: 0,
            ...springsForIndex(i),
          }),
          removed: false,
        })),
        index: INITIAL_COUNT,
      }),
    );

    const rateItem = (direction: "left" | "right") => {
      // Gate on a live connection, same as the drag and keyboard paths. The
      // Pass/Like buttons call this directly -- without the check a tap while
      // disconnected removes the card locally while rate() is dropped, so the
      // client deck diverges from the server.
      if (connectionStatus !== "connected") return;

      const item = items.find((_) => !_.removed);

      if (item) {
        dispatch({
          type: "remove",
          payload: {
            id: item.id,
            direction,
          },
        });
        dispatch({ type: "add" });
      }
    };

    // rateItem is recreated every render but its identity-change shouldn't
    // re-bind the keyboard listener; we only need to re-bind when the
    // closed-over connectionStatus or items change (which the explicit
    // deps cover). The handler captures rateItem by closure; on the
    // next render rateItem reads the latest items/state via its own
    // closures so a stale reference works correctly.
    // biome-ignore lint/correctness/useExhaustiveDependencies: rateItem closure is intentional, see comment above.
    useEffect(() => {
      const handler = (e: KeyboardEvent) => {
        if (connectionStatus !== "connected") {
          return;
        }

        // Ignore arrows originating from editable/interactive elements.
        // FilterPanel's text inputs and operator <select>s stay mounted
        // alongside the stack on both layouts, and a caret move or option
        // change must not swipe the top card -- ratings are permanent
        // server-side, so a stray Arrow key here creates real likes and
        // can false-match the whole room. (audit 16 #420)
        const target = e.target instanceof Element ? e.target : null;
        if (target?.closest('input, textarea, select, [contenteditable="true"]')) {
          return;
        }

        if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
          rateItem(e.code === "ArrowLeft" ? "left" : "right");
        }
      };
      window.addEventListener("keydown", handler);
      return () => window.removeEventListener("keydown", handler);
    }, [items, connectionStatus]);

    const bind = useGesture(
      {
        onDrag({ args: [id], down, delta: [x], movement: [mx] }) {
          if (down && connectionStatus === "connected") {
            const p = abs(mx / (vw + ew));
            let isAfterId = false;
            items.forEach(({ removed, index, id: _id, controller }) => {
              if (!removed) {
                if (id === _id) {
                  controller.set({
                    // SpringValue.get() exists at runtime but @react-spring/web v9 doesn't expose it on the typed springs record (audit 14 #364; revisit on v10 bump).
                    // biome-ignore lint/suspicious/noExplicitAny: react-spring v9 typedef gap.
                    x: (controller.springs as any).x.get() + x,
                  });
                  isAfterId = true;
                } else {
                  const z = p * (isAfterId ? Z_STEP : -Z_STEP) -
                    index * Z_STEP;
                  controller.set({ z });
                }
              }
            });
          }
        },
        onDragEnd({ args: [id], movement: [x], velocity: [vx] }) {
          const p = abs(x / (vw + ew));
          // Gate the whole removal on connected, not just the velocity branch.
          // While disconnected the card spring never moves (onDrag is gated),
          // but use-gesture still tracks movement -- so a long drag yields
          // p > 0.5, removes the card, and rate() then silently drops the
          // message, desyncing the stack from the server.
          if (connectionStatus === "connected" && (p > 0.5 || abs(vx) > 0.5)) {
            dispatch({
              type: "remove",
              payload: {
                id,
                direction: sign(x) === -1 ? "left" : "right",
              },
            });
            dispatch({ type: "add" });
          } else {
            items.forEach(({ removed, index, id: _id, controller }) => {
              if (!removed) {
                if (id === _id) {
                  controller.start({ x: 0, opacity: 1 });
                } else {
                  controller.start({
                    y: yForIndex(index),
                    z: -index * Z_STEP,
                    config: { duration: 50, velocity: 1000 },
                  });
                }
              }
            });
          }
        },
      },
      { drag: { axis: "x" } },
    );

    const isEmpty = items.length === 0;

    return (
        <div className={isEmpty ? styles.emptyStack : styles.stack} ref={elRef}>
          {isEmpty && (
            <>
              <div className={styles.emptyIcon}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d={HEART_PATH} stroke="var(--ry-pink)" strokeWidth="2" />
                </svg>
              </div>
              <p className={styles.emptyText}>That's everything.</p>
              <p className={styles.emptySubtext}>
                <Tr
                  name={
                    hasActiveFilters
                      ? "RATE_SECTION_EXHAUSTED_CARDS_FILTERED"
                      : "RATE_SECTION_EXHAUSTED_CARDS"
                  }
                />
              </p>
            </>
          )}
          {!isEmpty && (
            <>
              <button
                type="button"
                className={styles.dislikeButton}
                onClick={() => rateItem("left")}
                aria-label="Pass"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d={X_PATH} stroke="var(--ry-pink)" strokeWidth="2.5" strokeLinecap="round" />
                </svg>
              </button>
              <button
                type="button"
                className={styles.likeButton}
                onClick={() => rateItem("right")}
                aria-label="Like"
              >
                <svg width="26" height="26" viewBox="0 0 24 24" fill="white" aria-hidden="true">
                  <path d={HEART_PATH} />
                </svg>
              </button>
            </>
          )}
          {items.map((item) => {
            const { x, y, z, opacity } = item.controller.springs;
            const isFront = item.index === 0;
            return (
              <animated.div
                key={item.id}
                data-index={item.index}
                className={styles.item}
                style={{
                  x,
                  y,
                  z,
                  opacity: opacity.to([0.1, 0.8, 1], [0, 1, 1]),
                  zIndex: INITIAL_COUNT - item.index,
                }}
                onDragStart={(e) => e.preventDefault()} // prevents native browser drag ghost from cancelling the spring-based pointer gesture
                {...bind(item.id)}
              >
                <div className={styles.cardWrapper}>
                  {renderCard(item.item)}
                  {isFront && (
                    <>
                      <animated.div
                        className={styles.likeHint}
                        style={{
                          opacity: x.to(
                            (v) => Math.min(1, Math.max(0, v / 80)),
                          ),
                        }}
                      />
                      <animated.div
                        className={styles.dislikeHint}
                        style={{
                          opacity: x.to(
                            (v) => Math.min(1, Math.max(0, -v / 80)),
                          ),
                        }}
                      />
                    </>
                  )}
                </div>
              </animated.div>
            );
          })}
        </div>
    );
  },
  // areEqual always returns true: spring controllers (react-spring) own
  // their animation state internally, and re-rendering on a prop change
  // would tear down + recreate the controllers mid-animation. The parent
  // (Room.tsx) forces a full remount via `key={room.mediaVersion}` when
  // the card set genuinely changes -- that is the ONLY supported path
  // for new cards to enter this component.
  //
  // INVARIANT: do not add props to CardStackProps expecting them to flow
  // through at runtime. They won't -- this memo blocks every re-render.
  // If a new piece of state must influence the stack mid-life, either:
  //   (a) bump `room.mediaVersion` so the parent remounts CardStack, or
  //   (b) move the state into a Zustand selector read inside the body,
  //   or
  //   (c) remove this always-true memo and audit every re-render path
  //       for animation safety.
  () => true,
);
