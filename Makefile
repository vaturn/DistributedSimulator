# 작업-모듈 배치 시뮬레이터 Makefile
# 표준 작업(설치, 실행, 테스트, 검증, 시뮬레이션)은 이 타깃을 쓴다. 예외는 AGENTS.md 참고.
# 사용법: make help

SHELL := /bin/bash
.DEFAULT_GOAL := help

NPM      ?= npm
SCENARIO ?= basic
POLICY   ?= greedy
SEED     ?=
POLICIES ?= random,greedy
OUT      ?= out
FILE     ?=
ARGS     ?=

# git 작업 (규칙: docs/GIT.md)
GIT_REMOTE ?= origin
GIT_BRANCH ?= main
MSG        ?=
CO_AUTHOR  ?=
# 커밋에 넣으면 안 되는 경로 패턴 (확장 정규식)
GIT_FORBIDDEN := (^|/)(node_modules|dist|out)/|(^|/)\.env[^/]*$$|\.(pem|key)$$|(^|/)\.claude/settings\.local\.json$$

# MSG와 CO_AUTHOR는 값을 그대로(make 확장 없이) 환경변수로 넘겨 셸 인용 문제를 피한다.
override MSG := $(value MSG)
override CO_AUTHOR := $(value CO_AUTHOR)
export MSG CO_AUTHOR

SEED_ARG := $(if $(SEED),--seed $(SEED),)
# make sim은 OUT을 명령줄(또는 환경변수)로 줬을 때만 결과 JSON을 저장한다.
SIM_OUT_ARG := $(if $(filter command line environment,$(origin OUT)),--out $(OUT),)

.PHONY: help setup dev build preview test test-watch typecheck check sim compare replay clean distclean git-status commit push ship sync

help: ## 사용 가능한 타깃 목록
	@echo "사용법: make <타깃> [변수=값]"
	@echo
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "변수: SCENARIO=$(SCENARIO) POLICY=$(POLICY) SEED=$(SEED) POLICIES=$(POLICIES) OUT=$(OUT) FILE=$(FILE) ARGS=$(ARGS)"

package.json:
	@echo "package.json이 없습니다. 먼저 M0(프로젝트 셋업)을 진행하세요. (plan/planing.md §10)" >&2
	@exit 1

# package.json이 바뀌었을 때만 다시 설치한다.
node_modules: package.json
	$(NPM) install
	@touch node_modules

setup: node_modules ## 의존성 설치

dev: node_modules ## 개발 서버 실행 (브라우저에서 시뮬레이터 확인)
	$(NPM) run dev

build: node_modules ## 프로덕션 빌드 (dist/)
	$(NPM) run build

preview: build ## 빌드 결과 미리보기
	$(NPM) run preview

test: node_modules ## 테스트 1회 실행 (ARGS로 파일/필터 지정 가능)
	$(NPM) run test -- $(ARGS)

test-watch: node_modules ## 테스트 감시 모드 (ARGS로 파일/필터 지정 가능)
	$(NPM) run test:watch -- $(ARGS)

typecheck: node_modules ## 타입 검사
	$(NPM) run typecheck

check: typecheck test ## 작업 완료 전 필수 검증 (타입 검사 + 테스트)
	@echo "✓ check 통과"

sim: node_modules ## 화면 없이 시뮬레이션 실행 (SCENARIO, POLICY, SEED, OUT을 주면 결과 JSON 저장)
	$(NPM) run sim -- --scenario $(SCENARIO) --policy $(POLICY) $(SEED_ARG) $(SIM_OUT_ARG)

compare: node_modules ## 여러 정책을 같은 조건으로 비교 (SCENARIO, POLICIES, SEED, OUT)
	@mkdir -p $(OUT)
	$(NPM) run sim -- --scenario $(SCENARIO) --compare $(POLICIES) $(SEED_ARG) --out $(OUT)

replay: node_modules ## 결과 JSON의 명령 로그를 재생해 지표 일치 확인 (FILE 필수)
	@if [ -z "$(FILE)" ]; then echo "오류: FILE이 필요합니다. 예: make replay FILE=out/basic-greedy-42.json" >&2; exit 1; fi
	$(NPM) run sim -- --replay $(FILE)

clean: ## 빌드 산출물과 실행 결과 삭제
	rm -rf dist $(OUT)

distclean: clean ## clean + node_modules 삭제
	rm -rf node_modules

git-status: ## 브랜치, 짧은 상태, 원격과의 차이(ahead/behind) 표시
	@GIT_TERMINAL_PROMPT=0 git fetch -q $(GIT_REMOTE) $(GIT_BRANCH) || echo "경고: 원격을 가져오지 못했습니다. 마지막으로 알려진 원격 상태로 비교합니다." >&2
	@git status -sb
	@set -- $$(git rev-list --left-right --count $(GIT_REMOTE)/$(GIT_BRANCH)...HEAD); \
		echo "원격 $(GIT_REMOTE)/$(GIT_BRANCH) 대비: ahead $$2, behind $$1"

commit: ## make check 통과 후 전체 변경 커밋 (MSG 필수, CO_AUTHOR 선택)
	@if [ -z "$$MSG" ]; then echo "오류: MSG가 필요합니다. 예: make commit MSG=\"요약\"" >&2; exit 1; fi
	@$(MAKE) --no-print-directory check
	@git add -A
	@bad=$$(git diff --cached --name-only | grep -E '$(GIT_FORBIDDEN)' || true); \
		if [ -n "$$bad" ]; then \
			git reset -q; \
			echo "오류: 커밋 금지 파일이 스테이징되어 스테이징을 모두 풀었습니다:" >&2; \
			echo "$$bad" | sed 's/^/  /' >&2; \
			exit 1; \
		fi
	@if git diff --cached --quiet; then echo "커밋할 변경이 없습니다."; exit 0; fi; \
		if [ -n "$$CO_AUTHOR" ]; then \
			git commit -q -m "$$MSG" -m "Co-Authored-By: $$CO_AUTHOR"; \
		else \
			git commit -q -m "$$MSG"; \
		fi; \
		git log -1 --oneline

push: ## 현재 브랜치가 GIT_BRANCH인지 확인 후 푸시 (force 금지)
	@cur=$$(git rev-parse --abbrev-ref HEAD); \
		if [ "$$cur" != "$(GIT_BRANCH)" ]; then echo "오류: 현재 브랜치가 $$cur 입니다. $(GIT_BRANCH)에서만 푸시합니다." >&2; exit 1; fi
	GIT_TERMINAL_PROMPT=0 git push $(GIT_REMOTE) $(GIT_BRANCH)

ship: ## commit 다음 push (MSG 필수, CO_AUTHOR 선택)
	@$(MAKE) --no-print-directory commit
	@$(MAKE) --no-print-directory push

sync: ## 원격 변경을 rebase로 가져오기
	GIT_TERMINAL_PROMPT=0 git pull --rebase $(GIT_REMOTE) $(GIT_BRANCH)
