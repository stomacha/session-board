// Liquid Glass 렌더 엔진 (WebGL)
// 화면 뒤에 캔버스 한 장을 깔고, 배경(점 무늬/단색/사진)과 유리 판을 GPU로 직접 그린다.
//  - 유리 판: 계정 상자, 사용량 원, 세션 상자 (DOM 위치를 매 프레임 따라감)
//  - 가장자리 굴절 + 색 분산, 안쪽은 흐린 배경에 검은 틴트, 테두리 반사광은 마우스 위치를 빛으로 삼는다
//  - 위치/배경/빛이 바뀔 때만 다시 그린다
// Liquid Glass 테마이고 WebGL이 되고 "투명도 줄이기"가 꺼져 있을 때만 켜진다. 아니면 CSS 글래스가 그대로 쓰인다.
(() => {
  const root = document.documentElement;
  const canvas = document.getElementById("glass");
  const TARGETS = ".account, #usage, .team";   // 계정 상자, 사용량 원, 팀 상자들
  const MAX = 16;           // 셰이더가 받는 유리 판 최대 개수 (팀 12개 + 여유)
  const RADIUS = 24;        // CSS 모서리와 같은 값 (px)
  const reduce = matchMedia("(prefers-reduced-transparency: reduce)");
  if (!canvas) return;

  let gl = null, P = null, quad = null, bgTex = null, A = null, B = null;
  let on = false, raf = 0, dirtyBg = true, lastKey = "", W = 0, H = 0, dpr = 1;
  let light = [0, 0], img = null, imgUrl = "";
  // 설정 창 슬라이더 값 (index.html이 window.glassSettings로 알려 준다)
  let look = { tint: 0.55, refract: 1, spec: 1 };
  const readLook = () => { const s = window.glassSettings; if (s) look = { tint: +s.tint, refract: +s.refract, spec: +s.spec }; lastKey = ""; };

  // ---------- 셰이더 ----------
  const VERT = `attribute vec2 p; varying vec2 uv;
    void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

  // 9탭 가우시안을 두 방향으로 나눠 돌린다
  const BLUR = `precision mediump float; uniform sampler2D t; uniform vec2 dir; varying vec2 uv;
    void main() {
      vec4 c = texture2D(t, uv) * 0.2270270270;
      c += texture2D(t, uv + dir * 1.3846153846) * 0.3162162162;
      c += texture2D(t, uv - dir * 1.3846153846) * 0.3162162162;
      c += texture2D(t, uv + dir * 3.2307692308) * 0.0702702703;
      c += texture2D(t, uv - dir * 3.2307692308) * 0.0702702703;
      gl_FragColor = c;
    }`;

  const MAIN = `precision highp float;
    uniform sampler2D bg, blur;
    uniform vec2 res, light;
    uniform vec4 rects[${MAX}];
    uniform int count;
    uniform float dpr, radius;
    uniform float tint, refract, spec;   // 설정 슬라이더: 투명~틴트(0~1), 굴절(0~1.5), 반사광(0~1.5)
    varying vec2 uv;

    // 둥근 사각형까지의 거리 (안쪽이 음수)
    float sd(vec2 p, vec2 c, vec2 h, float r) {
      vec2 q = abs(p - c) - h + r;
      return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    }
    vec2 tc(vec2 px) { return vec2(px.x / res.x, 1.0 - px.y / res.y); }

    void main() {
      vec2 px = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y);
      vec3 col = texture2D(bg, uv).rgb;
      float r = radius * dpr;

      // 가장 가까운 판 찾기 + 판 아래 그림자
      float best = 1e9, shadow = 0.0;
      vec2 C = vec2(0.0), Hh = vec2(1.0);
      for (int i = 0; i < ${MAX}; i++) {
        if (i >= count) break;
        vec4 R = rects[i];
        vec2 c = R.xy + R.zw * 0.5, h = R.zw * 0.5;
        float d = sd(px, c, h, r);
        float ds = sd(px - vec2(0.0, 16.0 * dpr), c, h, r);
        shadow = max(shadow, (1.0 - smoothstep(-8.0 * dpr, 44.0 * dpr, ds)) * 0.6);
        if (d < best) { best = d; C = c; Hh = h; }
      }
      col *= 1.0 - shadow;
      // 유리 바로 바깥의 어두운 테두리: 밝은 배경 위에서도 판의 경계가 또렷하게 (iOS 27의 가독성 보정)
      if (best >= 0.0) col *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 3.0 * dpr, best));

      if (best < 0.5) {
        float d = -best;                                   // 판 안쪽으로 들어간 깊이
        float e = 1.0;
        vec2 n = normalize(vec2(sd(px + vec2(e, 0.0), C, Hh, r) - sd(px - vec2(e, 0.0), C, Hh, r),
                                sd(px + vec2(0.0, e), C, Hh, r) - sd(px - vec2(0.0, e), C, Hh, r)) + 1e-6);
        float bevel = 24.0 * dpr;
        float t = clamp(1.0 - d / bevel, 0.0, 1.0);        // 가장자리 1, 안쪽 0
        float bend = t * t * t;
        float S = 30.0 * dpr * bend * refract;             // 굴절 세기: 가장자리에서 바깥 배경을 끌어온다

        vec2 pr = px + n * S * 1.10, pg = px + n * S, pb = px + n * S * 0.90;   // 색 분산
        vec3 frost = vec3(texture2D(blur, tc(pr)).r, texture2D(blur, tc(pg)).g, texture2D(blur, tc(pb)).b);
        vec3 sharp = vec3(texture2D(bg, tc(pr)).r, texture2D(bg, tc(pg)).g, texture2D(bg, tc(pb)).b);
        float clear = 1.0 - tint;
        vec3 g = mix(frost, sharp, max(bend * 0.55, clear * 0.4));   // 투명할수록 뒤가 또렷하게 비친다

        g = mix(g, vec3(0.0), mix(0.22, 0.84, tint)) + 0.03;         // 검은 틴트: 바탕은 검은색 유지

        // 반사광: 마우스 쪽을 향한 가장자리가 밝아진다
        vec2 L = normalize(light - C + 1e-6);
        float facing = max(dot(n, L), 0.0);
        float rim = 1.0 - smoothstep(0.0, 1.6 * dpr, d);   // 아주 얇은 테두리
        float band = pow(t, 5.0);                          // 굴절 띠
        g += rim * (0.2 + 0.75 * pow(facing, 2.0)) * spec;
        g += band * (0.05 + 0.2 * pow(facing, 3.0)) * spec;
        g *= 1.0 - 0.22 * smoothstep(1.6 * dpr, 2.4 * dpr, d) * (1.0 - smoothstep(2.4 * dpr, 5.0 * dpr, d));   // 반사광 안쪽의 어두운 선
        g += (1.0 - smoothstep(0.0, 140.0 * dpr, px.y - (C.y - Hh.y))) * 0.035 * spec;   // 위쪽의 은은한 광택

        float a = smoothstep(-0.5, 1.0, d);               // 테두리 계단 현상 줄이기
        col = mix(col, g, a);
      }
      gl_FragColor = vec4(col, 1.0);
    }`;

  // ---------- WebGL 준비 ----------
  function shader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(frag, names) {
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(p, 0, "p");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    for (const n of names) u[n] = gl.getUniformLocation(p, n);
    return { p, u };
  }
  function texture() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function target(w, h) {
    const tex = texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h };
  }
  function drop(t) { if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); } }

  function init() {
    if (gl) return true;
    try {
      gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
      if (!gl) return false;
      P = {
        blur: program(BLUR, ["t", "dir"]),
        main: program(MAIN, ["bg", "blur", "res", "light", "rects", "count", "dpr", "radius", "tint", "refract", "spec"]),
      };
      quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      bgTex = texture();
      return true;
    } catch (e) {
      console.warn("glass: WebGL을 쓸 수 없어 CSS 글래스로 둡니다.", e);
      gl = null;
      return false;
    }
  }

  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); stop(); gl = null; A = B = null; });
  canvas.addEventListener("webglcontextrestored", () => sync());

  // ---------- 배경 그리기 (2D 캔버스 → 텍스처 → 흐린 사본) ----------
  const paper = document.createElement("canvas");
  function drawBackground() {
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
    gl.bindTexture(gl.TEXTURE_2D, bgTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, paper);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    // 1/4 크기에서 가로·세로 흐림을 두 번씩
    const pass = (src, dst, dx, dy) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.useProgram(P.blur.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src);
      gl.uniform1i(P.blur.u.t, 0);
      gl.uniform2f(P.blur.u.dir, dx / dst.w, dy / dst.h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    bindQuad();
    // 복잡한 배경도 충분히 퍼지도록 세 번 (iOS 27에서 흐림을 다시 조정한 방향)
    pass(bgTex, A, 1.8, 0); pass(A.tex, B, 0, 1.8);
    pass(B.tex, A, 2.2, 0); pass(A.tex, B, 0, 2.2);
    pass(B.tex, A, 2.6, 0); pass(A.tex, B, 0, 2.6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    dirtyBg = false;
  }
  function bindQuad() {
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    // innerWidth는 세로 스크롤바까지 포함해서, 스크롤바가 생기면 그림이 옆으로 눌려 상자가 두 겹으로 보였다
    W = Math.max(1, Math.round(canvas.clientWidth * dpr)); H = Math.max(1, Math.round(canvas.clientHeight * dpr));
    canvas.width = W; canvas.height = H;
    drop(A); drop(B);
    const w = Math.max(1, W >> 2), h = Math.max(1, H >> 2);
    A = target(w, h); B = target(w, h);
    dirtyBg = true; lastKey = "";
  }

  // ---------- 그리기 ----------
  const rectBuf = new Float32Array(MAX * 4);
  function frame() {
    raf = requestAnimationFrame(frame);
    if (document.hidden || !gl) return;
    if (canvas.width !== Math.max(1, Math.round(canvas.clientWidth * Math.min(devicePixelRatio || 1, 2))) || canvas.height !== Math.max(1, Math.round(canvas.clientHeight * Math.min(devicePixelRatio || 1, 2)))) resize();

    const zoom = window.boardZoom || 1;   // 화면 확대 비율: 모서리 둥글기도 같이 맞춘다
    let n = 0, key = `${W}x${H}|${light[0] | 0},${light[1] | 0}|z${zoom}`;
    for (const el of document.querySelectorAll(TARGETS)) {
      if (n >= MAX) break;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) continue;
      rectBuf.set([r.left * dpr, r.top * dpr, r.width * dpr, r.height * dpr], n * 4);
      key += `|${r.left | 0},${r.top | 0},${r.width | 0},${r.height | 0}`;
      n++;
    }
    if (dirtyBg) drawBackground();
    else if (key === lastKey) return;      // 바뀐 게 없으면 그리지 않는다
    lastKey = key;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.useProgram(P.main.p);
    bindQuad();
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, bgTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, B.tex);
    const u = P.main.u;
    gl.uniform1i(u.bg, 0); gl.uniform1i(u.blur, 1);
    gl.uniform2f(u.res, W, H);
    gl.uniform2f(u.light, light[0] * dpr, light[1] * dpr);
    gl.uniform4fv(u.rects, rectBuf);
    gl.uniform1i(u.count, n);
    gl.uniform1f(u.dpr, dpr);
    gl.uniform1f(u.radius, RADIUS * zoom);
    gl.uniform1f(u.tint, look.tint);
    gl.uniform1f(u.refract, look.refract);
    gl.uniform1f(u.spec, look.spec);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ---------- 켜고 끄기 ----------
  function start() {
    if (!init()) return;                  // WebGL이 없으면 CSS 글래스 그대로
    on = true;
    root.classList.add("gl-on");
    resize();
    loadImage();
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function stop() {
    on = false;
    root.classList.remove("gl-on");
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }
  function want() { return root.dataset.theme === "liquid-glass" && !reduce.matches; }
  function sync() { if (want() && !on) start(); else if (!want() && on) stop(); }

  function loadImage() {
    const b = window.boardBg;
    const url = b && b.mode === "image" ? b.url : "";
    dirtyBg = true;
    if (url === imgUrl) return;
    imgUrl = url; img = null;
    if (!url) return;
    const im = new Image();
    im.onload = () => { if (imgUrl === url) { img = im; dirtyBg = true; } };
    im.src = url;
  }

  // 시험용: 엔진 상태 확인
  window.glassEngine = { get on() { return on; }, get size() { return [W, H]; } };

  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  reduce.addEventListener("change", sync);
  addEventListener("boardbg", () => { if (on) loadImage(); });
  addEventListener("glasssettings", readLook);
  readLook();
  addEventListener("pointermove", (e) => { light = [e.clientX, e.clientY]; }, { passive: true });
  addEventListener("resize", () => { if (on) dirtyBg = true; });
  sync();
})();
