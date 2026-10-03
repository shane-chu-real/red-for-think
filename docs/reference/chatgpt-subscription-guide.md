# ChatGPT 구독 연동으로 시스템 AI 호출 전환하기

**AI 개발 도구 전달용 구현 지침서 · v1.0 · 2026-10-03 확인**

## 이 문서의 목표

현재 구독 중인 ChatGPT 플랜의 사용량을, 본인 소유 시스템의 AI 작업에 활용하는 연결 구조를 정의합니다. 기존의 개발자 API 키 기반 호출을 **사용자가 승인한 OAuth 토큰 기반 ChatGPT 플랜 사용 경로**로 전환하는 것이 목표입니다. API 통신 자체를 없애거나, ChatGPT 웹 대화창을 자동 조작하는 방식은 아닙니다. [S02, S06]

> **핵심 구분**
> 기존 시스템 → 개발자 API 키 → 종량제 AI 호출
> 전환 시스템 → 사용자가 승인한 OAuth → 적격 요청을 ChatGPT 구독 한도로 처리
> 기존 구독료·호스팅 비용은 남으며, 무제한·무조건 무료를 뜻하지 않습니다. [S01]

## 적용 전제와 확인 범위

사용자의 정확한 플랜, 운영체제, 기존 코드, 배포 환경, 계정별 연동 가능 여부는 제공되지 않았습니다. 따라서 특정 플랜을 이미 사용할 수 있다고 가정하지 않습니다. 공식 안내상 플랜 사용 기능은 Plus·Pro 대상이며, 실제 권한과 모델 접근은 해당 계정으로 확인해야 합니다. [S01, S06]

이 문서에서 ‘시스템 API’는 **시스템이 AI 모델을 호출하는 부분**을 뜻합니다. 데이터베이스·결제·업무시스템·운영체제 API를 ChatGPT로 대체한다는 뜻은 아닙니다.

**권장 출발점:** 본인이 제어하는 로컬 실행 앱에서 텍스트 작업 한 가지를 먼저 검증합니다. 오픈소스·로컬 앱 경로의 적용 조건부터 확인하고, 자체 호스팅 또는 외부 공개는 별도 판단합니다. 공개·유료 서비스의 참여 조건을 로컬 경로로 우회하지 않습니다. [S02, S03]

## 문서 활용 순서

먼저 1장의 적합성 판단을 수행하고, 2~6장의 연결 구조와 구현 조건을 적용합니다. v0를 쓰는 경우 7장도 읽습니다. AI 개발 도구에는 **9장의 작업 지시문과 이 문서 전체**를 전달하고, 완료 여부는 10장의 인수시험으로 판정합니다.

**검증 상태:** 공식 문서 대조를 마친 구현 명세입니다. 사용자 계정의 실제 OAuth 승인, 실요청, 비용 측정 및 배포는 수행하지 않았습니다. 예제는 전체 인증 시스템이 아닌 인증 이후의 추론 연결 시험입니다.

<!-- PAGEBREAK -->

# 1. 먼저 적용 가능한 경로를 판정합니다

| 사용 형태 | 적용 방향 | 진행 조건 |
|---|---|---|
| 본인 PC의 로컬 앱·오픈소스 도구 | 공식 동적 등록 OAuth를 검토합니다. | 앱 조건, 계정 권한, 실제 추론 완료를 확인합니다. [S02, S04] |
| 본인이 제어하는 VM의 오픈소스 앱 | 공식 자체 호스팅 절차를 검토합니다. | VM별 host ID와 보호된 자격 증명 이전이 필요합니다. [S12] |
| Vercel 등에 올리는 외부 공개·유료 앱 | 상용·원격 호스팅 참여 절차로 분리합니다. | 확인일 현재 선별 파트너·관심 등록 경로입니다. [S02, S03] |
| v0에서 앱을 만드는 작업 | v0의 ChatGPT 플랜 연결을 사용합니다. | 제작 단계의 연결이며 배포 앱의 AI 기능과는 별개입니다. [S11] |

## 착수 시 남겨야 할 확인 기록

아래 값은 **이 문서의 프로젝트 설정 예시**이지 OpenAI가 제공하는 공식 설정 파일이 아닙니다. 확인하지 못한 항목은 `unknown`으로 남겨야 합니다.

```yaml
project:
  objective: replace_developer_api_key_for_eligible_ai_requests
  deployment_mode: local_single_user
  account_plan: unknown
  app_eligibility: unknown
  runtime_entitlement: unverified
  existing_stack: unknown
  existing_ai_contract: unknown
billing_policy:
  allow_paid_api_fallback: false
  allow_provider_switch: false
  chatgpt_credit_setting_verified_off: false
  automatic_credit_purchase_verified_off: false
implementation:
  first_scope: text_only
  initial_concurrency: 1
  public_ingress: disabled
```

`initial_concurrency: 1`은 검증을 위한 설계 기본값이며 공식 사용 한도가 아닙니다. `verified_off: false`는 ‘켜져 있음’이 아니라 ‘아직 꺼졌는지 확인하지 못함’입니다.

## 진행·보류 기준

**진행:** 허용된 앱 형태이고, 본인이 공식 로그인에서 플랜 사용을 승인하며, 실제 요청이 완료될 때 진행합니다.

**보류:** 공개 서비스 승인 여부가 불명확하거나, 로그인은 성공했지만 플랜 사용 권한이 없으면 실추론을 중단합니다. 이때 UI·모의 응답·단위시험은 계속 구현할 수 있지만, 유료 API를 자동 연결하거나 동작 성공으로 보고하지 않습니다. [S04, S10]

<!-- PAGEBREAK -->

# 2. 기존 시스템에 넣을 연결 구조

## 권장 구조: 업무 로직과 AI 공급자를 분리합니다

```text
[사용자 / 업무 워크플로 / AI 에이전트]
                  |
         [기존 시스템의 AI 인터페이스]
                  |
     [ChatGPTSubscriptionProvider 어댑터]
          |                    |
   [권한·사용 정책 검사]   [보호된 자격 증명 저장소]
          |                    |
          +---- [OAuth access token]
                         |
         [공식 Responses API / SSE 스트림]
                         |
      [완료 검증 → 출력 검증 → 업무 로직에 전달]
```

이는 이 문서의 설계 제안입니다. `ChatGPTSubscriptionProvider`는 새로 구현할 프로젝트 내부 이름이며 공식 SDK 클래스가 아닙니다. 외부 호출은 공식 모델·추론 경로를 사용합니다. [S06]

## 시스템 내부 계약 예시

```typescript
// 프로젝트 내부 타입입니다. 기존 코드에 맞춰 조정하십시오.
type GenerateRequest = {
  requestId: string;
  input: string;
  instructions?: string;
};
type GenerateResult = {
  requestId: string;
  status: "completed";
  text: string;
  billingRoute: "chatgpt_plan";
};
```

`billingRoute`는 선택한 경로를 표시할 뿐, 추가 크레딧 차감이 0이었다는 증빙이 아닙니다. 계정의 크레딧 사용 설정도 별도로 점검해야 합니다. [S01]

**교체 순서:** 현재 AI 호출 위치와 입출력 계약을 찾고, 공급자 인터페이스를 분리한 다음, 새 어댑터를 연결합니다. 기존 호출자에게 반환하던 필드와 오류 계약은 가능하면 유지하되, 지원되지 않는 기능을 조용히 생략하지 않습니다.

**AI 에이전트 연결:** 에이전트에는 `generate_text` 같은 제한된 내부 도구를 제공합니다. 토큰은 도구의 실행기만 다루며 모델 프롬프트에 넣지 않습니다. 호출자 인증에서 계정을 결정하고, 요청 본문의 임의 `accountId`로 다른 계정의 자격 증명을 선택하지 않습니다.

**업무 실행 경계:** 생성 중인 부분 응답으로 이메일 발송·파일 삭제·데이터 갱신을 실행하지 않습니다. 완결된 출력에 형식·권한 검사를 적용한 다음, 필요한 사용자 승인을 받아 후속 작업을 수행하도록 설계합니다.

<!-- PAGEBREAK -->

# 3. 공식 로그인과 플랜 사용 승인

## 3.1 인증 흐름

로컬 동적 등록 경로의 최소 순서는 다음과 같습니다. 유지보수되는 OAuth/OIDC 라이브러리를 활용하고, 웹사이트의 신원 확인 전용 흐름과 플랜 사용 흐름을 혼동하지 않습니다. [S04, S05]

1. 설치 환경마다 불투명하고 안정적인 `ext_agent_host_id`를 저장합니다. 간단한 대안은 한 번 생성한 `urn:uuid:<UUIDv4>`입니다. 매 실행마다 바꾸지 않습니다. [S02]
2. `127.0.0.1`의 콜백 리스너를 먼저 열고, 새 `state`, `nonce`, PKCE verifier 및 S256 challenge를 생성합니다.
3. 최초에는 `dynamic_agent_client`로 등록하고 실제 앱 이름을 전달합니다. 사용자에게 OpenAI 공식 브라우저 로그인과 플랜 사용 승인 화면을 보여 줍니다.
4. 콜백의 state를 검증하고, 최초 등록에서 반환된 실제 `client_id`로 코드를 교환합니다. 재로그인은 저장한 ID를 재사용합니다.
5. ID 토큰 검증과 허가된 scope 확인을 마친 뒤에만 자격 증명을 저장하고 추론을 허용합니다. [S04]

## 3.2 엔드포인트와 요청 값

```text
Discovery: https://auth.openai.com/.well-known/openid-configuration
Authorize: https://auth.openai.com/api/accounts/authorize
Token:     https://auth.openai.com/api/accounts/oauth/token
Resource:  https://api.openai.com/v1
Callback:  http://127.0.0.1:1455/auth/callback
```

Discovery에서 issuer·엔드포인트·JWKS 정보를 읽고, 신뢰하는 OpenAI 발급자와 일치하는지 검사합니다. 위 콜백 포트는 예시입니다. [S04, S05]

| 매개변수 | 구현 값 |
|---|---|
| `client_id` | 최초 `dynamic_agent_client`, 이후 반환받아 저장한 issued ID |
| `agent_name_hint` | 최초 등록에만 실제 앱 이름 |
| `ext_agent_host_id` | 해당 호스트의 영속 식별자 |
| `response_type` / `resource` | `code` / `https://api.openai.com/v1` |
| `scope` | `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` |
| `state` / `nonce` | 매 인증 시도마다 새 난수 |
| `code_challenge_method` | `S256` |

콜백 주소는 승인 요청과 코드 교환에서 완전히 같아야 합니다. `127.0.0.1`을 `localhost`로 바꾸지 않습니다. 재로그인 시 허용되는 포트 변화와 경로 일치 조건은 [S04]를 따릅니다.

<!-- PAGEBREAK -->

# 4. 인증 검증·저장·갱신

## 4.1 성공을 판정하는 조건

**코드 교환:** form-encoded `authorization_code` 요청에 발급된 client ID, code, verifier, 동일 redirect URI와 resource를 넣습니다. 로컬 public client 경로에서는 client secret을 만들어 넣지 않습니다. `dynamic_agent_client`를 실제 발급 ID 대신 사용해서는 안 됩니다. [S04]

**신원 검증:** JWKS 서명, issuer, 발급 client ID를 대상으로 한 audience, 만료 시간, 저장한 nonce를 검증합니다. 검증된 `sub`와 client ID의 대응을 유지합니다. 단순 JWT 디코딩이나 이메일 일치만으로 통과시키지 않습니다. [S04, S05]

**사용 권한:** 반환된 granted scopes의 `chatgpt.tokens.use.direct`를 확인합니다. ID 토큰만 있는 로그인 성공과 플랜 사용 허가는 다릅니다. 권한이 없으면 ‘로그인됨 / AI 플랜 사용 비활성’ 상태를 구분합니다. [S04, S10]

## 4.2 보호할 데이터

| 데이터 | 처리 원칙 |
|---|---|
| issuer, subject, issued client ID | 검증된 계정 등록 단위로 묶어 보관합니다. |
| access·refresh·retained ID token | 보호된 런타임 저장소에서만 다룹니다. |
| scope, saved_at, expires_in | 토큰 세트와 함께 갱신합니다. |
| ext_agent_host_id | 호스트 수명 동안 유지하며 비밀키로 취급하지 않습니다. |

토큰을 소스 저장소, AI 대화, 브라우저 localStorage, 분석 로그에 넣지 않습니다. 파일 방식이면 Unix `0600` 및 상위 디렉터리 접근 제한을 사용하고 원자적으로 저장합니다. Windows에서는 소유자 제한 ACL 또는 OS 보안 저장소를 사용하도록 설계합니다. [S04, S08]

## 4.3 갱신과 종료

공식 토큰 문서는 access token 1시간, refresh token 30일 및 성공 시 회전을 설명합니다. 구현은 고정 숫자만 믿지 말고 응답의 만료 정보를 저장해 사용합니다. [S09]

갱신에는 발급 client ID, 최신 refresh token, resource를 사용하고 scope는 생략합니다. 같은 세션의 갱신은 직렬화하고, 새 access·refresh token과 만료 정보를 함께 교체합니다. 확정된 무효 토큰은 재인증으로 복구하되 일시적 네트워크 오류만으로 자격 증명을 지우지 않습니다. [S08, S10]

로그아웃 시 요청을 중단하고 discovery의 revocation endpoint로 갱신 세션 취소를 시도합니다. 로컬 삭제와 원격 권한 철회를 구분해 표시하며, 철회를 확인하지 못하면 이를 사용자에게 알립니다. [S08]

<!-- PAGEBREAK -->

# 5. 추론 어댑터와 호환성

## 5.1 반드시 적용할 프로토콜

사용 계정의 OAuth access token으로 `GET /v1/models`를 조회합니다. 문서화된 이 경로의 응답은 `models` 배열이며, `visibility: "list"`인 항목의 표시명과 slug를 사용합니다. 모델 이름을 문서나 코드에 영구 고정하지 않습니다. [S06]

```http
POST https://api.openai.com/v1/responses
Authorization: Bearer <OAUTH_ACCESS_TOKEN>
Content-Type: application/json
```

```json
{
  "model": "<현재 계정에서 조회한 모델 slug>",
  "instructions": "제공된 내용만 사용해 한국어로 요약하십시오.",
  "input": [{"role": "user", "content": "요약 대상 텍스트"}],
  "store": false,
  "stream": true
}
```

텍스트 delta를 수집하되 `response.completed`를 수신해야 성공입니다. `response.failed`, `response.incomplete`, 오류 이벤트 또는 조기 연결 종료는 실패·미완료로 구분합니다. 스트림이 시작된 뒤에도 한도 오류가 올 수 있습니다. [S06]

## 5.2 일반 API 코드를 그대로 전달하지 않습니다

| 기존 코드의 기능 | 이 경로에서 필요한 처리 |
|---|---|
| Chat Completions의 messages·응답 객체 | Responses 입출력으로 명시적으로 변환합니다. 호환 엔드포인트라고 가정하지 않습니다. |
| `system` 메시지 | 이 경로에서는 `instructions` 또는 developer 메시지로 설계합니다. |
| 서버 저장 대화·`previous_response_id` | HTTP에서는 필요한 이력을 `input`으로 보내도록 바꿉니다. |
| `temperature`, `top_p`, `max_output_tokens` 등 | 현재 미지원 옵션을 거부하거나 명시적 대안으로 전환합니다. |
| 이미지 생성·호스팅 file search·Code Interpreter | 현재 경로의 지원 기능으로 취급하지 않습니다. |
| 파일·이미지 입력 | 모델이 수용하는 입력과 Files 업로드 API 지원을 구분합니다. |

현재 HTTP 요구사항과 미지원 목록의 기준은 [S07]입니다. 오디오·동영상 입력, 전사 API, 호스팅 MCP/connectors도 이 경로에서는 지원되지 않습니다. 지원 옵션은 출시 시점에 다시 대조해야 합니다.

**설계 원칙:** 호환성을 위해 요청 필드를 조용히 버리지 않습니다. 먼저 차이를 보고하고, 의미가 보존되는 변환만 적용합니다. `max_output_tokens` 대신 앱에서 출력을 중단해도 서버 측 사용량 상한이 동일하게 보장되는 것은 아닙니다.

<!-- PAGEBREAK -->

# 6. 인증 후 최소 연결 시험

아래 Python 예제는 **3~4장에서 검증·저장한 access token과 5장에서 조회한 모델 slug가 준비된 이후**의 연결 시험입니다. `openai` 패키지가 필요하며, 시험한 버전은 프로젝트 잠금 파일에 기록하십시오. Python SDK의 `api_key` 인수에는 이 경우 OAuth bearer token을 전달합니다. 별도 종량제 API 키를 넣는 예제가 아닙니다. [S06]

토큰은 보호된 실행기에서 프로세스 환경으로 주입합니다. AI 대화나 명령 기록에 실제 토큰을 붙여 넣지 마십시오. 모델 목록 확인과 OAuth 전체 구현은 이 짧은 예제의 범위 밖입니다.

```python
import os
import sys
from openai import OpenAI, APIStatusError, OpenAIError


def main() -> int:
    token = os.environ.get("CHATGPT_ACCESS_TOKEN")
    model = os.environ.get("CHATGPT_MODEL_SLUG")
    if not token or not model:
        print("Validated token and model slug are required.",
              file=sys.stderr)
        return 2
    parts: list[str] = []
    completed = False
    try:
        with OpenAI(api_key=token,
                    base_url="https://api.openai.com/v1",
                    max_retries=0, timeout=60.0) as client:
            with client.responses.create(
                model=model,
                input=[{"role": "user", "content": "Reply: OK"}],
                store=False, stream=True,
            ) as events:
                for event in events:
                    if event.type == "response.output_text.delta":
                        parts.append(event.delta)
                    elif event.type == "response.completed":
                        completed = True
                    elif event.type == "response.failed":
                        err = event.response.error
                        code = err.code if err else "unknown"
                        raise RuntimeError(code)
                    elif event.type in ("response.incomplete", "error"):
                        raise RuntimeError(event.type)
        if not completed or not parts:
            raise RuntimeError("missing_completed_text")
        print("".join(parts))
        return 0
    except APIStatusError as exc:
        print(f"HTTP {exc.status_code}; request={exc.request_id}",
              file=sys.stderr)
    except (OpenAIError, RuntimeError) as exc:
        print(f"Inference did not complete: {type(exc).__name__}",
              file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
```

**시험 해석:** 출력은 완료 후에만 반환됩니다. 비정상 종료는 성공 처리하지 않습니다. 이 예제의 60초는 앱 측 읽기 등 작업의 제한값이지 공식 SLA나 전체 작업 완료 보장이 아닙니다. 계정 한도·추가 크레딧 여부는 별도로 확인합니다.

<!-- PAGEBREAK -->

# 7. v0·자체 호스팅·Codex에 적용하기

## 7.1 v0에서는 제작 연결과 실행 연결을 분리합니다

제작용 연결은 v0 상단 크레딧 메뉴의 **Use ChatGPT plan → Continue with ChatGPT → 승인 → 활성화** 순서입니다. 지원 모델을 선택하고 `Using ChatGPT plan` 표시를 확인합니다. 이미지 작업·일부 하위 에이전트 작업에는 v0 크레딧이 남을 수 있습니다. [S11]

**실행용 구현은 별도 작업입니다.** v0에 이 문서를 주어 화면과 공급자 인터페이스를 만들게 하되, 그것만으로 배포된 앱의 AI 사용량이 자신의 구독으로 연결됐다고 판정하지 않습니다.

권장 초기 흐름은 v0로 UI와 코드를 제작한 뒤, 본인이 제어하는 로컬 환경에서 OAuth·보안 저장소·어댑터를 실행하고 검증하는 것입니다. 브라우저의 loopback 콜백은 사용자의 PC로 돌아옵니다. 클라우드 미리보기 안의 서버가 그 콜백을 직접 받는 구조로 가정하지 않습니다. [S04, S12]

v0가 편의상 AI Gateway나 유료 공급자 키를 추가하지 않도록 지시합니다. 이는 추가 과금 방지를 위한 프로젝트 정책이며, v0 전체 동작에 대한 보장은 아닙니다.

## 7.2 개인 VM에서 운영하는 경우

공식 자체 호스팅 가이드는 오픈소스 앱을 대상으로 로컬 OAuth 완료 후 보호된 자격 증명을 SSH 등으로 VM에 이전하는 절차를 설명합니다. VM 고유 host ID를 보존하고, 이후 갱신 소유자를 VM으로 정합니다. 복제된 refresh token을 여러 프로세스가 경쟁적으로 갱신하지 않도록 설계합니다. [S12]

현재 이전된 세션의 호스트별 사용 귀속·철회에는 제한이 있습니다. 개인 VM 절차를 다중 이용자 공개 SaaS 승인으로 해석하지 않습니다. VM 비용도 구독 한도와 별도입니다. [S12, S02]

## 7.3 Codex를 실행기로 사용하는 선택지

단순 텍스트 호출에는 직접 Responses 어댑터가 더 작은 구현 범위입니다. 이미 Codex 기반 도구 실행이 필요한 경우에는 공식 app-server 연결을 검토할 수 있습니다. [S13]

```bash
codex app-server --listen stdio:// \
  -c 'model_provider="openai_chatgpt_plan"' \
  -c 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"' \
  -c 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"' \
  -c 'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"' \
  -c 'model_providers.openai_chatgpt_plan.wire_api="responses"' \
  -c 'model_providers.openai_chatgpt_plan.requires_openai_auth=false' \
  -c 'model_providers.openai_chatgpt_plan.supports_websockets=false'
```

이 명령은 OAuth 토큰을 자식 프로세스의 `ACCESS_TOKEN` 환경에 안전하게 전달한 뒤 사용합니다. `initialize → initialized → thread/start → turn/start` 흐름을 구현하고, `turn/completed`의 `turn.status`까지 검사합니다. 토큰 갱신 후 자식 프로세스 반영 정책도 필요합니다. [S13]

<!-- PAGEBREAK -->

# 8. 장애·한도·추가 비용 통제

## 8.1 오류를 원인별로 처리합니다

아래는 공식 오류의 주요 분기입니다. HTTP 상태와 코드, request ID를 보존하되 토큰·민감한 입력은 로그에서 제거합니다. 모든 실패 응답이 동일한 JSON 구조라고 가정하지 않습니다. [S10]

| 관측한 오류 | 조치 |
|---|---|
| `subscription_sharing_user_not_eligible` | 계정·워크스페이스·정책 제한을 표시합니다. 반복 로그인으로 해결하려 하지 않습니다. |
| `subscription_sharing_usage_limit_exceeded` | 새 요청을 멈추고 Usage 설정을 안내합니다. 앱 한도인지 전체 한도인지 단정하지 않습니다. |
| `subscription_sharing_usage_unavailable` | 자격 증명을 보존하고 제한된 지수 백오프로 재시도합니다. |
| `subscription_sharing_unsupported_capability` | `error.param`을 보고 요청을 고칩니다. 같은 잘못된 요청을 반복하지 않습니다. |
| `subscription_sharing_route_not_supported` | HTTP 메서드·공식 엔드포인트를 확인합니다. |
| 무효 refresh token·확정된 철회 | 무효 토큰을 정리하고 저장된 client ID로 재인증합니다. |

상세한 scope/context 오류와 일시적 사용자 정보 장애는 [S10]의 최신 표를 따릅니다. 앱이 별도 과금 경로로 전환하도록 코딩하지 않습니다.

## 8.2 ‘추가 지출 없음’을 위한 이중 확인

**앱 측:** 유료 API fallback, 대체 공급자 자동 전환, 자동 결제·크레딧 구매를 구현하지 않습니다. 모의 실패 시험에서도 외부 유료 공급자 호출 수가 0이어야 합니다.

**ChatGPT 계정 측:** Settings → Usage에서 앱의 사용 한도와 **포함 사용량 소진 후 크레딧 사용 허용**을 확인합니다. 추가 지출을 원하지 않으면 크레딧 사용과 자동 크레딧 구매 설정을 각각 꺼 둡니다. 앱 내부의 `fallback=false`만으로 계정 설정까지 통제할 수는 없습니다. [S01]

구독 사용은 별도 무료 사용량을 새로 만드는 것이 아닙니다. 사용량과 모델·계정 접근은 공유 한도와 정책에 좌우되므로 무제한 사용이나 요청당 고정 비용을 약속하지 않습니다. [S01, S08]

## 8.3 자동화에 적용할 보수적 기본값

초기에는 계정당 동시 실행 1개로 제한하고, 일일 실행 건수·입력 크기·에이전트 반복 수를 앱 설정으로 관리합니다. 이 값들은 OpenAI가 보장한 한도가 아니라 운영자가 정하는 안전장치입니다.

스트림이 이미 시작된 작업은 중복 사용과 후속 작업 중복을 피하도록 자동 재제출하지 않는 것을 기본으로 합니다. 요청 ID와 작업 상태를 기록하고, 불완전 출력은 ‘완료’ 상태나 결과 캐시에 넣지 않습니다.

<!-- PAGEBREAK -->

# 9. AI 개발 도구에 전달할 작업 지시문

아래 지시문과 이 문서 전체를 함께 전달하십시오. 실제 비밀번호·API 키·OAuth 토큰은 첨부하지 않습니다.

> **프로젝트 목표**
> 기존 시스템의 적격 AI 호출을 사용자가 승인한 ChatGPT 구독 사용 경로로 전환하십시오. 종량제 API 키 의존성을 줄이는 것이 목표이며, ChatGPT 웹 자동화나 무제한 무료 서비스가 목표가 아닙니다.
>
> **먼저 확인할 것**
> 저장소를 읽어 현재 기술 스택, AI 호출 위치, 요청·응답 계약, 배포 구조와 사용 도구를 정리하십시오. 사용자 플랜과 연동 자격은 추정하지 말고 확인 필요 항목으로 남기십시오. 오픈소스·로컬 조건과 공개·유료 서비스의 승인 조건을 구분하십시오.
>
> **구현할 것**
> 공급자 인터페이스를 분리하고 ChatGPTSubscriptionProvider를 구현하십시오. 공식 OAuth 동적 등록, PKCE, state·nonce·ID token 검증, 발급 client ID 재사용, host ID 영속화, granted scope 검사와 안전한 토큰 회전을 적용하십시오. 외부 호출은 공식 Responses 경로로 한정하십시오.
>
> 모델은 현재 계정의 catalog에서 선택하십시오. 요청은 store=false, stream=true로 보내며 필요한 문맥을 input에 포함하십시오. 완료 이벤트가 없으면 성공 반환하지 마십시오. 기존 system 지시와 미지원 옵션은 호환성 보고 후 의미가 보존되는 방식으로 전환하십시오.
>
> **보안과 비용**
> 토큰을 브라우저 저장소·AI 프롬프트·소스·로그에 넣지 마십시오. 기존 Codex 인증 파일이나 ChatGPT 쿠키를 임의로 추출하거나, 비공개 backend-api 경로를 대체 통로로 사용하지 마십시오. 계정 선택은 검증된 호출자 권한에 연결하십시오. 로컬 서버는 loopback에만 바인딩하고 Host·Origin·CSRF·앱 세션을 검증하십시오.
>
> 유료 API fallback, AI Gateway 자동 연결, 공급자 자동 전환, 자동 크레딧 구매는 기본적으로 비활성화하십시오. ChatGPT 계정의 크레딧 사용·자동 구매 설정은 별도 수동 확인 항목으로 남기십시오. 한도 소진이나 권한 거절을 우회하지 마십시오.
>
> **진행 순서**
> 구조 조사 → 호환성 보고 → 모의 공급자 시험 → 로컬 OAuth 구현 → 사용자 본인의 승인 → 텍스트 실요청 1건 → 오류·갱신·철회 시험 → 기존 기능 연결 순서로 진행하십시오. 사용자 승인이 필요한 단계는 명시하고, 승인 없이 실제 계정 작업을 완료했다고 보고하지 마십시오.
>
> **반환할 산출물**
> 변경 파일 목록, 실행 방법, 설정 예시, 인증·공급자 코드, 단위시험, 수동 인수시험, 확인한 공식 문서 날짜, 미지원 기능 목록과 미검증 사항을 제출하십시오. 자격 미충족 시 작동하는 모의 구현과 blocker를 제출하되 실제 연결 성공으로 표현하지 마십시오.

이 지시문은 프로젝트 요구사항입니다. 공식 프로토콜의 근거와 최신 변경 여부는 11장의 출처를 확인하십시오.

<!-- PAGEBREAK -->

# 10. 완료 판정과 인수시험

## 10.1 필수 시험표

| ID | 시험 | 통과 기준 |
|---|---|---|
| A01 | 최초 OAuth | 실제 issued client ID를 저장하고 dynamic ID를 재사용하지 않습니다. |
| A02 | 재시작·재로그인 | 동일 host ID와 계정의 issued client ID를 보존합니다. |
| A03 | state·nonce·서명·audience 변조 | 모두 거절하고 기존 정상 계정 토큰을 덮어쓰지 않습니다. |
| A04 | 사용자가 플랜 권한 거절 | 로그인 상태와 AI 사용 불가를 구분하며 추론하지 않습니다. |
| A05 | 잘못된 계정 선택 | 다른 등록의 토큰·client ID를 섞지 않습니다. |
| I01 | 정상 텍스트 요청 | terminal completion 확인 후에만 성공합니다. |
| I02 | delta 후 스트림 중단 | 부분 답변을 실패·미완료로 처리합니다. |
| I03 | 스트림 도중 한도 오류 | 완료로 처리하지 않고 새 구독 요청을 중지합니다. |
| I04 | 미지원 옵션·도구 | 조용히 무시하지 않고 원인과 대안을 반환합니다. |
| S01 | access token 갱신·동시 호출 | 회전한 refresh token을 원자적으로 저장하고 갱신을 직렬화합니다. |
| S02 | 연결 해제·확정된 무효 토큰 | 호출을 중단하고 재인증 상태로 전환합니다. |
| S03 | 토큰 유출 점검 | UI·빌드·로그·저장소·AI 메시지에 토큰이 없습니다. |
| C01 | 한도·인증 오류 시 fallback | 유료 공급자 자동 호출이 0건입니다. |
| C02 | 계정 크레딧 설정 | 사용 허용과 자동 구매 설정을 각각 확인한 기록이 있습니다. |
| D01 | 실제 작업 비교 | 기존 입출력 계약·품질·실패 처리 차이를 기록합니다. |

위 표는 이 문서가 제안하는 인수 기준입니다. 공급자 동작의 근거는 [S04, S06, S07, S08, S10]입니다.

## 10.2 운영 전 확인할 항목

외부 사용자 공개 여부, 승인 자격, 데이터 처리 정책, 계정 연결 해제, 로그 보존 기간과 장애 시 행동을 운영 문서에 기록합니다. 구독료·호스팅·저장소·앱 자체 요금은 AI 호출 경로와 별도로 계산합니다.

실요청 전후의 ChatGPT 앱 사용량과 크레딧 상태를 확인하되, 표시 지연이나 내부 집계 때문에 단일 요청의 정확한 비용을 즉시 역산할 수 있다고 가정하지 않습니다. 모델 목록 조회만으로 실제 추론 권한을 입증했다고 보고하지 않습니다. [S01, S13]

## 10.3 완료 보고서 형식

```text
구현 완료 범위:
실제로 사용한 계정·플랜 확인 여부: (비밀정보 제외)
검증한 배포 형태 / 공식 문서 확인일:
실요청 결과 / terminal event / request ID:
토큰 갱신·철회 시험 결과:
추가 과금 차단 설정 확인 결과:
기존 시스템과의 호환성 차이:
남은 미검증 사항과 공개 배포 차단 조건:
```

<!-- PAGEBREAK -->

# 11. 공식 출처와 갱신 기준

**모든 출처 확인일: 2026-10-03.** 본문의 [S번호]는 아래 문서에 대응합니다. 실제 구현·배포 시 프리뷰 제한과 자격 조건을 다시 확인하십시오. 이 문서의 아키텍처·내부 타입·설정 예시·시험 기준은 공식 제공 코드가 아니라 구현을 위한 제안입니다.

## 핵심 기능·인증·추론

**[S01] OpenAI Help — Using your ChatGPT plan in other apps and sites**
대상 플랜, 앱 승인, 사용 한도, 크레딧 사용 및 자동 구매를 확인하는 근거입니다.
https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites

**[S02] OpenAI Developers — ChatGPT plan usage: Overview**
오픈소스·로컬 앱의 적용 범위, 사용자별 client와 host 식별자의 구분입니다.
https://developers.openai.com/siwc/token-sharing-open-source

**[S03] OpenAI Developers — Request a client ID**
상용 파트너의 제한된 제공·관심 등록 경로입니다.
https://developers.openai.com/siwc/request-client-id

**[S04] OpenAI Developers — Registration and sign-in**
동적 등록, 로컬 콜백, scope, 코드 교환, ID 토큰 및 자격 증명 저장 규칙입니다.
https://developers.openai.com/siwc/token-sharing-open-source/sign-in

**[S05] OpenAI Developers — On your website**
OIDC discovery, JWKS와 검증 원칙의 참고 문서입니다. 신원 확인 흐름을 플랜 사용 승인과 동일시하지 않습니다.
https://developers.openai.com/siwc/website

**[S06] OpenAI Developers — Models and inference**
모델 목록, OAuth bearer 인증, Responses 호출과 완료 이벤트의 근거입니다.
https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference

**[S07] OpenAI Developers — Preview limitations**
지원·미지원 요청 필드, 이력, 도구와 입력 종류의 판단 기준입니다.
https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations

<!-- PAGEBREAK -->

# 11. 공식 출처와 갱신 기준 — 계속

## 세션·오류·실행 환경

**[S08] OpenAI Developers — Accounts and sessions**
계정 분리, 토큰 갱신·철회, 자격 증명 보안과 사용량 관리입니다.
https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions

**[S09] OpenAI Developers — Token reference**
토큰 응답 필드와 수명·회전의 기준입니다.
https://developers.openai.com/siwc/token-sharing-open-source/token-reference

**[S10] OpenAI Developers — Errors and recovery**
한도·자격·scope·경로 오류와 갱신 실패의 복구 기준입니다.
https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery

**[S11] v0 Docs — ChatGPT**
v0 제작 단계의 구독 연결 절차, 적용 범위, 별도 v0 크레딧 작업입니다.
https://v0.app/docs/chatgpt

**[S12] OpenAI Developers — Self-hosted VMs**
VM host ID, 로컬 OAuth 이후 보호된 세션 이전 및 현재 제한입니다.
https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms

**[S13] OpenAI Developers — Codex app-server**
OAuth 토큰을 사용하는 app-server 공급자 설정과 턴 완료 검증입니다.
https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server

**[S14] OpenAI Developers — UI/UX guidelines**
첫 승인 안내, 플랜 사용 표시와 사용량 관리 연결의 UI 참고입니다.
https://developers.openai.com/siwc/ui-ux-guidelines

## 갱신이 필요한 시점

모델·SDK·Codex 버전 변경, 로컬에서 클라우드로의 이전, 외부 이용자 추가, 지원 도구 확장, 인증·한도 오류 증가가 있을 때 재검토합니다. 먼저 공식 문서와 계정의 실제 승인 결과를 확인하고, 블로그의 과거 예시나 이 문서의 모델·기능 가정을 그대로 고정하지 않습니다.

**최종 판단:** 이 경로는 적격 요청의 인증·사용량 귀속을 바꾸는 방법입니다. 일반 OpenAI API 전체의 완전 호환 대체나, 개인 구독 하나를 다수 이용자에게 공유하는 범용 무료 API 서버의 설계가 아닙니다. [S02, S07]
