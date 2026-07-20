# VibeMon Pet 개발 문서

## 1. 문서 목적

이 문서는 VibeMon에 AI 사용 활동 기반의 성장형 몬스터 시스템을 추가하기 위한 제품 및 기술 설계를 정의한다.

대상 AI 도구는 다음과 같다.

- Claude Code
- Codex
- Kiro
- OpenClaw
- 향후 연동되는 기타 AI 개발 도구

사용자는 **계정 또는 발급된 Key당 하나의 몬스터**를 보유한다.  
몬스터는 사용자의 AI 개발 활동을 기반으로 경험치를 획득하고, 작업 패턴에 따라 서로 다른 계열로 성장하거나 진화한다.

---

## 2. 제품 정의

### 2.1 한 문장 설명

> AI 개발 활동을 기록하고, 사용자의 작업 방식에 따라 성장하고 진화하는 VibeMon 몬스터.

### 2.2 핵심 가치

VibeMon Pet은 단순한 활동량 측정 도구가 아니다.

다음 정보를 하나의 살아 있는 캐릭터로 표현한다.

- AI 도구를 얼마나 꾸준히 사용하는가
- 어떤 종류의 작업을 주로 수행하는가
- 어떤 모델과 도구를 조합해 사용하는가
- 작업을 얼마나 안정적으로 완료하는가
- 테스트, 문서화, 인프라, UI 등 어떤 개발 습관을 가지고 있는가

### 2.3 핵심 차별점

- 계정 또는 Key당 하나의 몬스터
- Claude Code, Codex, Kiro, OpenClaw 등 멀티 도구 지원
- 단순 토큰 사용량이 아니라 실제 개발 활동을 기반으로 성장
- 파일명, 경로, 확장자, 명령어를 활용한 로컬 분류
- 원본 코드나 전체 경로를 서버에 전송하지 않는 프라이버시 우선 설계
- 작업 패턴에 따른 진화 계열
- 꾸준함, 멀티 모델 사용, 완료율 등 별도 특성 부여

---

## 3. 목표와 비목표

## 3.1 목표

- 사용자가 VibeMon을 지속적으로 실행할 동기를 제공한다.
- AI 개발 활동을 시각적 성장으로 변환한다.
- 사용자의 개발 습관을 재미있고 이해하기 쉬운 방식으로 보여준다.
- 여러 AI 도구의 활동을 하나의 계정 단위로 통합한다.
- 로컬 우선 분석으로 기업 환경에서도 사용할 수 있도록 한다.
- 몬스터 외형과 진화 결과가 공유 가능한 콘텐츠가 되도록 한다.

## 3.2 비목표

초기 버전에서는 다음 기능을 구현하지 않는다.

- 몬스터 전투
- 실시간 PvP
- 가챠
- 사용자 간 아이템 거래
- 몬스터 사망
- 사용하지 않을 때 발생하는 강한 패널티
- 코드 내용 자체를 분석하는 서버 측 AI 분류
- 프로젝트별 복수 몬스터
- 복잡한 경제 시스템
- 생성형 AI 기반 자유 대화

---

## 4. 사용자 모델

## 4.1 몬스터 소유 단위

몬스터는 다음 중 하나의 식별자에 귀속된다.

### 계정 기반

```text
account_id -> monster_id
```

적합한 경우:

- 로그인 기능이 있는 VibeMon 사용자
- 여러 기기에서 동일한 몬스터를 사용
- SaaS 형태의 동기화가 필요한 경우

### Key 기반

```text
license_key 또는 api_key -> monster_id
```

적합한 경우:

- 로그인 없이 사용할 수 있는 데스크톱 앱
- 조직이나 팀에서 Key를 배포하는 경우
- 초기 MVP에서 인증 복잡도를 줄이려는 경우

Key는 VibeMon이 직접 발급하고 관리하는 키를 말한다. Anthropic, OpenAI 등 AI 도구의 API Key는 소유자 식별과 인증에 사용하지 않는다.

### 권장 구조

내부적으로는 소유자를 추상화한다.

```typescript
type OwnerType = "account" | "key";

interface MonsterOwner {
  ownerType: OwnerType;
  ownerId: string;
}
```

이 구조를 사용하면 초기에는 Key 기반으로 시작하고, 이후 계정 시스템으로 이전할 수 있다.

---

## 5. 핵심 사용자 흐름

### 5.1 최초 생성

1. 사용자가 VibeMon에 로그인하거나 Key를 등록한다.
2. 서버 또는 로컬 저장소에서 기존 몬스터를 조회한다.
3. 몬스터가 없으면 알 또는 기본 생명체를 생성한다.
4. 사용자가 몬스터 이름을 지정한다.
5. 초기 성장 상태를 화면에 표시한다.

### 5.2 일반 사용

1. 사용자가 Claude Code, Codex, Kiro 또는 OpenClaw를 실행한다.
2. VibeMon이 도구 상태와 활동 이벤트를 감지한다.
3. 로컬 분류기가 활동을 카테고리별 점수로 변환한다.
4. 안전한 집계 이벤트만 서버로 전송한다.
5. 세션 종료 또는 일정 주기마다 XP와 진화 점수를 반영한다.
6. 몬스터의 상태, 애니메이션, 레벨 또는 특성이 갱신된다.

### 5.3 진화

1. 일정 레벨 또는 누적 활동 조건을 만족한다.
2. 최근 30일 또는 전체 누적 점수에서 우세 계열을 계산한다.
3. 진화 후보를 결정한다.
4. 사용자에게 진화 미리보기를 보여준다.
5. 진화가 확정되면 외형, 애니메이션, 칭호를 갱신한다.

---

## 6. 몬스터 성장 구조

몬스터의 성장은 세 개의 독립 축으로 구성한다.

## 6.1 레벨

사용량과 활동 완료를 기반으로 상승한다.

예시:

```text
Level 1–5   : 알 / 유아기
Level 6–15  : 성장기
Level 16–30 : 1차 진화
Level 31–50 : 성숙기
Level 51+   : 2차 진화 또는 희귀 형태
```

## 6.2 주 계열

사용자가 어떤 종류의 작업을 많이 하는지 나타낸다.

- 품질 수호자
- 인프라 골렘
- 픽셀 디자이너
- 지식 마법사
- 향후 추가 가능
  - 데이터 연금술사
  - 백엔드 대장장이
  - 보안 감시자
  - 자동화 정령

## 6.3 성격 및 특성

어떻게 AI를 사용하는지 나타낸다.

### 성격

- 탐험가: 여러 도구와 모델을 폭넓게 사용
- 집중형: 하나의 모델 또는 도구를 깊게 사용
- 계획형: planning 상태 비중이 높음
- 자동화형: 명령어와 도구 실행 비중이 높음
- 완성형: done 비율과 완료 세션 비율이 높음
- 회복형: 오류 후 성공적으로 복구하는 비율이 높음

### 성장 특성

- 신생
- 숙련
- 장수
- 전설

최종 표현 예시:

```text
장수형 멀티코어 인프라 골렘
계획형 품질 수호자
탐험가 픽셀 디자이너
```

---

## 7. 활동 분류 전략

## 7.1 기본 원칙

작업 분류는 서버의 생성형 AI보다 로컬 규칙 엔진을 우선한다.

신뢰도 우선순위는 다음과 같다.

```text
실행 명령어
> 파일 경로 및 파일명
> 파일 확장자
> 언어
> AI 상태 및 세션 패턴
```

언어만으로 작업 유형을 결정하지 않는다.

예시:

```text
src/api/user.py      -> 백엔드 가능성
tests/test_user.py   -> 품질
scripts/deploy.py    -> 인프라
docs/example.py      -> 문서
```

## 7.2 도구별 신호 밀도

도구마다 수집할 수 있는 신호의 깊이가 다르다.

```text
Claude Code : 훅 이벤트, 도구 이름, 파일 경로, 명령어 (전체 신호)
Codex       : 명령어 신호 중심 (파일 경로 신호 없음)
Kiro        : 상태 신호 위주
OpenClaw    : 상태 신호 위주
```

분류 품질 목표는 도구별 신호 밀도에 맞춘다. 파일 경로 기반 분류는 Claude Code를 기준으로 설계하고, 다른 도구는 명령어와 상태 신호 범위 안에서 분류한다.

---

## 8. 분류 카테고리

초기 MVP에서는 다음 네 개의 주 카테고리만 구현한다.

```typescript
type ActivityCategory =
  | "quality"
  | "infra"
  | "frontend"
  | "documentation";
```

멀티 모델 사용과 장기 사용은 작업 카테고리가 아니라 별도 특성 점수로 계산한다.

어떤 규칙에도 매칭되지 않는 활동은 `general`로 분류한다. `general` 점수는 XP 계산에만 반영하고, 계열 점수와 서버 집계(`ActivitySummary.scores`)에는 포함하지 않는다.

---

## 9. 신호별 분류 규칙

## 9.1 품질 수호자

### 파일 및 경로

```text
tests/
test/
__tests__/
spec/
*_test.go
*.test.ts
*.test.tsx
*.spec.ts
*.spec.tsx
pytest.ini
jest.config.*
vitest.config.*
playwright.config.*
cypress.config.*
```

### 명령어

```text
pytest
python -m pytest
jest
vitest
go test
cargo test
npm test
pnpm test
yarn test
playwright test
cypress run
eslint
ruff
mypy
tsc --noEmit
coverage
```

### 예시 점수

```text
테스트 명령 실행          +5
테스트 파일 수정          +3
린트 실행                 +2
타입체크 실행             +2
커버리지 실행             +2
실패 테스트 후 성공       +4
```

---

## 9.2 인프라 골렘

### 파일 및 경로

```text
*.tf
*.tfvars
Dockerfile
docker-compose.yml
compose.yml
k8s/
kubernetes/
helm/
charts/
ansible/
.github/workflows/
.gitlab-ci.yml
Pulumi.*
serverless.yml
```

### 명령어

```text
terraform plan
terraform apply
terraform destroy
kubectl
helm
pulumi
docker
docker compose
ansible
aws
gcloud
az
argocd
flux
```

### 예시 점수

```text
terraform plan           +4
terraform apply          +6
*.tf 수정                +3
kubectl 실행             +4
helm 실행                +4
Dockerfile 수정          +2
CI/CD 파일 수정          +2
```

---

## 9.3 픽셀 디자이너

### 파일 및 경로

```text
*.tsx
*.jsx
*.vue
*.svelte
*.css
*.scss
*.sass
*.less
components/
pages/
app/
public/
assets/
styles/
storybook/
```

### 명령어

```text
vite
next dev
nuxt dev
storybook
npm run dev
pnpm dev
yarn dev
playwright
cypress
```

### 예시 점수

```text
CSS 또는 스타일 파일 수정   +4
UI 컴포넌트 파일 수정        +2
assets 파일 변경             +3
Storybook 실행               +4
프런트 개발 서버 실행         +1
브라우저 테스트 실행          +2
```

프런트엔드 계열은 TypeScript 파일만으로 판정하지 않는다.  
경로, CSS, UI 컴포넌트, 프런트 개발 서버 실행 신호를 함께 사용한다.

---

## 9.4 지식 마법사

### 파일 및 경로

```text
README*
docs/
*.md
*.mdx
ADR/
RFC/
design/
architecture/
CHANGELOG*
CONTRIBUTING*
```

### 명령어

```text
mkdocs
sphinx-build
typedoc
docusaurus
vitepress
docsify
```

### 예시 점수

```text
README 수정              +2
docs/ 수정               +3
ADR 또는 RFC 작성        +5
Markdown 500자 이상 변경 +2
planning 상태 10분 이상  +2
문서 빌드 실행           +3
```

---

## 10. 별도 특성 계산

## 10.1 멀티코어 키메라

여러 AI 모델 또는 AI 도구를 조합해서 사용하는 패턴이다.

### 조건 예시

```text
하루 모델 2종 이상 사용        +3
하루 AI 도구 3종 이상 사용     +5
동시 세션 2개 이상             +4
주간 모델 4종 이상             +6
서로 다른 도구 간 연속 작업     +2
```

### 권장 판정

최근 30일 동안 멀티 도구 점수가 일정 기준을 넘으면 특성을 부여한다.

```text
multi_tool_score >= 50
```

## 10.2 장수형 생명체

시간과 지속성을 기반으로 한다.

```text
7일 연속 활동           +5
30일 중 15일 활동       +10
90일 이상 유지          +20
180일 이상 유지         +30
365일 이상 유지         +50
휴식 후 복귀            +5
```

장수형은 주 계열을 대체하지 않는다.

예시:

```text
고대 인프라 골렘
장수형 지식 마법사
전설의 품질 수호자
```

---

## 11. 이벤트 모델

## 11.1 로컬 원시 이벤트

로컬에서는 다음과 같은 이벤트를 수집할 수 있다.

```typescript
interface RawActivityEvent {
  eventId: string;
  ownerId: string;
  tool: "claude-code" | "codex" | "kiro" | "openclaw" | string;
  model?: string;
  projectId?: string;
  eventType:
    | "session_start"
    | "session_end"
    | "status_change"
    | "file_read"
    | "file_write"
    | "command_run"
    | "tool_call"
    | "task_done"
    | "task_error";
  filePath?: string;
  command?: string;
  status?: string;
  timestamp: string;
}
```

원시 이벤트는 기본적으로 로컬에서만 처리한다.

## 11.2 정규화 이벤트

로컬 분류기가 원시 이벤트를 다음 형태로 변환한다.

```typescript
interface ClassifiedActivityEvent {
  eventId: string;
  ownerId: string;
  category:
    | "quality"
    | "infra"
    | "frontend"
    | "documentation"
    | "general";
  signal:
    | "test_command"
    | "infra_file"
    | "frontend_style"
    | "documentation_file"
    | "model_switch"
    | "session_completed"
    | string;
  weight: number;
  tool: string;
  model?: string;
  timestamp: string;
}
```

## 11.3 서버 전송 집계 이벤트

서버에는 세부 파일명이나 전체 명령어를 보내지 않는다.

```typescript
interface ActivitySummary {
  summaryId: string;
  ownerId: string;
  deviceId: string;
  periodStart: string;
  periodEnd: string;
  scores: {
    quality: number;
    infra: number;
    frontend: number;
    documentation: number;
  };
  usage: {
    sessionCount: number;
    completedSessionCount: number;
    errorCount: number;
    activeMinutes: number;
    distinctTools: number;
    distinctModels: number;
  };
  xp: number;
}
```

`summaryId`는 `ownerId`, `deviceId`, `periodStart`에서 유도되는 멱등성 키다. `deviceId`는 설치 시 생성하는 무작위 ID로, 하드웨어 정보를 담지 않는다.

---

## 12. 개인정보 및 보안 원칙

### 12.1 서버로 보내지 않는 정보

- 소스코드 내용
- 프롬프트 원문
- AI 응답 원문
- 절대경로
- 전체 명령어 원문
- 환경 변수
- 토큰
- Secret
- 고객명 또는 프로젝트명
- Git 원격 저장소 URL

### 12.2 경로 처리

입력:

```text
/Users/alice/work/secret-client/infra/main.tf
```

로컬 분류 결과:

```text
category = infra
signal = terraform_file
weight = 3
```

서버에는 분류 결과만 전달한다.

### 12.3 명령어 처리

입력:

```bash
AWS_PROFILE=production terraform apply -var-file=customer-a.tfvars
```

서버 전송:

```json
{
  "category": "infra",
  "signal": "terraform_apply",
  "weight": 6
}
```

민감한 인자와 환경 변수는 저장하지 않는다.

### 12.4 사용자 제어

설정 화면에서 다음 옵션을 제공한다.

- 활동 분석 활성화/비활성화
- 서버 동기화 활성화/비활성화
- 분류 이벤트 로그 확인
- 특정 프로젝트 제외
- 특정 경로 제외
- 특정 명령어 제외
- 모든 성장 데이터 초기화
- 몬스터 데이터 내보내기

---

## 13. XP 설계

## 13.1 기본 원칙

XP는 AI를 많이 소비하는 것보다 의미 있는 활동과 완료를 보상해야 한다.

피해야 할 방식:

```text
토큰 1,000개 사용 = XP 10
코드 100줄 생성 = XP 20
```

이 방식은 불필요한 토큰 소비와 코드 생성을 유도할 수 있다.

권장 방식:

```text
세션 시작                  +1
유효 활동 10분             +2
작업 완료                  +5
테스트 성공                +3
오류 후 성공적 복구        +2
일일 첫 활동               +2
서로 다른 AI 도구 사용     +1
```

유효 활동 시간은 상태 이벤트의 간격으로 계산한다. 활성 상태(thinking, planning, working, packing) 이벤트 사이 간격이 5분 이내면 활동 시간으로 합산하고, 그보다 길면 중단으로 간주한다.

## 13.2 일일 제한

무한 반복을 방지하기 위해 신호별 XP 상한을 둔다.

```text
세션 시작 XP        일일 최대 5
명령 실행 XP        일일 최대 20
완료 XP             일일 최대 30
테스트 성공 XP      일일 최대 20
문서 작성 XP        일일 최대 15
```

하루 경계는 사용자 로컬 자정 기준이다. 서버는 업로드된 `periodStart`와 `periodEnd`의 UTC 타임스탬프로 기간 중복과 시간 조작을 검증한다.

## 13.3 레벨 공식

초기 예시:

```typescript
function xpRequiredForLevel(level: number): number {
  return Math.floor(100 * Math.pow(level, 1.35));
}
```

또는 누적 XP 기준 테이블을 사용할 수 있다.

```text
Level 1   0 XP
Level 2   100 XP
Level 3   250 XP
Level 5   800 XP
Level 10  3,500 XP
Level 20  12,000 XP
Level 30  30,000 XP
Level 50  100,000 XP
```

---

## 14. 진화 판정

## 14.1 평가 기간

진화 계열은 하루의 작업에 따라 즉시 바뀌지 않아야 한다.

권장 기준:

- 최근 30일 점수
- 전체 누적 점수
- 최소 활동일
- 최소 레벨
- 계열 점수 간 차이

## 14.2 가중치

```text
최종 계열 점수
= 최근 30일 점수 × 0.7
+ 전체 누적 점수 × 0.3
```

최근 작업 패턴을 반영하되, 오랜 활동 이력도 유지한다.

## 14.3 우세 계열 판정

```typescript
interface EvolutionScore {
  quality: number;
  infra: number;
  frontend: number;
  documentation: number;
}
```

조건 예시:

```text
최고 점수 비율 >= 전체의 40%
최고 점수와 2위 점수 차이 >= 전체 점수 합의 10%
최소 활동일 >= 7일
최소 레벨 >= 10
```

조건을 만족하지 않으면 범용 성장형을 유지한다.

## 14.4 혼합 진화

상위 두 계열 점수가 비슷한 경우 혼합형을 제공할 수 있다.

예시:

```text
품질 + 인프라       -> 배포 감시자
프런트엔드 + 문서   -> 인터페이스 기록자
인프라 + 문서       -> 아키텍처 골렘
품질 + 프런트엔드   -> UI 검증 수호자
```

혼합 진화는 MVP 이후로 미룬다.

---

## 15. 몬스터 상태 애니메이션

기존 VibeMon 상태를 몬스터 행동으로 직접 연결한다.

| VibeMon 상태 | 몬스터 행동 |
|---|---|
| start | 깨어나며 인사 |
| idle | 기다리거나 주변을 살핌 |
| thinking | 고민하거나 머리 위에 표시 |
| planning | 지도 또는 설계도를 펼침 |
| working | 타이핑하거나 도구를 사용 |
| packing | 기억과 문서를 상자에 정리 |
| notification | 사용자를 부름 |
| done | 성공 포즈 또는 보상 획득 |
| sleep | 잠듦 |
| alert | 놀라거나 경고 표시 |

애니메이션은 상태별 하나의 자연스러운 루프를 가진다.

MVP에서는 상태별 표현을 기존 엔진의 eyeType과 effect 조합으로 구현한다. 타이핑, 지도 펼치기 같은 행동 루프는 멀티프레임 스프라이트 재생 능력이 필요하므로 별도 개발 단계(Phase 5)로 분리한다.

## 15.1 기존 캐릭터 축과의 관계

현재 `character` 필드는 어느 AI 도구가 상태를 보고했는지 나타내고, `characterLock`이 이를 고정할 수 있다. 몬스터 외형(`species` + `evolutionStage`)은 이와 별개의 축이다.

- 펫 모드가 활성화되면 창의 외형은 몬스터가 결정한다.
- 도구별 캐릭터와 `characterLock`은 펫 모드 비활성 상태에서만 적용된다.
- 어떤 AI 도구가 활동 중인지는 말풍선의 도구 표시로 구분한다.

---

## 16. 데이터 모델

## 16.1 Monster

```typescript
interface Monster {
  id: string;
  ownerType: "account" | "key";
  ownerId: string;

  name: string;
  species: string;
  evolutionStage: number;
  primaryClass:
    | "neutral"
    | "quality_guardian"
    | "infra_golem"
    | "pixel_designer"
    | "knowledge_mage";

  personalityTraits: string[];
  longevityTier: "new" | "skilled" | "long_lived" | "legendary";

  level: number;
  currentXp: number;
  totalXp: number;

  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
}
```

## 16.2 MonsterStats

```typescript
interface MonsterStats {
  monsterId: string;

  categoryScores: {
    quality: number;
    infra: number;
    frontend: number;
    documentation: number;
  };

  toolUsage: Record<string, number>;
  modelUsage: Record<string, number>;

  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  completedSessions: number;
  errorSessions: number;

  firstActivityAt?: string;
  lastActivityAt?: string;
}
```

## 16.3 DailyActivity

```typescript
interface DailyActivity {
  monsterId: string;
  date: string;

  xpEarned: number;
  activeMinutes: number;
  sessionCount: number;
  completedSessionCount: number;

  scores: {
    quality: number;
    infra: number;
    frontend: number;
    documentation: number;
  };

  tools: string[];
  models: string[];
}
```

## 16.4 로컬 저장

- `Monster`와 `MonsterStats`는 기존 설정 저장소(electron-store)에 저장한다.
- `DailyActivity`와 분류 이벤트 로그는 추가 전용 JSONL 파일에 일 단위로 기록하고, 최소 90일 보존 후 정리한다.
- 원시 이벤트(`RawActivityEvent`)는 분류 직후 폐기하고 디스크에 저장하지 않는다.

---

## 17. API 초안

## 17.1 몬스터 조회

```http
GET /v1/monster
Authorization: Bearer <account-token-or-key>
```

응답:

```json
{
  "id": "mon_123",
  "name": "Momo",
  "level": 12,
  "currentXp": 320,
  "nextLevelXp": 500,
  "primaryClass": "infra_golem",
  "personalityTraits": ["multi_core", "planner"],
  "longevityTier": "skilled"
}
```

## 17.2 활동 집계 업로드

```http
POST /v1/activity/summaries
Authorization: Bearer <account-token-or-key>
Content-Type: application/json
```

```json
{
  "summaryId": "sum_9f3a",
  "deviceId": "dev_7b21",
  "periodStart": "2026-07-20T00:00:00Z",
  "periodEnd": "2026-07-20T01:00:00Z",
  "scores": {
    "quality": 8,
    "infra": 24,
    "frontend": 2,
    "documentation": 5
  },
  "usage": {
    "sessionCount": 3,
    "completedSessionCount": 2,
    "errorCount": 1,
    "activeMinutes": 42,
    "distinctTools": 2,
    "distinctModels": 2
  },
  "xp": 31
}
```

## 17.3 성장 기록 조회

```http
GET /v1/monster/history?range=30d
```

## 17.4 몬스터 이름 변경

```http
PATCH /v1/monster
```

```json
{
  "name": "Terraform"
}
```

## 17.5 서버 신뢰 모델

서버는 클라이언트가 보고한 값을 그대로 신뢰하지 않는다.

- XP는 클라이언트 보고값을 참고만 하고, 업로드된 `scores`와 `usage`에서 서버가 재계산한 뒤 일일 상한을 적용한다.
- `summaryId`로 동일 집계의 재전송을 멱등 처리한다.
- 여러 기기의 집계는 기기별로 수신해 소유자 단위로 합산하되, 일일 XP 상한은 소유자 단위로 적용한다.

---

## 18. 로컬 분류 엔진

## 18.1 규칙 형식

규칙을 코드에 직접 하드코딩하기보다 JSON 또는 YAML로 분리한다.

```yaml
rules:
  - id: terraform-file
    category: infra
    signal: terraform_file
    weight: 3
    match:
      extensions:
        - .tf
        - .tfvars

  - id: pytest-command
    category: quality
    signal: test_command
    weight: 5
    match:
      commandPrefixes:
        - pytest
        - python -m pytest

  - id: documentation-path
    category: documentation
    signal: documentation_file
    weight: 3
    match:
      pathPrefixes:
        - docs/
        - ADR/
        - RFC/
```

## 18.2 매칭 순서

1. 제외 규칙 검사
2. 민감 정보 제거
3. 정확한 명령어 규칙
4. 파일명 규칙
5. 경로 규칙
6. 확장자 규칙
7. 일반 언어 규칙
8. 기본 general 처리

## 18.3 중복 점수 처리

하나의 이벤트가 여러 규칙에 매칭될 수 있다.

권장 정책:

- 동일 카테고리에서는 가장 높은 점수 1개만 적용
- 서로 다른 카테고리에는 각각 적용 가능
- 이벤트당 최대 총점 제한

예시:

```text
src/components/Button.test.tsx
```

매칭:

- frontend +2
- quality +3

최종:

```text
frontend +2
quality +3
```

---

## 19. 부정 사용 방지

### 19.1 예상 악용

- 동일 명령어 반복 실행
- 빈 파일 반복 수정
- 테스트 명령 무한 반복
- 여러 가짜 세션 생성
- 시스템 시간을 변경해 스트릭 조작
- 동일 이벤트 재전송

### 19.2 방지 방식

- eventId 기반 중복 제거 (로컬)
- summaryId 기반 집계 중복 제거 (서버)
- 신호별 일일 XP 상한
- 동일 명령 반복 쿨다운
- 최소 활동 시간
- 파일 변경량 최소 기준
- 서버 수신 시각으로 스트릭 교차 검증
- 이상 활동 탐지
- 클라이언트 버전과 서명 검증
- 오프라인 이벤트 재생 시 순서와 타임스탬프 검사

---

## 20. 화면 구성

## 20.1 메인 화면

표시 요소:

- 몬스터
- 현재 상태 애니메이션
- 이름
- 레벨
- XP 진행률
- 현재 사용 중인 AI 도구
- 현재 모델
- 현재 상태
- 오늘 획득한 XP

## 20.2 성장 화면

- 최근 30일 활동 그래프
- 계열별 점수
- 현재 진화 방향
- 다음 진화 조건
- 성격 및 특성
- 사용 도구와 모델 분포

## 20.3 활동 화면

- 오늘의 세션 수
- 완료한 작업 수
- 테스트 실행
- 인프라 작업
- UI 작업
- 문서 작업
- 분류된 이벤트 로그

## 20.4 설정 화면

- 계정 또는 Key 관리
- 활동 분석 설정
- 서버 동기화 설정
- 프로젝트 제외
- 경로 제외
- 명령어 제외
- 개인정보 설정
- 데이터 내보내기 및 삭제

---

## 21. MVP 범위

## 21.1 필수 기능

- 계정 또는 Key당 몬스터 1개
- 몬스터 이름 지정
- 레벨 및 XP
- 기존 10개 상태 연동 (eyeType과 effect 조합 표현)
- 네 개 작업 카테고리 분류
- 명령어, 파일명, 경로, 확장자 기반 로컬 규칙 엔진
- 최근 30일 점수 저장
- 1차 진화 4종
- 멀티 모델 특성
- 장수 특성
- 로컬 집계 후 서버 동기화
- 분류 로그 확인
- 제외 설정

## 21.2 MVP 제외

- 혼합 진화
- 몬스터 교배
- 펫 전투
- 친구 기능
- 리더보드
- 아이템 거래
- 생성형 대화
- UGC
- 팀 단위 몬스터
- 프로젝트별 몬스터
- 유료 경제 시스템
- 상태별 행동 루프 애니메이션

---

## 22. 시스템 구성과 레포 분담

VibeMon Pet은 네 개 저장소에 걸쳐 구현된다.

| 저장소 | 책임 |
|---|---|
| vibemon-docs | AI 도구 훅. 원시 이벤트 방출 — 훅 이벤트 이름, 도구 이름, 파일 경로, 명령어를 추출해 전송 |
| vibemon-app | 이벤트 수신, 로컬 분류 엔진, XP·집계 계산, 로컬 저장, 몬스터 UI |
| vibemon-static | 진화 폼 이미지, 상태·캐릭터 레지스트리, 분류 규칙 배포 채널 |
| 서버 (신규) | 소유자·몬스터 저장, 집계 수신과 검증, 기기 간 동기화 |

## 22.1 훅 페이로드 확장

vibemon-docs 훅은 기존 상태 페이로드에 다음 필드를 추가한다.

```text
hookEvent : 훅 이벤트 이름 (SessionStart, PreToolUse, PostToolUse, Stop, SessionEnd 등)
toolName  : 실행된 도구 이름 (Bash, Read, Write, Edit 등)
filePath  : 도구가 다룬 파일 경로 (로컬 분류 전용)
command   : 실행 명령어 (민감 인자와 환경 변수 제거 후, 로컬 분류 전용)
```

vibemon-app은 수신 필드 화이트리스트와 검증기에 동일한 필드를 추가한다. 이 필드들은 로컬 분류에만 사용하고 서버로 전송하지 않는다.

## 22.2 분류 규칙 배포

분류 규칙(JSON)은 vibemon-static의 레지스트리 갱신 채널로 배포한다. 앱은 시작 시 검증된 원격 규칙을 우선 사용하고, 실패하면 번들 규칙으로 동작한다.

---

## 23. 개발 단계

## Phase 1. 로컬 프로토타입

목표:

- 활동 이벤트 수집 (vibemon-docs 훅 확장 + 앱 수신 필드 확장)
- 규칙 기반 분류
- 로컬 XP 계산
- 몬스터 상태 연동

완료 조건:

- Claude Code 활동 분류 (파일 경로와 명령어 신호)
- Codex 활동 분류 (명령어 신호 한정)
- 테스트, 인프라, 프런트엔드, 문서 작업 구분
- 이벤트 로그에서 분류 근거 확인 가능
- 네 개 카테고리 점수 누적

## Phase 2. 계정 및 동기화

목표:

- 계정 또는 Key 단위 몬스터 저장
- 여러 기기 간 동기화
- 중복 이벤트 방지

완료 조건:

- 동일 Key로 여러 기기에서 같은 몬스터 조회
- 활동 집계 업로드
- 레벨과 XP 동기화
- 오프라인 이벤트 재전송

## Phase 3. 진화 시스템

목표:

- 레벨 조건
- 계열 판정
- 1차 진화
- 특성 부여

완료 조건:

- 최근 30일과 전체 누적 점수 반영
- 진화 미리보기
- 진화 애니메이션
- 멀티코어 및 장수 특성 표시

## Phase 4. 공유 및 리텐션

목표:

- 공유 가능한 성장 카드
- 주간 리포트
- 복귀 경험

완료 조건:

- 몬스터 프로필 이미지 생성
- 주간 활동 요약
- 휴식 후 복귀 메시지
- 부정적 스트릭 패널티 없음

## Phase 5. 행동 애니메이션

목표:

- 엔진의 멀티프레임 스프라이트 재생 지원
- 상태별 행동 루프 애니메이션
- 진화 연출 강화

완료 조건:

- 상태별 행동 루프 애니메이션 1개 이상
- 기존 캐릭터 렌더링 회귀 없음

---

## 24. 초기 성공 지표

### 활성화

- 신규 사용자 중 몬스터 생성률
- 최초 24시간 내 XP 획득률
- 첫 세션 완료율
- 첫 진화 방향 확인률

### 리텐션

- D1, D7, D30 유지율
- 주간 활성일
- VibeMon 실행 시간
- 활동 동기화 성공률
- 몬스터 화면 재방문율

### 참여

- 일평균 세션 수
- 일평균 XP 획득량
- 진화 화면 조회율
- 이름 지정률
- 성장 카드 공유율

### 품질

- 작업 분류 정확도
- 사용자가 수정한 분류 비율
- 이벤트 중복률
- 오프라인 동기화 실패율
- 잘못된 진화 이의 제기율

---

## 25. 분류 정확도 검증

MVP에서는 사용자가 분류 결과를 확인하고 수정할 수 있도록 한다.

예시:

```text
terraform plan
분류 결과: 인프라 +4

[맞음] [다른 분류 선택]
```

수정 데이터는 원본 코드 없이 규칙 개선에 사용할 수 있다.

수집 가능한 피드백:

```typescript
interface ClassificationFeedback {
  ruleId: string;
  predictedCategory: string;
  correctedCategory: string;
  tool: string;
  clientVersion: string;
}
```

---

## 26. 제품 원칙

1. 몬스터는 사용자를 벌주지 않는다.
2. 휴식은 실패가 아니다.
3. 토큰 낭비를 성장으로 보상하지 않는다.
4. 코드나 프롬프트 원문을 수집하지 않는다.
5. 사용자는 왜 해당 계열로 진화했는지 확인할 수 있다.
6. 성장 결과는 설명 가능해야 한다.
7. AI 사용량보다 완료와 좋은 습관을 우선한다.
8. 계열은 천천히 변하고 하루 활동에 흔들리지 않는다.
9. 사용자는 모든 수집과 동기화를 제어할 수 있다.
10. 몬스터는 생산성 도구의 방해 요소가 되어서는 안 된다.

---

## 27. 초기 권장 진화 구조

```text
알
└── 기본 VibeMon
    ├── 품질 수호자
    ├── 인프라 골렘
    ├── 픽셀 디자이너
    └── 지식 마법사
```

특성은 별도로 결합한다.

```text
품질 수호자 + 완성형
인프라 골렘 + 멀티코어
픽셀 디자이너 + 탐험가
지식 마법사 + 장수형
```

---

## 28. 향후 확장

- 데이터 연금술사
- 백엔드 대장장이
- 보안 감시자
- 자동화 정령
- 혼합 진화
- 조직 단위 공동 몬스터
- 팀별 성장 기록
- GitHub PR 및 CI 연동
- 로컬 Git 이벤트 연동
- 커스텀 스킨
- 캐릭터 마켓
- ESP32 및 하드웨어 디스플레이 연동
- 데스크톱 위젯
- 커뮤니티 진화 도감
- 시즌 이벤트

---

## 29. 최종 MVP 정의

> VibeMon 사용자가 계정 또는 Key당 하나의 몬스터를 보유하고, Claude Code, Codex, Kiro, OpenClaw에서 수행한 개발 활동을 로컬에서 안전하게 분류하여 XP와 진화 점수로 변환하는 시스템.

MVP의 성공 기준은 몬스터 종류의 수가 아니다.

다음 세 가지가 성립해야 한다.

1. 사용자가 자신의 작업 패턴이 몬스터에 반영된다고 느낀다.
2. 진화 결과를 납득할 수 있다.
3. 몬스터를 보기 위해 VibeMon을 계속 실행하고 싶어진다.
