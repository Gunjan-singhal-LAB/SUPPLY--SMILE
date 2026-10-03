// Supply Smile - the Smile-meter loader on the sign-in and setup pages.
// The tooth fills with bright enamel as the app really loads:
//   page ready (35%) -> icons and fonts ready (60%) -> server answered (90%) -> done (100%)
// then it sparkles, fades away, and the sign-in card slides up.
// Shown once per browser session; skipped for people who prefer reduced motion.
const SmileLoader = (() => {
  const root = document.getElementById('smile-loader');
  const quick = document.documentElement.classList.contains('ss-quick');
  let shown = 0, target = 8, finished = false;
  const fill = document.getElementById('sm-fill'), bar = document.getElementById('sm-bar');
  const pct = document.getElementById('sm-pct'), label = document.getElementById('sm-label');

  function words(p) {
    if (p >= 100) return 'Ready to smile';
    if (p >= 75) return 'Almost sparkling…';
    if (p >= 40) return 'Brightening your smile…';
    return 'Waking up…';
  }
  function paint() {
    const p = Math.round(shown);
    fill.setAttribute('y', String(154 - 146 * shown / 100));   // enamel rises from the root to the crown
    root.style.setProperty('--p', (shown / 100).toFixed(3));   // glow grows with it (CSS)
    bar.style.width = shown + '%';
    pct.textContent = p + '%';
    label.textContent = words(p);
  }
  function reveal() {
    if (finished) return;
    finished = true;
    root.classList.add('sm-done');                             // sparkles pop
    setTimeout(() => {
      document.body.classList.remove('ss-loading');
      document.body.classList.add('ss-ready');                 // loader fades, card slides up (CSS)
      try { sessionStorage.setItem('ss-seen', '1'); } catch (e) { /* ignore */ }
      setTimeout(() => root.remove(), 700);
    }, 420);
  }
  function frame() {
    // Ease toward the target, but never faster than ~0.8 s for a full fill so the brightening is visible.
    shown = Math.min(target, shown + Math.min(Math.max(0.5, (target - shown) * 0.07), 2.1));
    paint();
    if (shown >= 100) { reveal(); return; }
    requestAnimationFrame(frame);
  }
  const set = p => { target = Math.max(target, Math.min(100, p)); };

  if (!root) return { set() {}, done() {}, skip() {} };
  if (quick) {                                                  // no animation: show the card straight away
    root.remove();
    document.body.classList.remove('ss-loading');
    document.body.classList.add('ss-ready', 'ss-instant');
    return { set() {}, done() {}, skip() {} };
  }
  requestAnimationFrame(frame);
  if (document.readyState !== 'loading') set(35); else document.addEventListener('DOMContentLoaded', () => set(35));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => set(60)); else set(60);
  setTimeout(() => set(100), 6000);                             // never keep anyone waiting if the server is slow
  return {
    set,
    done: () => set(100),
    skip: () => { try { sessionStorage.setItem('ss-seen', '1'); } catch (e) { /* ignore */ } }  // going to another page
  };
})();
