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

브랜드 수는 스크립트가 `index.html`에 자동 반영한다 (`<!-- brands:count -->` 영역, 메타 설명, 통계 수치). `llms.txt`와 `llms-full.txt`의 브랜드 수·목록은 자동 갱신되지 않으니 직접 고친다.

주의: 릴스와 마찬가지로 `src`에 있는 로고만 칩으로 만든다. 다른 PC에서 추가할 때는 기존 원본까지 모두 넣고 실행한다.
