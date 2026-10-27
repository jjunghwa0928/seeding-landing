# 엔클루 시딩 랜딩

정적 HTML. `index.html`(랜딩 + 리뷰 매거진), `tool.html`(예상 실적 확인).

- 리뷰 매거진은 Weedy API에서 매주 월요일 09:00 자동 갱신 후 커밋·푸시된다 (`scripts/`, Hermes cron `seeding-reviews-weekly`).
- 배포: GitHub Pages (main 브랜치 루트). 윈도우 서버는 `git pull`로 동기화.
- 디자인 작업 원본·스크린샷·핸드오프: `~/Desktop/hermes/seeding-redesign/` (로컬 전용).
- SEO/AEO/GEO: 두 페이지 `<head>`의 canonical·OG·JSON-LD, `index.html#faq` 섹션, 루트의 `sitemap.xml`·`robots.txt`·`llms.txt`·`llms-full.txt`·`.nojekyll` (절대 URL은 모두 `/seeding-landing/` 서브패스 포함).
