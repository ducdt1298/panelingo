// Vietnamese UI catalog. PURE.

import type { Catalog } from "./en.ts";

export const VI: Catalog = {
  errors: {
    "api.unreachable": {
      title: "Không kết nối được endpoint AI",
      hint: "Kiểm tra Base URL trong Cài đặt và máy chủ (hoặc model chạy cục bộ) đang chạy.",
    },
    "api.lna_blocked": {
      title: "Chrome chặn kết nối tới máy chủ AI cục bộ",
      hint: "Mở cài đặt trang của extension → Truy cập mạng cục bộ (Local network access) → Cho phép.",
    },
    "api.unauthorized": {
      title: "Endpoint AI từ chối API key",
      hint: "Nhập API key hợp lệ trong Cài đặt; extension sẽ tự dịch tiếp.",
    },
    "api.config": {
      title: "Cấu hình endpoint hoặc model chưa đúng",
      hint: "Kiểm tra Base URL và chọn model nhận được ảnh (vision) trong Cài đặt.",
    },
    "api.rate_limit": {
      title: "Nhà cung cấp AI đang giới hạn tốc độ",
      hint: "Extension sẽ chậm lại và tự thử lại.",
    },
    "api.upstream": { title: "Lỗi máy chủ AI, đang thử lại", hint: "" },
    "api.context_length": { title: "Yêu cầu quá dài, đang chia nhỏ", hint: "" },
    "api.timeout": { title: "AI phản hồi quá lâu", hint: "Extension sẽ thử lại một lần." },
    "api.truncated": { title: "Bản dịch bị cắt giữa chừng, đang dịch tiếp", hint: "" },
    "api.partial": { title: "AI bỏ sót vài bong bóng, đang hỏi lại", hint: "" },
    "api.empty": { title: "AI trả lời rỗng, đang thử lại", hint: "" },
    "api.too_large": { title: "Ảnh gửi đi quá lớn, đang thu nhỏ", hint: "" },
    "api.bad_request": {
      title: "Yêu cầu bị từ chối (lỗi phần mềm)",
      hint: "Xuất nhật ký debug trong Cài đặt.",
    },
    "api.protocol": { title: "Endpoint AI trả lời sai định dạng", hint: "" },
    "llm.refused": { title: "AI từ chối dịch", hint: "Bong bóng giữ nguyên chữ gốc." },
    "llm.missing": { title: "Chưa dịch", hint: "Bấm “Dịch lại” để thử riêng bong bóng này." },
    "llm.format": { title: "AI trả lời sai định dạng, đang thử lại", hint: "" },
    "image.url_blocked": { title: "Ảnh bị chặn vì an toàn", hint: "" },
    "image.http": {
      title: "Không tải được ảnh",
      hint: "Nếu trang cần đăng nhập, bật “Gửi cookie khi tải ảnh” cho trang này trong popup.",
    },
    "image.not_image": { title: "Tệp không phải ảnh", hint: "" },
    "image.too_large": { title: "Ảnh quá lớn", hint: "" },
    "image.decode": { title: "Không giải mã được ảnh", hint: "" },
    "image.capture_unavailable": { title: "Cuộn tới ảnh để dịch", hint: "" },
    "image.capture_blocked": {
      title: "Chỉ có thể đọc ảnh này bằng cách chụp màn hình",
      hint: "Bật dịch cho trang này và giữ thẻ này ở phía trước, rồi thử lại.",
    },
    "detector.webgpu_unavailable": { title: "Đang nhận diện chữ bằng CPU (chậm hơn)", hint: "" },
    "detector.canary_mismatch": { title: "GPU cho kết quả lệch, chuyển sang CPU", hint: "" },
    "detector.model_integrity": {
      title: "Model nhận diện chữ bị hỏng",
      hint: "Cài lại extension (nhà phát triển: npm run fetch-models rồi npm run build).",
    },
    "detector.init": {
      title: "Không khởi động được bộ nhận diện chữ",
      hint: "Xuất nhật ký debug trong Cài đặt.",
    },
    "detector.run": { title: "Lỗi bộ nhận diện chữ", hint: "" },
    "engine.unavailable": {
      title: "Không khởi động được engine dịch",
      hint: "Tải lại trang, hoặc tắt rồi bật lại extension.",
    },
    "engine.closing": { title: "Engine đang khởi động lại", hint: "" },
    "engine.overloaded": { title: "Engine đang bận", hint: "" },
    "engine.protocol": { title: "Phiên bản extension không khớp", hint: "Tải lại trang." },
    "engine.internal": { title: "Lỗi nội bộ", hint: "Xuất nhật ký debug trong Cài đặt." },
    "msg.too_large": { title: "Dữ liệu quá lớn, đang tải lại theo URL", hint: "" },
    "ctx.invalidated": { title: "Extension vừa được tải lại", hint: "Tải lại trang để dịch tiếp." },
    "dnr.failed": { title: "Không đặt được Referer cho ảnh", hint: "" },
    "store.io": { title: "Không đọc/ghi được bộ nhớ đệm", hint: "" },
    "store.quota": { title: "Bộ nhớ đệm đầy", hint: "Xoá bớt bộ nhớ đệm trong Cài đặt." },
    "site.disabled": { title: "Đã tắt dịch cho trang này", hint: "" },
    "privacy.consent": {
      title: "Chưa xác nhận gửi ảnh lên AI",
      hint: "Đọc thông báo quyền riêng tư và bấm cho phép gửi để bắt đầu dịch.",
    },
    cancelled: { title: "Đã huỷ", hint: "" },
  },
  readiness: {
    unknown: { label: "Đang kiểm tra endpoint AI…", hint: "" },
    ready: { label: "Endpoint AI sẵn sàng", hint: "" },
    unauthorized: {
      label: "API key bị từ chối",
      hint: "Nhập API key hợp lệ trong Cài đặt; extension sẽ tự dịch tiếp.",
    },
    unreachable: {
      label: "Không kết nối được endpoint AI",
      hint: "Kiểm tra Base URL trong Cài đặt và máy chủ (hoặc model chạy cục bộ) đang chạy.",
    },
    lna_blocked: {
      label: "Chrome chặn máy chủ AI cục bộ",
      hint: "Mở cài đặt trang của extension → Truy cập mạng cục bộ (Local network access) → Cho phép.",
    },
    misconfigured: {
      label: "Chưa cấu hình endpoint AI",
      hint: "Kiểm tra Base URL và chọn model nhận được ảnh (vision) trong Cài đặt.",
    },
  },
  imageState: {
    queued: "Đang chờ",
    acquiring: "Đang tải ảnh",
    detecting: "Đang tìm chữ",
    waiting: "Đang chờ dịch",
    translating: "Đang dịch",
    done: "Đã dịch",
    "no-text": "Không có chữ",
    partial: "Dịch một phần",
    refused: "AI từ chối dịch",
    paused: "Tạm dừng",
    error: "Lỗi",
    stale: "Bản dịch cũ",
  },
  unitStatus: {
    pending: "Đang chờ",
    translating: "Đang dịch",
    ok: "Đã dịch",
    "keep-original": "Giữ nguyên",
    manual: "Đã sửa tay",
    untranslated: "Chưa dịch",
    refused: "AI từ chối dịch",
    ignored: "Bỏ qua",
    error: "Lỗi",
    stale: "Bản dịch cũ",
  },
  enginePhase: {
    booting: "Engine đang khởi động",
    ready: "Engine đang chạy",
    closing: "Engine đang tắt",
    failed: "Engine gặp lỗi",
  },
  detectorBackend: { webgpu: "GPU (WebGPU)", wasm: "CPU (WASM)", none: "chưa chọn" },
  detectorState: { unloaded: "chưa nạp", loading: "đang nạp", ready: "sẵn sàng", failed: "lỗi" },
  detectorCanary: {
    pass: "đã kiểm tra GPU",
    fail: "GPU cho kết quả lệch, đã chuyển sang CPU",
    pending: "đang kiểm tra GPU",
    skipped: "",
  },
  ui: {
    appName: "Panelingo",
    siteEnable: "Bật dịch cho trang này",
    siteDisable: "Tắt dịch cho trang này",
    modeAuto: "Tự dịch khi cuộn",
    modeManual: "Chỉ dịch khi bấm",
    translateVisible: "Dịch các ảnh đang hiển thị",
    translateImage: "Dịch",
    retranslate: "Dịch lại",
    showOriginal: "Xem bản gốc",
    uploadsToday: (count: number, mb: number): string =>
      `Hôm nay đã gửi ${count} ảnh ghép (${mb.toFixed(1).replace(".", ",")} MB) tới AI`,
    progress: (done: number, total: number, etaSec?: number): string =>
      etaSec === undefined || !Number.isFinite(etaSec)
        ? `Đang dịch ${done}/${total}`
        : `Đang dịch ${done}/${total} · ~${Math.max(1, Math.round(etaSec))} s`,
    privacyTitle: "Trước khi gửi ảnh tới AI",
    privacyBody:
      "Để dịch, extension gửi ảnh ghép của những khung truyện có chữ (chỉ trên trang bạn bật, hoặc khi bạn yêu cầu) " +
      "tới endpoint AI bạn đã cấu hình. Nhà cung cấp AI có thể lưu lại những gì nhận được theo điều khoản của họ. " +
      "Hãy chắc rằng việc này phù hợp với bạn và với nội dung bạn đọc.",
    privacyAccept: "Tôi hiểu, cho phép gửi",
    privacyDecline: "Không gửi",
  },
  bubble: {
    original: "Bản gốc",
    translation: "Bản dịch",
    save: "Lưu",
    revert: "Dùng bản dịch của AI",
    retranslate: "Dịch lại",
    close: "Đóng",
    dialog: "Bong bóng đã dịch",
    copy: "Sao chép",
    editLabel: "Sửa bản dịch",
    shortened: "Chữ đã được rút gọn cho vừa bong bóng.",
    saved: "Đã lưu.",
    retranslating: "Đang dịch lại…",
  },
  menu: {
    translateImage: "Dịch ảnh này",
    retranslateImage: "Dịch lại ảnh này",
  },
  sidepanel: {
    title: "Panelingo – Lời thoại",
    heading: "Lời thoại",
    empty: "Tab này chưa có câu nào được dịch.",
    emptyHint: "Mở một trang truyện trên trang web bạn đã bật. Các câu sẽ hiện ở đây khi được dịch.",
    refresh: "Làm mới",
    copy: "Sao chép tất cả",
    copied: "Đã sao chép vào bộ nhớ tạm.",
    page: (n: number): string => `Trang ${n}`,
    jump: "Xem",
    jumpHint: "Cuộn trang tới bong bóng này",
    edit: "Sửa",
    save: "Lưu",
    cancel: "Huỷ",
    retranslate: "Dịch lại",
    revert: "Bỏ bản sửa",
    noTranslation: "Chưa có bản dịch",
    notFound: "Bong bóng này không còn trên trang.",
    failed: "Không thực hiện được. Hãy thử lại.",
    types: {
      dialogue: "Lời thoại",
      thought: "Suy nghĩ",
      narration: "Dẫn truyện",
      sign: "Biển chữ",
      sfx: "Hiệu ứng âm thanh",
      ignore: "Bỏ qua",
    },
    inconsistent: "Khác với bảng thuật ngữ",
    tabs: { transcript: "Lời thoại", glossary: "Thuật ngữ" },
    glossary: {
      noSeries: "Mở một trang truyện để xem bảng thuật ngữ của bộ truyện đó.",
      untitled: "Bộ truyện chưa có tên",
      states: {
        manual: "Mục của bạn",
        confirmed: "Đã xác nhận",
        learned: "Đã học",
        candidate: "Gợi ý",
      },
      hints: {
        manual: "Luôn được dùng. AI không bao giờ thay đổi.",
        confirmed: "Các gợi ý bạn đã chấp nhận. Luôn được dùng.",
        learned: "Tên và thuật ngữ AI đã dùng trong nhiều yêu cầu. Được gửi kèm mọi yêu cầu.",
        candidate: "AI mới gặp một lần. Chưa gửi cho đến khi bạn xác nhận hoặc gặp lại.",
      },
      empty: "Chưa có mục nào. Tên và thuật ngữ sẽ hiện ở đây khi AI nhận ra, hoặc bạn tự thêm.",
      original: "Văn bản gốc",
      translation: "Bản dịch",
      note: "Ghi chú (không bắt buộc)",
      add: "Thêm",
      delete: "Xóa",
      confirm: "Xác nhận",
      seen: (count: number): string => `Gặp ${count} lần`,
      incomplete: "Nhập văn bản gốc và bản dịch.",
      profileHeading: "Cài đặt bộ truyện",
      sourceLang: "Ngôn ngữ gốc",
      langAuto: "Tự nhận diện",
      langs: {
        ja: "Tiếng Nhật",
        ko: "Tiếng Hàn",
        zh: "Tiếng Trung",
        en: "Tiếng Anh",
        es: "Tiếng Tây Ban Nha",
        other: "Khác",
      },
      koNames: "Tên tiếng Hàn",
      koRomanized: "Latin hóa (Minjun)",
      koHanViet: "Hán Việt (cho bản dịch tiếng Việt)",
      keepHonorifics: "Giữ kính ngữ tiếng Nhật (-san, -kun)",
      summary: "Gửi tóm tắt cốt truyện liên tục",
      saveProfile: "Lưu cài đặt",
      saved: "Đã lưu.",
      export: "Xuất",
      import: "Nhập",
      imported: (count: number): string => `Đã nhập ${count} mục.`,
      importFailed: "Tệp này không phải bảng thuật ngữ Panelingo.",
    },
  },
  debug: { heading: "Debug (chỉ bản dev/test)" },
  duration: (ms: number): string => {
    const seconds = Math.round(Math.abs(ms) / 1000);
    if (seconds < 60) return `${seconds} giây`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} phút`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} giờ`;
    return `${Math.round(hours / 24)} ngày`;
  },
  popup: {
    openTranscript: "Mở bảng lời thoại",
    cookies: "Gửi cookie khi tải ảnh",
    cookiesHint:
      "Cho trang chỉ hiện ảnh khi đã đăng nhập. Cookie chỉ gửi tới máy chủ ảnh, không bao giờ gửi tới AI.",
    apiHeading: "Endpoint AI",
    engineHeading: "Engine dịch",
    siteHeading: "Trang này",
    checking: "Đang kiểm tra…",
    model: (model: string): string => `Model: ${model}`,
    endpoint: (url: string): string => `Endpoint: ${url}`,
    cause: (cause: string): string => `Chi tiết: ${cause}`,
    engineStopped: "Engine đang nghỉ; sẽ tự chạy khi bạn dịch.",
    engineUnreadable: "Không đọc được trạng thái engine.",
    detectorLine: (backend: string, state: string, canary: string): string =>
      `Nhận diện chữ: ${backend}, ${state}${canary === "" ? "" : ` (${canary})`}`,
    queueLine: (queued: number, inFlight: number, done: number, failed: number): string =>
      `Hàng đợi: ${queued} chờ · ${inFlight} đang gửi · ${done} xong · ${failed} lỗi`,
    pausedBy: (title: string): string => `Đang tạm dừng: ${title}`,
    siteUnsupported: "Không dịch được trên trang này (chỉ trang http/https).",
    siteOn: "Đang bật dịch cho trang này.",
    siteOff: "Chưa bật dịch cho trang này.",
    modeLabel: "Chế độ",
    visibleSent: (count: number): string =>
      count > 0 ? `Đã gửi ${count} ảnh để dịch.` : "Không thấy ảnh truyện nào đang hiển thị.",
    visibleUnavailable: "Không chạy được extension trên trang này.",
    retranslatePage: "Dịch lại trang",
    retranslateQueued: (count: number): string => `Đã xếp ${count} bong bóng để dịch lại.`,
    actionFailed: (title: string): string => `Không thực hiện được: ${title}`,
    privacyDetails: "Xem chi tiết những gì được gửi",
    options: "Cài đặt",
    setupHint: "Cấu hình endpoint AI (Base URL, API key, model) trong Cài đặt để bắt đầu.",
    consentHint: "Bấm biểu tượng Panelingo để đọc thông báo quyền riêng tư trước khi bật dịch cho trang này.",
    build: (id: string): string => `Bản dựng ${id}`,
  },
  options: {
    exportLog: "Xuất nhật ký debug",
    exportFailed: "Không xuất được nhật ký debug.",
    exportEmpty: "Nhật ký debug đang trống.",
    title: "Cài đặt",
    apiHeading: "Endpoint AI (tương thích OpenAI)",
    apiIntro:
      "Dùng được mọi dịch vụ hỗ trợ API chat completions của OpenAI và nhận ảnh: OpenAI, OpenRouter, Azure OpenAI, " +
      "Google Gemini (chế độ OpenAI), hoặc máy chủ chạy cục bộ như Ollama, LM Studio, vLLM, LiteLLM.",
    preset: "Mẫu cấu hình",
    presetCustom: "Tuỳ chỉnh",
    baseUrl: "Base URL",
    baseUrlHint: "Gồm cả phần phiên bản, ví dụ https://api.openai.com/v1 hoặc http://127.0.0.1:11434/v1.",
    baseUrlInvalid: "URL http(s) không hợp lệ.",
    apiKey: "API key",
    apiKeyHint: "Chỉ lưu trong hồ sơ trình duyệt này; để trống với máy chủ cục bộ không cần key.",
    model: "Model",
    modelHint: "Model phải nhận được ảnh (vision), ví dụ gpt-4o-mini, gemini-2.5-flash, qwen2.5-vl.",
    modelInvalid: "Nhập tên model.",
    testConnection: "Kiểm tra kết nối",
    testing: "Đang kiểm tra…",
    testOk: (detail: string): string => `Đã kết nối. ${detail}`,
    testFailed: (detail: string): string => `Thất bại: ${detail}`,
    concurrency: "Số yêu cầu dịch song song",
    concurrencyHint: "Mặc định 2; tối đa 4. Giảm xuống nếu nhà cung cấp giới hạn tốc độ.",
    concurrencyInvalid: "Chọn một số từ 1 đến 4.",
    languageHeading: "Ngôn ngữ",
    uiLanguage: "Ngôn ngữ giao diện",
    targetLanguage: "Dịch sang",
    languageAuto: "Theo trình duyệt",
    save: "Lưu",
    saved: "Đã lưu.",
    saveFailed: "Không lưu được.",
    sitesHeading: "Trang đã thêm",
    sitesEmpty: "Chưa có trang nào. Mở một trang truyện, bấm biểu tượng extension rồi bật dịch cho trang đó.",
    siteEnabled: "Bật",
    siteMode: "Chế độ",
    siteRemove: "Xoá",
    privacyHeading: "Quyền riêng tư: những gì được gửi tới AI",
    privacyPoints: [
      "Mỗi lần dịch, extension gửi một ảnh ghép JPEG tới endpoint AI bạn đã cấu hình: ảnh thu nhỏ của những ảnh " +
        "(hoặc lát webtoon) có chữ, khung đánh số quanh từng vùng chữ và ảnh cắt phóng to của các vùng đó.",
      "Kèm theo ảnh là phần chữ: quy tắc định dạng và ngôn ngữ, thuật ngữ của bộ truyện (tối đa 60 mục), tối đa 20 " +
        "câu thoại trước đó trong cùng chương và một bản tóm tắt ngắn.",
      "Không bao giờ gửi: ảnh không có chữ, địa chỉ trang đang đọc, cookie, địa chỉ IP hay header của trình duyệt " +
        "(ngoài những gì mọi yêu cầu tới endpoint của bạn đều có).",
      "Nhà cung cấp AI có thể lưu lại những gì nhận được theo điều khoản của họ. Hãy coi mọi thứ đã gửi là được lưu.",
      "Chỉ trang bạn bật mới tự dịch khi cuộn. Trang khác chỉ dịch khi bạn yêu cầu (menu chuột phải hoặc phím tắt), " +
        "và extension luôn hỏi trước lần gửi đầu tiên.",
      "Popup hiện số ảnh ghép đã gửi trong ngày.",
      "Trên máy: bản dịch, vị trí bong bóng và lớp xoá chữ nằm trong IndexedDB của extension; xoá được ở mục " +
        "Bộ nhớ đệm bên dưới.",
    ],
    privacyAcked: (when: string): string => `Bạn đã xác nhận thông báo gửi ảnh lúc ${when}.`,
    privacyNotAcked: "Bạn chưa xác nhận thông báo gửi ảnh; extension sẽ hỏi trước lần gửi đầu tiên.",
    cacheHeading: "Bộ nhớ đệm",
    cacheHint:
      "Xoá mọi bản dịch, vị trí bong bóng và lớp xoá chữ đã lưu trên máy. Đọc lại sẽ phải dịch (và gửi ảnh) lại.",
    cacheClear: "Xoá toàn bộ bộ nhớ đệm",
    cacheConfirm: "Xoá toàn bộ bộ nhớ đệm? Lần đọc sau sẽ phải dịch và gửi ảnh lại.",
    cacheCleared: (count: number): string => `Đã xoá ${count} bản ghi.`,
    cacheFailed: (title: string): string => `Không xoá được bộ nhớ đệm: ${title}`,
    debugHeading: "Nhật ký debug",
    logLevel: "Mức ghi nhật ký",
    logLevels: { debug: "Chi tiết (debug)", info: "Thông tin", warn: "Cảnh báo", error: "Chỉ lỗi" },
  },
  optionsAdvanced: {
    heading: "Cài đặt nâng cao",
    intro:
      "Tinh chỉnh yêu cầu gửi AI, nhận diện chữ, cách hiển thị chữ và bộ nhớ đệm. Giá trị mặc định phù hợp " +
      "với hầu hết nhu cầu. Mỗi thay đổi được lưu khi bạn rời khỏi ô nhập.",
    defaultIs: (value: string): string => `Mặc định: ${value}`,
    range: (min: string, max: string): string => `Cho phép: từ ${min} đến ${max}`,
    automatic: "tự động",
    on: "bật",
    off: "tắt",
    reset: "Đặt lại",
    resetLabel: (label: string): string => `Đặt lại “${label}” về mặc định`,
    resetAll: "Đặt lại mọi cài đặt nâng cao",
    resetAllConfirm: "Đặt lại tất cả cài đặt nâng cao về mặc định?",
    resetAllDone: "Đã đưa mọi cài đặt nâng cao về mặc định.",
    notANumber: "Hãy nhập một số.",
    adjusted: (value: string): string => `Đã lưu là ${value}, giá trị hợp lệ gần nhất.`,
    badKey: "Dùng mã phím như Backquote hoặc KeyH, hoặc để trống.",
    verticalChoices: { auto: "Tự động", never: "Không bao giờ" },
    groups: {
      api: "Yêu cầu AI",
      translate: "Nội dung yêu cầu",
      detector: "Nhận diện chữ",
      engine: "Engine dịch",
      discovery: "Tìm ảnh",
      render: "Hiển thị bản dịch",
      memory: "Ghi nhớ bộ truyện",
      cache: "Bộ nhớ đệm",
      privacy: "Giới hạn ảnh",
      debug: "Nhật ký debug",
    },
    fields: {
      "api.temperature": {
        label: "Nhiệt độ (temperature)",
        hint: "Mức đa dạng của câu trả lời. Để trống để dùng mặc định của nhà cung cấp.",
      },
      "api.urgentLane": {
        label: "Thêm luồng cho ảnh đang xem",
        hint: "Thêm một luồng yêu cầu dành riêng cho những ảnh bạn đang xem.",
      },
      "api.maxInFlight": {
        label: "Số yêu cầu tối đa cùng lúc",
        hint: "Giới hạn cứng, tính cả luồng thêm. Không bao giờ thấp hơn số yêu cầu dịch song song.",
      },
      "api.firstByteTimeoutMs": {
        label: "Chờ phản hồi đầu tiên (giây)",
        hint: "Dừng chờ khi endpoint không gửi gì trong chừng ấy thời gian.",
      },
      "api.idleTimeoutMs": {
        label: "Hết giờ khi câu trả lời bị treo (giây)",
        hint: "Dừng chờ khi câu trả lời ngừng truyền về trong chừng ấy thời gian.",
      },
      "api.totalTimeoutMs": {
        label: "Thời gian tối đa cho một yêu cầu (giây)",
        hint: "Dừng mọi yêu cầu chạy lâu hơn thời gian này.",
      },
      "api.healthTimeoutMs": {
        label: "Thời gian chờ kiểm tra kết nối (giây)",
        hint: "Dùng khi kiểm tra endpoint và khi bấm Kiểm tra kết nối.",
      },
      "translate.boxBudget": {
        label: "Số vùng chữ mỗi yêu cầu",
        hint: "Để trống để dùng theo cấu hình của model (12, 16 hoặc 20).",
      },
      "translate.jpegQuality": {
        label: "Chất lượng JPEG",
        hint: "Chất lượng của ảnh ghép gửi tới AI.",
      },
      "translate.requestBodyCapMb": {
        label: "Kích thước yêu cầu tối đa (MB)",
        hint: "Ảnh ghép lớn hơn sẽ được nén mạnh hơn, rồi chia nhỏ.",
      },
      "translate.promptCharCap": {
        label: "Độ dài prompt tối đa (ký tự)",
        hint: "Khi yêu cầu dài hơn, phần ngữ cảnh sẽ được rút gọn trước.",
      },
      "translate.maxLadderRequestsPerPack": {
        label: "Số yêu cầu thêm để lấy lại chữ bị sót",
        hint: "Hỏi lại và chia nhỏ khi AI bỏ qua vùng chữ.",
      },
      "translate.maxHttpRetriesPerRequest": {
        label: "Số lần thử lại khi lỗi mạng",
        hint: "Tính cho mỗi yêu cầu, với lỗi HTTP và lỗi mạng tạm thời.",
      },
      "translate.splitOnRefusal": {
        label: "Chia nhỏ yêu cầu bị từ chối",
        hint: "Khi AI từ chối, thử riêng từng nửa thay vì bỏ cuộc.",
      },
      "detector.backend": {
        label: "Phần cứng nhận diện",
        hint: "Tự động: dùng GPU nếu vượt qua bài tự kiểm tra, nếu không thì dùng CPU.",
      },
      "detector.scoreMin": {
        label: "Điểm nhận diện tối thiểu",
        hint: "Giá trị thấp hơn tìm được nhiều chữ hơn, nhưng cũng nhận nhầm nhiều hơn.",
      },
      "detector.sliceTriggerRatio": {
        label: "Cắt lát ảnh dài hơn (tỉ lệ)",
        hint: "Ảnh và dải webtoon có cạnh dài vượt quá bội số này của cạnh ngắn sẽ được cắt thành lát.",
      },
      "detector.sliceHeightRatio": {
        label: "Độ dài lát (× cạnh ngắn)",
        hint: "Độ dài mỗi lát, tính theo bội số cạnh ngắn của ảnh.",
      },
      "detector.sliceOverlap": {
        label: "Phần chồng giữa các lát (tỉ lệ)",
        hint: "Phần chồng giữa hai lát liền kề, tính theo tỉ lệ của một lát.",
      },
      "detector.sliceOverlapMinPx": {
        label: "Phần chồng tối thiểu giữa các lát (pixel)",
        hint: "Hai lát liền kề luôn chồng lên nhau ít nhất chừng này pixel.",
      },
      "detector.quietRows": {
        label: "Cắt lát giữa các dòng chữ",
        hint: "Thử nghiệm: dời đường cắt lát tới những hàng không có mực.",
      },
      "engine.idleCloseMin": {
        label: "Tắt engine khi rảnh sau (phút)",
        hint: "Giải phóng bộ nhớ khi không trang nào dùng engine trong chừng ấy thời gian.",
      },
      "engine.detectorReleaseMin": {
        label: "Gỡ bộ nhận diện chữ sau (phút)",
        hint: "Giải phóng model nhận diện khi nó không chạy trong chừng ấy thời gian.",
      },
      "engine.portIdleMin": {
        label: "Ngắt kết nối trang rảnh sau (phút)",
        hint: "Trang sẽ rời engine sau chừng ấy thời gian không có việc.",
      },
      "discovery.minNaturalSide": {
        label: "Bỏ qua ảnh nhỏ hơn (pixel)",
        hint: "Kích thước thật của cạnh ngắn. Bỏ qua biểu tượng, ảnh đại diện và quảng cáo.",
      },
      "discovery.minDisplayedSide": {
        label: "Bỏ qua ảnh hiển thị nhỏ hơn (pixel)",
        hint: "Kích thước cạnh ngắn trên màn hình.",
      },
      "discovery.secondsPerScreenDefault": {
        label: "Tốc độ đọc ban đầu (giây mỗi màn hình)",
        hint: "Ước lượng ban đầu cho đến khi đo được tốc độ đọc của bạn.",
      },
      "discovery.lookaheadMinScreens": {
        label: "Dịch trước, tối thiểu (màn hình)",
        hint: "Ảnh cách vùng đang xem chừng này màn hình luôn được dịch trước khi bạn tới.",
      },
      "discovery.lookaheadMaxScreens": {
        label: "Dịch trước, tối đa (màn hình)",
        hint: "Giới hạn trên khi bạn đọc nhanh hoặc AI phản hồi chậm.",
      },
      "discovery.lookaheadMaxScreensStrip": {
        label: "Dịch trước trên dải webtoon, tối đa (màn hình)",
        hint: "Giới hạn trên cho các dải dọc dài.",
      },
      "discovery.detectAheadMinScreens": {
        label: "Nhận diện trước, tối thiểu (màn hình)",
        hint: "Ảnh trang chưa tải được nhận diện trước trong khoảng này (không tải lên).",
      },
      "discovery.detectAheadMaxScreens": {
        label: "Nhận diện trước, tối đa (màn hình)",
        hint: "Giới hạn trên khi đọc nhanh.",
      },
      "discovery.detectMaxImages": {
        label: "Số ảnh nhận diện trước, tối đa",
        hint: "Tính mọi ảnh phía trước bạn, đã tải hay chưa.",
      },
      "discovery.fetchPerHostConcurrency": {
        label: "Số ảnh tải song song mỗi máy chủ",
        hint: "Số ảnh tải cùng lúc từ cùng một máy chủ ảnh.",
      },
      "discovery.prefetchSpacingMs": {
        label: "Khoảng nghỉ giữa các lần tải ảnh (mili giây)",
        hint: "Thời gian tối thiểu giữa hai lần tải từ cùng một máy chủ.",
      },
      "discovery.scrollDebounceMs": {
        label: "Độ trễ phản ứng khi cuộn (mili giây)",
        hint: "Chờ chừng này sau khi cuộn rồi mới sắp xếp lại công việc.",
      },
      "discovery.mutationDebounceMs": {
        label: "Độ trễ phản ứng khi trang thay đổi (mili giây)",
        hint: "Chờ chừng này sau khi trang thay đổi (tải dần, ứng dụng đọc truyện) rồi mới tìm ảnh mới.",
      },
      "discovery.stripGapPx": {
        label: "Khoảng hở tối đa trong dải webtoon (pixel)",
        hint: "Các ảnh gần nhau hơn mức này tạo thành một dải liền mạch.",
      },
      "discovery.translateHiddenTabs": {
        label: "Dịch trong tab nền",
        hint: "Tắt: chế độ tự động chờ đến khi tab được hiển thị.",
      },
      "render.font": {
        label: "Phông chữ lời thoại",
        hint: "Phông chữ của bản dịch trong bong bóng thoại.",
      },
      "render.verticalText": {
        label: "Chữ dọc",
        hint: "Bản dịch tiếng Nhật hoặc tiếng Trung phồn thể được viết từ trên xuống trong bong bóng dọc. “Không bao giờ” giữ mọi bản dịch nằm ngang.",
      },
      "render.minFontPx": {
        label: "Cỡ chữ nhỏ nhất (pixel)",
        hint: "Chữ không vừa ở cỡ này sẽ được rút gọn bằng “…”.",
      },
      "render.maxFontPx": {
        label: "Cỡ chữ lớn nhất (pixel)",
        hint: "Chữ cũng được giữ gần với cỡ chữ gốc.",
      },
      "render.eraseSfx": {
        label: "Xoá hiệu ứng âm thanh",
        hint: "Xoá hiệu ứng âm thanh khỏi ảnh thay vì gắn nhãn.",
      },
      "render.sfxLabels": {
        label: "Gắn nhãn hiệu ứng âm thanh",
        hint: "Hiện bản dịch của hiệu ứng âm thanh dưới dạng nhãn nhỏ.",
      },
      "render.showDoneBadge": {
        label: "Đánh dấu ảnh đã dịch",
        hint: "Hiện một dấu nhỏ trên mỗi ảnh đã dịch.",
      },
      "render.peekKey": {
        label: "Giữ phím để xem bản gốc (mã phím)",
        hint: "Mã phím như Backquote hoặc KeyH. Để trống để tắt.",
      },
      "render.peekWithAlt": {
        label: "Cũng xem bản gốc khi giữ Alt",
        hint: "Chỉ giữ phím Alt cũng ẩn bản dịch.",
      },
      "render.popupWithAltClick": {
        label: "Alt+nhấp để mở cửa sổ bong bóng",
        hint: "Cửa sổ hiện bản gốc và cho phép sửa bản dịch. Nhấn giữ luôn mở được cửa sổ này.",
      },
      "memory.enabled": {
        label: "Dùng ghi nhớ bộ truyện",
        hint: "Gửi kèm bảng thuật ngữ, các câu trước và tóm tắt cốt truyện với mỗi yêu cầu, và học tên từ câu trả lời.",
      },
      "memory.glossaryInPrompt": {
        label: "Số mục thuật ngữ mỗi yêu cầu",
        hint: "Mục của bạn trước, rồi mục đã xác nhận, rồi mục đã học.",
      },
      "memory.termMinSightings": {
        label: "Số lần gặp trước khi học thuật ngữ",
        hint: "Số yêu cầu khác nhau phải nhắc tới một thuật ngữ trước khi nó được gửi đi.",
      },
      "memory.historyMaxLines": {
        label: "Số câu trước gửi làm ngữ cảnh",
        hint: "Các câu trong cùng chương. 0 là không gửi.",
      },
      "memory.historyMaxTokens": {
        label: "Giới hạn token cho các câu trước",
        hint: "Câu cũ nhất bị bỏ trước.",
      },
      "memory.summaryMaxWords": {
        label: "Độ dài tóm tắt cốt truyện (từ)",
        hint: "0 là tắt bản tóm tắt liên tục.",
      },
      "cache.translationTtlDays": {
        label: "Giữ bản dịch không dùng đến trong (ngày)",
        hint: "Bản bạn tự sửa không bao giờ hết hạn.",
      },
      "cache.encodedBytesLruMb": {
        label: "Bộ nhớ đệm ảnh đã tải (MB)",
        hint: "Bộ nhớ engine dùng để giữ ảnh đã tải.",
      },
      "privacy.maxImageBytes": {
        label: "Tệp ảnh lớn nhất (MiB)",
        hint: "Tệp ảnh lớn hơn sẽ bị bỏ qua.",
      },
      "privacy.maxImagePixels": {
        label: "Ảnh lớn nhất (megapixel)",
        hint: "Ảnh có nhiều điểm ảnh hơn sẽ bị bỏ qua.",
      },
      "debug.logCapacity": {
        label: "Số mục nhật ký được giữ",
        hint: "Kích thước nhật ký debug mà engine lưu.",
      },
    },
    site: {
      settings: "Cài đặt",
      settingsFor: (site: string): string => `Cài đặt cho ${site}`,
      layout: "Bố cục và hướng đọc",
      layouts: {
        auto: "Tự nhận diện",
        webtoon: "Webtoon (dải dọc)",
        "paged-rtl": "Theo trang, phải sang trái (manga)",
        "paged-ltr": "Theo trang, trái sang phải (truyện Âu Mỹ)",
      },
      sourceLangHint: "Chọn bộ hướng dẫn riêng theo ngôn ngữ cho AI và mức phóng to ảnh cắt vùng chữ.",
      referer: "Referer khi tải ảnh",
      referers: {
        auto: "Tự động",
        "page-url": "Địa chỉ trang đầy đủ",
        origin: "Chỉ địa chỉ trang web",
      },
      refererHint:
        "Tự động: theo trang đang đọc, rồi thử lại với địa chỉ trang đầy đủ nếu máy chủ ảnh từ chối. " +
        "Chỉ đổi khi ảnh không tải được.",
      subdomains: "Áp dụng cho cả tên miền con",
      subdomainsHint: "Dịch trên mọi tên miền con của trang này với cùng cài đặt.",
      prefetch: "Chuẩn bị ảnh trước",
      prefetchHint:
        "Nhận diện các ảnh bên dưới vùng đang xem mà trang chưa tải, để chúng sẵn sàng khi bạn tới. Không tải lên gì cho tới khi ảnh ở gần.",
      frames: "Khung đọc truyện từ trang khác",
      framesHint:
        "Mỗi dòng một origin, ví dụ https://viewer.example.com, khi trang truyện hiển thị trong một khung " +
        "(frame) do trang khác cung cấp.",
      framesInvalid: (lines: string): string => `Không phải origin http(s): ${lines}`,
    },
    transfer: {
      heading: "Sao lưu và khôi phục",
      hint:
        "Lưu cài đặt và danh sách trang vào tệp JSON, hoặc nạp lại từ tệp đó. Xác nhận quyền riêng tư " +
        "không bao giờ được xuất.",
      includeKey: "Kèm API key",
      includeKeyHint: "Hãy tắt mục này trước khi chia sẻ tệp: ai cũng có thể đọc được key trong đó.",
      export: "Xuất cài đặt",
      import: "Nhập cài đặt",
      importConfirm:
        "Thay cài đặt hiện tại bằng cài đặt trong tệp? Các trang trong tệp sẽ được thêm hoặc cập nhật.",
      notJson: "Tệp này không phải JSON hợp lệ.",
      notSettings: "Tệp này không phải bản xuất cài đặt Panelingo.",
      tooNew: "Tệp này được tạo bởi phiên bản Panelingo mới hơn.",
      imported: (settings: number, sites: number): string =>
        `Đã nhập. Số cài đặt thay đổi: ${settings}. Số trang: ${sites}.`,
      keyImported: "Đã nhập API key từ tệp.",
      keyKept: "Đã giữ API key của bạn (tệp không có key).",
    },
  },
  manifest: {
    description:
      "Dịch truyện tranh, manga, webtoon ngay trên trang đang đọc, với bất kỳ AI tương thích OpenAI.",
    commands: {
      "toggle-overlay": "Bật/tắt lớp dịch trên trang",
      "translate-visible": "Dịch các ảnh đang hiển thị",
      "toggle-site": "Bật/tắt tự động dịch cho trang này",
      "open-side-panel": "Mở bảng lời thoại",
    },
  },
};
