// 시험용 가짜 서버: OpenAI 로그인(OAuth/OIDC)과 Responses 스트림을 흉내 낸다. 실제 계정·토큰은 쓰지 않는다.
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

function listen(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void>; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        server,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export interface FakeAuthControls {
  tamperState: boolean;
  tamperNonce: boolean;
  wrongKey: boolean;
  wrongAudience: boolean;
  dropPlanScope: boolean;
  subject: string;
  refreshError: string | null;
  refreshDelayMs: number;
}

export async function startFakeAuth() {
  const good = await generateKeyPair("RS256");
  const bad = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(good.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const control: FakeAuthControls = { tamperState: false, tamperNonce: false, wrongKey: false, wrongAudience: false, dropPlanScope: false, subject: "user-1", refreshError: null, refreshDelayMs: 0 };
  const seen = { authorize: [] as Record<string, string>[], token: [] as Record<string, string>[], revoke: [] as Record<string, string>[] };
  const codes = new Map<string, { nonce: string; challenge: string; client_id: string }>();
  let refreshSeq = 0;
  const ISSUED = "oaiapp_test_client";
  let base = "";

  const srv = await listen(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks`, revocation_endpoint: `${base}/revoke` });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      const p = Object.fromEntries(url.searchParams);
      seen.authorize.push(p);
      const code = randomUUID();
      const clientId = p.client_id === "dynamic_agent_client" ? ISSUED : p.client_id;
      codes.set(code, { nonce: p.nonce, challenge: p.code_challenge, client_id: clientId });
      const scope = control.dropPlanScope ? "openid profile email offline_access" : p.scope;
      const back = new URL(p.redirect_uri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", control.tamperState ? "attacker-state" : p.state);
      back.searchParams.set("client_id", clientId);
      back.searchParams.set("scope", scope);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
      seen.token.push(form);
      if (form.grant_type === "authorization_code") {
        const rec = codes.get(form.code);
        const ok = rec && createHash("sha256").update(form.code_verifier).digest("base64url") === rec.challenge && form.client_id === rec.client_id && form.resource === "https://api.openai.com/v1";
        if (!ok || !rec) return json(400, { error: "invalid_grant" });
        const id_token = await new SignJWT({ nonce: control.tamperNonce ? "other-nonce" : rec.nonce, email: "user@example.com" })
          .setProtectedHeader({ alg: "RS256", kid: "k1" })
          .setIssuer(base)
          .setAudience(control.wrongAudience ? "someone-else" : rec.client_id)
          .setSubject(control.subject)
          .setIssuedAt()
          .setExpirationTime("10m")
          .sign(control.wrongKey ? bad.privateKey : good.privateKey);
        return json(200, {
          access_token: `access-${randomUUID()}`,
          refresh_token: `refresh-${++refreshSeq}`,
          id_token,
          token_type: "Bearer",
          expires_in: 3600,
          scope: control.dropPlanScope ? "openid profile email offline_access" : "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
        });
      }
      if (form.grant_type === "refresh_token") {
        if (control.refreshDelayMs) await new Promise((r) => setTimeout(r, control.refreshDelayMs));
        if (control.refreshError) return json(400, { error: control.refreshError });
        return json(200, { access_token: `access-${randomUUID()}`, refresh_token: `refresh-${++refreshSeq}`, token_type: "Bearer", expires_in: 3600 });
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/revoke" && req.method === "POST") {
      seen.revoke.push(Object.fromEntries(new URLSearchParams(await readBody(req))));
      res.writeHead(200);
      return res.end();
    }
    res.writeHead(404).end();
  });
  base = srv.url;

  // 사용자의 브라우저 역할: 승인 주소를 열고 루프백 콜백으로 이동한다.
  const browser = async (url: string) => {
    const res = await fetch(url, { redirect: "manual" });
    const loc = res.headers.get("location");
    if (loc) await fetch(loc);
  };

  return { issuer: base, close: srv.close, control, seen, browser, ISSUED };
}

export type ResponsesScenario =
  | "ok"
  | "cut_after_delta"
  | "failed_limit"
  | "incomplete"
  | "http_429"
  | "http_503_once"
  | "reject_text_format"
  | "http_403_not_eligible"
  | "close_before_event"
  | "failed_unsupported_after_delta"
  | "reject_unattributed"
  | "reject_always";

export async function startFakeResponses() {
  const state = { scenario: "ok" as ResponsesScenario, text: '{"reply":"OK"}', bodies: [] as Record<string, unknown>[], auth: [] as string[], calls: 0 };
  const sse = (res: http.ServerResponse, event: Record<string, unknown>) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const srv = await listen(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    state.auth.push(String(req.headers.authorization ?? ""));
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "x-request-id": "req_test_123" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/models") {
      return json(200, { models: [{ slug: "gpt-test", display_name: "GPT Test", visibility: "list" }, { slug: "internal", display_name: "Hidden", visibility: "hide" }] });
    }
    if (url.pathname === "/responses" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      state.bodies.push(body);
      state.calls += 1;
      const s = state.scenario;
      if (s === "http_429") return json(429, { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } });
      if (s === "http_403_not_eligible") return json(403, { error: { code: "subscription_sharing_user_not_eligible", message: "no" } });
      if (s === "http_503_once" && state.calls === 1) return json(503, { error: { code: "subscription_sharing_usage_unavailable", message: "later" } });
      if (s === "reject_text_format" && body.text) return json(400, { error: { code: "subscription_sharing_unsupported_capability", message: "unsupported", param: "text.format" } });
      if (s === "reject_unattributed" && body.text) return json(400, { error: { code: "subscription_sharing_unsupported_capability", message: "unsupported" } });
      if (s === "reject_always") return json(400, { error: { code: "subscription_sharing_unsupported_capability", message: "unsupported" } });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-request-id": "req_test_123" });
      if (s === "close_before_event") return res.end(); // 요청은 받아들였지만 이벤트 없이 종료
      sse(res, { type: "response.created", response: { id: "resp_1" } });
      const half = Math.ceil(state.text.length / 2);
      sse(res, { type: "response.output_text.delta", delta: state.text.slice(0, half) });
      if (s === "cut_after_delta") return res.end(); // 완료 이벤트 없이 연결 종료
      if (s === "failed_unsupported_after_delta") {
        sse(res, { type: "response.failed", response: { id: "resp_1", error: { code: "subscription_sharing_unsupported_capability", message: "unsupported" } } });
        return res.end();
      }
      if (s === "failed_limit") {
        sse(res, { type: "response.failed", response: { id: "resp_1", error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } });
        return res.end();
      }
      if (s === "incomplete") {
        sse(res, { type: "response.incomplete", response: { id: "resp_1", incomplete_details: { reason: "max_output_tokens" } } });
        return res.end();
      }
      sse(res, { type: "response.output_text.delta", delta: state.text.slice(half) });
      sse(res, { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
      return res.end();
    }
    res.writeHead(404).end();
  });
  return { baseURL: srv.url, close: srv.close, state };
}
