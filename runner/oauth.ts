// ChatGPT 플랜 사용 OAuth (공식 동적 등록·루프백 콜백). 출처: developers.openai.com/siwc/token-sharing-open-source/sign-in
// 순서: discovery → 127.0.0.1 콜백 리스너 → 승인 화면 → state 검증 → 코드 교환 → ID 토큰 검증 → scope 확인 → 저장
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { dataDir, deleteSecret, hostId, loadSecret, saveSecret } from "./secure-store";

export const ISSUER = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
export const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const AGENT_NAME = "Red for Think Runner";
const DYNAMIC_CLIENT = "dynamic_agent_client";
const CALLBACK_PATH = "/auth/callback";
const DEFAULT_PORT = 1455;
const SECRET_NAME = "credentials";

export interface Registration {
  issuer: string;
  subject: string;
  email: string | null;
  client_id: string; // 발급받은 실제 client ID (dynamic_agent_client가 아님)
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
  expires_at: string;
  earliest_refresh_at: string | null;
  scopes: string[];
  saved_at: string;
}

export interface Credentials {
  registration: Registration;
  ext_agent_host_id: string;
  tokens: Tokens | null;
}

export class AuthError extends Error {
  constructor(
    public code: "STATE_MISMATCH" | "CALLBACK_ERROR" | "TOKEN_EXCHANGE_FAILED" | "ID_TOKEN_INVALID" | "ACCOUNT_MISMATCH" | "DISCOVERY_FAILED" | "REAUTH_REQUIRED" | "REFRESH_TEMPORARY" | "NOT_SIGNED_IN" | "TIMEOUT",
    message: string,
  ) {
    super(message);
  }
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
}

export interface OAuthOptions {
  issuer?: string;
  port?: number;
  timeoutMs?: number;
  // 승인 URL을 여는 방법. 기본은 OS 브라우저. 시험에서는 가짜 사용자로 바꾼다.
  openBrowser?: (url: string) => Promise<void> | void;
  log?: (line: string) => void;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export function loadCredentials(): Credentials | null {
  return loadSecret<Credentials>(SECRET_NAME);
}

export async function discover(issuer = ISSUER): Promise<Discovery> {
  let doc: Discovery;
  try {
    const res = await fetch(`${issuer}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    doc = (await res.json()) as Discovery;
  } catch (e) {
    throw new AuthError("DISCOVERY_FAILED", `로그인 서버 정보를 가져오지 못했습니다: ${e instanceof Error ? e.message : e}`);
  }
  // 신뢰하는 발급자와 일치하고, 엔드포인트가 같은 출처에 있는지 확인한다.
  const origin = new URL(issuer).origin;
  if (doc.issuer !== issuer) throw new AuthError("DISCOVERY_FAILED", "발급자(issuer)가 예상과 다릅니다.");
  for (const url of [doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri, doc.revocation_endpoint]) {
    if (url && new URL(url).origin !== origin) throw new AuthError("DISCOVERY_FAILED", "로그인 엔드포인트가 발급자와 다른 출처에 있습니다.");
  }
  return doc;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

interface Callback {
  code: string;
  client_id: string | null;
  scope: string | null;
}

// 127.0.0.1에만 바인딩한 1회용 콜백 리스너
function listenForCallback(port: number, state: string, timeoutMs: number): Promise<{ redirectUri: string; result: Promise<Callback>; close: () => void }> {
  return new Promise((resolve, reject) => {
    let settle: (v: Callback) => void = () => undefined;
    let fail: (e: Error) => void = () => undefined;
    const result = new Promise<Callback>((res, rej) => {
      settle = res;
      fail = rej;
    });
    result.catch(() => undefined);
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      const host = req.headers.host ?? "";
      const page = (title: string) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:sans-serif;padding:2rem"><h1>${title}</h1><p>이 창은 닫아도 됩니다.</p></body>`);
      };
      if (!host.startsWith("127.0.0.1:") || url.pathname !== CALLBACK_PATH || req.method !== "GET") {
        res.writeHead(404).end();
        return;
      }
      const got = url.searchParams;
      if (!safeEqual(got.get("state") ?? "", state)) {
        page("로그인 요청을 확인할 수 없습니다");
        fail(new AuthError("STATE_MISMATCH", "콜백의 state 값이 요청과 다릅니다. 로그인을 중단했습니다."));
        return;
      }
      if (got.get("error")) {
        page("로그인이 취소되었거나 실패했습니다");
        fail(new AuthError("CALLBACK_ERROR", `로그인 실패: ${got.get("error")} ${got.get("error_description") ?? ""}`.trim()));
        return;
      }
      const code = got.get("code");
      if (!code) {
        page("로그인 응답에 코드가 없습니다");
        fail(new AuthError("CALLBACK_ERROR", "콜백에 인증 코드가 없습니다."));
        return;
      }
      page("로그인 응답을 받았습니다");
      settle({ code, client_id: got.get("client_id"), scope: got.get("scope") });
    });
    const timer = setTimeout(() => fail(new AuthError("TIMEOUT", "제한 시간 안에 로그인이 끝나지 않았습니다.")), timeoutMs);
    const close = () => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
    };
    server.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE" && port !== 0) {
        // 기본 포트가 사용 중이면 빈 포트를 쓴다(스킴·호스트·경로는 그대로).
        server.listen(0, "127.0.0.1");
        return;
      }
      clearTimeout(timer);
      reject(e);
    });
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({ redirectUri: `http://127.0.0.1:${actual}${CALLBACK_PATH}`, result, close });
    });
  });
}

async function postForm(url: string, form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

function tokensFrom(body: Record<string, unknown>, fallback: Partial<Tokens>): Tokens {
  const now = Date.now();
  const expiresIn = Number(body.expires_in ?? 3600);
  const early = typeof body.earliest_refresh_at === "number" ? new Date(body.earliest_refresh_at * 1000).toISOString() : typeof body.earliest_refresh_at === "string" ? body.earliest_refresh_at : null;
  return {
    access_token: String(body.access_token),
    refresh_token: String(body.refresh_token ?? fallback.refresh_token ?? ""),
    id_token: String(body.id_token ?? fallback.id_token ?? ""),
    token_type: String(body.token_type ?? "Bearer"),
    expires_in: expiresIn,
    expires_at: new Date(now + expiresIn * 1000).toISOString(),
    earliest_refresh_at: early,
    scopes: body.scope ? String(body.scope).split(/\s+/).filter(Boolean).sort() : (fallback.scopes ?? []),
    saved_at: new Date(now).toISOString(),
  };
}

export function defaultOpenBrowser(url: string) {
  // URL은 화면에도 출력하므로, 브라우저가 열리지 않으면 직접 붙여 넣으면 된다.
  import("node:child_process").then(({ spawn }) => {
    if (process.platform === "win32") spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
    else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  });
}

// 로그인. 모든 검증을 통과한 뒤에만 저장하므로, 실패해도 기존 정상 자격 증명은 그대로 남는다.
export async function login(opts: OAuthOptions = {}): Promise<Credentials> {
  const issuer = opts.issuer ?? ISSUER;
  const log = opts.log ?? (() => undefined);
  const disc = await discover(issuer);
  const existing = loadCredentials();
  const reuse = existing?.registration.issuer === issuer ? existing.registration : null;
  const host = existing?.ext_agent_host_id ?? hostId();

  const state = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());

  const cb = await listenForCallback(opts.port ?? DEFAULT_PORT, state, opts.timeoutMs ?? 5 * 60_000);
  try {
    const params = new URLSearchParams({
      client_id: reuse?.client_id ?? DYNAMIC_CLIENT,
      ext_agent_host_id: host,
      response_type: "code",
      redirect_uri: cb.redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: challenge,
    });
    if (!reuse) params.set("agent_name_hint", AGENT_NAME);
    if (reuse && existing?.tokens?.id_token) params.set("id_token_hint", existing.tokens.id_token);
    const url = `${disc.authorization_endpoint}?${params}`;
    log("브라우저에서 ChatGPT 로그인과 플랜 사용 승인을 진행해 주세요. 열리지 않으면 아래 주소를 직접 여세요.");
    log(url);
    await (opts.openBrowser ?? defaultOpenBrowser)(url);

    const got = await cb.result;
    // 최초 등록이면 콜백의 client_id가 발급 ID다. 재로그인은 저장한 ID를 다시 쓴다.
    const clientId = got.client_id ?? reuse?.client_id;
    if (!clientId || clientId === DYNAMIC_CLIENT) throw new AuthError("CALLBACK_ERROR", "발급된 client ID를 받지 못했습니다.");
    if (reuse && got.client_id && got.client_id !== reuse.client_id) throw new AuthError("ACCOUNT_MISMATCH", "저장된 등록과 다른 client ID가 돌아왔습니다. 계정을 바꾸려면 먼저 logout 하세요.");

    const ex = await postForm(disc.token_endpoint, {
      grant_type: "authorization_code",
      client_id: clientId,
      code: got.code,
      code_verifier: verifier,
      redirect_uri: cb.redirectUri,
      resource: RESOURCE,
    });
    if (ex.status !== 200 || !ex.body.access_token || !ex.body.id_token) {
      throw new AuthError("TOKEN_EXCHANGE_FAILED", `코드 교환에 실패했습니다(HTTP ${ex.status}${ex.body.error ? `, ${ex.body.error}` : ""}).`);
    }

    // ID 토큰: JWKS 서명·발급자·대상(발급 client ID)·만료·nonce를 모두 검증한다.
    let claims: Record<string, unknown>;
    try {
      const verified = await jwtVerify(String(ex.body.id_token), createRemoteJWKSet(new URL(disc.jwks_uri)), { issuer: disc.issuer, audience: clientId });
      claims = verified.payload as Record<string, unknown>;
    } catch (e) {
      throw new AuthError("ID_TOKEN_INVALID", `ID 토큰 검증에 실패했습니다: ${e instanceof Error ? e.message : e}`);
    }
    if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, nonce)) throw new AuthError("ID_TOKEN_INVALID", "ID 토큰의 nonce가 요청과 다릅니다.");
    if (typeof claims.sub !== "string" || !claims.sub) throw new AuthError("ID_TOKEN_INVALID", "ID 토큰에 subject가 없습니다.");
    if (reuse && reuse.subject !== claims.sub) {
      throw new AuthError("ACCOUNT_MISMATCH", "저장된 등록과 다른 ChatGPT 계정으로 로그인했습니다. 계정을 바꾸려면 먼저 logout 하세요.");
    }

    const tokens = tokensFrom(ex.body, { scopes: got.scope ? got.scope.split(/\s+/).filter(Boolean).sort() : [] });
    const creds: Credentials = {
      registration: { issuer: disc.issuer, subject: claims.sub, email: typeof claims.email === "string" ? claims.email : null, client_id: clientId },
      ext_agent_host_id: host,
      tokens,
    };
    saveSecret(SECRET_NAME, creds);
    return creds;
  } finally {
    cb.close();
  }
}

export function planUsageEnabled(creds: Credentials | null): boolean {
  return Boolean(creds?.tokens?.scopes.includes(PLAN_SCOPE));
}

// ── 갱신: 같은 세션의 갱신은 한 번에 하나만 (프로세스 안: 프라미스, 프로세스 간: 잠금 파일) ──

let refreshing: Promise<Credentials> | null = null;

function acquireLock(): () => void {
  const file = path.join(dataDir(), "refresh.lock");
  for (let i = 0; i < 100; i++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.closeSync(fd);
      return () => fs.rmSync(file, { force: true });
    } catch {
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > 30_000) fs.rmSync(file, { force: true });
      } catch {
        /* 다른 프로세스가 방금 지움 */
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  throw new AuthError("REFRESH_TEMPORARY", "다른 프로세스가 토큰을 갱신 중입니다. 잠시 뒤 다시 시도해 주세요.");
}

export async function refresh(opts: OAuthOptions = {}): Promise<Credentials> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const release = acquireLock();
    try {
      // 잠금을 얻은 뒤 다시 읽는다: 다른 프로세스가 이미 갱신했을 수 있다.
      const creds = loadCredentials();
      if (!creds?.tokens?.refresh_token) throw new AuthError("NOT_SIGNED_IN", "로그인되어 있지 않습니다. runner login을 실행해 주세요.");
      if (!needsRefresh(creds.tokens)) return creds;
      const disc = await discover(opts.issuer ?? creds.registration.issuer);
      let res: Awaited<ReturnType<typeof postForm>>;
      try {
        // scope는 보내지 않는다(공식 규칙).
        res = await postForm(disc.token_endpoint, { grant_type: "refresh_token", client_id: creds.registration.client_id, refresh_token: creds.tokens.refresh_token, resource: RESOURCE });
      } catch (e) {
        // 일시적인 네트워크 오류만으로는 자격 증명을 지우지 않는다.
        throw new AuthError("REFRESH_TEMPORARY", `토큰 갱신 요청에 실패했습니다(네트워크): ${e instanceof Error ? e.message : e}`);
      }
      if (res.status === 200 && res.body.access_token) {
        const next: Credentials = { ...creds, tokens: tokensFrom(res.body, creds.tokens) };
        saveSecret(SECRET_NAME, next); // access·refresh·만료 정보를 한 번에 교체
        return next;
      }
      if (res.body.error === "invalid_grant" || res.body.error === "invalid_client") {
        // 확정된 무효 토큰: 토큰만 지우고 등록(client ID)은 남겨 재로그인에 쓴다.
        saveSecret(SECRET_NAME, { ...creds, tokens: null });
        throw new AuthError("REAUTH_REQUIRED", "로그인이 만료되었거나 연결이 해제되었습니다. runner login으로 다시 로그인해 주세요.");
      }
      throw new AuthError("REFRESH_TEMPORARY", `토큰 갱신에 실패했습니다(HTTP ${res.status}). 자격 증명은 그대로 두었습니다.`);
    } finally {
      release();
    }
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}

function needsRefresh(t: Tokens): boolean {
  const now = Date.now();
  if (t.earliest_refresh_at && now >= new Date(t.earliest_refresh_at).getTime()) return true;
  return new Date(t.expires_at).getTime() - now < 120_000;
}

// 호출 직전에 유효한 access token을 돌려준다. 토큰 값은 호출자 밖으로 내보내지 않는다.
export async function getAccessToken(opts: OAuthOptions = {}): Promise<string> {
  let creds = loadCredentials();
  if (!creds?.tokens) throw new AuthError("NOT_SIGNED_IN", "로그인되어 있지 않습니다. runner login을 실행해 주세요.");
  if (needsRefresh(creds.tokens)) creds = await refresh(opts);
  return creds.tokens!.access_token;
}

// 로그아웃: 원격 철회와 로컬 삭제 결과를 구분해 돌려준다.
export async function logout(opts: OAuthOptions = {}): Promise<{ local: "deleted" | "none"; remote: "revoked" | "failed" | "skipped"; detail: string }> {
  const creds = loadCredentials();
  if (!creds) return { local: "none", remote: "skipped", detail: "저장된 로그인 정보가 없습니다." };
  let remote: "revoked" | "failed" | "skipped" = "skipped";
  let detail = "";
  if (creds.tokens?.refresh_token) {
    try {
      const disc = await discover(opts.issuer ?? creds.registration.issuer);
      if (disc.revocation_endpoint) {
        const res = await fetch(disc.revocation_endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: creds.tokens.refresh_token, token_type_hint: "refresh_token", client_id: creds.registration.client_id }).toString(),
        });
        remote = res.status === 200 ? "revoked" : "failed";
        detail = res.status === 200 ? "원격 세션을 철회했습니다." : `원격 철회 실패(HTTP ${res.status}). ChatGPT 설정에서 앱 연결을 직접 해제해 주세요.`;
      } else detail = "철회 엔드포인트를 찾지 못했습니다. ChatGPT 설정에서 앱 연결을 직접 해제해 주세요.";
    } catch (e) {
      remote = "failed";
      detail = `원격 철회를 확인하지 못했습니다(${e instanceof Error ? e.message : e}). ChatGPT 설정에서 앱 연결을 직접 해제해 주세요.`;
    }
  }
  deleteSecret(SECRET_NAME);
  return { local: "deleted", remote, detail };
}
