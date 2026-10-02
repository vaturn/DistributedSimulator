# GIT.md — git 작업 규칙

git 작업(커밋, 푸시, 원격 동기화)을 하는 AI 에이전트와 사람이 따르는 규칙이다. git 작업은 아래 `make` 타깃으로 한다.

## 1. 결정 사항

| 항목 | 규칙 |
|---|---|
| 브랜치 | `main`에 직접 커밋한다. 기능 브랜치와 PR은 쓰지 않는다. |
| 커밋 메시지 | 자유 형식 한국어. 첫 줄은 짧은 요약(약 50자 이내). 필요하면 빈 줄 다음에 본문을 쓴다. |
| 커밋 시점 | 작업 계획의 단계마다 `make check`를 통과하면 커밋하고 바로 푸시한다. |
| 문서 | git 규칙은 이 문서(`docs/GIT.md`)에만 둔다. |

## 2. 작성자

- 전역 git 설정(`vaturn` / `will6867@naver.com`)을 그대로 쓴다.
- 저장소 로컬 설정(`git config user.*`)으로 덮어쓰지 않는다. 전역 설정도 바꾸지 않는다.
- AI가 만든 커밋은 메시지 끝에 빈 줄을 두고 다음 trailer를 넣는다. `CO_AUTHOR` 변수로 넣는다.

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```

## 3. 커밋 단위

- 작업 계획의 단계 하나 = 커밋 하나.
- 관련 없는 변경을 한 커밋에 섞지 않는다. 섞여 있으면 먼저 정리하거나 사용자에게 묻는다.
- `make check`가 실패하면 커밋하지 않는다. (`make commit`이 자동으로 `make check`를 먼저 돌린다.)

## 4. 금지

- force push (`git push --force`, `--force-with-lease` 포함)
- `git reset --hard`, 이미 푸시한 커밋의 amend/rebase 같은 히스토리 재작성
- `node_modules/`, `dist/`, `out/`, `.env*`, `*.pem`, `*.key`, 비밀값, `.claude/settings.local.json` 커밋
- `--no-verify`로 훅 건너뛰기, 테스트를 건너뛰거나 약하게 고친 뒤 커밋
- 토큰이나 자격 증명을 출력하거나 커밋하기

`make commit`은 스테이징된 파일에 금지 경로 패턴이 있으면 스테이징을 풀고 실패한다.

## 5. 문제가 생기면

- **푸시 거부(원격이 앞섬)**: `make sync`(`git pull --rebase`)로 맞춘 뒤 `make check`를 다시 통과시키고 `make push`한다.
- **rebase 충돌**: 직접 해결하지 말고 멈춘 뒤 사용자에게 묻는다.
- **인증 실패, 토큰 문제, 원격 주소 변경이 필요한 경우**: 멈추고 보고한다. 토큰을 출력하거나 설정 파일에 쓰지 않는다.

## 6. make 타깃

| 타깃 | 하는 일 |
|---|---|
| `make git-status` | 브랜치, 짧은 상태, 원격과의 차이(ahead/behind) 표시 |
| `make commit MSG="..." [CO_AUTHOR="..."]` | MSG 확인 → `make check` → `git add -A` → 금지 파일 검사 → 커밋. 변경이 없으면 알리고 성공 종료 |
| `make push` | 현재 브랜치가 `main`인지 확인 후 `git push origin main` (force 없음) |
| `make ship MSG="..." [CO_AUTHOR="..."]` | `commit` 다음 `push` |
| `make sync` | `git pull --rebase origin main` |

변수: `GIT_REMOTE ?= origin`, `GIT_BRANCH ?= main`, `MSG`, `CO_AUTHOR`(기본 비움). `MSG`는 따옴표나 `$`가 있어도 그대로 전달된다.

본문이 있는 메시지는 `MSG`에 줄바꿈을 넣는다.

```bash
make ship MSG="$(printf '요약 한 줄\n\n본문 설명')" CO_AUTHOR="Claude Opus 5.5 <noreply@anthropic.com>"
```

## 7. 표준 순서 (단계마다)

1. `make git-status` — 시작 전 상태 확인. behind가 있으면 `make sync`.
2. 단계 작업 수행.
3. `make git-status` — 이번 단계 변경만 있는지 확인.
4. `make ship MSG="요약" CO_AUTHOR="Claude Opus 5.5 <noreply@anthropic.com>"` — 검사, 커밋, 푸시.
5. 확인: `git log -1 --format=%B`(메시지와 trailer), `git status -sb`(`## main...origin/main`이면 동기화됨).
