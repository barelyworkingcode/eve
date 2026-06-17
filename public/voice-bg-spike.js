/**
 * Background keep-alive spike (diagnostic — safe to leave in; inert unless armed).
 *
 * Answers the one question the Simulator can't: does a running native
 * AVAudioEngine keep the WKWebView's JS event loop + WebSocket alive while the
 * iPhone is LOCKED? It starts the native *silent* keep-alive (no mic, no VAD,
 * no chimes) and shows a heartbeat overlay.
 *
 * Arm it (on the native app) via the deep link  relayclient://bgspike
 * (or open eve.lan/?bgspike=1 in a desktop browser to smoke-test the overlay).
 *
 * How to read it on a real device:
 *   1. Arm it, then TAP the overlay to zero the counters.
 *   2. Lock the phone (side button) and wait 3-5 minutes.
 *   3. Unlock and read "max gap" + "ws drops".
 *      PASS: max gap stays ~2s and ws drops = 0  → JS kept running while locked.
 *      FAIL: max gap ≈ the lock duration          → JS was suspended (the audio
 *            assertion didn't hold the web process; fallback = native WebSocket).
 */
(function () {
  // bgspike overlay disabled (removed 2026-06-16): when armed it started a
  // silent keepalive probe that hijacked the audio session (sessionActive=true,
  // no mic tap), blocking the mic during real voice sessions — and added no
  // value for normal use. Hard-disabled here (this file is served live, so it
  // takes effect immediately even though the cached index.html still references
  // it); the <script> include has also been removed from index.html.
  const armed = () => false;

  const WS_STATE = { '-1': 'none', 0: 'CONNECTING', 1: 'OPEN', 2: 'CLOSING', 3: 'CLOSED' };

  let started = false;
  let bridge = null;
  let el = null;
  let ticks = 0;
  let last = 0;
  let maxGap = 0;
  let wsDrops = 0;
  let startedAt = 0;

  function wsReadyState() {
    const rs = window.client?.wsClient?.ws?.readyState;
    return (rs === undefined || rs === null) ? -1 : rs;
  }

  function render() {
    if (!el) return;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const sinceLast = Math.round((Date.now() - last) / 1000);
    const rs = wsReadyState();
    el.innerHTML =
      `<b>BG&nbsp;SPIKE</b>&nbsp; ticks ${ticks} · ${elapsed}s<br>` +
      `ws ${WS_STATE[rs]} · drops ${wsDrops}<br>` +
      `gap ${sinceLast}s · <b>max ${(maxGap / 1000).toFixed(1)}s</b><br>` +
      `native ${bridge && bridge.available ? 'HELD' : 'off'} · tap=reset`;
  }

  function tick() {
    const now = Date.now();
    const gap = now - last;
    if (ticks > 0 && gap > maxGap) maxGap = gap;
    last = now;
    ticks++;
    if (wsReadyState() !== 1) wsDrops++;
    console.log(`[bgspike] tick ${ticks} ws=${WS_STATE[wsReadyState()]} gap=${gap}ms max=${maxGap}ms drops=${wsDrops}`);
    render();
  }

  function reset() {
    startedAt = last = Date.now();
    ticks = 0;
    maxGap = 0;
    wsDrops = 0;
    render();
  }

  function start() {
    if (started) return;
    started = true;

    // Hold the native background-audio assertion (silent). No-op off the app.
    try {
      bridge = (typeof NativeAudioBridge !== 'undefined') ? new NativeAudioBridge(null) : null;
      if (bridge && bridge.available) bridge.startKeepaliveProbe();
    } catch (err) {
      console.warn('[bgspike] native keepalive failed:', err);
    }

    el = document.createElement('div');
    el.id = 'bgSpikeOverlay';
    el.style.cssText =
      'position:fixed;top:54px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
      'background:rgba(0,0,0,0.86);color:#13ff5e;font:12px/1.55 ui-monospace,Menlo,monospace;' +
      'padding:10px 16px;border:1px solid #13ff5e;border-radius:10px;text-align:center;' +
      'white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,0.5);';
    el.addEventListener('click', reset);
    document.body.appendChild(el);

    reset();
    setInterval(tick, 2000);
    console.log('[bgspike] armed — tap overlay to reset, then lock the phone');
  }

  function check() { if (armed()) start(); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check);
  } else {
    check();
  }
  // Deep link (relayclient://bgspike) sets the hash after load.
  window.addEventListener('hashchange', check);
})();
