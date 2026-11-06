// Claude Code 상태줄 명령: 세션이 넘겨주는 JSON(사용량 한도 포함)을 파일로 남기고 화면에는 아무것도 찍지 않는다.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

try {
  const raw = readFileSync(0, "utf8");
  const dir = join(tmpdir(), "session-board-status");
  mkdirSync(dir, { recursive: true });
  const id = String(JSON.parse(raw).session_id ?? "unknown").replace(/[^\w-]/g, "");
  writeFileSync(join(dir, `${id}.json`), raw);
} catch {}
