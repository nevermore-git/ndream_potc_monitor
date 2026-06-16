# POC 서버 모니터 — 정적 뷰어 (status_site)

폰(Safari)에서 POC 게임서버의 **현재 동접(CCU)·FPS·상태**를 읽기전용으로 보는 정적 웹앱.
의존성 없음(vanilla JS). 같은 출처의 `status.json` 하나만 읽어 렌더한다.

## 구성
| 파일 | 역할 |
|---|---|
| `index.html` / `styles.css` / `app.js` | 뷰어 (정렬 번호·동접·FPS / 핀 / 검색 / 30초 자동갱신) |
| `manifest.webmanifest` / `icon.svg` | PWA — Safari "홈 화면에 추가" 시 앱처럼 동작 |
| `status.json` | **데이터** — 브릿지가 주기적으로 덮어쓴다. 지금 들어있는 건 `source:"mock"` 미리보기용 |

## 데이터 출처 (status.json)
dev PC의 브릿지가 Live Master(:30000)에 붙어 생성:
```
cd web_dashboard/bridge
python monitor_client.py --host <live-host> --emit ../status_site/status.json
```
스키마: `{ updated_at, updated_epoch, source, summary{server_count,total_ccu}, servers:[{num,name,type,ccu,fps,condition}] }`
`source`는 `live/qa/backup/local` 라벨(내부 호스트명은 넣지 않음).

## 배포 (GitHub Pages)
1. 이 폴더 내용을 repo 루트에 두고 Pages 활성화 → `https://<id>.github.io/<repo>/` 에서 열림.
2. 브릿지가 `status.json`을 같은 repo에 주기 push(`commit --amend` + `push --force`) → 페이지가 자동 최신화.
3. 폰 Safari로 열고 **공유 → 홈 화면에 추가**.

> ⚠️ 공개 Pages면 서버명·CCU·FPS가 URL을 아는 사람에게 공개된다. 비공개로 두려면 Cloudflare Pages + Access(이메일 잠금)로 같은 파일을 서빙하면 된다(뷰어 코드 동일).

## 로컬 미리보기
```
cd web_dashboard/status_site
python -m http.server 8080
# 브라우저에서 http://localhost:8080  (목업 status.json 렌더)
```

## TODO (phase 2)
- 서버 상세: 탭 → FPS·동접 추이 그래프 + 로그 (status.json 옆에 시계열 히스토리 추가 필요).
