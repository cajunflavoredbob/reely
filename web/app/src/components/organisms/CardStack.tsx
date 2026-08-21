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

import {
  INITIAL_COUNT,
  Z_STEP,
  yForIndex,
  springsForIndex,
} from "./cardStackGeometry";

// Color comes from the surrounding button styles.
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

// Measures the ref'd element itself, feeding the swipe-throw math. Not
// firstElementChild: with the ref on the stack <div> that is the dislike
// <button>, giving a ~44px throw threshold.
//
// ResizeObserver rather than measure-once, so orientation changes and
// desktop/mobile transitions re-measure. `transform` is read through a ref so
// an inline callback doesn't re-subscribe the effect every render.
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
    // Drives the empty-state subtext: with filters applied, say the deck may be
    // short because of them, not because the library is exhausted.
    //
    // Computed subscription, NOT useStore(["room"]): the whole room slice fails
    // shallow equality on every progress/match/join/leave broadcast, which
    // re-renders the gesture-hottest component in the app several times a second.
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
        // Deliberately impure: starts spring animations and dispatches
        // "finalizeRemove" from their .then(). Doing it in a useEffect would
        // mean mirroring item state outside the reducer to drive the springs.
        let newIndex = index;
        let newItems = items;

        switch (action.type) {
          case "add": {
            newIndex = index + 1;
            if (newIndex > cards.length) {
              return { items, index };
            }
            const [newCard] = cards.slice(index, newIndex);
            // Append to the back so the card rising during the swipe is the one
            // that lands on top, not a freshly inserted one.
            const backIndex = items.filter((i) => !i.removed).length;
            const controller = new Controller<Spring>({
              x: 0,
              ...springsForIndex(backIndex),
              // Start at 0 so the settle loop below fades the card in instead
              // of popping it in at full opacity.
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

            // No fade-to-1 here: the settle loop drives opacity from each
            // item's index, and forcing it would flash a buffered back card.
            break;
          }
          case "remove": {
            const item = items.find((_) => _.id === action.payload.id);
            // Gated on `x.idle`: marking `removed: true` on a non-idle
            // controller strands the card, because the .then() that dispatches
            // `finalizeRemove` never runs. Animate, mark, and schedule the
            // finalize together, or do nothing.
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

        // Settle every item to its index's spring values, so the stack matches
        // the post-action ordering whichever branch ran.
        for (const item of newItems) {
          item.controller.start(springsForIndex(item.index));
        }

        return { index: newIndex, items: newItems };
      },
      undefined,
      // Lazy initializer: passing the object directly as arg 2 would build
      // INITIAL_COUNT throwaway Controllers on every render.
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
      // Gate on a live connection, same as the drag and keyboard paths: a tap
      // while disconnected removes the card locally but rate() is dropped, so
      // the client deck diverges from the server.
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

    // rateItem is recreated every render, but re-binding the listener only
    // matters when the values it closes over change, which the deps cover.
    // biome-ignore lint/correctness/useExhaustiveDependencies: rateItem is deliberately captured by closure; its deps are listed instead.
    useEffect(() => {
      const handler = (e: KeyboardEvent) => {
        if (connectionStatus !== "connected") {
          return;
        }

        // Ignore arrows from editable/interactive elements: FilterPanel's
        // inputs and <select>s stay mounted alongside the stack, and ratings
        // are permanent server-side, so a caret move must not create a like.
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
                    x: controller.springs.x.get() + x,
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
          // The whole removal is gated on connected, not just the velocity
          // branch: use-gesture keeps tracking movement while disconnected, so
          // a long drag would remove a card whose rate() is silently dropped.
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
                onDragStart={(e) => e.preventDefault()} // the native drag ghost cancels the pointer gesture
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
  // areEqual always returns true: the spring controllers own their animation
  // state, and re-rendering on a prop change would recreate them mid-animation.
  // Room.tsx remounts via `key={room.mediaVersion}` to deliver a new card set.
  //
  // INVARIANT: new props will NOT flow through at runtime; this memo blocks
  // every re-render. To influence the stack mid-life, either bump
  // `room.mediaVersion`, read a store selector inside the body, or drop this
  // memo and check every re-render path for animation safety.
  () => true,
);
