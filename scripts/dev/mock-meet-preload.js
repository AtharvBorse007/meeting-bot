/**
 * Dev/test helper - NOT used in normal operation.
 *
 * Serves a fake Google Meet page to the bot's browser so the whole pipeline (join -> lobby ->
 * recording -> stop -> save) can be exercised without a real meeting:
 *
 *   node -r ./scripts/dev/mock-meet-preload.js node_modules/ts-node/dist/bin.js src/index.ts
 *
 * Then start bots on these meeting codes from the dashboard:
 *   aaa-bbbb-ccc   joins, stays in the call until stopped
 *   eee-nnnn-ddd   joins, the "meeting" ends by itself after ~25s
 *   lll-oooo-bbb   never admitted (stuck in the lobby) - for testing Cancel
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const { chromium } = require('playwright-extra');

const page = (code) => `<!doctype html><html><head><title>Meet ${code}</title>
<style>body{font-family:sans-serif;background:#202124;color:#fff;margin:0;padding:24px}
canvas{background:#111;border-radius:8px}button{padding:8px 14px;margin:4px}</style></head>
<body>
<div id="prejoin"><h2>Ready to join?</h2>
  <input type="text" placeholder="Your name" />
  <button id="join">Join now</button>
</div>
<div id="lobby" style="display:none"><h2>Asking to join...</h2>
  <p>Please wait until a meeting host brings you into the call</p></div>
<div id="call" style="display:none"><h2>Mock meeting ${code}</h2>
  <canvas id="c" width="640" height="360"></canvas><br>
  <button aria-label="People - 2 joined"><span data-avatar-count="2">2</span></button>
  <button aria-label="Leave call" id="leave">Leave</button>
</div>
<div id="left" style="display:none"><h2>You left the meeting</h2></div>
<script>
  const code = ${JSON.stringify(code)};
  const show = (id) => { for (const e of ['prejoin','lobby','call','left']) { const el = document.getElementById(e); if (el) el.style.display = e === id ? 'block' : 'none'; } };
  document.getElementById('join').onclick = () => {
    if (code === 'lll-oooo-bbb') { show('lobby'); return; }
    show('lobby');
    setTimeout(() => { show('call'); startMedia(); }, 3000);
  };
  // Like the real thing: once the call is over the in-call controls are gone from the page
  const leave = () => { show('left'); document.getElementById('call').remove(); };
  document.getElementById('leave').onclick = leave;
  function startMedia() {
    const ctx = document.getElementById('c').getContext('2d');
    let n = 0;
    setInterval(() => { n++; ctx.fillStyle = 'hsl(' + (n * 7 % 360) + ',70%,40%)'; ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#fff'; ctx.font = '40px sans-serif'; ctx.fillText(new Date().toLocaleTimeString(), 180, 190); }, 100);
    try { const a = new AudioContext(); const o = a.createOscillator(); const g = a.createGain(); g.gain.value = 0.2;
      o.connect(g); g.connect(a.destination); o.start(); } catch (e) {}
    if (code === 'eee-nnnn-ddd') setTimeout(leave, 25000);
  }
</script></body></html>`;

const origLaunch = chromium.launch.bind(chromium);
chromium.launch = async (...args) => {
  const browser = await origLaunch(...args);
  const origNewContext = browser.newContext.bind(browser);
  browser.newContext = async (...a) => {
    const context = await origNewContext(...a);
    await context.route('https://meet.google.com/**', (route) => {
      const code = new URL(route.request().url()).pathname.slice(1);
      route.fulfill({ status: 200, contentType: 'text/html', body: page(code) });
    });
    return context;
  };
  return browser;
};
console.log('[mock-meet] fake meet.google.com enabled');
