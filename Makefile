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
ARGS     ?=

SEED_ARG := $(if $(SEED),--seed $(SEED),)

.PHONY: help setup dev build preview test test-watch typecheck check sim compare clean distclean

help: ## 사용 가능한 타깃 목록
	@echo "사용법: make <타깃> [변수=값]"
	@echo
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "변수: SCENARIO=$(SCENARIO) POLICY=$(POLICY) SEED=$(SEED) POLICIES=$(POLICIES) OUT=$(OUT) ARGS=$(ARGS)"

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

sim: node_modules ## 화면 없이 시뮬레이션 실행 (SCENARIO, POLICY, SEED)
	$(NPM) run sim -- --scenario $(SCENARIO) --policy $(POLICY) $(SEED_ARG)

compare: node_modules ## 여러 정책을 같은 조건으로 비교 (SCENARIO, POLICIES, SEED, OUT)
	@mkdir -p $(OUT)
	$(NPM) run sim -- --scenario $(SCENARIO) --compare $(POLICIES) $(SEED_ARG) --out $(OUT)

clean: ## 빌드 산출물과 실행 결과 삭제
	rm -rf dist $(OUT)

distclean: clean ## clean + node_modules 삭제
	rm -rf node_modules
