# fullauto — Spec Kit 확장

[GitHub Spec Kit](https://github.com/github/spec-kit) (v1.0 이상) 프로젝트에서
`/speckit-implement` 대신 fullauto-cc의 검증 루프로 `tasks.md`를 실행하는
확장입니다. 설치하면 `speckit.fullauto.run` 커맨드가 등록되고, Claude
integration에서는 `/speckit-fullauto-run` 스킬로 호출합니다. `/speckit-tasks`가
끝난 뒤에는 optional `after_tasks` 훅으로 "지금 fullauto 루프를 돌릴까요?"
프롬프트가 뜹니다 (거절 가능).

## 전제

- `fullauto` 바이너리가 PATH에 있어야 합니다 (저장소 루트에서 `npm install &&
  npm run build && npm link`).
- spec-kit CLI `specify` ≥ 1.0 (`specify --version`으로 확인).
- 프로젝트가 `specify init --integration claude`로 초기화되어 있어야
  `.claude/skills/speckit-*`가 존재합니다.

## 설치

```bash
cd /path/to/your/speckit-project
specify extension add --dev /path/to/fullauto-cc/extensions/fullauto
```

설치 확인:

```bash
specify extension list                              # Full Auto (v1.0.0) ... Commands: 1 | Hooks: 1
ls .claude/skills/speckit-fullauto-run/SKILL.md     # Claude 스킬 (심볼릭 링크)
```

제거:

```bash
specify extension remove fullauto
```

## 사용

```
/speckit-specify ...
/speckit-plan ...
/speckit-tasks                 # specs/<feature>/tasks.md 생성 → after_tasks 훅이 fullauto 실행을 제안
/speckit-fullauto-run          # 직접 호출도 가능
/speckit-fullauto-run --verbose --vibe-enhance    # 추가 플래그는 그대로 fullauto run에 전달
```

커맨드가 하는 일:

1. `.specify/scripts/bash/check-prerequisites.sh --json --require-tasks`로
   `FEATURE_DIR`를 찾습니다 (`tasks.md`가 없으면 중단하고 `/speckit-tasks`를
   먼저 돌리라고 안내).
2. `.fullauto/config.json`이 없으면 `fullauto init`을 실행하고(기본 preset은
   `convex`), 생성된 게이트(typecheck / test / lint / e2e + preset 게이트)를
   프로젝트 스택에 맞춰 검토하라고 한 줄 안내합니다.
3. `fullauto run "$FEATURE_DIR/tasks.md" --verify adaptive`를 실행합니다.
   task마다 fresh `claude -p` 서브에이전트 → 게이트 → 결정적 audit(orphan
   코드 / wiring 주장 / 테스트 무결성 / 게이트 설정 변조 / test-count / TDD
   red-green / verify-evidence) → 분류별 `/verify-loop` 깊이 조정. defer된
   attempt의 변경은 롤백되고 `.patch`로 보관됩니다.
4. `.fullauto/state.json`을 읽어 done / deferred / failed 요약, 미해결 task의
   `deferReason` + `deferDetail`, 로그 경로(`.fullauto/logs/<id>-attempt<N>.log`),
   사람이 봐야 하는 audit WARN / `FULLAUTO_TEST_CHANGE` 알림을 정리해 보고합니다.
   `failed`로 끝난 task는 원인을 고친 뒤 `fullauto retry <ids>`로 재시도합니다.

`tasks.md`의 `[X]` 체크박스는 건드리지 않습니다 — 완료 여부는
`.fullauto/state.json`이 진실 소스이고 게이트 + audit이 결정합니다.
`fullauto evolve`(컨셉 → 제품 라운드 루프)는 spec-kit 흐름 밖의 별도
명령이라 이 확장이 감싸지 않습니다.

## 파일

```
extensions/fullauto/
├── extension.yml        # 매니페스트 (schema_version 1.0, speckit.fullauto.run + after_tasks 훅)
├── commands/run.md      # 커맨드 본문 (→ .claude/skills/speckit-fullauto-run/SKILL.md로 설치됨)
└── README.md
```

동작 방식이나 마커(`- tdd: red`, `- tests: T###`, `- wired by: T###` 등)의
상세는 저장소 루트 README의 "왜 `/speckit-implement` 대신 fullauto인가",
"검증 파이프라인", "tasks.md 레퍼런스", "CLI 레퍼런스" 절을 참고하세요.
