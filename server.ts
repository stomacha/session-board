// 실행: node server.ts  (Node 22.6+ 에서 타입을 그대로 실행)
// 브라우저의 + 버튼으로 claude 세션을 백그라운드 터미널(PTY)에서 띄우고, 그 화면을 웹소켓으로 중계한다.
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import pty from "node-pty";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.SB_PORT) || 4777;   // 시험용 서버는 SB_PORT로 다른 포트에 띄운다
const MAX = 16; // 세션 개수는 자유지만, 컴퓨터가 버틸 수 있게 안전 상한만 둔다
const MODELS = ["opus", "sonnet", "haiku"];
// 세션으로 띄울 수 있는 CLI. Codex·Gemini는 첫 판: 띄우고 쓰기만 (이어하기·상태 표시·팀 규칙·폰 조종은 Claude Code만)
const TOOLS: Record<string, { label: string; install: string }> = {
  claude: { label: "Claude Code", install: "https://claude.com/claude-code" },
  codex: { label: "Codex", install: "npm install -g @openai/codex" },
  gemini: { label: "Gemini CLI", install: "npm install -g @google/gemini-cli" },
  agy: { label: "Antigravity", install: "the Antigravity CLI (agy) from Google" },
};
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
const CLAUDE = join(homedir(), ".claude");

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}

function email(): string {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")).oauthAccount.emailAddress;
  } catch {
    return "No account found";
  }
}

// ---- 사용량 한도: 이 프로그램이 띄운 세션의 상태줄이 남긴 JSON에서 읽는다 ----
const STATUS_DIR = join(tmpdir(), "session-board-status");
const SETTINGS = join(STATUS_DIR, PORT === 4777 ? "settings.json" : `settings-${PORT}.json`);
mkdirSync(STATUS_DIR, { recursive: true });
// 훅: 세션이 일하는 중 / 나를 기다림 / 끝남을 <id>.state 파일로 남긴다 (hook.mjs)
// 이 서버를 돌리는 node로 부른다: 앱으로 묶으면 함께 든 node.exe라서, PC에 Node가 없어도 훅·상태줄이 돈다
const NODE = `"${process.execPath}"`;
const HOOK = [{ hooks: [{ type: "command", command: `${NODE} "${join(import.meta.dirname, "hook.mjs")}"` }] }];
writeFileSync(SETTINGS, JSON.stringify({
  statusLine: { type: "command", command: `${NODE} "${join(import.meta.dirname, "statusline.mjs")}"` },
  hooks: { UserPromptSubmit: HOOK, PostToolUse: HOOK, Notification: HOOK, Stop: HOOK },
}));
export function sessionState(id: string): string {
  try { return JSON.parse(readFileSync(join(STATUS_DIR, `${id}.state`), "utf8")).s ?? "idle"; } catch { return "idle"; }
}

// 세션마다 마지막 대화 때의 값만 남기므로, 가장 최신 파일 하나가 아니라 모든 세션을 모아 고른다:
// 아직 안 끝난 기간 중 가장 새 기간에서, 가장 많이 쓴 값 (사용량은 한 기간 안에서 줄지 않는다)
export function pickLimits(entries: any[], nowSec: number) {
  const pick: Record<string, any> = {};
  for (const rl of entries) for (const k of ["five_hour", "seven_day"]) {
    const v = rl?.[k];
    if (!v || !(v.resets_at > nowSec) || typeof v.used_percentage !== "number") continue;
    const c = pick[k];
    const newer = !c || v.resets_at > c.resets_at + 60;
    const same = c && Math.abs(v.resets_at - c.resets_at) <= 60;
    if (newer || (same && v.used_percentage > c.used_percentage)) pick[k] = v;
  }
  return pick;
}
function limits(): unknown {
  const entries: any[] = [];
  let updated = 0;
  for (const f of readdirSync(STATUS_DIR)) {
    if (f.startsWith("settings") || !f.endsWith(".json")) continue;
    try {
      const p = join(STATUS_DIR, f), rl = JSON.parse(readFileSync(p, "utf8")).rate_limits;
      if (rl) { entries.push(rl); updated = Math.max(updated, statSync(p).mtimeMs); }
    } catch {}
  }
  const pick = pickLimits(entries, Date.now() / 1000);
  return Object.keys(pick).length ? { ...pick, updated } : null;
}

// ---- 토큰: 세션 id로 ~/.claude/projects 의 로그를 찾아 합산 ----
// 로그는 뒤에 붙기만 하므로 지난번에 읽은 곳부터 새로 붙은 부분만 읽는다 (큰 로그도 폴링이 가볍다)
const tokenCache = new Map<string, { size: number; tokens: number; seen: Set<string>; rest: Buffer }>();
const tokenPath = new Map<string, string>();
export function tokensOf(id: string): number {
  let path = tokenPath.get(id);
  if (!path || !existsSync(path)) {
    path = undefined;
    const root = join(CLAUDE, "projects");
    let dirs: string[] = [];
    try { dirs = readdirSync(root); } catch { return 0; }
    for (const d of dirs) { const p = join(root, d, `${id}.jsonl`); if (existsSync(p)) { path = p; break; } }
    if (!path) return 0;
    tokenPath.set(id, path);
  }
  const size = statSync(path).size;
  let c = tokenCache.get(path);
  if (!c || size < c.size) c = { size: 0, tokens: 0, seen: new Set(), rest: Buffer.alloc(0) };   // 처음이거나 파일이 줄었으면 처음부터
  if (size > c.size) {
    const fd = openSync(path, "r"), buf = Buffer.alloc(size - c.size);
    try { readSync(fd, buf, 0, buf.length, c.size); } finally { closeSync(fd); }
    const all = Buffer.concat([c.rest, buf]), nl = all.lastIndexOf(10);
    c.rest = all.subarray(nl + 1);   // 아직 줄이 안 끝난 부분은 다음에
    for (const line of all.subarray(0, nl + 1).toString("utf8").split("\n")) {
      if (!line) continue;
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      const m = o.message;
      if (o.type === "assistant" && m?.usage && !c.seen.has(m.id)) {
        c.seen.add(m.id); // 스트리밍 중 같은 응답이 여러 줄로 기록되므로 중복 제거
        const u = m.usage;
        c.tokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      }
    }
    c.size = size;
  }
  tokenCache.set(path, c);
  return c.tokens;
}

// ---- 하루 정산: 그날 이 PC에서 Claude Code가 쓴 토큰·세션 수·작업 시간 (보드 밖에서 쓴 것도 포함) ----
// 토큰은 입력+출력만 센다 (캐시는 숫자만 부풀린다). 작업 시간은 기록 사이 간격이 5분 미만인 구간만 더한다
// (켜 두기만 한 시간은 빠진다). 세션이 여러 개 동시에 돌면 세션마다 따로 더한 합계
const GAP_MS = 5 * 60_000;
export type DayStats = { date: string; tokens: number; sessions: number; workMs: number };
export function dayRange(date: string): [number, number] {   // 이 PC 시간대 기준 그날 0시 ~ 다음 날 0시
  const [y, m, d] = date.split("-").map(Number);
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}
// 로그 줄들 → 그날의 토큰 합과 기록 시각들. 스트리밍 중 같은 응답이 여러 줄로 남으므로 message.id로 한 번만 센다
export async function tallyDay(lines: Iterable<string> | AsyncIterable<string>, start: number, end: number) {
  let tokens = 0;
  const times: number[] = [], seen = new Set<string>();
  for await (const line of lines) {
    const i = line.indexOf('"timestamp":"');
    if (i < 0) continue;
    const t = Date.parse(line.slice(i + 13, line.indexOf('"', i + 13)));
    if (!(t >= start && t < end)) continue;
    times.push(t);
    if (!line.includes('"usage"')) continue;   // 토큰이 없는 줄은 JSON을 풀지 않는다 (큰 로그도 빨리)
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const m = o.message;
    if (o.type !== "assistant" || !m?.usage || (m.id && seen.has(m.id))) continue;
    if (m.id) seen.add(m.id);
    tokens += (m.usage.input_tokens ?? 0) + (m.usage.output_tokens ?? 0);
  }
  return { tokens, times };
}
export function activeMs(times: number[]): number {
  const s = [...times].sort((a, b) => a - b);
  let ms = 0;
  for (let i = 1; i < s.length; i++) { const d = s[i] - s[i - 1]; if (d < GAP_MS) ms += d; }
  return ms;
}
const dayCache = new Map<string, DayStats>();   // 지난 날은 바뀌지 않으므로 한 번만 센다
export async function dayStats(date: string): Promise<DayStats> {
  const hit = dayCache.get(date);
  if (hit) return hit;
  const [start, end] = dayRange(date), root = join(CLAUDE, "projects");
  const r: DayStats = { date, tokens: 0, sessions: 0, workMs: 0 };
  let files: string[] = [];
  try { files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl")); } catch {}
  for (const f of files) {
    const p = join(root, f);
    try { if (statSync(p).mtimeMs < start) continue; } catch { continue; }   // 그날 전에 끝난 기록은 열지 않는다
    const { tokens, times } = await tallyDay(createInterface({ input: createReadStream(p), crlfDelay: Infinity }), start, end);
    r.tokens += tokens;
    // projects/<폴더>/<세션>.jsonl 만 세션으로 센다. 하위 에이전트 기록은 토큰만 더한다 (시간은 본 세션과 겹침)
    if (f.split(/[\\/]/).length === 2 && times.length) { r.sessions++; r.workMs += activeMs(times); }
  }
  if (end <= Date.now()) dayCache.set(date, r);
  return r;
}

// ---- 커밋 전 위험한 키 검사: 바뀐 줄에서 API 키·비밀키 모양을 찾는다 ----
const run = promisify(execFile);
const git = (cwd: string, args: string[]) => run("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }).then((r) => r.stdout);
const SECRETS: [string, RegExp][] = [
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI API key", /sk-(?:proj-)?(?!ant-)[A-Za-z0-9_-]{20,}/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["Stripe secret key", /\b[sr]k_live_[0-9a-zA-Z]{20,}/],
  ["Hugging Face token", /\bhf_[A-Za-z0-9]{30,}\b/],
  ["Discord bot token", /\b[MN][A-Za-z\d]{23,27}\.[\w-]{6}\.[\w-]{27,}/],
  ["Private key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ["Password or secret in code", /(?:api[_-]?key|secret|token|passw(?:or)?d)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i],
];
const RISKY_FILE = /(?:^|\/)(?:\.env(?:\.(?!example$|sample$|template$)[\w.-]+)?|id_[rd]sa|credentials\.json|[^/]+\.(?:pem|p12|pfx|key))$/i;
const mask = (v: string) => (v.length <= 10 ? "•".repeat(v.length) : `${v.slice(0, 6)}…${v.slice(-2)}`);
export function scanDiff(diff: string) {
  const found: { file: string; line: number; kind: string; preview: string }[] = [];
  let file = "", line = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) { file = l.slice(4).replace(/^b\//, ""); if (RISKY_FILE.test(file)) found.push({ file, line: 0, kind: "Secret file (should not be in git)", preview: "" }); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h) { line = +h[1]; continue; }
    if (l.startsWith("+")) {
      for (const [kind, re] of SECRETS) { const m = re.exec(l); if (m) { found.push({ file, line, kind, preview: mask(m[0]) }); break; } }
      line++;
    } else if (!l.startsWith("-")) line++;
  }
  return found;
}

// 저장소 전체 검사: git grep으로 키 같은 낱말이 있는 줄만 먼저 추린 뒤 정확한 패턴으로 다시 본다
const PREFILTER = "sk-|AKIA|ASIA|gh[pousr]_|github_pat_|AIza|xox[baprs]-|_live_|hf_|PRIVATE KEY|api.?key|secret|token|passw|[MN][A-Za-z0-9]{23}";
export function scanGrep(out: string) {
  const found: { file: string; line: number; kind: string; preview: string }[] = [];
  for (const l of out.split("\n")) {
    const m = /^(.+?):(\d+):(.*)$/.exec(l);
    if (!m) continue;
    for (const [kind, re] of SECRETS) { const k = re.exec(m[3]); if (k) { found.push({ file: m[1], line: +m[2], kind, preview: mask(k[0]) }); break; } }
  }
  return found;
}
async function scanRepo(cwd: string, tracked: string[]) {
  const found = tracked.filter((f) => RISKY_FILE.test(f)).map((file) => ({ file, line: 0, kind: "Secret file (should not be in git)", preview: "" }));
  let out = "";
  try { out = await git(cwd, ["grep", "-n", "-I", "-i", "--no-color", "-E", PREFILTER, "--", "."]); }
  catch (e: any) { if (e?.code !== 1) throw e; }   // 1 = 찾은 줄 없음
  return found.concat(scanGrep(out)).slice(0, 300);
}

// ---- 지난 세션: ~/.claude/projects 의 기록에서 최근 것부터 ----
// 큰 기록 파일도 있으니 앞쪽 256KB(폴더, 첫 질문)와 뒤쪽 256KB(최근 제목)만 읽는다
const CHUNK = 256 * 1024;
const ACTIVE_MS = 2 * 60 * 1000;
function headTail(path: string): string {
  const size = statSync(path).size, fd = openSync(path, "r");
  try {
    const read = (pos: number, len: number) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, pos); return b.toString("utf8"); };
    return size <= CHUNK * 2 ? read(0, size) : read(0, CHUNK) + "\n" + read(size - CHUNK, CHUNK);
  } finally { closeSync(fd); }
}
type Past = { cwd: string; project: string; title: string };
function pastInfo(path: string): Past | null {
  let cwd = "", ai = "", custom = "", first = "";
  for (const line of headTail(path).split("\n")) {
    if (!line) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }   // 잘린 줄은 건너뛴다
    cwd ||= o.cwd ?? "";
    if (o.type === "ai-title" && o.aiTitle) ai = o.aiTitle;
    if (o.type === "custom-title" && o.customTitle) custom = o.customTitle;
    if (o.type === "user" && !first && !o.isMeta) {
      const c = o.message?.content;
      const t = typeof c === "string" ? c : Array.isArray(c) ? (c.find((b: any) => b.type === "text")?.text ?? "") : "";
      if (t && !t.trimStart().startsWith("<")) first = t;
    }
  }
  const title = cleanName(String(custom || ai || first).replace(/\s+/g, " "), 80);
  return cwd && title ? { cwd, project: basename(cwd), title } : null;   // 대화가 없는 세션은 이어갈 게 없으니 뺀다
}
const pastCache = new Map<string, { mtime: number; info: Past | null }>();
function sessionFiles() {
  const root = join(CLAUDE, "projects"), out: { id: string; path: string; mtime: number }[] = [];
  let dirs: string[] = [];
  try { dirs = readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    let fl: string[];
    try { fl = readdirSync(join(root, d)); } catch { continue; }
    for (const f of fl) if (f.endsWith(".jsonl")) { const path = join(root, d, f); try { out.push({ id: f.slice(0, -6), path, mtime: statSync(path).mtimeMs }); } catch {} }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
function history(limit = 40) {
  const out: (Past & { id: string; end: number })[] = [];
  for (const f of sessionFiles()) {
    if (out.length >= limit) break;
    if (live.has(f.id)) continue;   // 지금 이 보드에서 돌고 있는 세션은 빼고
    let c = pastCache.get(f.path);
    if (!c || c.mtime !== f.mtime) pastCache.set(f.path, (c = { mtime: f.mtime, info: pastInfo(f.path) }));
    // 최근 2분 안에 기록이 늘었으면 다른 창에서 쓰는 중으로 본다 (같은 세션을 두 곳에서 열면 기록이 꼬인다)
    if (c.info) out.push({ id: f.id, end: f.mtime, active: Date.now() - f.mtime < ACTIVE_MS, ...c.info });
  }
  return out;
}

// ---- 세션: 이 프로그램이 띄운 claude 프로세스 ----
type Live = {
  id: string; n: number; model: string; effort: string; cwd: string; start: number;
  name: string; team: string; role: string;   // 사용자가 붙인 이름(비면 "Session N"), 속한 팀, 팀 안에서 맡은 일
  tool: string;                                // claude / codex / gemini
  term: any; buf: string; exited: boolean; sockets: Set<any>;
};

// ---- 팀: 세션을 묶는 상자. teams.json에 저장해 서버를 다시 켜도 남는다 ----
// rules: 팀 규칙. 이 팀에서 새로 띄우거나 이어 가는 세션에 시스템 프롬프트로 붙는다
type Team = { id: string; name: string; rules?: string };
// SB_DATA: 앱(Electron)이 사용자 데이터 폴더를 알려 준다. 프로그램 폴더에 두면 업데이트·재설치 때 팀이 날아간다
const DATA_DIR = process.env.SB_DATA || import.meta.dirname;
mkdirSync(DATA_DIR, { recursive: true });
const TEAMS_FILE = join(DATA_DIR, "teams.json");
const MAIN = "main";
let teams: Team[] = [{ id: MAIN, name: "Sessions" }];
try {
  const t = JSON.parse(readFileSync(TEAMS_FILE, "utf8"));
  if (Array.isArray(t) && t.some((x) => x?.id === MAIN)) teams = t.filter((x) => typeof x?.id === "string" && typeof x?.name === "string");
} catch {}
// 쓰다가 꺼져도 teams.json이 반쯤 쓰인 채로 남지 않게 임시 파일에 쓰고 바꿔 끼운다
const saveTeams = () => { writeFileSync(`${TEAMS_FILE}.tmp`, JSON.stringify(teams, null, 2)); renameSync(`${TEAMS_FILE}.tmp`, TEAMS_FILE); };
const teamOk = (id: unknown) => typeof id === "string" && teams.some((t) => t.id === id);
// 이름: 글자만 남기고 앞뒤 공백 제거, 40자까지
export const cleanName = (v: unknown, max = 40) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "");
// 팀 규칙은 여러 줄을 받되 줄바꿈만 남기고 다른 제어 문자는 뺀다
export const cleanRules = (v: unknown) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim().slice(0, 600) : "");
// 세션에 붙는 지시문: 팀 이름·규칙과 이 세션의 역할. 둘 다 없으면 빈 문자열(옵션을 붙이지 않음)
export function teamPrompt(team: Team | undefined, role: string): string {
  const rules = team?.rules?.trim() ?? "";
  if (!rules && !role) return "";
  const lines = [`You are one of several Claude Code sessions in the team "${team?.name ?? "Sessions"}", run from Session Board.`];
  if (role) lines.push(`Your role in this team: ${role}. Stay within this role; leave other work to your teammates.`);
  if (rules) lines.push(`Team rules (always follow):\n${rules}`);
  return lines.join("\n");
}
const live = new Map<string, Live>();
// Claude Code가 없어도 서버는 켜진다 (Codex·Gemini만 쓰는 사람). Claude 세션을 띄울 때만 설치 안내
const claudeExe = (() => { try { return execFileSync("where.exe", ["claude"], { stdio: ["ignore", "pipe", "ignore"] }).toString().split(/\r?\n/)[0].trim(); } catch { return ""; } })();

function startSession(model: string, effort: string, cwd: string, name = "", team = MAIN, resumeId = "", role = "", rc = false, tool = "claude"): Live {
  let n = 1;
  while ([...live.values()].some((s) => s.n === n)) n++; // 비어 있는 가장 작은 번호
  const id = resumeId || randomUUID();   // 이어가기면 그 세션의 id를 그대로 쓴다
  const t = teams.find((x) => x.id === team);
  const prompt = teamPrompt(t, role);
  // rc: 밖에서 폰(Claude 앱)으로 이어 조종. 앱 목록에서 알아보게 "팀 - 세션" 이름을 붙인다
  const rcName = cleanName(`${t?.name ?? "Main"} - ${name || `Session ${n}`}`, 60);
  const args = [resumeId ? "--resume" : "--session-id", id, "--effort", effort, "--settings", SETTINGS,...(model ? ["--model", model] : []), ...(prompt ? ["--append-system-prompt", prompt] : []), ...(rc ? ["--remote-control", rcName] : [])];
  // 색을 켠다: 서버를 띄운 창에 NO_COLOR가 있으면 세션 화면이 흑백이 되므로 빼고, 트루컬러를 알린다
  // WT_SESSION: Claude Code는 Windows에서 이 값이 있어야 색을 낸다 (보드의 xterm은 Windows Terminal처럼 VT 색을 그대로 그린다)
  const env: Record<string, string> = { ...(process.env as Record<string, string>), TERM: "xterm-256color", COLORTERM: "truecolor", FORCE_COLOR: "3", WT_SESSION: randomUUID() };
  delete env.NO_COLOR;
  // 이 서버가 Claude Code 안에서 켜졌어도 새 세션이 그 흔적을 물려받지 않게 한다
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k === "CLAUDE_PID" || (k.startsWith("CLAUDE_CODE_") && k !== "CLAUDE_CODE_OAUTH_TOKEN")) delete env[k];
  let file = claudeExe, argv = args;
  if (tool === "claude" && !claudeExe) throw new Error(`Claude Code isn't installed. Install it from ${TOOLS.claude.install}, then restart Session Board.`);
  if (tool !== "claude") {
    // .exe(agy 등)는 바로 띄우고, npm으로 깐 CLI(.cmd)는 cmd로 감싸 띄운다 (node-pty는 .cmd를 바로 못 띄움)
    const find = (name: string) => { try { return execFileSync("where.exe", [name], { stdio: ["ignore", "pipe", "ignore"] }).toString().split(/\r?\n/)[0].trim(); } catch { return ""; } };
    const exe = find(`${tool}.exe`);
    if (exe) argv = [];
    else if (find(`${tool}.cmd`)) argv = ["/d", "/c", `${tool}.cmd`];
    else throw new Error(`${TOOLS[tool].label} isn't installed. Install it with: ${TOOLS[tool].install}`);
    file = exe || "cmd.exe";
  }
  const term = pty.spawn(file, argv, { name: "xterm-256color", cols: 100, rows: 30, cwd, env });
  const s: Live = { id, n, model, effort, cwd, start: Date.now(), name, team, role, tool, term, buf: "", exited: false, sockets: new Set() };
  // ponytail: 화면 복원용 버퍼는 마지막 400KB만, 이스케이프 시퀀스 중간에서 잘릴 수 있음
  term.onData((d: string) => { s.buf = (s.buf + d).slice(-400_000); for (const ws of s.sockets) ws.send(d); });
  term.onExit(() => { s.exited = true; for (const ws of s.sockets) ws.send("\r\n[session ended]\r\n"); });
  live.set(id, s);
  return s;
}

function stopSession(id: string) {
  const s = live.get(id);
  if (!s) return;
  if (!s.exited) try { s.term.kill(); } catch {}
  for (const ws of s.sockets) ws.close();
  live.delete(id);
}

// ---- HTTP ----
// 이 서버는 프로세스를 띄우므로 다른 웹사이트가 localhost로 요청을 보내도 거부한다 (Host와 Origin 확인)
const hostOk = (req: IncomingMessage) => HOSTS.includes(req.headers.host ?? "");
const originOk = (req: IncomingMessage) => hostOk(req) && req.headers.origin === `http://${req.headers.host}`;

const VENDOR: Record<string, [string, string]> = {
  "/vendor/xterm.js": ["@xterm/xterm/lib/xterm.js", "text/javascript"],
  "/vendor/xterm.css": ["@xterm/xterm/css/xterm.css", "text/css"],
  "/vendor/fit.js": ["@xterm/addon-fit/lib/addon-fit.js", "text/javascript"],
};
const dir = import.meta.dirname;
const json = (res: any, code: number, body: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((ok) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 4096) req.destroy(); });
    req.on("end", () => { try { ok(JSON.parse(b)); } catch { ok(null); } });
  });
}

const server = createServer(async (req, res) => {
  if (!hostOk(req)) return json(res, 403, { error: "bad host" });
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && url.pathname === "/api") {
    const sessions = [...live.values()].sort((a, b) => a.n - b.n).map((s) => ({
      id: s.id, n: s.n, name: s.name, team: teamOk(s.team) ? s.team : MAIN, role: s.role, tool: s.tool, model: s.model || "default", effort: s.effort, cwd: s.cwd, start: s.start, exited: s.exited, tokens: tokensOf(s.id),
      state: s.exited ? "ended" : sessionState(s.id),
    }));
    return json(res, 200, { email: email(), max: MAX, home: homedir(), defaultCwd: homedir(), limits: limits(), teams, sessions });
  }
  if (req.method === "POST" && url.pathname === "/api/new") {
    if (!originOk(req) || req.headers["content-type"] !== "application/json") return json(res, 403, { error: "forbidden" });
    const b = await readBody(req);
    if (!b || !MODELS.concat("").includes(b.model ?? "") || !EFFORTS.includes(b.effort)) return json(res, 400, { error: "model or effort is invalid" });
    if (typeof b.cwd !== "string" || !existsSync(b.cwd) || !statSync(b.cwd).isDirectory()) return json(res, 400, { error: "folder does not exist" });
    if (live.size >= MAX) return json(res, 409, { error: `at most ${MAX} sessions` });
    const tool = Object.hasOwn(TOOLS, b.tool) ? b.tool : "claude";
    try { return json(res, 200, { id: startSession(tool === "claude" ? b.model ?? "" : "", b.effort, b.cwd, cleanName(b.name), teamOk(b.team) ? b.team : MAIN, "", cleanName(b.role, 60), tool === "claude" && b.rc === true, tool).id }); }
    catch (e: any) { return json(res, 500, { error: String(e?.message ?? e) }); }
  }
  if (req.method === "DELETE" && url.pathname === "/api/session") {
    if (!originOk(req)) return json(res, 403, { error: "forbidden" });
    stopSession(url.searchParams.get("id") ?? "");
    return json(res, 200, {});
  }
  // 사용량 한도만 (화면이 1초마다 가볍게 묻는다)
  if (req.method === "GET" && url.pathname === "/api/limits") return json(res, 200, { limits: limits() });
  // 지난 세션 목록 / 이어가기
  if (req.method === "GET" && url.pathname === "/api/history") return json(res, 200, { sessions: history() });
  if (req.method === "GET" && url.pathname === "/api/day") {   // 하루 정산 카드
    const date = url.searchParams.get("date") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: "date must be YYYY-MM-DD" });
    return json(res, 200, await dayStats(date));
  }
  if (req.method === "POST" && url.pathname === "/api/resume") {
    if (!originOk(req) || req.headers["content-type"] !== "application/json") return json(res, 403, { error: "forbidden" });
    const b = await readBody(req);
    if (!b || typeof b.id !== "string" || !/^[0-9a-f-]{36}$/i.test(b.id)) return json(res, 400, { error: "Pick a session to resume." });
    if (!MODELS.concat("").includes(b.model ?? "") || !EFFORTS.includes(b.effort)) return json(res, 400, { error: "model or effort is invalid" });
    if (live.has(b.id)) return json(res, 409, { error: "That session is already open on the board." });
    if (live.size >= MAX) return json(res, 409, { error: `at most ${MAX} sessions` });
    const f = sessionFiles().find((x) => x.id === b.id), info = f && pastInfo(f.path);
    if (!info) return json(res, 404, { error: "That session's history wasn't found." });
    if (Date.now() - f.mtime < ACTIVE_MS) return json(res, 409, { error: "That session is in use in another window. Close it there, then resume it here." });
    if (!existsSync(info.cwd)) return json(res, 400, { error: `Its folder no longer exists: ${info.cwd}` });
    try {
      const s = startSession(b.model ?? "", b.effort, info.cwd, cleanName(b.name) || cleanName(info.title), teamOk(b.team) ? b.team : MAIN, b.id, cleanName(b.role, 60), b.rc === true);
      return json(res, 200, { id: s.id });
    } catch (e: any) { return json(res, 500, { error: String(e?.message ?? e) }); }
  }
  // 커밋: 위험한 키를 먼저 찾고, 있으면 멈춘다. 이미 추적 중인 파일의 변경만 올린다 (push는 하지 않음)
  if (req.method === "POST" && url.pathname === "/api/commit") {
    if (!originOk(req) || req.headers["content-type"] !== "application/json") return json(res, 403, { error: "forbidden" });
    const b = await readBody(req), s = live.get(b?.id);
    if (!s) return json(res, 404, { error: "session not found" });
    try {
      try { await git(s.cwd, ["rev-parse", "--show-toplevel"]); } catch { return json(res, 400, { error: `${s.cwd} isn't a git repository.` }); }
      // 1) 저장소(이 폴더 아래 git이 추적하는 파일 전체, 지금 고친 내용 포함)를 검사한다
      const tracked = (await git(s.cwd, ["ls-files", "--", "."])).split("\n").filter(Boolean);
      if (!tracked.length) return json(res, 200, { status: "empty" });
      const findings = await scanRepo(s.cwd, tracked);
      if (findings.length) return json(res, 200, { status: "blocked", findings, scanned: tracked.length });
      // 2) 키가 없으면 바뀐 것만 커밋한다
      const files = (await git(s.cwd, ["diff", "HEAD", "--name-only", "--relative", "--", "."])).split("\n").filter(Boolean);
      if (!files.length) return json(res, 200, { status: "clean", scanned: tracked.length });
      await git(s.cwd, ["add", "-u", "--", "."]);
      await git(s.cwd, ["commit", "-m", `Session board: ${s.name || `Session ${s.n}`}`]);
      const hash = (await git(s.cwd, ["rev-parse", "--short", "HEAD"])).trim();
      return json(res, 200, { status: "committed", hash, files, scanned: tracked.length });
    } catch (e: any) { return json(res, 500, { error: String(e?.stderr || e?.message || e).trim().slice(0, 400) }); }
  }
  // 세션 이름 바꾸기 / 다른 팀으로 옮기기
  if (req.method === "PATCH" && url.pathname === "/api/session") {
    if (!originOk(req) || req.headers["content-type"] !== "application/json") return json(res, 403, { error: "forbidden" });
    const b = await readBody(req), s = live.get(b?.id);
    if (!s) return json(res, 404, { error: "session not found" });
    if ("name" in b) s.name = cleanName(b.name);
    if ("team" in b) { if (!teamOk(b.team)) return json(res, 400, { error: "team not found" }); s.team = b.team; }
    return json(res, 200, {});
  }
  // 팀 만들기: 이름 + 처음에 넣을 세션들
  if (req.method === "POST" && url.pathname === "/api/team") {
    if (!originOk(req) || req.headers["content-type"] !== "application/json") return json(res, 403, { error: "forbidden" });
    const b = await readBody(req), name = cleanName(b?.name);
    if (!name) return json(res, 400, { error: "Give the team a name." });
    if (teams.length >= 12) return json(res, 409, { error: "at most 12 teams" });
    const t = { id: randomUUID().slice(0, 8), name };
    teams.push(t); saveTeams();
    for (const id of Array.isArray(b.sessions) ? b.sessions : []) { const s = live.get(id); if (s) s.team = t.id; }
    return json(res, 200, t);
  }
  // 팀 이름 바꾸기 / 팀 규칙 고치기 (규칙은 그다음에 띄우는 세션부터 적용)
  if (req.method === "PATCH" && url.pathname === "/api/team") {
    if (!originOk(req) || req.headers["content-type"] !== "application/json") return json(res, 403, { error: "forbidden" });
    const b = await readBody(req), t = teams.find((x) => x.id === b?.id);
    if (!t) return json(res, 404, { error: "team not found" });
    if ("name" in b) { const name = cleanName(b.name); if (!name) return json(res, 400, { error: "Give the team a name." }); t.name = name; }
    if ("rules" in b) t.rules = cleanRules(b.rules);
    saveTeams();
    return json(res, 200, t);
  }
  // 팀 지우기: 세션은 끄지 않고 기본 상자로 옮긴다 (기본 상자는 지울 수 없음)
  if (req.method === "DELETE" && url.pathname === "/api/team") {
    if (!originOk(req)) return json(res, 403, { error: "forbidden" });
    const id = url.searchParams.get("id");
    if (id === MAIN || !teamOk(id)) return json(res, 400, { error: "This team can't be deleted." });
    teams = teams.filter((t) => t.id !== id); saveTeams();
    for (const s of live.values()) if (s.team === id) s.team = MAIN;
    return json(res, 200, {});
  }
  if (url.pathname === "/glass.js") {   // Liquid Glass 연결부
    res.setHeader("content-type", "text/javascript");
    return res.end(readFileSync(join(dir, "glass.js")));
  }
  const g = /^\/glass\/(core|liquid-glass)\.mjs$/.exec(url.pathname);   // Liquid Glass 엔진 모듈 (이 두 파일만)
  if (g) {
    res.setHeader("content-type", "text/javascript");
    return res.end(readFileSync(join(dir, "glass", `${g[1]}.mjs`)));
  }
  const v = VENDOR[url.pathname];
  if (v) {
    res.setHeader("content-type", v[1]);
    return res.end(readFileSync(join(dir, "node_modules", v[0])));
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(readFileSync(join(dir, "index.html"))); // 요청마다 읽어 수정 즉시 반영
});

// ---- WebSocket: 세션 하나의 터미널 화면 ----
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const s = live.get(new URL(req.url ?? "/", "http://x").searchParams.get("id") ?? "");
  if (!originOk(req) || !s) return void socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    s.sockets.add(ws);
    if (s.buf) ws.send(s.buf);
    ws.on("close", () => s.sockets.delete(ws));
    ws.on("message", (raw) => {
      let m: any;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.t === "in" && typeof m.d === "string" && !s.exited) s.term.write(m.d);
      else if (m.t === "resize" && !s.exited) {
        const cols = Math.min(Math.max(Number(m.cols) | 0, 20), 300), rows = Math.min(Math.max(Number(m.rows) | 0, 5), 100);
        try { s.term.resize(cols, rows); } catch {}
      }
    });
  });
});

const killAll = () => { for (const s of live.values()) if (!s.exited) try { s.term.kill(); } catch {} };
process.on("exit", killAll);
process.on("SIGINT", () => process.exit());
// 세션 하나의 오류(터미널 종료 중 쓰기 등)로 서버 전체가 죽지 않게 한다
process.on("uncaughtException", (e) => console.error("uncaught:", e));
process.on("unhandledRejection", (e) => console.error("unhandled:", e));

if (process.argv[1]?.endsWith("server.ts")) {
  server.listen(PORT, "127.0.0.1", () => console.log(`http://127.0.0.1:${PORT}`));
}

// 자체 확인: node server.ts --check
if (process.argv.includes("--check")) {
  console.assert(fmtDuration(3723000) === "1h 2m 3s", "fmtDuration");
  console.assert(cleanName("  팀\u0007 A  ") === "팀 A", "cleanName trims and strips control chars");
  console.assert(cleanName("x".repeat(60)).length === 40, "cleanName caps length");
  console.assert(cleanName(42) === "", "cleanName rejects non-strings");
  {
    const fake = "sk-ant-" + "a1B2c3D4e5F6g7H8i9J0".repeat(2);
    const d = ["+++ b/app.py", "@@ -1,0 +10,2 @@", "+print('hi')", `+KEY = "${fake}"`, "+++ b/.env", "@@ -0,0 +1 @@", "+X=1", "+++ b/.env.example", "@@ -0,0 +1 @@", "+X="].join("\n");
    const f = scanDiff(d);
    console.assert(f.length === 2 && f[0].file === "app.py" && f[0].line === 11 && f[0].kind === "Anthropic API key" && !f[0].preview.includes(fake), "scanDiff finds key with line, masks it");
    console.assert(f[1].file === ".env", "scanDiff flags .env but not .env.example");
    const g = scanGrep([`src/a.py:7:KEY = "${fake}"`, "src/b.py:3:token = get_token()", "c.md:1:no secret here"].join("\n"));
    console.assert(g.length === 1 && g[0].file === "src/a.py" && g[0].line === 7, "scanGrep keeps real keys, skips look-alikes");
  }
  {
    const r = pickLimits([
      { five_hour: { used_percentage: 40, resets_at: 1000 }, seven_day: { used_percentage: 80, resets_at: 5000 } },
      { five_hour: { used_percentage: 55, resets_at: 1010 } },   // 같은 기간, 더 많이 씀 → 이 값
      { five_hour: { used_percentage: 99, resets_at: 100 } },    // 이미 끝난 기간 → 무시
    ], 500);
    console.assert(r.five_hour.used_percentage === 55 && r.seven_day.used_percentage === 80, "pickLimits picks max in the current window");
    const n = pickLimits([{ five_hour: { used_percentage: 90, resets_at: 1000 } }, { five_hour: { used_percentage: 3, resets_at: 19000 } }], 500);
    console.assert(n.five_hour.used_percentage === 3, "pickLimits prefers the newer window");
  }
  {
    const { stateOf } = await import("./hook.mjs");
    console.assert(stateOf({ hook_event_name: "UserPromptSubmit" }) === "working" && stateOf({ hook_event_name: "Stop" }) === "done", "stateOf maps prompt and stop");
    console.assert(stateOf({ hook_event_name: "Notification", message: "Claude needs your permission to use Bash" }) === "waiting", "stateOf: permission request means waiting");
    console.assert(stateOf({ hook_event_name: "Notification", message: "Claude is waiting for your input" }) === null, "stateOf: idle reminder keeps done");
    console.assert(teamPrompt({ id: "x", name: "Docs" }, "") === "", "teamPrompt is empty without rules or role");
    const p = teamPrompt({ id: "x", name: "Shorts", rules: "Docs in /docs" }, "Video edit");
    console.assert(p.includes('"Shorts"') && p.includes("Video edit") && p.includes("Docs in /docs"), "teamPrompt includes team, role, rules");
    console.assert(cleanRules("a\r\nb\u0007") === "a\nb" && cleanRules("x".repeat(900)).length === 600, "cleanRules keeps newlines, strips control chars, caps length");
  }
  {
    const [s, e] = dayRange("2026-11-04"), at = (h: number, mi = 0, d = 4) => new Date(2026, 10, d, h, mi).toISOString();
    const lines = [
      `{"type":"user","timestamp":"${at(10)}"}`,
      `{"type":"assistant","timestamp":"${at(10, 1)}","message":{"id":"m1","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":9999,"cache_creation_input_tokens":777}}}`,
      `{"type":"assistant","timestamp":"${at(10, 2)}","message":{"id":"m1","usage":{"input_tokens":100,"output_tokens":50}}}`,   // 같은 응답의 다음 줄
      `{"type":"user","timestamp":"${at(12)}"}`,       // 2시간 쉼: 작업 시간에 안 들어감
      `{"type":"user","timestamp":"${at(1, 0, 5)}"}`,  // 다음 날
    ];
    const t = await tallyDay(lines, s, e);
    console.assert(t.tokens === 150 && t.times.length === 4, "tallyDay: input+output only, once per message, only that day");
    console.assert(activeMs(t.times) === 2 * 60_000, "activeMs skips long gaps");
  }
  console.log("check ok");
  process.exit();
}
