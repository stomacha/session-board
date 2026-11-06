// Session Board 데스크톱 앱 (Electron)
// 창만 Electron이 맡고, 서버는 함께 묶은 node.exe로 server.ts를 그대로 띄운다.
// (서버를 Electron 안에서 돌리면 node-pty를 Electron용으로 다시 빌드해야 해서 피했다)
const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PORT = 4777, ORIGIN = `http://127.0.0.1:${PORT}`;
// 묶은 앱: resources/board, 개발 중(npm start): 한 단계 위의 세션 보드 원본 폴더
const board = app.isPackaged ? path.join(process.resourcesPath, "board") : path.join(__dirname, "..");
const nodeExe = app.isPackaged ? path.join(board, "node", "node.exe") : "node";
let server = null, win = null, closing = false;

// 서버에 GET을 보내 본문을 돌려준다 (안 되면 null)
const get = (p) => new Promise((done) => {
  const req = http.get(ORIGIN + p, { timeout: 800 }, (res) => {
    let s = ""; res.on("data", (d) => (s += d)); res.on("end", () => done(res.statusCode === 200 ? s : null));
  });
  req.on("error", () => done(null));
  req.on("timeout", () => { req.destroy(); done(null); });
});

async function ensureServer() {
  if (await get("/api/limits")) return true;   // 이미 떠 있으면(start.bat 등) 그 서버를 그대로 쓴다
  const log = fs.openSync(path.join(app.getPath("userData"), "server.log"), "w");
  server = spawn(nodeExe, ["server.ts"], {
    cwd: board, windowsHide: true, stdio: ["ignore", log, log],
    // 묶은 앱은 팀 저장 파일을 사용자 데이터 폴더에 둔다 (개발 중에는 원본 폴더의 teams.json 그대로)
    env: app.isPackaged ? { ...process.env, SB_DATA: app.getPath("userData") } : process.env,
  });
  server.on("exit", () => { server = null; });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await get("/api/limits")) return true;
    if (!server) break;   // 서버가 바로 죽었다
  }
  return false;
}

// 이 앱이 띄운 서버에서 돌고 있는 세션 수 (창을 닫으면 같이 끝나므로 묻는다)
async function liveSessions() {
  if (!server) return 0;
  try { return JSON.parse((await get("/api")) || "{}").sessions?.filter((s) => s.state !== "ended").length ?? 0; }
  catch { return 0; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 1000, backgroundColor: "#000000", title: "Session Board",
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // 바깥 링크는 기본 브라우저로. 보드 밖으로 이동하지 않는다
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(ORIGIN)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  win.on("close", async (e) => {
    if (closing) return;
    e.preventDefault();
    const n = await liveSessions();
    if (n > 0) {
      const { response } = await dialog.showMessageBox(win, {
        type: "warning", buttons: ["Close and end sessions", "Cancel"], defaultId: 1, cancelId: 1,
        message: `${n} session${n > 1 ? "s are" : " is"} still running.`,
        detail: "Closing Session Board ends them. You can resume them later with + → Resume.",
      });
      if (response !== 0) return;
    }
    closing = true;
    win.close();
  });
  win.loadURL(ORIGIN);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    // 기본 메뉴를 없앤다: Ctrl+W(창 닫기)·Ctrl+R(새로고침)이 터미널 단축키(단어 지우기·기록 찾기)를 가로채기 때문
    Menu.setApplicationMenu(null);
    if (!(await ensureServer())) {
      dialog.showErrorBox("Session Board", `The board server didn't start.\nSee ${path.join(app.getPath("userData"), "server.log")}`);
      app.quit();
      return;
    }
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => { if (server) server.kill(); });
}
