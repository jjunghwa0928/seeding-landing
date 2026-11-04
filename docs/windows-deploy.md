# 윈도우 서버 배포 가이드 (시딩 랜딩 + 견적 문의 메일 API)

사내 윈도우 서버 한 대에서 랜딩 페이지와 견적 문의 메일 프로그램을 같이 운영합니다.
회사 홈페이지(enclu-homepage)와 같은 구조입니다.
그 서버에서는 이미 IIS, URL Rewrite, ARR, PM2, `enclu-contact-api`(포트 3200)가 돌고 있습니다.

```
고객 브라우저 → (Cloudflare) → IIS 사이트 (정적 파일)
                                 └ /api/* → web.config 리라이트 → PM2 seeding-quote-api (localhost:3201) → 네이버웍스 SMTP → mkt2@enclu.co.kr
```

## 0. 시작 전에 정해야 할 것

- **도메인**: `influencer.enclu.com`으로 운영합니다.
  이 도메인은 지금 Cloudflare를 거쳐 다른 Next.js 사이트가 응답하고 있습니다.
  9단계의 DNS 전환 전까지는 운영에 영향이 없습니다.
- **절대 URL**: canonical, OG, sitemap 주소는 이미 `https://influencer.enclu.com/`을 가리킵니다.
  도메인 전환 PR #5가 이 코드에 포함되어 있어서 따로 머지할 필요가 없습니다.
- **https**: 사이트가 https라서 폼이 보내는 `/api/quote`도 https로 열려 있어야 합니다.
  같은 도메인 안의 경로라서 사이트가 https면 API도 자동으로 https입니다.

## 1. 서버 사전 조건 확인 (이미 되어 있으면 건너뜀)

enclu-homepage 배포 때 설치를 마쳤습니다. 아래는 확인만 하면 됩니다.

1. Node.js 18 이상: `node -v`
2. PM2: `pm2 -v`. 없으면 `npm i -g pm2`로 설치합니다.
3. Git: `git --version`
4. IIS 관리자에서 사이트를 선택했을 때 **URL 재작성** 아이콘이 보이는지 확인합니다.
5. IIS 관리자에서 **서버 노드**를 선택하고, Application Request Routing Cache → Server Proxy Settings에서 **Enable proxy**가 체크되어 있는지 확인합니다.
   꺼져 있으면 `/api/*`가 404나 502로 응답합니다.

## 2. 코드 받기

명령 프롬프트(cmd)를 관리자 권한으로 열어 실행합니다. 경로는 예시이며 enclu-homepage 옆에 둡니다.

```bat
cd /d D:\WWW_ROOT
git clone https://github.com/jjunghwa0928/seeding-landing.git
cd seeding-landing
```

## 3. 비밀번호 넣기 (`api\.env`)

```bat
copy api\.env.example api\.env
notepad api\.env
```

`SMTP_PASS=` 뒤에 네이버웍스 앱 비밀번호를 붙여 넣고 저장합니다.
나머지 값은 기본값을 그대로 둡니다.

- `SMTP_HOST=smtp.worksmobile.com`
- `SMTP_PORT=465`
- `SMTP_SECURE=true`
- `SMTP_USER=mkt2@enclu.co.kr`
- `MAIL_TO=mkt2@enclu.co.kr`

주의할 점입니다.
- `api\.env`는 `.gitignore`에 들어 있어서 git에 올라가지 않습니다. 이 파일을 커밋하거나 메신저로 보내지 않습니다.
- `SMTP_PASS`가 비어 있으면 프로그램이 일부러 시작하지 않습니다.
- `TURNSTILE_SECRET`은 비워 둡니다. 화면에 Turnstile 위젯이 없는 상태에서 값을 넣으면 모든 문의가 거부됩니다.

네이버웍스 앱 비밀번호는 네이버웍스의 보안 설정에서 발급합니다.
관리자가 외부 메일 프로그램(IMAP/SMTP) 사용을 막아 두었다면 먼저 허용해야 합니다.

## 4. 메일 프로그램 설치와 실행

```bat
deploy.bat
```

`deploy.bat`은 아래 순서로 실행됩니다. 처음 설치할 때도, 이후 업데이트할 때도 이 파일 하나만 실행하면 됩니다.

1. `git pull origin main`
2. `api` 폴더에서 `npm ci --omit=dev`
3. PM2의 `seeding-quote-api`를 지웠다가 다시 시작
4. `pm2 save`
5. `http://localhost:3201/api/health` 확인

마지막에 `{"ok":true}`가 나오면 성공입니다.

PM2 상태 확인:

```bat
pm2 status
pm2 logs seeding-quote-api --lines 50
```

`enclu-contact-api`(3200)와 `seeding-quote-api`(3201)가 둘 다 `online`이어야 합니다.

서버를 재부팅해도 자동으로 실행되게 하려면, 처음 한 번만 `pm2-windows-startup`을 설치하거나 작업 스케줄러에 `pm2 resurrect`를 등록합니다.
enclu-homepage 때 이미 등록했다면 `pm2 save`만으로 같이 살아납니다.

3201 포트는 방화벽에서 외부로 열지 않습니다. IIS만 내부에서 접속합니다.

## 5. IIS 사이트 만들기

IIS 관리자 → 사이트 → **웹 사이트 추가**에서 설정합니다.

- 사이트 이름: `seeding_landing`
- 실제 경로: `D:\WWW_ROOT\seeding-landing` (`web.config`가 있는 저장소 루트)
- 바인딩: `http`, 포트 80, 호스트 이름 `influencer.enclu.com`
- https를 서버에서 직접 받는다면 443 바인딩과 인증서를 추가합니다. Cloudflare가 https를 처리한다면 80만 열어도 됩니다(7단계).

반드시 **사이트 루트**로 만듭니다.
기존 사이트 아래의 하위 애플리케이션(`/seeding`)으로 만들면 폼이 호출하는 `/api/quote` 경로가 맞지 않습니다.

`web.config`는 저장소에 들어 있어서 따로 만들지 않습니다. 이 파일이 하는 일은 다음과 같습니다.

- 기본 문서를 `index.html`로 지정합니다.
- `.webp`, `.woff2`, `.mp4`, `.webm`, `.txt`, `.xml` 파일 형식(MIME)을 등록합니다.
- `/api/*` 요청을 `localhost:3201`로 넘깁니다.
- `.env`, `node_modules`, `.git` 경로는 어떤 주소로도 열리지 않게 막습니다.

다른 사이트가 이미 `influencer.enclu.com`에 바인딩되어 있으면 그 바인딩부터 지웁니다.
enclu-homepage 때 `renew.enclu.com_3100`에서 `ec2.enclu.com` 바인딩만 지운 것과 같은 방법입니다.

## 6. 서버 안에서 확인 (DNS 전환 전)

```bat
curl http://localhost:3201/api/health
curl -H "Host: influencer.enclu.com" http://localhost/api/health
curl -I -H "Host: influencer.enclu.com" http://localhost/
curl -o NUL -s -w "%{http_code}\n" -H "Host: influencer.enclu.com" http://localhost/api/.env
```

- 첫째와 둘째 명령은 `{"ok":true}`가 나와야 합니다.
- 셋째 명령은 `200`이 나와야 합니다.
- 넷째 명령은 `404`가 나와야 합니다. `200`이 나오면 비밀번호가 노출되는 상태이니 즉시 사이트를 중지합니다.

실제 메일 발송 확인:

```bat
curl -X POST -H "Host: influencer.enclu.com" -H "Content-Type: application/json" http://localhost/api/quote -d "{\"company\":\"배포테스트\",\"phone\":\"010-0000-0000\",\"email\":\"mkt2@enclu.co.kr\",\"quantity\":\"50명 미만\",\"consent\":true}"
```

`{"ok":true}`가 나오고 mkt2@enclu.co.kr에 "[시딩 견적 문의] 배포테스트 / 50명 미만" 메일이 도착하면 성공입니다.
`502 send_failed`가 나오면 SMTP 설정 문제입니다. `pm2 logs seeding-quote-api`를 보고 앱 비밀번호와 SMTP 허용 여부를 확인합니다.
같은 내용을 10분 안에 다시 보내면 `429 duplicate`가 나옵니다. 정상 동작입니다.

## 7. https (Cloudflare)

`influencer.enclu.com`은 이미 Cloudflare 프록시(주황 구름)를 거치고 있습니다.

- 서버에 인증서가 없다면 SSL/TLS 모드를 **Flexible**로 둡니다. 이 경우 Cloudflare와 서버 사이 구간은 http입니다.
- 서버에 인증서(Cloudflare Origin 인증서 등)를 443으로 바인딩했다면 **Full (strict)**를 씁니다. 이 방식을 권장합니다.
- 어느 쪽이든 고객 브라우저와 Cloudflare 사이는 https입니다. 그래서 폼이 `/api/quote`를 호출할 때 차단되지 않습니다.

## 8. 도메인 주소 맞추기 (PR #5)

PR #5는 canonical, OG, sitemap, robots, llms의 절대 주소를 `https://influencer.enclu.com/`으로 바꾸고 분석 연결을 넣습니다.
PR #7과의 충돌은 해결되었고, PR #5 내용은 `feat/ga4-cta-events` 브랜치에 포함되어 있습니다.
이 브랜치를 도메인 전환(9단계)과 같은 날 머지합니다.
머지한 뒤 서버에서 `deploy.bat`을 한 번 더 실행합니다.

## 9. DNS 전환

Cloudflare DNS에서 `influencer.enclu.com` 레코드를 이 서버의 공인 IP로 바꿉니다. 주황 구름(프록시)은 켜 둡니다.
기존 Next.js 사이트로 돌아가야 할 때를 대비해, 바꾸기 전 레코드 값을 적어 둡니다.

## 10. 운영 확인 (DNS 전환 후)

```bat
curl https://influencer.enclu.com/api/health
curl -s https://influencer.enclu.com/ | findstr /C:"브랜드는 목표만 설정하세요"
curl -o NUL -s -w "%{http_code}\n" https://influencer.enclu.com/api/.env
curl -o NUL -s -w "%{http_code}\n" https://influencer.enclu.com/llms.txt
```

- `{"ok":true}`, 문구 1줄, `404`, `200`이 차례로 나와야 합니다.
- 휴대폰으로 `https://influencer.enclu.com/#quote`에 접속해 폼을 실제로 보냅니다.
  "견적 문의가 접수되었습니다"가 뜨고 메일이 도착하는지 확인합니다.
- 예상 실적 페이지(`/tool.html`)에서도 한 번 보내 봅니다. 메일 본문에 계산기에서 고른 조건이 들어 있어야 합니다.

## 업데이트 (이후 배포)

GitHub main에 머지된 뒤 서버에서 실행합니다.

```bat
cd /d D:\WWW_ROOT\seeding-landing
deploy.bat
```

정적 파일(html, css, js)만 바뀌었으면 IIS가 바로 새 파일을 내보냅니다. Cloudflare 캐시가 남아 있으면 Cloudflare에서 캐시를 비웁니다.

## 되돌리기

- 화면만 이전 버전으로: `git log --oneline -5`로 이전 커밋을 찾아 `git checkout <커밋> -- index.html tool.html assets` 실행
- 메일 프로그램 중지: `pm2 stop seeding-quote-api`. 폼은 자동으로 "메일 앱으로 보내기" 링크로 넘어갑니다.
- 도메인을 이전 사이트로: 9단계에서 적어 둔 DNS 값으로 되돌립니다.

## 문제 해결

| 증상 | 원인 | 조치 |
|---|---|---|
| `/api/health`가 404 | ARR Enable proxy 꺼짐, 또는 하위 애플리케이션으로 만듦 | 1-5단계 확인, 사이트 루트로 다시 만들기 |
| `/api/health`가 502 | PM2 프로그램이 꺼짐 | `pm2 status`, `pm2 logs seeding-quote-api` |
| PM2가 바로 `errored` | `SMTP_PASS` 비어 있음 | `api\.env` 확인 후 `deploy.bat` |
| `502 send_failed` | 앱 비밀번호 오류, SMTP 차단 | 네이버웍스 보안 설정, 앱 비밀번호 재발급 |
| 모든 문의가 `captcha_failed` | `TURNSTILE_SECRET`에 값이 들어감 | 값을 비우고 `pm2 restart seeding-quote-api` |
| 폼이 메일 앱을 엶 | API 호출 실패(네트워크 오류, 5xx), 또는 github.io 주소로 접속 | 위 health 확인 |
| 영상, 폰트가 안 나옴 | MIME 미등록 | `web.config`가 루트에 있는지 확인 |
