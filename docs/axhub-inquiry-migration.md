# 견적 문의 폼 → AX Hub 문의 API 전환 준비

상태: **착수 대기**. AX Hub 문의 API(axhub PR #223, `docs/architecture/inquiry-management.md`)의
결정 `IQ-D1`~`IQ-D18`이 전부 대기 중이고 API가 아직 없다. 이 문서는 API가 생기면 바로 전환할 수
있도록 이 저장소 쪽에서 바꿔야 할 것을 미리 정리한 것이다. 확인 시점 2026-11-04, 기준 `origin/main` `6ba5b31`.

## 1. 현재 구조 (전환 대상)

- 폼은 `assets/quote-form.js` 하나다. `index.html`과 `tool.html`이 같이 쓴다 (PR #7).
- 제출: `POST /api/quote` (JSON) → `api/server.js`(PM2, 포트 3201, IIS가 `/api/*` 프록시) → 네이버웍스 SMTP로 `MAIL_TO`에 메일.
- GitHub Pages(`*.github.io`)에는 API가 없어서 메일 앱을 연다.
  이때 화면은 "메일 앱에서 전송을 완료해 주세요"이고, 접수 완료로 표시하지 않는다.
- 네트워크 오류·5xx는 "전송에 실패했습니다 + 메일 앱으로 보내기" 링크를 보여 준다.

참고: axhub 설계안의 S3·현황 표는 "`tool.html`의 `SUBMIT_ENDPOINT`가 비어 있으면 mailto 후 성공 표시"라고 적었다.
이것은 PR #7 이전 코드(작업 브랜치 체크아웃)를 읽은 것이다.
`origin/main`에는 그 경로가 없다 (`git grep -n "SUBMIT_ENDPOINT = ''" origin/main` 0건).

## 2. 전환 시 바꿀 곳

`assets/quote-form.js`

1. `SUBMIT_ENDPOINT`를 허브 주소로 바꾼다 (설계안 기준 `https://<허브 도메인>/api/public/v1/inquiries`, 경로는 구현 때 확정).
   반드시 `https://` 443 직접 호출이어야 한다 (설계안 S5 — Cloudflare Flexible 구간은 평문).
2. `HAS_API` 판정을 없앤다. 허브는 도메인과 무관하게 호출할 수 있다. GitHub Pages Origin을 허브 허용 목록에 넣을지는 결정 필요 (아래 4장).
3. 성공 판정을 바꾼다. 지금은 `res.ok`(2xx)면 완료다.
   허브는 `201 {"inquiryNo","status"}`만 완료이고, 중복은 `200`(기존 접수번호, IQ-D4)이다.
   → `201`과 `200 + inquiryNo`만 완료로 표시하고, 완료 화면에 접수번호를 보여 준다.
4. 오류 처리를 허브 응답에 맞춘다: `400` 필드 오류 표시, `403`(Origin·캡차) 재시도 안내, `429`는 `Retry-After` 안내, `5xx`·네트워크 오류는 실패 안내.
5. mailto 대체 경로를 없앤다. 설계안 IQ-D18 권장안 B는 "mailto 폴백은 두지 않음"이다.
   개인정보가 다시 그룹메일로 새지 않게 하려는 것이다. IQ-D18이 C로 정해지면 지금 동작을 유지한다.
6. 페이로드를 아래 3장 매핑대로 만든다. `idempotencyKey`는 모달을 열 때 `crypto.randomUUID()`로 한 번 만들고, 재시도에도 같은 값을 쓴다.
7. 캡차 위젯을 넣는다 (IQ-D2 권장 Turnstile). 현재 `api/server.js`는 `TURNSTILE_SECRET`이 있을 때만 검증하고, 폼에는 위젯이 없다.

`assets/analytics.js` (PR #10이 머지된 경우)

- `generate_lead`는 지금 "`/api/quote` 2xx + 본문 `{"ok":true}`"일 때만 발생한다. 허브 응답에는 `ok` 필드가 없다.
  → 판정을 "201, 또는 200 + `inquiryNo`"로 바꾼다. 안 바꾸면 전환 후 전환 이벤트가 0이 된다.

`api/server.js`, `web.config`, `docs/windows-deploy.md`, `README.md`

- 병행 기간(IQ-D18 B)이 끝나면 `/api/quote` 서버와 IIS `/api/*` 프록시 규칙, PM2 등록을 내린다.
- 그 전까지는 둔다. 허브 장애 때 되돌릴 경로가 된다.

## 3. 필드 매핑 (현재 → 설계안 예시 페이로드)

| 현재 (`quote-form.js`) | 허브 | 비고 |
|---|---|---|
| — | `siteKey` | 허브가 발급하는 사이트 식별자 (비밀 아님, IQ-D1). 상수로 넣는다 |
| — | `idempotencyKey` | 새로 생성 |
| `source` (`index`/`tool`) | `inquiryType` 또는 별도 필드 | 허브 유형 목록에 "시딩 견적"이 있어야 한다. 경로(index/tool)를 남길 필드가 설계안에 없다 → **허브 쪽 확인 필요** |
| `company` | `company` | 같음 |
| `contactName` (담당자명) | `contactName` | 같음. 설계안 예시의 `customerName`이 아니라 axhub `sales-lead/2`에 이미 있는 `contactName`을 쓴다. 2026-11-04 필수로 결정했고 폼에 칸을 추가했다 |
| `phone` | `phone` | 같음 |
| `email` | `email` | 같음 |
| `quantity` (선택 5종) | 없음 | `message` 앞에 붙이거나 허브에 사이트별 추가 필드가 필요 → **허브 쪽 확인 필요** |
| `vouchers` (키 배열 `kita`/`kosme`, 2026-11-04 추가) | `voucher` (문자열, 최대 100자) | 허브에 이미 있는 텍스트 칸. 한글 문자열로 합쳐 보낸다. 예: `한국무역협회 보유, 중소벤처기업진흥공단 미보유`, 빈 배열은 `미보유` (메일 표기와 같음). 허브 변경 불필요 |
| `message` | `message` | 같음 |
| `context` (계산기 조건 5개: `category`, `tier`, `quantity`, `goal`, `voucher`) | 없음 | `quantity`와 같은 문제 |
| `consent` (불리언) | `consent.privacyAgreed` + `privacyVersion` | 동의 문구 버전 값이 필요하다 (IQ-D11). 마케팅 동의 칸은 지금 없다 |
| — | `utm.*` | 페이지 URL의 `utm_*`를 읽어 채운다 |
| — | `pageUrl` | `location.href` |
| `website` (허니팟) | 없음 | 설계안에도 허니팟이 있다(IQ-D3). 필드 이름은 허브와 맞춘다. 허브가 "알 수 없는 필드 거부"이므로 이름이 다르면 400이 난다 |
| — | `captchaToken` | 위젯 토큰 |

## 4. 허브 쪽에 넘길 확인 사항

1. 사이트별 추가 필드(`quantity`, 계산기 조건, 문의 경로)를 어떻게 받을지.
2. (해결, 2026-11-04) 담당자 이름은 허브의 `contactName`(axhub `sales-lead/2`)으로 보내고 필수로 한다. 폼에 담당자명 칸을 추가했다.
3. 허브 CORS 허용 Origin에 `https://influencer.enclu.com`을 넣는다. GitHub Pages(`https://jjunghwa0928.github.io`)도 넣을지.
4. 허브 공개 경로의 IP 허용 목록 제외 (설계안 S15·U14).

## 5. 전환 순서

1. 허브 API 운영 배포, `siteKey` 발급, CORS에 이 도메인 등록.
2. 이 저장소에서 2장 변경을 한 PR로 만든다. `api/test/quote.test.js`처럼 응답 코드별 화면 분기를 테스트한다.
3. 운영(`influencer.enclu.com`)에서 실제 접수 1건 → 허브 관리자 화면에 들어왔는지, 완료 화면에 접수번호가 나오는지 확인.
4. 병행 기간 후 `/api/quote` 서버를 내린다.
