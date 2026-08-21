// CardStack geometry, in one place so the call sites that settle springs by
// index cannot drift apart.

// Cards kept live in the React tree.
export const INITIAL_COUNT = 5;

// Front card plus two peeks; the rest sit at opacity:0 in the buffer.
export const VISIBLE_COUNT = 3;

//   Y_BASE  vertical lift of the front card.
//   Y_PEEK  extra lift per back card, so two card tops show above the front.
//   Z_STEP  per-index z. Larger = stronger size falloff and a more pronounced
//           rise-forward when a back card promotes.
export const Y_BASE = -30;
export const Y_PEEK = -36;
export const Z_STEP = 50;

export const yForIndex = (i: number) => Y_BASE + Y_PEEK * i;

// Non-x spring values for a card at stack index `i`. `x` is omitted: the swipe
// axis is driven by the drag, not by index.
export const springsForIndex = (i: number) => ({
  y: yForIndex(i),
  z: -Z_STEP * i,
  // Buffer cards stay at 0 and fade in as they rise into the visible window.
  opacity: i < VISIBLE_COUNT ? 1 : 0,
});

// The settle loop stays inline in CardStack.tsx: generic over an arbitrary
// Controller<...> it needs more react-spring type gymnastics than it saves.
