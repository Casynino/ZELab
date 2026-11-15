import { useSyncExternalStore } from 'react';

// "Has this phone asked for less motion?" — the same answer motion/react's useReducedMotion gives, without
// the animation library (15 Nov 2026). The page shell, the stat cards, the rings and the sign-in page only
// need this yes/no, and importing it from motion put the whole library (about 42 KB) in front of every first
// open, the sign-in page included. Follows the setting live, like the library's hook.
const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(QUERY);
  if (mq.addEventListener) {
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }
  mq.addListener(onChange); // Safari before 14
  return () => mq.removeListener(onChange);
}

const current = () => (typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(QUERY).matches);

export function useReducedMotion() {
  return useSyncExternalStore(subscribe, current, () => false);
}
