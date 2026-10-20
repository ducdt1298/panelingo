// Korean UI catalog. PURE.

import type { Catalog } from "./en.ts";

const errors: Catalog["errors"] = {
  "api.unreachable": {
    title: "AI 엔드포인트에 연결할 수 없습니다",
    hint: "옵션의 기본 URL이 올바른지, 서버(또는 로컬 모델)가 실행 중인지 확인하세요.",
  },
  "api.lna_blocked": {
    title: "Chrome이 로컬 AI 서버 연결을 차단했습니다",
    hint: "확장 프로그램의 ‘사이트 설정’ → ‘로컬 네트워크 액세스(Local network access)’ → ‘허용’을 선택하세요.",
  },
  "api.unauthorized": {
    title: "AI 엔드포인트가 API 키를 거부했습니다",
    hint: "옵션에서 유효한 API 키를 입력하세요. 번역은 자동으로 다시 시작됩니다.",
  },
  "api.config": {
    title: "AI 엔드포인트 또는 모델 설정이 잘못되었습니다",
    hint: "옵션에서 기본 URL을 확인하고, 이미지 입력(비전)을 지원하는 모델을 선택하세요.",
  },
  "api.rate_limit": {
    title: "AI 제공업체가 요청 속도를 제한하고 있습니다",
    hint: "확장 프로그램이 속도를 낮춰 자동으로 다시 시도합니다.",
  },
  "api.upstream": { title: "AI 서버 오류로 다시 시도 중", hint: "" },
  "api.context_length": { title: "요청이 너무 길어 나누는 중", hint: "" },
  "api.timeout": {
    title: "AI가 응답하는 데 너무 오래 걸렸습니다",
    hint: "확장 프로그램이 한 번 더 시도합니다.",
  },
  "api.truncated": { title: "응답이 중간에 끊겨 이어서 받는 중", hint: "" },
  "api.partial": { title: "AI가 일부 말풍선을 빠뜨려 다시 요청하는 중", hint: "" },
  "api.empty": { title: "AI 응답이 비어 있어 다시 시도 중", hint: "" },
  "api.too_large": { title: "보낼 이미지가 너무 커서 줄이는 중", hint: "" },
  "api.bad_request": { title: "요청이 거부되었습니다(버그)", hint: "옵션에서 디버그 로그를 내보내세요." },
  "api.protocol": { title: "AI 엔드포인트의 응답 형식이 예상과 다릅니다", hint: "" },
  "llm.refused": { title: "AI가 번역을 거부했습니다", hint: "이 말풍선은 원문 그대로 유지됩니다." },
  "llm.missing": { title: "번역되지 않음", hint: "‘다시 번역’을 눌러 이 말풍선만 다시 시도하세요." },
  "llm.format": { title: "AI 응답 형식이 잘못되어 다시 시도 중", hint: "" },
  "image.url_blocked": { title: "안전을 위해 이미지를 차단했습니다", hint: "" },
  "image.http": {
    title: "이미지를 불러올 수 없습니다",
    hint: "사이트에 로그인해야 한다면 팝업에서 ‘이미지 요청 시 쿠키 보내기’를 켜세요.",
  },
  "image.not_image": { title: "이미지 파일이 아닙니다", hint: "" },
  "image.too_large": { title: "이미지가 너무 큽니다", hint: "" },
  "image.decode": { title: "이미지를 디코딩할 수 없습니다", hint: "" },
  "image.capture_unavailable": { title: "번역하려면 이미지까지 스크롤하세요", hint: "" },
  "image.capture_blocked": {
    title: "이 이미지는 화면 캡처로만 읽을 수 있습니다",
    hint: "이 사이트의 번역을 켜고 이 탭을 앞에 둔 채 다시 시도하세요.",
  },
  "detector.webgpu_unavailable": { title: "CPU로 텍스트 감지 중(느림)", hint: "" },
  "detector.canary_mismatch": { title: "GPU 결과가 일치하지 않아 CPU 사용 중", hint: "" },
  "detector.model_integrity": {
    title: "텍스트 감지 모델이 손상되었습니다",
    hint: "확장 프로그램을 다시 설치하세요(개발자: npm run fetch-models 실행 후 npm run build).",
  },
  "detector.init": { title: "텍스트 감지를 시작할 수 없습니다", hint: "옵션에서 디버그 로그를 내보내세요." },
  "detector.run": { title: "텍스트 감지에 실패했습니다", hint: "" },
  "offline.pair_unsupported": {
    title: "이 언어 조합은 오프라인으로 사용할 수 없습니다",
    hint: "옵션에서 오프라인 모델로 NLLB-200을 선택하거나 다른 번역 언어를 선택하세요.",
  },
  "offline.download": {
    title: "오프라인 모델을 다운로드하지 못했습니다",
    hint: "huggingface.co 연결을 확인하세요. 번역은 자동으로 다시 시도됩니다.",
  },
  "offline.model_integrity": {
    title: "다운로드한 오프라인 모델이 손상되었습니다",
    hint: "다시 번역하면 모델을 한 번 더 다운로드합니다.",
  },
  "offline.run": {
    title: "오프라인 모델에서 오류가 발생했습니다",
    hint: "옵션에서 디버그 로그를 내보내세요.",
  },
  "offline.out_of_memory": {
    title: "오프라인 모델에 쓸 메모리가 부족합니다",
    hint: "번역 모델을 다시 시작했으며 엔진은 계속 실행 중입니다. 옵션에서 Opus-MT(훨씬 작은 모델)를 선택하거나 다른 탭을 닫으세요.",
  },
  "engine.unavailable": {
    title: "번역 엔진을 시작할 수 없습니다",
    hint: "페이지를 새로고침하거나 확장 프로그램을 껐다가 다시 켜세요.",
  },
  "engine.closing": { title: "번역 엔진을 다시 시작하는 중", hint: "" },
  "engine.overloaded": { title: "번역 엔진이 바쁩니다", hint: "" },
  "engine.protocol": { title: "확장 프로그램 버전이 일치하지 않습니다", hint: "페이지를 새로고침하세요." },
  "engine.internal": { title: "내부 오류", hint: "옵션에서 디버그 로그를 내보내세요." },
  "msg.too_large": { title: "데이터가 너무 커서 URL로 다시 불러오는 중", hint: "" },
  "ctx.invalidated": {
    title: "확장 프로그램이 방금 다시 로드되었습니다",
    hint: "번역을 계속하려면 페이지를 새로고침하세요.",
  },
  "dnr.failed": { title: "이미지 Referer를 설정할 수 없습니다", hint: "" },
  "store.io": { title: "캐시를 읽거나 쓸 수 없습니다", hint: "" },
  "store.quota": { title: "캐시가 가득 찼습니다", hint: "옵션에서 캐시를 삭제해 공간을 확보하세요." },
  "site.disabled": { title: "이 사이트에서는 번역이 꺼져 있습니다", hint: "" },
  "privacy.consent": {
    title: "AI로 이미지를 보내는 데 아직 동의하지 않았습니다",
    hint: "개인정보 보호 안내를 읽고 전송을 허용하면 번역이 시작됩니다.",
  },
  cancelled: { title: "취소됨", hint: "" },
};

export const KO: Catalog = {
  errors,
  readiness: {
    unknown: { label: "AI 엔드포인트 확인 중…", hint: "" },
    ready: { label: "AI 엔드포인트 준비됨", hint: "" },
    unauthorized: { label: "API 키가 거부됨", hint: errors["api.unauthorized"].hint },
    unreachable: { label: "AI 엔드포인트에 연결할 수 없음", hint: errors["api.unreachable"].hint },
    lna_blocked: { label: "Chrome이 로컬 AI 서버를 차단함", hint: errors["api.lna_blocked"].hint },
    misconfigured: { label: "AI 엔드포인트가 설정되지 않음", hint: errors["api.config"].hint },
  },
  imageState: {
    queued: "대기 중",
    acquiring: "이미지 불러오는 중",
    detecting: "텍스트 찾는 중",
    waiting: "번역 대기 중",
    translating: "번역 중",
    done: "번역 완료",
    "no-text": "텍스트 없음",
    partial: "일부만 번역됨",
    refused: "AI가 번역 거부",
    paused: "일시 중지됨",
    error: "오류",
    stale: "오래된 번역",
  },
  unitStatus: {
    pending: "대기 중",
    translating: "번역 중",
    ok: "번역 완료",
    "keep-original": "원문 유지",
    manual: "직접 수정됨",
    untranslated: "번역되지 않음",
    refused: "AI가 번역 거부",
    ignored: "제외됨",
    error: "오류",
    stale: "오래된 번역",
  },
  enginePhase: {
    booting: "번역 엔진 시작 중",
    ready: "번역 엔진 실행 중",
    closing: "번역 엔진 종료 중",
    failed: "번역 엔진 오류",
  },
  detectorBackend: { webgpu: "GPU(WebGPU)", wasm: "CPU(WASM)", none: "아직 선택 안 됨" },
  detectorState: { unloaded: "로드 안 됨", loading: "로드 중", ready: "준비됨", failed: "실패" },
  detectorCanary: {
    pass: "GPU 확인됨",
    fail: "GPU 결과가 일치하지 않아 CPU로 전환함",
    pending: "GPU 확인 중",
    skipped: "",
  },
  offlineState: {
    idle: "모델은 처음 사용할 때 로드됩니다",
    downloading: "모델 다운로드 중",
    loading: "모델 로드 중",
    ready: "준비됨",
    failed: "실패",
  },
  ui: {
    appName: "Panelingo",
    siteEnable: "이 사이트 번역하기",
    siteDisable: "이 사이트 번역 중지",
    modeAuto: "스크롤하면 자동 번역",
    modeManual: "요청할 때만 번역",
    translateVisible: "보이는 이미지 번역",
    translateImage: "번역",
    retranslate: "다시 번역",
    showOriginal: "원본 보기",
    uploadsToday: (count: number, mb: number): string =>
      `오늘 AI로 보낸 합성 이미지: ${count}장(${mb.toFixed(1)} MB)`,
    progress: (done: number, total: number, etaSec?: number): string =>
      etaSec === undefined || !Number.isFinite(etaSec)
        ? `번역 중 ${done}/${total}`
        : `번역 중 ${done}/${total} · 약 ${Math.max(1, Math.round(etaSec))}초 남음`,
    privacyTitle: "AI로 이미지를 보내기 전에",
    privacyBody:
      "번역을 위해 확장 프로그램은 텍스트가 있는 만화 컷의 합성 이미지를 설정한 AI 엔드포인트로 보냅니다(사용 설정한 " +
      "사이트에서만, 또는 직접 요청할 때만). AI 제공업체는 받은 내용을 자체 약관에 따라 저장할 수 있습니다. 본인과 " +
      "읽고 있는 콘텐츠에 문제가 없는지 확인하세요.",
    privacyAccept: "이해했으며 전송을 허용합니다",
    privacyDecline: "보내지 않음",
  },
  bubble: {
    original: "원문",
    translation: "번역문",
    save: "저장",
    revert: "AI 번역으로 되돌리기",
    retranslate: "다시 번역",
    close: "닫기",
    dialog: "번역된 말풍선",
    copy: "복사",
    editLabel: "번역문 편집",
    shortened: "말풍선에 맞도록 글자를 줄였습니다.",
    saved: "저장했습니다.",
    retranslating: "다시 번역하는 중…",
  },
  menu: {
    translateImage: "이 이미지 번역",
    retranslateImage: "이 이미지 다시 번역",
  },
  sidepanel: {
    title: "Panelingo – 대사 목록",
    heading: "대사 목록",
    empty: "이 탭에는 아직 번역된 대사가 없습니다.",
    emptyHint: "사용하도록 설정한 사이트에서 만화 페이지를 여세요. 번역되는 대로 대사가 여기에 표시됩니다.",
    refresh: "새로고침",
    copy: "모두 복사",
    copied: "클립보드에 복사했습니다.",
    page: (n: number): string => `${n}페이지`,
    jump: "보기",
    jumpHint: "이 말풍선으로 페이지 스크롤",
    edit: "편집",
    save: "저장",
    cancel: "취소",
    retranslate: "다시 번역",
    revert: "편집 취소",
    noTranslation: "번역 없음",
    notFound: "이 말풍선은 더 이상 페이지에 없습니다.",
    failed: "실패했습니다. 다시 시도하세요.",
    types: {
      dialogue: "대사",
      thought: "생각",
      narration: "내레이션",
      sign: "간판",
      sfx: "효과음",
      ignore: "무시됨",
    },
    inconsistent: "용어집과 다름",
    tabs: { transcript: "대사 목록", glossary: "용어집" },
    glossary: {
      noSeries: "만화 페이지를 열면 해당 시리즈의 용어집이 표시됩니다.",
      untitled: "제목 없는 시리즈",
      states: {
        manual: "내 항목",
        confirmed: "확인됨",
        learned: "학습됨",
        candidate: "제안",
      },
      hints: {
        manual: "항상 사용됩니다. AI가 바꾸지 않습니다.",
        confirmed: "수락한 제안입니다. 항상 사용됩니다.",
        learned: "AI가 여러 요청에서 사용한 이름과 용어입니다. 모든 요청에 함께 보냅니다.",
        candidate: "AI가 한 번 발견한 항목입니다. 확인하거나 다시 나타날 때까지 보내지 않습니다.",
      },
      empty: "아직 항목이 없습니다. AI가 발견한 이름과 용어가 여기에 표시되며, 직접 추가할 수도 있습니다.",
      original: "원문",
      translation: "번역",
      note: "메모(선택)",
      add: "추가",
      delete: "삭제",
      confirm: "확인",
      seen: (count: number): string => `${count}회 등장`,
      incomplete: "원문과 번역을 입력하세요.",
      profileHeading: "시리즈 설정",
      sourceLang: "원문 언어",
      langAuto: "자동 감지",
      langs: {
        ja: "일본어",
        ko: "한국어",
        zh: "중국어",
        en: "영어",
        es: "스페인어",
        other: "기타",
      },
      koNames: "한국어 이름",
      koRomanized: "로마자 표기 (Minjun)",
      koHanViet: "한월음 (베트남어 번역 전용)",
      keepHonorifics: "일본어 경칭 유지 (-san, -kun)",
      summary: "이야기 요약을 계속 보내기",
      saveProfile: "설정 저장",
      saved: "저장했습니다.",
      export: "내보내기",
      import: "가져오기",
      imported: (count: number): string => `항목 ${count}개를 가져왔습니다.`,
      importFailed: "이 파일은 Panelingo 용어집이 아닙니다.",
      address: {
        heading: "호칭",
        hint: "각 인물이 자신과 상대를 어떻게 부르는지입니다. 읽는 동안 AI가 채우고 그대로 유지하며, 직접 정한 규칙은 바꾸지 않습니다.",
        speaker: "말하는 사람",
        listener: "듣는 사람",
        self: "자신을 부르는 말",
        other: "상대를 부르는 말",
        learned: "AI가 학습함",
        mine: "내 규칙",
        keep: "고정",
        addHeading: "호칭 추가",
        incomplete: "두 이름과 호칭을 하나 이상 입력하세요.",
        full: "목록이 가득 찼습니다. 먼저 규칙을 삭제하세요.",
        empty: "아직 없습니다. AI가 만난 인물 쌍이 여기에 표시됩니다.",
      },
    },
  },
  debug: { heading: "디버그(개발/테스트 빌드 전용)" },
  duration: (ms: number): string => {
    const seconds = Math.round(Math.abs(ms) / 1000);
    if (seconds < 60) return `${seconds}초`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}분`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}시간`;
    return `${Math.round(hours / 24)}일`;
  },
  popup: {
    openTranscript: "대사 목록 열기",
    cookies: "이미지 요청에 쿠키 보내기",
    cookiesHint:
      "로그인한 독자에게만 이미지를 보여 주는 사이트용입니다. 쿠키는 이미지 서버로만 전송되며 AI로는 절대 전송되지 않습니다.",
    apiHeading: "AI 엔드포인트",
    engineHeading: "번역 엔진",
    siteHeading: "이 사이트",
    checking: "확인 중…",
    model: (model: string): string => `모델: ${model}`,
    endpoint: (url: string): string => `엔드포인트: ${url}`,
    cause: (cause: string): string => `세부 정보: ${cause}`,
    engineStopped: "번역 엔진이 대기 중입니다. 번역을 시작하면 실행됩니다.",
    engineUnreadable: "번역 엔진 상태를 읽을 수 없습니다.",
    offlineHeading: "오프라인 모드(실험적)",
    offlineHint: "AI 엔드포인트를 사용하지 않습니다. 텍스트 인식과 번역이 이 기기에서 실행됩니다.",
    offlineDownload: (doneMb: number, totalMb: number): string =>
      `다운로드 중 ${Math.round(doneMb)} / ${Math.round(totalMb)} MB`,
    offlineModels: (models: string): string => `모델: ${models}`,
    detectorLine: (backend: string, state: string, canary: string): string =>
      `텍스트 감지: ${backend}, ${state}${canary === "" ? "" : `(${canary})`}`,
    queueLine: (queued: number, inFlight: number, done: number, failed: number): string =>
      `대기열: 대기 ${queued} · 전송 중 ${inFlight} · 완료 ${done} · 실패 ${failed}`,
    pausedBy: (title: string): string => `일시 중지됨: ${title}`,
    siteUnsupported: "이 페이지는 번역할 수 없습니다(http/https 페이지만 지원).",
    siteOn: "이 사이트에서 번역이 켜져 있습니다.",
    siteOff: "이 사이트에서 번역이 꺼져 있습니다.",
    modeLabel: "모드",
    visibleSent: (count: number): string =>
      count > 0 ? `이미지 ${count}장의 번역을 요청했습니다.` : "화면에 보이는 만화 이미지가 없습니다.",
    visibleUnavailable: "이 페이지에서는 확장 프로그램을 실행할 수 없습니다.",
    retranslatePage: "페이지 다시 번역",
    retranslateQueued: (count: number): string => `말풍선 ${count}개를 다시 번역 대기열에 추가했습니다.`,
    actionFailed: (title: string): string => `작업을 완료하지 못했습니다: ${title}`,
    privacyDetails: "전송되는 내용 보기",
    options: "옵션",
    setupHint: "시작하려면 옵션에서 AI 엔드포인트(기본 URL, API 키, 모델)를 설정하세요.",
    consentHint: "이 사이트에서 번역을 켜기 전에 Panelingo 아이콘을 클릭해 개인정보 보호 안내를 읽어 주세요.",
    build: (id: string): string => `빌드 ${id}`,
  },
  options: {
    exportLog: "디버그 로그 내보내기",
    exportFailed: "디버그 로그를 내보낼 수 없습니다.",
    exportEmpty: "디버그 로그가 비어 있습니다.",
    title: "옵션",
    apiHeading: "AI 엔드포인트(OpenAI 호환)",
    apiIntro:
      "OpenAI Chat Completions API를 지원하고 이미지를 받을 수 있는 서비스라면 무엇이든 사용할 수 있습니다. 예: OpenAI, " +
      "OpenRouter, Azure OpenAI, Google Gemini(OpenAI 호환 모드), 또는 Ollama, LM Studio, vLLM, LiteLLM 같은 로컬 서버.",
    preset: "프리셋",
    presetCustom: "사용자 지정",
    baseUrl: "기본 URL",
    baseUrlHint: "버전 경로까지 포함하세요(예: https://api.openai.com/v1 또는 http://127.0.0.1:11434/v1).",
    baseUrlInvalid: "올바른 http(s) URL이 아닙니다.",
    apiKey: "API 키",
    apiKeyHint: "이 브라우저 프로필에만 저장됩니다. 키가 필요 없는 로컬 서버라면 비워 두세요.",
    model: "모델",
    modelHint:
      "이미지 입력(비전)을 지원하는 모델이어야 합니다(예: gpt-4o-mini, gemini-2.5-flash, qwen2.5-vl).",
    modelInvalid: "모델 ID를 입력하세요.",
    testConnection: "연결 테스트",
    testing: "테스트 중…",
    testOk: (detail: string): string => `연결되었습니다. ${detail}`,
    testFailed: (detail: string): string => `실패: ${detail}`,
    concurrency: "동시 번역 요청 수",
    concurrencyHint: "기본값은 2, 최대 4까지 설정할 수 있습니다. 제공업체에서 속도 제한이 걸리면 낮추세요.",
    concurrencyInvalid: "1에서 4 사이의 숫자를 선택하세요.",
    languageHeading: "언어",
    uiLanguage: "인터페이스 언어",
    targetLanguage: "번역할 언어",
    languageAuto: "브라우저 설정과 동일",
    save: "저장",
    saved: "저장되었습니다.",
    saveFailed: "저장하지 못했습니다.",
    sitesHeading: "사이트",
    sitesEmpty:
      "아직 사이트가 없습니다. 만화 페이지를 열고 확장 프로그램 아이콘을 클릭한 다음 해당 사이트의 번역을 켜세요.",
    siteEnabled: "사용",
    siteMode: "모드",
    siteRemove: "삭제",
    privacyHeading: "개인정보 보호: AI로 보내는 내용",
    privacyPoints: [
      "번역할 때마다 확장 프로그램은 설정한 AI 엔드포인트로 JPEG 합성 이미지 한 장을 보냅니다. 여기에는 텍스트가 있는 " +
        "이미지(또는 웹툰 조각)의 썸네일, 각 텍스트 영역을 둘러싼 번호 상자, 해당 영역을 확대해 잘라낸 이미지가 들어 있습니다.",
      "함께 보내는 텍스트: 형식 및 언어 규칙, 작품 용어집(최대 60개 항목), 같은 화의 이전 대사(최대 20줄), 짧은 요약.",
      "보내지 않는 것: 텍스트가 없는 이미지, 읽고 있는 페이지 주소, 쿠키, IP 주소, 브라우저 헤더(엔드포인트로 보내는 " +
        "모든 요청에 기본적으로 포함되는 정보는 제외).",
      "AI 제공업체는 받은 내용을 자체 약관에 따라 보관할 수 있습니다. 보낸 내용은 모두 저장된다고 생각하세요.",
      "스크롤할 때 자동으로 번역되는 것은 사용 설정한 사이트뿐입니다. 다른 페이지는 직접 요청할 때(마우스 오른쪽 버튼 " +
        "메뉴 또는 단축키)만 번역되며, 처음 보내기 전에는 항상 확인을 요청합니다.",
      "팝업에서 오늘 보낸 합성 이미지 수를 확인할 수 있습니다.",
      "번역, 말풍선 위치, 글자 지우기 패치는 이 기기에 있는 확장 프로그램의 IndexedDB에 저장됩니다. 아래 ‘캐시’에서 " +
        "삭제할 수 있습니다.",
    ],
    privacyAcked: (when: string): string => `${when}에 이미지 전송 안내를 확인했습니다.`,
    privacyNotAcked:
      "아직 이미지 전송 안내를 확인하지 않았습니다. 처음 보내기 전에 확장 프로그램이 확인을 요청합니다.",
    cacheHeading: "캐시",
    cacheHint:
      "이 기기에 저장된 모든 번역, 말풍선 위치, 글자 지우기 패치를 삭제합니다. 다시 읽을 때 번역과 이미지 전송이 " +
      "다시 이루어집니다.",
    cacheClear: "캐시 전체 삭제",
    cacheConfirm: "캐시를 모두 삭제할까요? 다음에 읽을 때 번역과 이미지 전송이 다시 이루어집니다.",
    cacheCleared: (count: number): string => `기록 ${count}건을 삭제했습니다.`,
    cacheFailed: (title: string): string => `캐시를 삭제하지 못했습니다: ${title}`,
    debugHeading: "디버그 로그",
    logLevel: "로그 수준",
    logLevels: { debug: "자세히(debug)", info: "정보", warn: "경고", error: "오류만" },
  },
  optionsAdvanced: {
    heading: "고급 설정",
    intro:
      "요청, 텍스트 감지, 번역문 표시, 캐시를 세밀하게 조정합니다. 대부분의 경우 기본값이 적합합니다. " +
      "변경 사항은 입력란에서 벗어날 때 저장됩니다.",
    defaultIs: (value: string): string => `기본값: ${value}`,
    range: (min: string, max: string): string => `허용 범위: ${min}~${max}`,
    automatic: "자동",
    on: "켜짐",
    off: "꺼짐",
    reset: "초기화",
    resetLabel: (label: string): string => `‘${label}’ 설정을 기본값으로 되돌리기`,
    resetAll: "모든 고급 설정 초기화",
    resetAllConfirm: "모든 고급 설정을 기본값으로 되돌릴까요?",
    resetAllDone: "모든 고급 설정을 기본값으로 되돌렸습니다.",
    notANumber: "숫자를 입력하세요.",
    adjusted: (value: string): string => `허용되는 가장 가까운 값(${value})으로 저장했습니다.`,
    badKey: "Backquote, KeyH 같은 키 코드를 입력하거나 비워 두세요.",
    verticalChoices: { auto: "자동", never: "사용 안 함" },
    groups: {
      api: "AI 요청",
      translate: "요청 내용",
      detector: "텍스트 감지",
      engine: "번역 엔진",
      discovery: "이미지 찾기",
      render: "번역문 표시",
      memory: "시리즈 기억",
      cache: "캐시",
      privacy: "이미지 제한",
      debug: "디버그 로그",
    },
    fields: {
      "api.temperature": {
        label: "온도(Temperature)",
        hint: "응답이 얼마나 다양할지 정합니다. 비워 두면 제공업체의 기본값을 사용합니다.",
      },
      "api.urgentLane": {
        label: "화면에 보이는 이미지용 추가 슬롯",
        hint: "지금 보고 있는 이미지 전용 요청 슬롯을 하나 추가합니다.",
      },
      "api.maxInFlight": {
        label: "최대 동시 요청 수",
        hint: "추가 슬롯을 포함한 절대 상한입니다. 동시 번역 요청 수보다 낮아지지 않습니다.",
      },
      "api.firstByteTimeoutMs": {
        label: "첫 응답 대기 시간(초)",
        hint: "엔드포인트가 이 시간 동안 아무것도 보내지 않으면 중단합니다.",
      },
      "api.idleTimeoutMs": {
        label: "응답 멈춤 시간 제한(초)",
        hint: "응답 스트리밍이 이 시간 동안 멈추면 중단합니다.",
      },
      "api.totalTimeoutMs": {
        label: "최대 요청 시간(초)",
        hint: "어떤 요청이든 이 시간이 지나면 중단합니다.",
      },
      "api.healthTimeoutMs": {
        label: "연결 확인 시간 제한(초)",
        hint: "엔드포인트 확인과 ‘연결 테스트’에서 사용됩니다.",
      },
      "translate.boxBudget": {
        label: "요청당 텍스트 영역 수",
        hint: "비워 두면 모델 프로필 값(12, 16 또는 20)을 사용합니다.",
      },
      "translate.packWaitMs": {
        label: "이미지 묶기 대기 시간 (ms)",
        hint: "한 이미지의 텍스트가 같은 요청으로 묶이도록 페이지의 다음 이미지를 기다리는 시간입니다. 0이면 이미지마다 바로 보냅니다.",
      },
      "translate.urgentPackMax": {
        label: "화면의 첫 요청에 넣을 말풍선 수",
        hint: "화면에 보이는 이미지의 첫 요청에는 최대 이만큼의 말풍선만 넣어 더 빨리 표시합니다. 0 = 별도 제한 없음.",
      },
      "translate.jpegQuality": {
        label: "JPEG 품질",
        hint: "AI로 보내는 합성 이미지의 품질입니다.",
      },
      "translate.requestBodyCapMb": {
        label: "최대 요청 크기(MB)",
        hint: "이보다 큰 합성 이미지는 더 강하게 압축하고, 그래도 크면 나눕니다.",
      },
      "translate.promptCharCap": {
        label: "최대 프롬프트 길이(글자 수)",
        hint: "요청이 이보다 길면 먼저 문맥을 줄입니다.",
      },
      "translate.maxLadderRequestsPerPack": {
        label: "누락된 텍스트를 복구하는 추가 요청 수",
        hint: "AI가 텍스트 영역을 건너뛸 때 다시 요청하거나 나누어 요청합니다.",
      },
      "translate.maxHttpRetriesPerRequest": {
        label: "네트워크 오류 후 재시도 횟수",
        hint: "요청마다 적용되며, 일시적인 HTTP 및 네트워크 오류가 대상입니다.",
      },
      "translate.engine": {
        label: "번역 엔진",
        hint: "오프라인 모드는 실험적 기능입니다. 위의 오프라인 모드를 참고하세요.",
      },
      "translate.offlineModel": {
        label: "오프라인 번역 모델",
        hint: "오프라인 모드에서만 사용됩니다.",
      },
      "translate.splitOnRefusal": {
        label: "거부된 요청 나누기",
        hint: "AI가 거부하면 포기하지 않고 절반씩 따로 시도합니다.",
      },
      "detector.backend": {
        label: "감지에 사용할 하드웨어",
        hint: "‘자동’은 GPU가 자체 테스트를 통과하면 GPU를, 그렇지 않으면 CPU를 사용합니다.",
      },
      "detector.scoreMin": {
        label: "최소 감지 점수",
        hint: "값을 낮추면 텍스트를 더 많이 찾지만 잘못된 감지도 늘어납니다.",
      },
      "detector.sliceTriggerRatio": {
        label: "이보다 긴 이미지 분할(비율)",
        hint: "긴 변이 짧은 변의 이 배수를 넘는 이미지와 웹툰 스트립은 여러 조각으로 잘라 처리합니다.",
      },
      "detector.sliceHeightRatio": {
        label: "조각 길이(× 짧은 변)",
        hint: "각 조각의 길이를 이미지 짧은 변의 배수로 지정합니다.",
      },
      "detector.sliceOverlap": {
        label: "조각 겹침(비율)",
        hint: "이웃한 조각끼리 겹치는 부분을 조각 길이에 대한 비율로 지정합니다.",
      },
      "detector.sliceOverlapMinPx": {
        label: "최소 조각 겹침(픽셀)",
        hint: "이웃한 조각은 항상 최소 이만큼의 픽셀을 공유합니다.",
      },
      "detector.quietRows": {
        label: "텍스트 줄 사이에서 조각 자르기",
        hint: "실험 기능: 자르는 위치를 잉크가 없는 줄로 옮깁니다.",
      },
      "engine.idleCloseMin": {
        label: "유휴 엔진 종료까지 시간(분)",
        hint: "이 시간 동안 엔진을 사용한 페이지가 없으면 메모리를 확보합니다.",
      },
      "engine.detectorReleaseMin": {
        label: "텍스트 감지 해제까지 시간(분)",
        hint: "감지 모델이 이 시간 동안 실행되지 않으면 메모리에서 내립니다.",
      },
      "engine.portIdleMin": {
        label: "유휴 페이지 연결 해제까지 시간(분)",
        hint: "작업 없이 이 시간이 지나면 페이지와 엔진의 연결을 끊습니다.",
      },
      "discovery.minNaturalSide": {
        label: "이보다 작은 이미지 무시(픽셀)",
        hint: "짧은 변의 실제 크기입니다. 아이콘, 아바타, 광고를 건너뜁니다.",
      },
      "discovery.minDisplayedSide": {
        label: "화면에 이보다 작게 표시되는 이미지 무시(픽셀)",
        hint: "화면에 표시되는 짧은 변의 크기입니다.",
      },
      "discovery.secondsPerScreenDefault": {
        label: "초기 읽기 속도(화면당 초)",
        hint: "실제 읽기 속도를 측정하기 전까지 사용하는 추정값입니다.",
      },
      "discovery.lookaheadMinScreens": {
        label: "미리 번역 최소 범위(화면 수)",
        hint: "보기 아래로 이만큼 떨어진 이미지는 도착하기 전에 항상 번역됩니다.",
      },
      "discovery.lookaheadMaxScreens": {
        label: "미리 번역 최대 범위(화면 수)",
        hint: "빨리 읽거나 AI 응답이 느릴 때의 상한입니다.",
      },
      "discovery.lookaheadMaxScreensStrip": {
        label: "웹툰 스트립 미리 번역 최대 범위(화면 수)",
        hint: "긴 세로 스트립에서의 상한입니다.",
      },
      "discovery.detectAheadMinScreens": {
        label: "미리 감지 최소 범위(화면 수)",
        hint: "페이지가 아직 불러오지 않은 이미지를 이만큼 앞서 감지합니다(업로드 없음).",
      },
      "discovery.detectAheadMaxScreens": {
        label: "미리 감지 최대 범위(화면 수)",
        hint: "빨리 읽는 경우의 상한입니다.",
      },
      "discovery.detectMaxImages": {
        label: "미리 감지할 이미지 최대 수",
        hint: "불러왔는지와 관계없이 앞에 있는 모든 이미지를 셉니다.",
      },
      "discovery.fetchPerHostConcurrency": {
        label: "서버당 동시 이미지 다운로드 수",
        hint: "같은 이미지 서버에서 동시에 내려받는 이미지 수입니다.",
      },
      "discovery.prefetchSpacingMs": {
        label: "이미지 다운로드 간격(ms)",
        hint: "같은 서버에서 두 번 내려받을 때 사이에 두는 최소 시간입니다.",
      },
      "discovery.scrollDebounceMs": {
        label: "스크롤 반응 지연(ms)",
        hint: "스크롤한 뒤 이 시간만큼 기다렸다가 작업 순서를 다시 정합니다.",
      },
      "discovery.mutationDebounceMs": {
        label: "페이지 변경 반응 지연(ms)",
        hint: "페이지가 바뀐 뒤(지연 로딩, 뷰어 앱 등) 이 시간만큼 기다렸다가 새 이미지를 찾습니다.",
      },
      "discovery.stripGapPx": {
        label: "웹툰 스트립 안의 최대 간격(픽셀)",
        hint: "간격이 이보다 좁은 이미지는 하나의 연속된 스트립으로 봅니다.",
      },
      "discovery.translateHiddenTabs": {
        label: "백그라운드 탭에서도 번역",
        hint: "끄면 자동 모드는 탭이 한 번 표시될 때까지 기다립니다.",
      },
      "render.font": {
        label: "대사 글꼴",
        hint: "말풍선 속 번역문에 쓰는 글꼴입니다.",
      },
      "render.verticalText": {
        label: "세로쓰기",
        hint: "일본어나 번체 중국어 번역은 세로 말풍선에서 위에서 아래로 씁니다. '사용 안 함'을 고르면 모든 번역을 가로로 씁니다.",
      },
      "render.minFontPx": {
        label: "최소 글자 크기(픽셀)",
        hint: "이 크기로도 들어가지 않는 텍스트는 ‘…’로 줄입니다.",
      },
      "render.maxFontPx": {
        label: "최대 글자 크기(픽셀)",
        hint: "번역문은 원래 글자 크기와도 비슷하게 유지됩니다.",
      },
      "render.eraseSfx": {
        label: "효과음 지우기",
        hint: "효과음에 라벨을 붙이는 대신 이미지에서 지웁니다.",
      },
      "render.sfxLabels": {
        label: "효과음 라벨 표시",
        hint: "효과음 번역을 작은 라벨로 보여 줍니다.",
      },
      "render.showDoneBadge": {
        label: "번역된 이미지 표시",
        hint: "번역된 모든 이미지에 작은 배지를 표시합니다.",
      },
      "render.peekKey": {
        label: "누르고 있으면 원본 보기(키 코드)",
        hint: "Backquote, KeyH 같은 키 코드입니다. 비워 두면 사용하지 않습니다.",
      },
      "render.peekWithAlt": {
        label: "Alt 키를 누르고 있을 때도 원본 보기",
        hint: "Alt 키만 누르고 있어도 번역이 숨겨집니다.",
      },
      "render.popupWithAltClick": {
        label: "Alt+클릭으로 말풍선 팝업 열기",
        hint: "팝업에서 원문을 보고 번역을 편집할 수 있습니다. 길게 누르면 항상 열립니다.",
      },
      "memory.enabled": {
        label: "시리즈 기억 사용",
        hint: "요청마다 용어집, 이전 대사, 이야기 요약을 함께 보내고 응답에서 이름을 학습합니다.",
      },
      "memory.glossaryInPrompt": {
        label: "요청당 용어집 항목 수",
        hint: "내 항목을 먼저 넣고, 그다음 확인된 항목, 그다음 학습된 항목을 넣습니다.",
      },
      "memory.termMinSightings": {
        label: "용어 학습에 필요한 등장 횟수",
        hint: "용어를 보내기 전에 그 용어가 등장해야 하는 서로 다른 요청의 수입니다.",
      },
      "memory.historyMaxLines": {
        label: "문맥으로 보낼 이전 대사 수",
        hint: "같은 화의 대사입니다. 0이면 보내지 않습니다.",
      },
      "memory.historyMaxTokens": {
        label: "이전 대사의 토큰 한도",
        hint: "가장 오래된 대사부터 뺍니다.",
      },
      "memory.summaryMaxWords": {
        label: "이야기 요약 길이(단어 수)",
        hint: "0이면 계속 갱신되는 이야기 요약을 끕니다.",
      },
      "memory.warmUp": {
        label: "새 시리즈 예열",
        hint: "시리즈 기억이 아직 없으면 첫 요청만 먼저 보내고, 다음 페이지는 그 요청의 이름과 호칭을 그대로 씁니다. 처음 몇 페이지는 조금 더 걸립니다.",
      },
      "cache.translationTtlDays": {
        label: "사용하지 않은 번역 보관 기간(일)",
        hint: "직접 수정한 번역은 만료되지 않습니다.",
      },
      "cache.encodedBytesLruMb": {
        label: "다운로드한 이미지 캐시(MB)",
        hint: "엔진이 다운로드한 이미지를 보관하는 데 쓰는 메모리입니다.",
      },
      "privacy.maxImageBytes": {
        label: "최대 이미지 파일 크기(MiB)",
        hint: "이보다 큰 이미지 파일은 건너뜁니다.",
      },
      "privacy.maxImagePixels": {
        label: "최대 이미지 크기(메가픽셀)",
        hint: "픽셀 수가 이보다 많은 이미지는 건너뜁니다.",
      },
      "debug.logCapacity": {
        label: "보관할 로그 항목 수",
        hint: "엔진이 저장하는 디버그 로그의 크기입니다.",
      },
    },
    site: {
      settings: "설정",
      settingsFor: (site: string): string => `${site} 설정`,
      layout: "레이아웃 및 읽는 방향",
      layouts: {
        auto: "자동 감지",
        webtoon: "웹툰(세로 스크롤)",
        "paged-rtl": "페이지, 오른쪽에서 왼쪽으로(일본 만화)",
        "paged-ltr": "페이지, 왼쪽에서 오른쪽으로(서양 만화)",
      },
      sourceLangHint: "AI에 전달할 언어별 지침과 텍스트를 잘라낸 이미지의 확대 정도를 정합니다.",
      referer: "이미지 다운로드용 Referer",
      referers: {
        auto: "자동",
        "page-url": "전체 페이지 주소",
        origin: "사이트 주소만",
      },
      refererHint:
        "‘자동’은 페이지를 따르고, 이미지 서버가 거부하면 전체 페이지 주소로 다시 시도합니다. " +
        "이미지가 로드되지 않을 때만 변경하세요.",
      subdomains: "하위 도메인에도 적용",
      subdomainsHint: "이 사이트의 모든 하위 도메인에서 같은 설정으로 번역합니다.",
      prefetch: "이미지 미리 준비",
      prefetchHint:
        "보기 아래에서 페이지가 아직 불러오지 않은 이미지를 감지해 도착했을 때 준비되도록 합니다. 가까워질 때까지 아무것도 업로드하지 않습니다.",
      frames: "다른 사이트의 뷰어 프레임",
      framesHint:
        "페이지가 다른 사이트에서 제공하는 프레임 안에 표시될 때, 오리진을 한 줄에 하나씩 입력하세요" +
        "(예: https://viewer.example.com).",
      framesInvalid: (lines: string): string => `http(s) 오리진이 아닙니다: ${lines}`,
    },
    transfer: {
      heading: "백업 및 복원",
      hint:
        "설정과 사이트 목록을 JSON 파일로 저장하거나 파일에서 불러옵니다. " +
        "개인정보 보호 안내 확인 여부는 내보내지 않습니다.",
      includeKey: "API 키 포함",
      includeKeyHint: "파일을 공유하기 전에는 끄세요. 파일을 가진 사람은 누구나 키를 읽을 수 있습니다.",
      export: "설정 내보내기",
      import: "설정 가져오기",
      importConfirm: "현재 설정을 파일의 설정으로 바꿀까요? 파일에 있는 사이트는 추가되거나 업데이트됩니다.",
      notJson: "올바른 JSON 파일이 아닙니다.",
      notSettings: "Panelingo 설정 내보내기 파일이 아닙니다.",
      tooNew: "더 새로운 버전의 Panelingo에서 만든 파일입니다.",
      imported: (settings: number, sites: number): string =>
        `가져왔습니다. 변경된 설정: ${settings}개, 사이트: ${sites}개.`,
      keyImported: "파일에 있던 API 키를 가져왔습니다.",
      keyKept: "기존 API 키를 유지했습니다(파일에 키가 없음).",
    },
  },
  offline: {
    heading: "오프라인 모드(실험적)",
    intro:
      "AI 엔드포인트 없이 번역합니다. 오픈소스 텍스트 인식(PaddleOCR) 모델과 번역 모델이 이 기기에서 실행됩니다. 품질은 비전 모델보다 확실히 낮습니다. 말풍선 사이의 문맥이나 등장인물 이름을 고려하지 않으며, 장식적인 글자는 자주 잘못 읽습니다. 효과음은 번역하지 않고 그대로 둡니다.",
    download:
      "모델은 처음 필요할 때 Hugging Face에서 한 번만 다운로드되고, 검증된 뒤 이 기기에 보관됩니다. 그 후에는 네트워크 없이 번역할 수 있습니다. 크기: 텍스트 인식은 언어당 8~17 MB, Opus-MT는 언어 쌍당 약 115 MB(영어를 거치면 두 배), NLLB-200은 약 910 MB입니다.",
    engine: "번역 엔진",
    engineChoices: { api: "AI 엔드포인트(OpenAI 호환)", offline: "이 기기에서 오프라인(실험적)" },
    model: "오프라인 번역 모델",
    modelChoices: {
      "opus-mt": "Opus-MT: 작음, 언어 쌍마다 모델 하나",
      "nllb-600m": "NLLB-200 600M: 모든 언어 쌍, 대용량, 비상업용",
    },
    pairs:
      "Opus-MT는 한국어, 일본어, 중국어, 스페인어를 영어로, 영어를 베트남어, 스페인어, 프랑스어, 독일어, 이탈리아어, 인도네시아어로 번역합니다. 다른 조합은 영어를 거칩니다. NLLB-200은 여기 나열된 모든 언어 사이를 번역합니다.",
    license:
      "라이선스: PaddleOCR과 대부분의 Opus-MT 모델은 Apache-2.0, Opus-MT 모델 두 개는 CC-BY-4.0, NLLB-200은 CC-BY-NC-4.0(비상업적 용도만 허용)입니다.",
    stored: (mb: number): string => `이 기기에 다운로드한 모델: ${Math.round(mb)} MB`,
    deleteModels: "다운로드한 모델 삭제",
    deleteConfirm: "다운로드한 오프라인 모델을 삭제할까요? 필요할 때 다시 다운로드됩니다.",
    deleted: "다운로드한 모델을 삭제했습니다.",
  },
  manifest: {
    description:
      "만화와 웹툰을 읽는 화면에서 바로 번역합니다. OpenAI 호환 AI라면 무엇이든 사용할 수 있습니다.",
    commands: {
      "toggle-overlay": "번역 오버레이 표시/숨기기",
      "translate-visible": "보이는 이미지 번역",
      "toggle-site": "이 사이트 자동 번역 켜기/끄기",
      "open-side-panel": "대사 목록 사이드 패널 열기",
    },
  },
};
