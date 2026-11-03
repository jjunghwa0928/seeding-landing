# 엔클루 시딩 랜딩

정적 HTML. `index.html`(랜딩 + 리뷰 매거진), `tool.html`(예상 실적 확인).

- 리뷰 매거진은 Weedy API에서 매주 월요일 09:00 자동 갱신 후 커밋·푸시된다 (`scripts/`, Hermes cron `seeding-reviews-weekly`).
- 배포: Windows Server + IIS(정적 파일 서빙, `/api/*`는 URL Rewrite + ARR 프록시) + PM2(Node API). 서버에서 `deploy.bat`으로 동기화한다. 처음 배포 순서는 [`docs/windows-deploy.md`](docs/windows-deploy.md), API 상세는 아래 "견적 문의 메일 API" 참고.
- 디자인 작업 원본·스크린샷·핸드오프: `~/Desktop/hermes/seeding-redesign/` (로컬 전용).
- SEO/AEO/GEO: 두 페이지 `<head>`의 canonical·OG·JSON-LD, `index.html#faq` 섹션, 루트의 `sitemap.xml`·`robots.txt`·`llms.txt`·`llms-full.txt`·`.nojekyll` (절대 URL은 모두 `/seeding-landing/` 서브패스 포함).

## 견적 문의 메일 API

견적 문의 폼(`assets/quote-form.js`)은 `POST /api/quote`로 JSON을 보내고, `api/server.js`가 SMTP(네이버웍스)로 `MAIL_TO`에 메일을 보낸다. 포트는 3201이다 (같은 서버의 `enclu-contact-api`는 3200).

```
브라우저 → IIS (web.config 리라이트) → Node (PM2 seeding-quote-api, :3201) → SMTP → mkt2@enclu.co.kr
```

### 서버 설치

1. IIS에 URL Rewrite와 Application Request Routing을 설치하고, IIS 관리자 → 서버 노드 → Application Request Routing Cache → Server Proxy Settings → **Enable proxy**를 켠다. 꺼져 있으면 `/api/*`가 502 또는 404가 된다.
2. IIS 사이트의 물리 경로를 이 저장소 루트(`web.config`가 있는 폴더)로 지정하고 도메인을 바인딩한다. 폼이 루트 기준 `/api/quote`를 호출하므로 하위 경로 애플리케이션이 아니라 **사이트 루트**여야 한다.
3. ARR의 Server Proxy Settings에서 "Include TCP port from client IP"를 꺼 두기를 권장한다. 켜져 있어도 서버가 포트를 지우고 IP를 센다.
4. API를 설치하고 기동한다.

```bat
cd api
npm ci --omit=dev
copy .env.example .env
rem .env 를 열어 SMTP_PASS 에 네이버웍스 앱 비밀번호를 넣는다
pm2 start ecosystem.config.js
pm2 save
```

서버 재부팅 후 자동 기동이 필요하면 최초 1회 `pm2-windows-startup` 또는 작업 스케줄러에 `pm2 resurrect`를 등록한다. 3201 포트는 외부에 열지 않는다.

`NODE_ENV=production`(PM2가 고정)에서 `SMTP_PASS`가 비어 있으면 서버는 기동을 거부한다. `.env`는 git에 올리지 않는다.

### 확인

```bat
curl http://localhost:3201/api/health
curl https://<도메인>/api/health
```

둘 다 `{"ok":true}`가 와야 한다. 실제 발송 확인:

```bat
curl -X POST https://<도메인>/api/quote -H "Content-Type: application/json" -d "{\"company\":\"테스트\",\"phone\":\"010-0000-0000\",\"email\":\"test@example.com\",\"quantity\":\"50명 미만\",\"consent\":true}"
```

로그는 `pm2 logs seeding-quote-api`로 본다. 문의 내용·이메일·비밀값은 기록하지 않고, 접수 IP와 거부 사유만 남는다.

| 응답 | 의미 | 폼 동작 |
|---|---|---|
| 200 `{"ok":true}` | 접수 완료 (허니팟에 걸린 요청도 같은 응답, 메일은 안 보냄) | 성공 화면 |
| 400 `invalid_input` + `fields` | 필수값 누락, 형식 오류, 길이 초과, 동의 없음 | 항목별 오류 표시 |
| 400 `captcha_failed` | Turnstile 토큰 없음 또는 검증 실패 | 입력 확인 안내 |
| 429 `rate_limited` / `duplicate` | IP당 10분 5회(전체 API 1분 60회) 초과, 또는 같은 내용 10분 내 재전송 | "잠시 후 다시 시도해 주세요." |
| 502 `send_failed` | SMTP 발송 실패. `.env`와 `pm2 logs` 확인 | 메일 앱으로 보내기 링크 |

### 스팸 방지 선택: Turnstile 없음

eh(`enclu-contact-api`)는 production에서 `TURNSTILE_SECRET`을 필수로 요구하지만, 여기서는 **선택**이다. 이번에는 프런트엔드 위젯을 넣지 않았기 때문이다. 비어 있으면 production에서 경고만 남기고 허니팟(`website`), 속도 제한, 중복 가드, 본문 16KB 제한에 의존한다.

**위젯을 넣기 전에 `TURNSTILE_SECRET`을 설정하면 모든 문의가 `captcha_failed`로 거부된다.** 위젯과 시크릿은 함께 적용한다.

### GitHub Pages

호스트명이 `github.io`로 끝나면 API가 없으므로 폼이 바로 `mailto:`를 연다. 다른 호스트에서는 네트워크 오류나 5xx일 때만 메일 앱으로 보내기 링크를 보여 준다.

### 개발

```bash
cd api
npm install
npm test     # node:test, 네트워크 없이 실행
```

## 릴스 교체 방법

ffmpeg가 필요하다. 주간 리뷰 cron은 이 영역을 건드리지 않는다.

1. 원본 영상을 `assets/reels/src/`에 넣는다 (`.mp4 .mov .m4v .webm`, 파일명 순서대로 노출). 이 폴더는 git에 올라가지 않으니 없으면 만든다.
2. (선택) 카드를 인스타그램으로 연결하려면 `links.txt`에 URL을 한 줄에 하나씩 파일명 순서대로 적는다. 빈 줄은 링크 없는 카드다.
3. `python3 scripts/bake_reels.py` 실행 (`links.txt`를 쓰면 `--links links.txt` 추가).
4. `index.html`과 `assets/reels/`의 결과물을 커밋한다. 더 이상 쓰지 않는 파일은 스크립트가 알려주니 `git rm`으로 지운다.

PC(768px 이상)는 5열 2행 고정 그리드라 10개가 딱 맞고, 모바일은 2행으로 자동으로 흐른다.

링크를 주지 않으면 카드는 클릭되지 않는 영상으로만 나온다 (현재 상태). 영상이 없으면 릴스 섹션 전체를 숨기고, 빈 박스가 필요하면 `--placeholders N`을 준다.

주의: 스크립트는 `src`에 있는 영상만 카드로 만든다. 일부만 넣으면 카드도 그만큼만 남고, 폴더가 비어 있으면 섹션이 숨겨진다. 다른 PC에서 교체할 때는 유지할 원본까지 모두 넣고 실행한다.

## 브랜드 로고 추가 방법

ffmpeg가 필요하다 (Pillow 등 추가 패키지 없음).

1. 로고를 `assets/IMG/brands/src/`에 `<순번>_<브랜드명>.png`로 넣는다 (`.png .jpg .jpeg .webp .svg`, 순번 숫자 순서대로 노출, 브랜드명 끝의 `.`은 제거되어 alt·aria-label로 쓰인다). 이 폴더는 git에 올라가지 않는다.
2. `python3 scripts/bake_brands.py` 실행. 투명 여백을 잘라 `assets/IMG/brands/<slug>.webp`를 만들고 `index.html`의 `<!-- brands:wall -->` 영역을 다시 쓴다. 같은 이름은 `-2`, `-3`이 붙는다. `.svg`는 여백을 자르지 않고 그대로 복사한다.
3. `index.html`과 `assets/IMG/brands/`의 결과물을 커밋한다. 더 이상 쓰지 않는 파일은 스크립트가 알려주니 `git rm`으로 지운다.

로고는 CSS 필터로 흰색 단색으로 표시되므로 배경이 투명해야 한다. 불투명 배경은 흰 박스로 보인다 (여백이 전혀 없으면 스크립트가 경고한다). 슬라이드 속도는 개수와 무관하게 일정하다.

흰색으로 뭉개져 읽히지 않는 로고는 `scripts/bake_brands.py`의 `KEEP_COLOR`에 확장자 없는 원본 파일명(예: `59_Maeil`)을 추가하고 다시 실행하면 원래 색으로 나온다. 파일명을 바꾸면 이 목록도 함께 고친다 (맞는 원본이 없으면 스크립트가 경고한다).

브랜드 수는 스크립트가 `index.html`의 메타 설명에 자동 반영한다. `llms.txt`와 `llms-full.txt`의 브랜드 수·목록은 자동 갱신되지 않으니 직접 고친다.

주의: 릴스와 마찬가지로 `src`에 있는 로고만 칩으로 만든다. 다른 PC에서 추가할 때는 기존 원본까지 모두 넣고 실행한다.
