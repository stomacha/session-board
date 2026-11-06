// Claude Code 훅 명령: 이벤트를 세션 상태로 바꿔 파일에 남긴다. 보드가 이 파일을 읽어 테두리 색을 바꾼다.
// UserPromptSubmit·PostToolUse → working, Notification(권한 요청 등) → waiting, Stop → done
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function stateOf(ev) {
  const e = ev?.hook_event_name;
  if (e === "UserPromptSubmit" || e === "PostToolUse") return "working";
  if (e === "Stop") return "done";
  if (e === "Notification") {
    // 일이 끝나고 한참 입력이 없을 때 오는 알림은 "끝남"을 덮지 않는다
    const idle = ev.notification_type === "idle_prompt" || /waiting for your input/i.test(ev.message ?? "");
    return idle ? null : "waiting";
  }
  return null;
}

if (process.argv[1]?.endsWith("hook.mjs")) {
  try {
    const ev = JSON.parse(readFileSync(0, "utf8").replace(/^﻿/, ""));   // 셸에 따라 앞에 BOM이 붙는다
    const s = stateOf(ev), id = String(ev.session_id ?? "").replace(/[^\w-]/g, "");
    if (s && id) {
      const dir = join(tmpdir(), "session-board-status");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.state`), JSON.stringify({ s, t: Date.now() }));
    }
  } catch {}
}
