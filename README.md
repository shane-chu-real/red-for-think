# 기획 레드팀 (red-for-think)

아이디어를 넣으면 인터뷰 → 다섯 관점(재무·리스크·현업·경영진·IT) 검토 → 수용·반박·보류 → 수정·재검증을 거쳐, **상세 기획서 · PPT 스토리라인 · 예상 질의응답 · 논쟁 기록**을 같은 확정 버전으로 만드는 **1인용** 기획 토론 웹앱입니다.

설계 전문은 [docs/design-v3.md](docs/design-v3.md)에 있습니다.

## 구조

```text
[브라우저] ─ Vercel 인증 ─▶ [Vercel: Next.js 웹앱 + Neon Postgres]   화면 · 상태 전환 · 저장 · 작업 대기열
                                   ▲  아웃바운드 HTTPS (우회 헤더 + 실행기 토큰)
                          [내 PC: 로컬 AI 실행기]  ChatGPT 로그인 · 토큰 보관 · AI 호출
                                   └─▶ api.openai.com/v1/responses (ChatGPT 플랜 사용량)
```

- **웹앱은 AI를 호출하지 않습니다.** AI 작업은 대기열에 쌓이고, PC의 실행기가 하나씩 가져가 처리합니다.
- **ChatGPT 토큰은 PC 밖으로 나가지 않습니다.** Windows에서는 DPAPI로 암호화하고 소유자 전용 권한을 겁니다.
- **유료 API로 대신 호출하는 경로가 없습니다.** 사용 한도에 닿으면 멈추고 알립니다.
- 실행기를 켜 둔 동안에만 AI 작업이 진행됩니다. 꺼져 있으면 작업은 대기 상태로 남습니다.

### 이렇게 만든 이유

OpenAI의 "ChatGPT 플랜 사용" 경로는 2026-10-03 기준으로 오픈소스·로컬 실행 앱을 대상으로 하고, 로그인 콜백이 `http://127.0.0.1`로만 돌아옵니다. 그래서 로그인과 추론은 PC의 실행기가 맡고, 웹앱은 화면과 저장만 맡습니다. 이 저장소는 그 조건에 맞춰 공개(MIT)되어 있으며, **본인 한 사람이 쓰는 용도**로 설계했습니다. 여러 사람에게 서비스하는 용도로 쓰지 마세요.

## 로컬에서 실행하기 (계정 없이, 모의 응답)

Node.js 22 이상이 필요합니다.

```bash
npm install
npm run dev            # http://localhost:3000 — 내장 Postgres(PGlite, .data/)를 씁니다
```

로컬 개발 서버는 `.env.local`에 운영 `DATABASE_URL`이 있어도 쓰지 않습니다(운영 데이터에 실수로 쓰지 않게). 로컬에서 원격 DB에 붙어야 할 때만 `RFT_USE_REMOTE_DB=1`을 줍니다.

브라우저에서 **설정 → 연결 문자열 발급**을 누른 뒤 다른 터미널에서:

```bash
npm run runner -- pair          # 연결 문자열을 붙여넣습니다
npm run runner -- start --mock  # 개발용 모의 응답 (실제 AI 아님, 화면에 [모의] 표시)
```

## 실제 ChatGPT 플랜으로 쓰기

1. 웹앱 **설정 → 연결 문자열 발급** → `npm run runner -- pair`
2. `npm run runner -- login` — 브라우저에서 ChatGPT에 로그인하고 플랜 사용을 승인합니다.
3. `npm run runner -- test` — 텍스트 실요청 1건으로 연결을 확인합니다(구독 사용량을 씁니다).
4. `npm run runner -- start` — 실행기를 켭니다.
5. ChatGPT → Settings → Usage에서 **크레딧 사용**과 **자동 크레딧 구매**가 꺼져 있는지 직접 확인합니다.

| 명령 | 하는 일 |
|---|---|
| `npm run runner -- pair` | 웹앱과 연결(1회용 코드 → 실행기 토큰) |
| `npm run runner -- login` / `logout` | ChatGPT 로그인 / 원격 철회 + 로컬 삭제 |
| `npm run runner -- status` | 연결·로그인 상태(토큰 값은 출력하지 않음) |
| `npm run runner -- models` | 내 계정에서 쓸 수 있는 모델 목록 |
| `npm run runner -- test` | 실요청 1건 |
| `npm run runner -- start [--mock]` | 실행기 시작 |

실행기 데이터는 Windows에서 `%APPDATA%\red-for-think-runner\`에 저장됩니다.

## 배포 (GitHub + Vercel + Neon)

1. 이 저장소를 Vercel 프로젝트로 가져옵니다(main 브랜치 = 운영).
2. `vercel install neon`으로 Postgres를 연결합니다(`DATABASE_URL` 자동 주입).
3. `vercel env pull .env.local` 후 `npm run db:migrate`로 스키마를 적용합니다.
4. Vercel **Settings → Deployment Protection**에서 Vercel Authentication을 **All Deployments**로 켭니다. 켜기 전에는 운영 주소를 쓰지 마세요.
5. 같은 화면의 **Protection Bypass for Automation**에서 비밀값을 만들고 다시 배포합니다(실행기가 보호를 통과하는 데 씁니다).

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `DATABASE_URL` | (Neon이 주입) | Postgres 연결 |
| `AI_CAP_PER_DAY` | 200 | 하루 AI 호출 상한 |
| `AI_CAP_PER_PROJECT` | 100 | 프로젝트당 AI 호출 상한 |

## 화면 명령

`/강도1`~`/강도3` · `/재무` `/리스크` `/현업` `/경영진` `/IT`(역할 추가 검토) · `/스킵` · `/마무리` · `/임원용` `/유관부서용`

## 시험

```bash
npm test          # 도메인 시나리오, 저장·대기열 규칙, 실행기 인증·추론(가짜 서버)
npm run typecheck
```

지침이나 검증 규칙을 바꾼 뒤에는 로컬 서버와 실행기를 켜 두고 `node scripts/e2e-real.mjs`로 전체 흐름을 한 번 돌려 볼 수 있습니다. 실제 실행기면 ChatGPT 플랜 요청을 16건 안팎 쓰고, `start --mock`이면 쓰지 않습니다.

## 알아 둘 점

- 입력한 기획 내용과 자료는 AI 작업 때 OpenAI(ChatGPT)로 전송됩니다.
- AI는 제안만 합니다. ID 발급, 상태 전환, 버전·참조 검사는 서버가 합니다. 그래도 AI 판단의 사실 여부를 보증하지는 않습니다.
- 자료는 텍스트 붙여넣기만 받습니다(1건 20,000자, 합계 60,000자). 넘으면 자르지 않고 거절합니다. 엑셀 표는 칸을 복사해 붙이면 줄마다 '열 이름: 값'인 글로 바뀌어 들어갑니다(첫 줄 = 열 이름).
- 토론을 마쳤다는 것이 추진 승인이나 사실 검증 완료를 뜻하지는 않습니다.
- 사용량 참고(2026-10-04 실측, Plus 플랜): 인터뷰부터 네 산출물까지 1라운드에 AI 요청 16건, 약 14분이 걸렸습니다. 라운드를 더 돌면 그만큼 늘어납니다.

## 라이선스

MIT
