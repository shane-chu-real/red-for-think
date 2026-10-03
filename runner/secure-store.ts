// 실행기 보호 저장소. Windows: DPAPI(현재 사용자) 암호화 + 소유자 전용 ACL, 그 외: 0600 파일.
// 토큰은 이 파일 밖(소스·로그·서버·브라우저)으로 내보내지 않는다.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const APP_NAME = "red-for-think-runner";

export function dataDir(): string {
  if (process.env.RFT_RUNNER_HOME) return process.env.RFT_RUNNER_HOME;
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  return path.join(os.homedir(), ".config", APP_NAME);
}

const PS_HEAD = "Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($in.Trim());";
const PS_SCOPE = "[System.Security.Cryptography.DataProtectionScope]::CurrentUser";

// 비밀값은 명령줄 인자가 아니라 표준입력으로 넘긴다(프로세스 목록에 남지 않게).
function dpapi(mode: "Protect" | "Unprotect", base64: string): string {
  const script = `${PS_HEAD} $o=[System.Security.Cryptography.ProtectedData]::${mode}($b,$null,${PS_SCOPE}); [Console]::Out.Write([Convert]::ToBase64String($o))`;
  const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input: base64, encoding: "utf8", windowsHide: true });
  if (res.status !== 0 || !res.stdout) throw new Error(`보호 저장소 처리 실패(DPAPI ${mode})`);
  return res.stdout.trim();
}

function restrictAcl(target: string) {
  if (process.platform !== "win32") return;
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  if (!user) return;
  // 상속 제거 후 현재 사용자에게만 권한을 준다.
  spawnSync("icacls", [target, "/inheritance:r", "/grant:r", `${user}:F`], { windowsHide: true });
}

function ensureDir(): string {
  const dir = dataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    restrictAcl(dir);
  }
  return dir;
}

function atomicWrite(file: string, content: string) {
  const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  restrictAcl(tmp);
  fs.renameSync(tmp, file);
}

export function saveSecret(name: string, value: unknown) {
  const file = path.join(ensureDir(), `${name}.bin`);
  const plain = Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  const body = process.platform === "win32" ? { v: 1, scheme: "dpapi", data: dpapi("Protect", plain) } : { v: 1, scheme: "file-0600", data: plain };
  atomicWrite(file, JSON.stringify(body));
}

export function loadSecret<T>(name: string): T | null {
  const file = path.join(dataDir(), `${name}.bin`);
  if (!fs.existsSync(file)) return null;
  const body = JSON.parse(fs.readFileSync(file, "utf8")) as { scheme: string; data: string };
  const plain = body.scheme === "dpapi" ? dpapi("Unprotect", body.data) : body.data;
  return JSON.parse(Buffer.from(plain, "base64").toString("utf8")) as T;
}

export function deleteSecret(name: string) {
  const file = path.join(dataDir(), `${name}.bin`);
  if (fs.existsSync(file)) fs.rmSync(file);
}

// 비밀이 아닌 설정(호스트 ID, 구조화 출력 확인 결과 등)
export function loadPlain<T>(name: string): T | null {
  const file = path.join(dataDir(), `${name}.json`);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : null;
}

export function savePlain(name: string, value: unknown) {
  atomicWrite(path.join(ensureDir(), `${name}.json`), JSON.stringify(value, null, 2));
}

// 설치 환경마다 한 번 만들고 계속 쓰는 호스트 식별자 (비밀 아님)
export function hostId(): string {
  const saved = loadPlain<{ ext_agent_host_id: string }>("host");
  if (saved?.ext_agent_host_id) return saved.ext_agent_host_id;
  const id = `urn:uuid:${crypto.randomUUID()}`;
  savePlain("host", { ext_agent_host_id: id, created_at: new Date().toISOString() });
  return id;
}
