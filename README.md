# 엔클루 시딩 랜딩

정적 HTML. `index.html`(랜딩 + 리뷰 매거진), `tool.html`(예상 실적 확인).

- 리뷰 매거진은 Weedy API에서 매주 월요일 09:00 자동 갱신 후 커밋·푸시된다 (`scripts/`, Hermes cron `seeding-reviews-weekly`).
- 배포: GitHub Pages (main 브랜치 루트). 윈도우 서버는 `git pull`로 동기화.
- 디자인 작업 원본·스크린샷·핸드오프: `~/Desktop/hermes/seeding-redesign/` (로컬 전용).
- SEO/AEO/GEO: 두 페이지 `<head>`의 canonical·OG·JSON-LD, `index.html#faq` 섹션, 루트의 `sitemap.xml`·`robots.txt`·`llms.txt`·`llms-full.txt`·`.nojekyll` (절대 URL은 모두 `/seeding-landing/` 서브패스 포함).

## 릴스 교체 방법

ffmpeg가 필요하다. 주간 리뷰 cron은 이 영역을 건드리지 않는다.

1. 원본 영상을 `assets/reels/src/`에 넣는다 (`.mp4 .mov .m4v .webm`, 파일명 순서대로 노출). 이 폴더는 git에 올라가지 않으니 없으면 만든다.
2. (선택) 카드를 인스타그램으로 연결하려면 `links.txt`에 URL을 한 줄에 하나씩 파일명 순서대로 적는다. 빈 줄은 링크 없는 카드다.
3. `python3 scripts/bake_reels.py` 실행 (`links.txt`를 쓰면 `--links links.txt` 추가).
4. `index.html`과 `assets/reels/`의 결과물을 커밋한다. 더 이상 쓰지 않는 파일은 스크립트가 알려주니 `git rm`으로 지운다.

주의: 스크립트는 `src`에 있는 영상만 카드로 만든다. 일부만 넣으면 카드도 그만큼만 남고, 폴더가 비어 있으면 릴스 섹션 전체가 숨겨진다. 다른 PC에서 교체할 때는 유지할 원본까지 모두 넣고 실행한다.
