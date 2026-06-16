# POTC Server Monitor — 정적 뷰어 (status_site)

폰(Safari/PWA)에서 POTC 게임서버 상태를 읽기전용으로 보는 vanilla JS 웹앱.
리스트(동접·FPS, 정렬·핀·검색·90초 자동갱신 + ↻ 버튼) → 서버 탭 → 상세(현재정보 + CCU/FPS 24h 추이 + 서버필터 이벤트로그).

> 전체 설명(아키텍처·배포·프로토콜·데이터 스키마)은 상위 **`../CLAUDE.md`** 참조.

## 구성
| 파일 | 역할 |
|---|---|
| `index.html` / `styles.css` / `app.js` | 뷰어 (리스트 + 상세 해시라우팅 `#s/<num>`) |
| `manifest.webmanifest` / `icon.svg` | PWA ("홈 화면에 추가") |
| `status.json`, `detail/<num>.json` | **로컬 프리뷰용 목업** (Pages엔 `data` 브랜치의 실데이터; 브릿지가 생성) |

## 로컬 미리보기
```
cd status_site
python -m http.server 8091
# http://localhost:8091  (localhost는 repoInfo()=null → 목업 폴백)
```
(또는 상위 `.claude/launch.json` 의 `status_site` 프리뷰 설정.)

## 배포
브릿지(`../bridge/monitor_client.py --git-dir`, 보통 `POTC-Bridge.cmd`)가 `main`=뷰어 / `data`=status.json+detail/ 로 push. 폰은 GitHub Pages 뷰어 + 무인증 contents API(`?ref=data`)로 확인. 자세한 내용은 `../CLAUDE.md`.
