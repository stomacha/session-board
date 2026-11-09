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
// 모델 이름은 CLI마다 달라 목록 대신 모양만 본다. cmd.exe로 넘어가는 CLI도 있어 특수문자(& | ^ % " 공백)는 막는다
const MODEL_RE = /^[\w.\-\[\]]{0,64}$/;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// 세션으로 띄울 수 있는 CLI. 다른 CLI는 띄우고 쓰기만 (이어하기·상태 표시·팀 규칙·폰 조종은 Claude Code만)
// efforts: 고를 수 있는 추론 강도 (빈 목록이면 그 CLI엔 추론 강도 옵션이 없음), args: 고른 모델·강도를 그 CLI의 플래그로
const TOOLS: Record<string, { label: string; install: string; efforts: string[]; args: (m: string, e: string) => string[] }> = {
  claude: { label: "Claude Code", install: "the installer at https://claude.com/claude-code", efforts: EFFORTS, args: () => [] },
  codex: { label: "Codex", install: "npm install -g @openai/codex", efforts: [...EFFORTS, "ultra"],
    args: (m, e) => [...(m ? ["-m", m] : []), ...(e ? ["-c", `model_reasoning_effort=${e}`] : [])] },
  gemini: { label: "Gemini CLI", install: "npm install -g @google/gemini-cli", efforts: [], args: (m) => (m ? ["-m", m] : []) },
  agy: { label: "Antigravity", install: "the Antigravity CLI (agy) installer from Google", efforts: EFFORTS,
    args: (m, e) => [...(m ? ["--model", m] : []), ...(e ? ["--effort", e] : [])] },
};
const HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
const CLAUDE = join(homedir(), ".claude");

// 여러 세션에 보낼 글: 줄바꿈은 살리고 나머지 제어 문자(ESC 포함)는 지워서, 글로 터미널 명령을 끼워 넣지 못하게 한다
export function cleanSend(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "").slice(0, 8000).trim();
}

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
  term: any; chunks: string[]; bufLen: number; pending: string; flushT: any; exited: boolean; sockets: Set<any>;
  lastOut: number;                             // 마지막 출력 시각: 화면이 조용해지면 입력을 받을 준비가 된 것
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
// ---- 프리셋: 팀 구성(이름·규칙·세션마다 도구·모델·추론 강도·폴더·이름·역할)을 저장해 두고 한 번에 다시 띄운다 ----
type PresetSession = { tool: string; model: string; effort: string; cwd: string; name: string; role: string };
type Preset = { id: string; name: string; rules: string; sessions: PresetSession[] };
const PRESETS_FILE = join(DATA_DIR, "presets.json");
let presets: Preset[] = [];
try {
  const p = JSON.parse(readFileSync(PRESETS_FILE, "utf8"));
  if (Array.isArray(p)) presets = p.filter((x) => typeof x?.id === "string" && typeof x?.name === "string" && Array.isArray(x?.sessions));
} catch {}
const savePresets = () => { writeFileSync(`${PRESETS_FILE}.tmp`, JSON.stringify(presets, null, 2)); renameSync(`${PRESETS_FILE}.tmp`, PRESETS_FILE); };
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
// Claude Code가 없어도 서버는 켜진다 (Codex·Gemini만 쓰는 사람). 나중에 깔면 세션을 띄울 때 다시 찾는다
const whereSync = (name: string) => { try { return execFileSync("where.exe", [name], { stdio: ["ignore", "pipe", "ignore"] }).toString().split(/\r?\n/)[0].trim(); } catch { return ""; } };
let claudeExe = whereSync("claude");

// 설치된 CLI: 화면이 새 세션 창과 "CLI 없음" 안내에 쓴다. 실행 중에 새로 깔 수도 있어 30초마다 다시 찾는다 (서버가 멈추지 않게 비동기)
const whereIs = async (name: string) => { try { return (await run("where.exe", [name])).stdout.split(/\r?\n/)[0].trim(); } catch { return ""; } };
let have: Record<string, boolean> = {}, haveAt = 0;
async function refreshTools() {
  haveAt = Date.now();
  const found = await Promise.all(Object.keys(TOOLS).map(async (t) => [t, !!((await whereIs(`${t}.exe`)) || (await whereIs(`${t}.cmd`)))] as const));
  have = Object.fromEntries(found);
  // 모델 목록 [id, 보여 줄 이름]: Codex는 자기 캐시 파일, Gemini·Antigravity는 목록 명령을 처음 한 번만 (agy는 인터넷으로 받아 옴)
  try { models.codex = JSON.parse(readFileSync(join(homedir(), ".codex", "models_cache.json"), "utf8")).models.filter((x: any) => x.visibility !== "hide").map((x: any) => [x.slug, x.display_name || pretty(x.slug)]); } catch {}
  const list = async (t: string, a: string[], re: RegExp) => {
    if (models[t] || !have[t]) return;
    models[t] = [];   // 실패해도 다시 묻지 않는다
    try { models[t] = [...(await run("cmd.exe", ["/d", "/c", t, ...a], { timeout: 30_000 })).stdout.matchAll(re)].map((x) => [x[1], x[2] === x[1] ? pretty(x[1]) : x[2]]); } catch {}
  };
  list("gemini", ["--list-models"], /^([\w.\-]+) \((.+)\)\s*$/gm);   // "gemini-2.5-pro (gemini-2.5-pro)"처럼 이름이 id 그대로면 다듬는다
  list("agy", ["models"], /^([\w.\-]+)\t(.+?)\s*$/gm);
}
// "gemini-3.1-flash-lite" → "Gemini 3.1 Flash Lite"
export const pretty = (id: string) => id.split("-").map((w) => (w === "gpt" ? "GPT" : w[0].toUpperCase() + w.slice(1))).join(" ");
const models: Record<string, [string, string][]> = { claude: [["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]] };
function toolInfo() {   // installed: 아직 찾는 중이면 비어 있다
  if (Date.now() - haveAt > 30_000) refreshTools();
  return Object.fromEntries(Object.entries(TOOLS).map(([k, v]) => [k, { label: v.label, install: v.install, efforts: v.efforts, models: models[k] ?? [], installed: have[k] }]));
}
refreshTools();

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
  if (tool === "claude" && !claudeExe) claudeExe = whereSync("claude");   // 서버를 켠 뒤에 깔았을 수도 있다
  if (tool === "claude" && !claudeExe) throw new Error(`Claude Code isn't installed. Install it with ${TOOLS.claude.install}.`);
  let file = claudeExe, argv = args;
  if (tool !== "claude") {
    // .exe(agy 등)는 바로 띄우고, npm으로 깐 CLI(.cmd)는 cmd로 감싸 띄운다 (node-pty는 .cmd를 바로 못 띄움)
    const exe = whereSync(`${tool}.exe`), extra = TOOLS[tool].args(model, effort);
    if (exe) argv = extra;
    else if (whereSync(`${tool}.cmd`)) argv = ["/d", "/c", `${tool}.cmd`, ...extra];
    else throw new Error(`${TOOLS[tool].label} isn't installed. Install it with: ${TOOLS[tool].install}`);
    file = exe || "cmd.exe";
  }
  const term = pty.spawn(file, argv, { name: "xterm-256color", cols: 100, rows: 30, cwd, env });
  const s: Live = { id, n, model, effort, cwd, start: Date.now(), name, team, role, tool, term, chunks: [], bufLen: 0, pending: "", flushT: null, exited: false, sockets: new Set(), lastOut: Date.now() };
  // 출력은 조각째 쌓고(매번 큰 문자열을 복사하지 않게) 16ms마다 한 번에 보낸다. 세션이 많아도 서버가 막히지 않게
  // ponytail: 화면 복원용 버퍼는 마지막 약 400KB를 조각 단위로, 이스케이프 시퀀스 중간에서 잘릴 수 있음
  const flush = () => { s.flushT = null; const out = s.pending; s.pending = ""; if (out) for (const ws of s.sockets) ws.send(out); };
  term.onData((d: string) => {
    s.chunks.push(d); s.bufLen += d.length; s.lastOut = Date.now();
    for (const l of loops.values()) if (l.session === s.id && l.status === "on") l.tail = (l.tail + plainText(d)).slice(-4000);
    while (s.bufLen > 400_000 && s.chunks.length > 1) s.bufLen -= s.chunks.shift()!.length;
    s.pending += d;
    if (!s.flushT) s.flushT = setTimeout(flush, 16);
  });
  term.onExit(() => { s.exited = true; clearTimeout(s.flushT); flush(); for (const ws of s.sockets) ws.send("\r\n[session ended]\r\n"); });
  live.set(id, s);
  return s;
}

// 붙여넣기(bracketed paste)로 넣고, TUI가 다 받은 뒤 Enter
function sendText(s: Live, text: string) {
  s.term.write(`\x1b[200~${text}\x1b[201~`);
  setTimeout(() => { if (!s.exited) s.term.write("\r"); }, 150);
}

// ---- 인수인계(handoff): 넘기는 세션이 직접 인수인계서를 쓰고, 다 쓰면 받는 세션에 "읽고 이어서 해"를 보낸다 ----
// 작업을 가장 잘 아는 건 그 세션 자신이라 요약을 따로 만들지 않는다. 어떤 CLI든 같은 방식으로 된다
type Handoff = { id: string; from: string; to: string; path: string; note: string; status: "writing" | "delivering" | "delivered" | "failed"; at: number; size: number; still: number };
const handoffs = new Map<string, Handoff>();
export const briefPrompt = (rel: string) =>
  `Hand this work over to another agent who will continue it. Write a handoff brief to the file ${rel} (create the folder if needed). ` +
  `Include: the goal, what is done (with file paths), what is not done yet, decisions and why, known problems, and the exact next steps. ` +
  `Keep it under 60 lines and write it in the language we have been using. Do not do any other work. When the file is written, say HANDOFF READY.`;
export const receivePrompt = (path: string, note: string) =>
  `You are taking over work from another session. First read the handoff brief at ${path}, then continue with its next steps.` + (note ? ` Extra instruction from the user: ${note}` : "");
function stampName() { const d = new Date(), p = (n: number) => String(n).padStart(2, "0"); return `handoff-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.md`; }
setInterval(() => {
  for (const h of handoffs.values()) {
    if (h.status === "writing") {
      if (Date.now() - h.at > 15 * 60_000 || !live.get(h.from) || live.get(h.from)!.exited) { h.status = "failed"; continue; }
      let size = 0; try { size = statSync(h.path).size; } catch {}
      if (size > 0 && size === h.size) h.still++; else h.still = 0;
      h.size = size;
      if (h.still >= 2) h.status = "delivering";   // 2초 동안 크기가 그대로면 다 쓴 것으로 본다
    }
    if (h.status === "delivering") {
      const t = live.get(h.to);
      if (!t || t.exited) { h.status = "failed"; continue; }
      // 받는 세션이 막 켜졌으면 화면이 자리 잡을 때까지(출력이 1.5초 조용해질 때까지) 기다린다
      if (Date.now() - t.start > 4000 && Date.now() - t.lastOut > 1500) { sendText(t, receivePrompt(h.path, h.note)); h.status = "delivered"; }
    }
  }
}, 1000).unref();

// ---- 반복(loop): 쉴 때 / N분마다 / 화면에 어떤 글자가 나오면 지시문을 보낸다. 목표 글자가 나오거나 횟수를 다 채우면 멈춘다 ----
type Loop = { id: string; session: string; when: "idle" | "every" | "match"; every: number; match: string; text: string; until: string; max: number;
  runs: number; lastFire: number; tail: string; status: "on" | "done" | "stopped"; why: string };
const loops = new Map<string, Loop>();
export const plainText = (x: string) => x.replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b./g, "");
export const seen = (tail: string, needle: string) => !!needle && tail.toLowerCase().includes(needle.toLowerCase());
setInterval(() => {
  const now = Date.now();
  for (const l of loops.values()) {
    if (l.status !== "on") continue;
    const s = live.get(l.session);
    if (!s || s.exited) { l.status = "stopped"; l.why = "the session closed"; continue; }
    if (seen(l.tail, l.until)) { l.status = "done"; l.why = `"${l.until}" appeared`; continue; }
    if (l.runs >= l.max) { l.status = "stopped"; l.why = `ran ${l.max} times`; continue; }
    let fire = false;
    if (l.when === "every") fire = now - l.lastFire >= l.every * 60_000;
    else if (l.when === "match") fire = seen(l.tail, l.match) && now - l.lastFire > 10_000;
    else {   // idle: Claude Code는 훅이 알려 주는 "끝남", 다른 CLI는 20초 동안 출력이 없으면. 보낸 뒤 새 출력이 있어야 다시 보낸다
      const idle = s.tool === "claude" ? sessionState(s.id) === "done" : now - s.lastOut > 20_000;
      fire = idle && s.lastOut > l.lastFire + 2000 && now - l.lastFire > 15_000;
    }
    if (fire) { sendText(s, l.text); l.runs++; l.lastFire = now; l.tail = ""; }
  }
}, 1000).unref();

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
    return json(res, 200, { email: email(), max: MAX, home: homedir(), defaultCwd: homedir(), limits: limits(), teams, sessions, tools: toolInfo(),
      presets: presets.map((p) => ({ id: p.id, name: p.name, count: p.sessions.length })),
      handoffs: [...handoffs.values()].slice(-10).map((h) => ({ id: h.id, from: h.from, to: h.to, status: h.status })),
      loops: [...loops.values()].slice(-30).map(({ tail, lastFire, ...l }) => l) });
  }
  // 인수인계: from 세션이 인수인계서를 쓰고, to 세션(없으면 같은 설정의 새 세션)이 받아서 이어 간다
  if (req.method === "POST" && url.pathname === "/api/handoff") {
    if (!originOk(req) || req.headers["content-type"] !== "application/json") return json(res, 403, { error: "forbidden" });
    const b = await readBody(req), s = b && live.get(b.from);
    if (!s || s.exited) return json(res, 400, { error: "That session isn't running." });
    let t = b.to ? live.get(b.to) : undefined;
    if (b.to && (!t || t.exited || t.id === s.id)) return json(res, 400, { error: "Pick a different running session to receive the work." });
    const dir = join(s.cwd, ".cerebro");
    try { mkdirSync(dir, { recursive: true }); if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "*\n"); }   // git이 이 폴더를 무시하게
    catch (e: any) { return json(res, 500, { error: `Can't write in ${s.cwd}: ${e?.message ?? e}` }); }
    if (!t) {
      if (live.size >= MAX) return json(res, 409, { error: `at most ${MAX} sessions` });
      try { t = startSession(s.model === "default" ? "" : s.model, s.effort, s.cwd, cleanName(`${s.name || `Session ${s.n}`} 2`), s.team, "", s.role, false, s.tool); }
      catch (e: any) { return json(res, 500, { error: String(e?.message ?? e) }); }
    }
    const name = stampName(), path = join(dir, name);
    sendText(s, briefPrompt(`.cerebro/${name}`));
    const h: Handoff = { id: randomUUID(), from: s.id, to: t.id, path, note: cleanSend(b.note).slice(0, 1000), status: "writing", at: Date.now(), size: 0, still: 0 };
    handoffs.set(h.id, h);
    return json(res, 200, { id: h.id, to: t.id });
  }
  // 반복 만들기 / 끄기
  if (req.method === "POST" && url.pathname === "/api/loop") {
    if (!originOk(req) || req.headers["content-type"] !== "application/json") return json(res, 403, { error: "forbidden" });
    const b = await readBody(req), s = b && live.get(b.session), text = cleanSend(b?.text), until = cleanSend(b?.until).slice(0, 200), match = cleanSend(b?.match).slice(0, 200);
    if (!s || s.exited) return json(res, 400, { error: "That session isn't running." });
    if (!["idle", "every", "match"].includes(b.when)) return json(res, 400, { error: "Pick when the loop runs." });
    if (!text) return json(res, 400, { error: "Write what to send each time." });
    const every = Math.round(Number(b.every)), max = Math.round(Number(b.max ?? 10));
    if (b.when === "every" && !(every >= 1 && every <= 1440)) return json(res, 400, { error: "Every 1 to 1440 minutes." });
    if (b.when === "match" && !match) return json(res, 400, { error: "Write the text to watch for." });
    if (!(max >= 1 && max <= 100)) return json(res, 400, { error: "Run it 1 to 100 times." });
    // 보낸 글이 화면에 그대로 찍히므로, 그 안에 든 글자로는 멈추거나 다시 시작할 수 없다
    if (seen(text, until) || seen(text, match)) return json(res, 400, { error: "The stop or watch text can't appear inside the message itself." });
    const l: Loop = { id: randomUUID(), session: s.id, when: b.when, every, match, text, until, max, runs: 0, lastFire: b.when === "every" ? Date.now() : 0, tail: "", status: "on", why: "" };
    loops.set(l.id, l);
    return json(res, 200, { id: l.id });
  }
  if (req.method === "DELETE" && url.pathname === "/api/loop") {
    if (!originOk(req)) return json(res, 403, { error: "forbidden" });
    const l = loops.get(url.searchParams.get("id") ?? "");
    if (l && l.status === "on") { l.status = "stopped"; l.why = "you stopped it"; }
    return json(res, 200, {});
  }
  // 한 번 입력으로 여러 세션에 지시: 붙여넣기(bracketed paste)로 넣고 Enter. 여러 줄이어도 중간에 제출되지 않는다
  if (req.method === "POST" && url.pathname === "/api/send") {
    if (!originOk(req) || req.headers["content-type"] !== "application/json") return json(res, 403, { error: "forbidden" });
    const b = await readBody(req), text = cleanSend(b?.text);
    if (!b || !Array.isArray(b.ids) || !text) return json(res, 400, { error: "Pick at least one session and write a message." });
    let sent = 0;
    for (const id of new Set(b.ids as string[])) {
      const s = live.get(id);
      if (!s || s.exited) continue;
      sendText(s, text);
      sent++;
    }
    return json(res, 200, { sent });
  }
  if (req.method === "POST" && url.pathname === "/api/new") {
    if (!originOk(req) || req.headers["content-type"] !== "application/json") return json(res, 403, { error: "forbidden" });
    const b = await readBody(req);
    const tool = b && Object.hasOwn(TOOLS, b.tool) ? b.tool : "claude";
    // Claude Code는 추론 강도가 꼭 있어야 하고, 다른 CLI는 비워 두면 그 CLI의 기본값
    if (!b || !MODEL_RE.test(b.model ?? "") || !(tool === "claude" ? EFFORTS : ["", ...TOOLS[tool].efforts]).includes(b.effort)) return json(res, 400, { error: "model or effort is invalid" });
    if (typeof b.cwd !== "string" || !existsSync(b.cwd) || !statSync(b.cwd).isDirectory()) return json(res, 400, { error: "folder does not exist" });
    if (live.size >= MAX) return json(res, 409, { error: `at most ${MAX} sessions` });
    try { return json(res, 200, { id: startSession(b.model ?? "", b.effort, b.cwd, cleanName(b.name), teamOk(b.team) ? b.team : MAIN, "", cleanName(b.role, 60), tool === "claude" && b.rc === true, tool).id }); }
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
    if (!MODEL_RE.test(b.model ?? "") || !EFFORTS.includes(b.effort)) return json(res, 400, { error: "model or effort is invalid" });
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
  // 프리셋 저장: 팀의 지금 구성을 그대로 적어 둔다. 같은 이름의 프리셋이 있으면 덮어쓴다
  if (req.method === "POST" && url.pathname === "/api/preset") {
    if (!originOk(req) || req.headers["content-type"] !== "application/json") return json(res, 403, { error: "forbidden" });
    const b = await readBody(req), t = teams.find((x) => x.id === b?.team);
    if (!t) return json(res, 404, { error: "team not found" });
    const sessions = [...live.values()].filter((s) => !s.exited && (teamOk(s.team) ? s.team : MAIN) === t.id).sort((x, y) => x.n - y.n)
      .map((s) => ({ tool: s.tool, model: s.model, effort: s.effort, cwd: s.cwd, name: s.name, role: s.role }));
    if (!sessions.length) return json(res, 400, { error: "This team has no running sessions to save." });
    const old = presets.find((p) => p.name === t.name);
    if (!old && presets.length >= 20) return json(res, 409, { error: "at most 20 presets" });
    const p: Preset = { id: old?.id ?? randomUUID().slice(0, 8), name: t.name, rules: t.rules ?? "", sessions };
    presets = presets.filter((x) => x !== old).concat(p); savePresets();
    return json(res, 200, { id: p.id, count: sessions.length });
  }
  // 프리셋 띄우기: 같은 이름·규칙의 새 팀을 만들고 세션을 한꺼번에 띄운다. 폴더가 없어졌거나 상한에 걸린 세션은 건너뛰고 알려 준다
  if (req.method === "POST" && url.pathname === "/api/preset/launch") {
    if (!originOk(req) || req.headers["content-type"] !== "application/json") return json(res, 403, { error: "forbidden" });
    const b = await readBody(req), p = presets.find((x) => x.id === b?.id);
    if (!p) return json(res, 404, { error: "preset not found" });
    if (teams.length >= 12) return json(res, 409, { error: "at most 12 teams" });
    const rules = cleanRules(p.rules), t: Team = { id: randomUUID().slice(0, 8), name: cleanName(p.name) || "Preset", ...(rules ? { rules } : {}) };
    teams.push(t); saveTeams();
    let started = 0;
    const skipped: string[] = [];
    for (const x of p.sessions) {
      const tool = Object.hasOwn(TOOLS, x?.tool) ? x.tool : "claude", label = cleanName(x?.name) || cleanName(x?.role) || TOOLS[tool].label;
      if (live.size >= MAX) { skipped.push(`${label}: at most ${MAX} sessions`); continue; }
      if (!MODEL_RE.test(x.model ?? "") || !(tool === "claude" ? EFFORTS : ["", ...TOOLS[tool].efforts]).includes(x.effort)) { skipped.push(`${label}: model or effort is invalid`); continue; }
      if (typeof x.cwd !== "string" || !existsSync(x.cwd) || !statSync(x.cwd).isDirectory()) { skipped.push(`${label}: folder is gone`); continue; }
      try { startSession(x.model ?? "", x.effort, x.cwd, cleanName(x.name), t.id, "", cleanName(x.role, 60), false, tool); started++; }
      catch (e: any) { skipped.push(`${label}: ${e?.message ?? e}`); }
    }
    return json(res, 200, { team: t.id, started, skipped });
  }
  if (req.method === "DELETE" && url.pathname === "/api/preset") {
    if (!originOk(req)) return json(res, 403, { error: "forbidden" });
    presets = presets.filter((p) => p.id !== url.searchParams.get("id")); savePresets();
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
    // 아직 안 보낸 출력은 기존 화면에 먼저 보내고 비운다. 새 화면은 쌓인 조각 전체로 복원하므로 같은 출력이 두 번 오지 않는다
    if (s.flushT) { clearTimeout(s.flushT); s.flushT = null; const out = s.pending; s.pending = ""; for (const o of s.sockets) o.send(out); }
    s.sockets.add(ws);
    if (s.chunks.length) ws.send(s.chunks.join(""));
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
// 서버가 죽은 시각과 이유를 server.log에 남긴다 (start.bat이 출력을 그리로 보낸다)
const stamp = () => new Date().toISOString();
process.on("exit", (code) => { console.error(stamp(), `exit code ${code}, ${live.size} sessions, heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB`); killAll(); });
process.on("SIGINT", () => process.exit());
// 세션 하나의 오류(터미널 종료 중 쓰기 등)로 서버 전체가 죽지 않게 한다
process.on("uncaughtException", (e) => console.error(stamp(), "uncaught:", e));
process.on("unhandledRejection", (e) => console.error(stamp(), "unhandled:", e));

if (process.argv[1]?.endsWith("server.ts")) {
  server.listen(PORT, "127.0.0.1", () => console.log(`http://127.0.0.1:${PORT}`));
}

// 자체 확인: node server.ts --check
if (process.argv.includes("--check")) {
  console.assert(fmtDuration(3723000) === "1h 2m 3s", "fmtDuration");
  console.assert(plainText("\x1b[31mALL \x1b[1mTESTS\x1b[0m PASS\x1b]0;title\x07") === "ALL TESTS PASS" && seen("x all tests pass y", "ALL TESTS PASS") && !seen("abc", ""), "loop text matching ignores colors and case");
  console.assert(briefPrompt(".cerebro/x.md").includes(".cerebro/x.md") && receivePrompt("p.md", "").endsWith("next steps.") && receivePrompt("p.md", "go").includes("go"), "handoff prompts carry the path and the note");
  console.assert(cleanSend("  fix it\r\nthen test\x1b[2J\x07 ") === "fix it\nthen test[2J" && cleanSend(42) === "", "cleanSend keeps lines, strips control chars");
  console.assert(pretty("gemini-3.1-flash-lite") === "Gemini 3.1 Flash Lite" && pretty("gpt-oss") === "GPT Oss", "pretty model names");
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
