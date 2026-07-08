// CardStack geometry constants + helpers (audit 13 #323). Extracted from
// CardStack.tsx so the same per-index spring values are computed in
// exactly one place. Three call sites used to inline the same
// `{ y: yForIndex(i), z: -i * Z_STEP, opacity: i < VISIBLE_COUNT ? 1 : 0 }`
// triple: initial mount, reducer trailing settle, and a few ad-hoc
// `controller.start` calls. Drift between them was a real risk.


// How many cards stay live in the React tree at any moment. The
// off-screen buffer absorbs the eventual fade-in as a back card promotes.
export const INITIAL_COUNT = 5;

// Only the first three cards (front + two peeks) are visible at any
// moment. Cards beyond that stay opacity:0 in the spring; when a peek
// promotes forward, the next back card fades in to fill the third-peek
// slot.
export const VISIBLE_COUNT = 3;

// Stack geometry. Tuned to read as a logo-style stack of cards: the
// front card sits low with the next two cards visibly peeking above it,
// each shrunk by perspective foreshortening.
//   Y_BASE  -- baseline vertical lift applied to the front card (kept
//              at -30 to preserve the previous front-card position).
//   Y_PEEK  -- each back card sits this many px higher than the card
//              in front of it, so two card tops are visible above the
//              front.
//   Z_STEP  -- per-index z translation. Larger = more pronounced size
//              difference between layers AND more pronounced "rise
//              forward" when a back card promotes to front after a
//              swipe.
export const Y_BASE = -30;
export const Y_PEEK = -36;
export const Z_STEP = 50;

export const yForIndex = (i: number) => Y_BASE + Y_PEEK * i;

// The full set of non-x spring values for a card at stack index `i`.
// `x` is the swipe axis and is driven by the user's drag / the swipe
// animation, NOT by index, so it's deliberately omitted here.
export const springsForIndex = (i: number) => ({
  y: yForIndex(i),
  z: -Z_STEP * i,
  // Hidden buffer cards stay at 0; when one promotes into the visible
  // window the spring fades it in as it rises forward.
  opacity: i < VISIBLE_COUNT ? 1 : 0,
});

// `settleAll(items)` lives in CardStack.tsx (where the full Spring type
// is in scope) rather than here, because making it generic over an
// arbitrary Controller<...> involves enough type gymnastics with
// react-spring's SpringValues / ControllerUpdate machinery that the
// helper ends up more confusing than the for-loop it replaces. The
// constants + yForIndex + springsForIndex extracted above were the
// real duplication; the trailing settle loop becomes a one-liner with
// springsForIndex even without a helper.
