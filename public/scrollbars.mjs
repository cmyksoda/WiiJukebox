// Marks a scroller while it moves, so its slim scrollbar (style.css) can fade in with the scrolling and back out after it.

const IDLE_MS = 800;
const timers = new WeakMap();

// A scroll event does not bubble, so one capturing listener on the document hears every scroller.
document.addEventListener('scroll', (event) => {
    const scroller = event.target;
    if (!(scroller instanceof Element)) return;
    scroller.classList.add('is-scrolling');
    clearTimeout(timers.get(scroller));
    timers.set(scroller, setTimeout(() => scroller.classList.remove('is-scrolling'), IDLE_MS));
}, { capture: true, passive: true });
