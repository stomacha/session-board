// Liquid Glass 연결부. 엔진은 두 가지 중 하나를 설정 창에서 고른다.
//  - WebGL (기본): glass/liquid-glass.mjs (GPT-6 Astra가 만든 독립 WebGL2 엔진). 배경 그림만 굴절시키고 가볍다
//  - SVG 굴절 (선택): 유리 뒤의 모든 것(글자·터미널·다른 상자)을 휘게 한다. 크로미움에서만 되고 GPU를 많이 쓴다
// Liquid Glass 테마이고 "투명도 줄이기"가 꺼져 있을 때만 켜진다. WebGL2가 없으면 엔진이 스스로 CSS 글래스로 물러난다.
// 옛 엔진(WebGL1, 판 16개를 셰이더 하나로)은 glass-classic.js에 남겨 둠.
import { LiquidGlass, PRESETS } from "/glass/liquid-glass.mjs";

const root = document.documentElement;
const scene = document.getElementById("canvas");          // 보드 전체 (main.canvas)
const world = document.getElementById("world");
const TARGETS = ".account, #usage, .team";                // 계정 상자, 사용량 원, 팀 상자들
const SVG_TARGETS = `${TARGETS}, .toolbar .pill, #newp, #setp, #teamf, .daycard`;   // SVG는 작은 버튼·창도 굴절
const reduce = matchMedia("(prefers-reduced-transparency: reduce)");
const paper = document.createElement("canvas");           // WebGL 엔진에 넘기는 배경 그림
let engine = null, img = null, imgUrl = "";

// 설정 창: 프리셋(regular/clear/tinted) + 슬라이더 3개. 슬라이더는 프리셋 값에 곱하는 배율이고 기본 위치면 프리셋 그대로
function material() {
  const s = window.glassSettings || {};
  const preset = Object.hasOwn(PRESETS, s.preset) ? s.preset : "regular", P = PRESETS[preset];
  const n = (x, d) => (Number.isFinite(+x) ? +x : d);
  return {
    preset,
    roughness: P.roughness * n(s.tint, 0.55) / 0.55,      // 프로스트(흐림): 슬라이더 55가 기본
    refraction: P.refraction * n(s.refract, 1),
    highlight: P.highlight * n(s.spec, 1),
  };                                                        // 범위를 넘는 값은 엔진이 잘라 낸다
}
const mode = () => (window.glassSettings?.engine === "svg" ? "svg" : "webgl");

// ---------- WebGL 엔진 ----------
// 배경: 화면 크기 캔버스에 그린다 (엔진 캔버스도 화면에 고정돼 있어 1:1로 맞는다)
function drawBackground() {
  const dpr = Math.min(devicePixelRatio || 1, 1.5);
  const W = Math.max(1, Math.round(root.clientWidth * dpr)), H = Math.max(1, Math.round(root.clientHeight * dpr));
  paper.width = W; paper.height = H;
  const g = paper.getContext("2d");
  const b = window.boardBg || { mode: "theme" };
  const css = getComputedStyle(root);
  if (b.mode === "color") {
    g.fillStyle = b.color; g.fillRect(0, 0, W, H);
  } else if (b.mode === "image" && img) {
    g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
    const s = Math.max(W / img.naturalWidth, H / img.naturalHeight), w = img.naturalWidth * s, h = img.naturalHeight * s;
    g.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    g.fillStyle = `rgba(0,0,0,${b.dim ?? 0.35})`; g.fillRect(0, 0, W, H);
  } else {
    g.fillStyle = css.getPropertyValue("--ground").trim() || "#000"; g.fillRect(0, 0, W, H);
    g.fillStyle = css.getPropertyValue("--dots").trim() || "rgba(255,255,255,.1)";
    const step = 26 * dpr, rad = 1 * dpr;
    for (let y = step / 2; y < H; y += step) for (let x = step / 2; x < W; x += step) { g.beginPath(); g.arc(x, y, rad, 0, 6.2832); g.fill(); }
  }
  engine?.invalidate({ source: true });
}

function loadImage() {
  const b = window.boardBg, url = b && b.mode === "image" ? b.url : "";
  if (url !== imgUrl) {
    imgUrl = url; img = null;
    if (url) { const im = new Image(); im.onload = () => { if (imgUrl === url) { img = im; drawBackground(); } }; im.src = url; }
  }
  drawBackground();
}

// 유리 판 붙이기: 새 팀 상자는 처음 보일 때 붙이고, 설정이 바뀌면 전부 새 재질로
function attachAll() { const m = material(); for (const el of scene.querySelectorAll(TARGETS)) engine.attach(el, m); }
function restyle() { if (!engine) return; const m = material(); for (const el of scene.querySelectorAll(TARGETS)) engine.attach(el, m).update(m); }

function start() {
  try {
    drawBackground();
    engine = new LiquidGlass({
      root: scene, source: paper, quality: "auto", mode: "auto",
      background: getComputedStyle(root).getPropertyValue("--ground").trim() || "#000",
      onStatus: (s) => root.classList.toggle("gl-on", s.mode === "webgl"),   // CSS 글래스 끄기·배경 div 숨기기
    });
    attachAll();
    loadImage();
  } catch (e) {
    console.warn("glass: 엔진을 켜지 못해 CSS 글래스로 둡니다.", e);
    engine?.destroy(); engine = null;
  }
}
function stop() { engine?.destroy(); engine = null; root.classList.remove("gl-on"); }

// ---------- SVG 굴절 ----------
// 상자마다 크기에 맞는 "렌즈 지도"를 그린다: 둥근 사각형 가장자리 띠(BEVEL px)에서 바깥 방향으로 밀고, 안쪽은 그대로(128).
// 지도를 상자 크기 그대로 만들기 때문에 큰 상자에서도 가장자리 굴절 폭이 일정하다. 색 분산은 R·G·B를 조금씩 다르게 밀어서
const SVGNS = "http://www.w3.org/2000/svg", BEVEL = 18;
let svgDefs = null, svgOn = false, svgQueued = false, seq = 0;
const lenses = new Map();   // 요소 → { id, w, h, r, map }
const svgResize = new ResizeObserver(() => queueSvg());

function lensMap(w, h, r) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"), im = g.createImageData(w, h), d = im.data;
  const hw = w / 2, hh = h / 2; r = Math.min(r, hw, hh);
  const sd = (x, y) => {   // 둥근 사각형까지의 거리 (안쪽이 음수)
    const qx = Math.abs(x - hw) - hw + r, qy = Math.abs(y - hh) - hh + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, px = x + 0.5, py = y + 0.5, depth = -sd(px, py);
    let nx = 0, ny = 0;
    if (depth < BEVEL) {
      const gx = sd(px + 1, py) - sd(px - 1, py), gy = sd(px, py + 1) - sd(px, py - 1), l = Math.hypot(gx, gy) || 1;
      const k = (1 - Math.max(depth, 0) / BEVEL) ** 2;    // 가장자리 1 → 띠 안쪽 끝 0
      nx = (gx / l) * k; ny = (gy / l) * k;
    }
    d[i] = 128 + nx * 127; d[i + 1] = 128 + ny * 127; d[i + 2] = 128; d[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return c.toDataURL();
}

function filterFor({ id, w, h, map }, m) {
  const blur = (m.roughness * 10).toFixed(2), s = m.refraction * 2;
  const disp = (scale, out) => `<feDisplacementMap in="b" in2="m" scale="${scale.toFixed(1)}" xChannelSelector="R" yChannelSelector="G" result="${out}"/>`;
  const only = (input, row, out) => `<feColorMatrix in="${input}" type="matrix" values="${row} 0 0 0 1 0" result="${out}"/>`;
  return `<filter id="${id}" x="0" y="0" width="${w}" height="${h}" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB">` +
    `<feGaussianBlur in="SourceGraphic" stdDeviation="${blur}" result="b"/>` +
    `<feImage href="${map}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="m"/>` +
    disp(s * 1.1, "dr") + disp(s, "dg") + disp(s * 0.9, "db") +
    only("dr", "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0", "r") + only("dg", "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0", "g") + only("db", "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0", "bl") +
    `<feBlend in="r" in2="g" mode="screen" result="rg"/><feBlend in="rg" in2="bl" mode="screen" result="c"/>` +
    `<feColorMatrix in="c" type="saturate" values="1.4"/></filter>`;
}

function svgApply() {
  if (!svgOn) return;
  const m = material(), parts = [];
  for (const el of document.querySelectorAll(SVG_TARGETS)) {
    let L = lenses.get(el);
    if (!L) { L = { id: `lgr${seq++}` }; lenses.set(el, L); svgResize.observe(el); }   // 닫힌 창은 열릴 때 크기가 생겨 다시 불린다
    const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
    if (w < 2 || h < 2) continue;
    const r = Math.round(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0);
    if (L.w !== w || L.h !== h || L.r !== r) Object.assign(L, { w, h, r, map: lensMap(w, h, r) });
    parts.push(filterFor(L, m));
    const v = `url(#${L.id})`;
    if (el.style.backdropFilter !== v) { el.style.backdropFilter = v; el.style.webkitBackdropFilter = v; }
  }
  svgDefs.innerHTML = parts.join("");
}
// 크기 조절 중에는 한 프레임에 한 번만 다시 만든다
function queueSvg() { if (svgOn && !svgQueued) { svgQueued = true; requestAnimationFrame(() => { svgQueued = false; svgApply(); }); } }

function svgStart() {
  if (svgOn) return;
  if (!svgDefs) {
    const s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("width", "0"); s.setAttribute("height", "0"); s.setAttribute("aria-hidden", "true");
    s.style.position = "absolute";
    svgDefs = document.createElementNS(SVGNS, "defs");
    s.append(svgDefs); document.body.append(s);
  }
  svgOn = true; root.classList.add("glass-svg");
  svgApply();
}
function svgStop() {
  if (!svgOn) return;
  svgOn = false; root.classList.remove("glass-svg");
  for (const el of lenses.keys()) { el.style.backdropFilter = ""; el.style.webkitBackdropFilter = ""; svgResize.unobserve(el); }
  lenses.clear();
  svgDefs.innerHTML = "";
}

// ---------- 켜고 끄기 ----------
const want = () => root.dataset.theme === "liquid-glass" && !reduce.matches;
function sync() {
  const on = want(), m = mode();
  if (on && m === "webgl") { svgStop(); if (!engine) start(); }
  else if (on && m === "svg") { if (engine) stop(); svgStart(); }
  else { if (engine) stop(); svgStop(); }
}

// 시험용: 엔진 상태 확인
window.glassEngine = {
  get mode() { return svgOn ? "svg" : engine ? "webgl" : "css"; },
  get on() { return svgOn || engine?.status.mode === "webgl"; },
  get size() { return engine ? [engine.canvas.width, engine.canvas.height] : [0, 0]; },
  get stats() { return engine?.stats ?? null; },
};

new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
// ponytail: 팀 상자는 #world 바로 아래에만 생긴다고 보고 그 자식만 본다. 다른 곳에 유리 판이 생기면 여기도 넓힐 것
if (world) new MutationObserver(() => { if (engine) attachAll(); queueSvg(); }).observe(world, { childList: true });
reduce.addEventListener("change", sync);
addEventListener("boardbg", () => { if (engine) loadImage(); });
addEventListener("glasssettings", () => { sync(); restyle(); svgApply(); });
addEventListener("resize", () => { if (engine) drawBackground(); });
sync();
