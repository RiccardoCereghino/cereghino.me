#!/usr/bin/env node
/**
 * Render guards for the landing page: the acceptance criteria that only a real
 * browser can confirm — reduced-motion staticness, no horizontal scroll at
 * narrow widths, computed animation state, and the JS-off path.
 *
 * Driven over the DevTools Protocol against an already-running Chrome. Two
 * headless flags are deliberately NOT used because they lie:
 *   --window-size        is clamped to a ~500px minimum, so it cannot test 375px
 *   --disable-javascript is a silent no-op as of Chrome 150
 * Emulation.setDeviceMetricsOverride / setScriptExecutionDisabled are used
 * instead. The no-JS scenario reads computed style through the CSS domain,
 * which does not depend on page scripting.
 *
 * Dependency-free: Node 22's built-in WebSocket, no node_modules.
 *
 * usage: node check_render.mjs <url> [screenshot-dir]
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:8765/index.html';
const SHOT_DIR = process.argv[3] || null;
const DEBUG_PORT = process.env.CDP_PORT || 9222;
const EPOCH = Date.UTC(2010, 0, 1);

if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });

/* ---------- minimal CDP client ---------- */
const ver = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then(r => r.json());
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', () => rej(new Error('cannot reach Chrome on :' + DEBUG_PORT)));
});

let seq = 0;
const pending = new Map();
const listeners = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(m.method + ': ' + JSON.stringify(m.error))) : res(m.result);
  } else if (m.method) {
    for (const l of [...listeners]) l(m);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const waitFor = (method, sessionId, timeout = 30000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => { off(); rej(new Error('timeout waiting for ' + method)); }, timeout);
    const l = m => { if (m.method === method && (!sessionId || m.sessionId === sessionId)) { off(); res(m.params); } };
    const off = () => { clearTimeout(t); listeners.splice(listeners.indexOf(l), 1); };
    listeners.push(l);
  });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- assertions ---------- */
const results = [];
const check = (scenario, name, ok, detail = '') => results.push({ scenario, name, ok: !!ok, detail });

/** Everything readable from page JS in one round trip. */
const PROBE = `(() => {
  const cs = el => el ? getComputedStyle(el) : null;
  const q = s => document.querySelector(s);
  const rows = [...document.querySelectorAll('dl > div')];
  const dts = [...document.querySelectorAll('dt')];
  const logo = q('.logo'), cmd = q('.cmd'), cursor = q('.cursor');
  const l = logo.getBoundingClientRect(), i = q('.info').getBoundingClientRect();
  return {
    uptime: q('#uptime').textContent,
    cursorCount: document.querySelectorAll('.cursor').length,
    cursorAtIdlePrompt: !!q('.prompt-end .cursor'),
    cursorAnim: cs(cursor).animationName,
    cursorHidden: cs(cursor).display === 'none' || cs(cursor).visibility === 'hidden',
    cmdAnim: cs(cmd).animationName,
    cmdFullyShown: cmd.scrollWidth <= cmd.clientWidth,
    headerText: q('.prompt').textContent.replace(/\\u00a0/g, ' ').trim(),
    rowsMinOpacity: Math.min(...rows.map(r => parseFloat(cs(r).opacity))),
    gridColumnCount: cs(q('.fetch')).gridTemplateColumns.split(' ').length,
    distinctDtLefts: [...new Set(dts.map(d => Math.round(d.getBoundingClientRect().left)))].length,
    logoAboveInfo: l.bottom <= i.top + 1,
    logoLineHeight: cs(logo).lineHeight,
    logoFontSize: cs(logo).fontSize,
    nameColor: cs(q('h1')).color,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    // Derived from what is actually there rather than a hardcoded list, so
    // adding or removing a background layer does not silently skip the check.
    decorativeCount: document.querySelectorAll('body > div').length,
    decorativeHidden: [...document.querySelectorAll('body > div')]
      .every(d => d.getAttribute('aria-hidden') === 'true'),
    // Anything animating forever. v1 swept an accent gradient down the page
    // every 17s and it read as a yellow line crawling downward; it was removed
    // on sight. The idle cursor blink is the only ambient motion allowed.
    infiniteAnimations: [...document.querySelectorAll('*')]
      .filter(el => {
        const s = cs(el);
        return s.animationName !== 'none' &&
          s.animationIterationCount.split(',').some(v => v.trim() === 'infinite');
      })
      .map(el => (el.getAttribute('class') || el.tagName.toLowerCase()) + ':' + cs(el).animationName),
    linksHaveText: [...document.querySelectorAll('a')].every(a => a.textContent.trim().length > 0),
  };
})()`;

const SCENARIOS = [
  { name: 'desktop-1440',       w: 1440, h: 900, mobile: false, rm: false, noJs: false, settle: 2000, shot: true },
  { name: 'mobile-375',         w: 375,  h: 812, mobile: true,  rm: false, noJs: false, settle: 2000, shot: true },
  { name: 'mobile-320',         w: 320,  h: 812, mobile: true,  rm: false, noJs: false, settle: 2000, shot: false },
  // Screenshot/probe EARLY: if reduced motion is truly static, the header is
  // already complete and every row visible well before the 600ms type could end.
  { name: 'reduced-motion-1440', w: 1440, h: 900, mobile: false, rm: true, noJs: false, settle: 100, shot: true },
  { name: 'reduced-motion-375',  w: 375,  h: 812, mobile: true,  rm: true, noJs: false, settle: 100, shot: true },
  // 2000ms: the last .pr reveal fires at 1.32s. CSS animations still run with
  // scripting off, so a shorter settle would look like missing rows.
  { name: 'nojs-375',            w: 375,  h: 812, mobile: true,  rm: false, noJs: true, settle: 2000, shot: true },
];

for (const s of SCENARIOS) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('DOM.enable', {}, sessionId);
  await send('CSS.enable', {}, sessionId);
  if (!s.noJs) await send('Runtime.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride',
    { width: s.w, height: s.h, deviceScaleFactor: 1, mobile: s.mobile }, sessionId);
  if (s.rm) await send('Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
  if (s.noJs) await send('Emulation.setScriptExecutionDisabled', { value: true }, sessionId);

  const load = waitFor('Page.loadEventFired', sessionId);
  await send('Page.navigate', { url: URL_UNDER_TEST }, sessionId);
  await load;
  await sleep(s.settle);

  if (s.noJs) {
    // Page scripting is off, so read computed style via the CSS domain.
    const { root } = await send('DOM.getDocument', { depth: -1 }, sessionId);
    const styleOf = async selector => {
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector }, sessionId);
      if (!nodeId) return null;
      const { computedStyle } = await send('CSS.getComputedStyleForNode', { nodeId }, sessionId);
      return Object.fromEntries(computedStyle.map(p => [p.name, p.value]));
    };
    const uptimeRow = await styleOf('#row-uptime');
    const otherRow = await styleOf('dl > div:last-of-type');
    const html = await send('DOM.getOuterHTML', { nodeId: root.nodeId }, sessionId).then(r => r.outerHTML);

    check(s.name, 'uptime row hidden without JS', uptimeRow && uptimeRow.display === 'none',
      uptimeRow ? `display:${uptimeRow.display}` : 'row not found');
    check(s.name, 'other rows still shown', otherRow && otherRow.display !== 'none',
      otherRow ? `display:${otherRow.display}` : 'row not found');
    check(s.name, 'uptime value left empty', /id="uptime"><\/dd>/.test(html));
  } else {
    const { result, exceptionDetails } = await send('Runtime.evaluate',
      { expression: PROBE, returnByValue: true }, sessionId);
    if (exceptionDetails) {
      check(s.name, 'probe evaluated', false, JSON.stringify(exceptionDetails.text || exceptionDetails));
    } else {
      const r = result.value;
      const HEADER = 'riccardo@cereghino.me:~$ neofetch';

      // --- uptime: format AND epoch, so a wrong epoch cannot slip through ---
      const m = /^(\d+) days, (\d+) hours, (\d+) mins$/.exec(r.uptime);
      check(s.name, 'uptime matches neofetch long format', !!m, r.uptime);
      if (m) {
        const expected = Math.floor((Date.now() - EPOCH) / 864e5);
        check(s.name, 'uptime days match 2010-01-01 epoch',
          Math.abs(Number(m[1]) - expected) <= 1, `page=${m[1]} expected=${expected}`);
      }

      // --- exactly one cursor, at the idle prompt ---
      check(s.name, 'exactly one cursor', r.cursorCount === 1, `found ${r.cursorCount}`);
      check(s.name, 'cursor is at the idle prompt', r.cursorAtIdlePrompt);

      // --- no horizontal scroll ---
      check(s.name, 'no horizontal scroll',
        r.scrollWidth <= r.innerWidth, `scrollWidth=${r.scrollWidth} innerWidth=${r.innerWidth}`);
      // Not just a harness sanity check. On a mobile-emulated viewport, content
      // that overflows widens the layout viewport instead of producing a scroll
      // delta — so scrollWidth <= innerWidth stays true while the page is
      // actually broken. Pinning innerWidth to the requested width is what
      // catches that; verified against a deliberately non-stacking mutant.
      check(s.name, 'viewport emulation actually applied',
        r.innerWidth === s.w, `innerWidth=${r.innerWidth} wanted=${s.w}`);

      // --- logo geometry ---
      check(s.name, 'logo line-height is 1',
        parseFloat(r.logoLineHeight) === parseFloat(r.logoFontSize),
        `${r.logoLineHeight} vs font ${r.logoFontSize}`);

      // --- name is the highest-contrast text ---
      check(s.name, 'name renders pure white', r.nameColor === 'rgb(255, 255, 255)', r.nameColor);

      // --- a11y basics ---
      check(s.name, 'decorative layers present', r.decorativeCount > 0, `${r.decorativeCount} layers`);
      check(s.name, 'decorative layers aria-hidden', r.decorativeHidden);
      check(s.name, 'every link has text', r.linksHaveText);

      // --- no ambient motion beyond the idle cursor ---
      if (s.rm) {
        check(s.name, 'nothing animates under reduced motion',
          r.infiniteAnimations.length === 0, r.infiniteAnimations.join(', '));
      } else {
        check(s.name, 'only the idle cursor animates forever',
          r.infiniteAnimations.length === 1 && r.infiniteAnimations[0].endsWith(':blink'),
          r.infiniteAnimations.join(', ') || 'none found');
      }

      if (s.rm) {
        // fully static: nothing animating, everything already in final state
        check(s.name, 'typing animation disabled', r.cmdAnim === 'none', r.cmdAnim);
        check(s.name, 'cursor not blinking', r.cursorAnim === 'none', r.cursorAnim);
        check(s.name, 'cursor still visible', !r.cursorHidden);
        check(s.name, 'complete header line shown', r.headerText === HEADER, r.headerText);
        check(s.name, 'command fully revealed', r.cmdFullyShown);
        check(s.name, 'all rows visible immediately', r.rowsMinOpacity === 1, `min opacity ${r.rowsMinOpacity}`);
      } else {
        check(s.name, 'typing animation present', r.cmdAnim === 'type', r.cmdAnim);
        check(s.name, 'cursor blinks', r.cursorAnim === 'blink', r.cursorAnim);
        check(s.name, 'all rows revealed after settle', r.rowsMinOpacity === 1, `min opacity ${r.rowsMinOpacity}`);
      }

      if (s.w <= 560) {
        check(s.name, 'single column layout', r.gridColumnCount === 1, `${r.gridColumnCount} columns`);
        check(s.name, 'logo above the table', r.logoAboveInfo);
        check(s.name, 'keys stay aligned', r.distinctDtLefts === 1, `${r.distinctDtLefts} distinct left edges`);
      } else {
        check(s.name, 'two column layout', r.gridColumnCount === 2, `${r.gridColumnCount} columns`);
      }
    }
  }

  if (s.shot && SHOT_DIR) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(`${SHOT_DIR}/${s.name}.png`, Buffer.from(data, 'base64'));
  }
  await send('Target.closeTarget', { targetId });
}

/* ---------- report ---------- */
let failed = 0;
let current = null;
const width = Math.max(...results.map(r => r.name.length));
for (const r of results) {
  if (r.scenario !== current) { console.log(`\n  ${r.scenario}`); current = r.scenario; }
  const mark = r.ok ? 'ok  ' : 'FAIL';
  let line = `    [${mark}] ${r.name.padEnd(width)}`;
  if (r.detail && !r.ok) line += `   <- ${r.detail}`;
  console.log(line);
  if (!r.ok) failed++;
}
console.log(`\n  ${results.length - failed}/${results.length} render checks passed`);
ws.close();
if (failed) {
  console.error(`\n  ${failed} render guard(s) failed.`);
  process.exit(1);
}
