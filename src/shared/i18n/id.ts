// Indonesian UI catalog. PURE.

import type { Catalog } from "./en.ts";

const errors: Catalog["errors"] = {
  "api.unreachable": {
    title: "Tidak dapat terhubung ke endpoint AI",
    hint: "Periksa URL dasar di Opsi dan pastikan server (atau model lokal Anda) sedang berjalan.",
  },
  "api.lna_blocked": {
    title: "Chrome memblokir koneksi ke server AI lokal Anda",
    hint: "Buka setelan situs ekstensi → Akses jaringan lokal (Local network access) → Izinkan.",
  },
  "api.unauthorized": {
    title: "Endpoint AI menolak kunci API",
    hint: "Masukkan kunci API yang valid di Opsi. Penerjemahan akan berlanjut secara otomatis.",
  },
  "api.config": {
    title: "Konfigurasi endpoint AI atau model salah",
    hint: "Periksa URL dasar dan pilih model yang menerima gambar (vision) di Opsi.",
  },
  "api.rate_limit": {
    title: "Penyedia AI sedang membatasi permintaan",
    hint: "Ekstensi akan memperlambat permintaan dan mencoba lagi secara otomatis.",
  },
  "api.upstream": { title: "Server AI mengalami kesalahan, mencoba lagi", hint: "" },
  "api.context_length": { title: "Permintaan terlalu panjang, sedang dipecah", hint: "" },
  "api.timeout": { title: "AI terlalu lama menjawab", hint: "Ekstensi akan mencoba lagi sekali." },
  "api.truncated": { title: "Jawaban terpotong, sedang dilanjutkan", hint: "" },
  "api.partial": { title: "AI melewatkan beberapa balon kata, meminta ulang", hint: "" },
  "api.empty": { title: "AI memberi jawaban kosong, mencoba lagi", hint: "" },
  "api.too_large": { title: "Gambar terlalu besar untuk dikirim, sedang diperkecil", hint: "" },
  "api.bad_request": { title: "Permintaan ditolak (bug)", hint: "Ekspor log debug dari Opsi." },
  "api.protocol": { title: "Format jawaban dari endpoint AI tidak terduga", hint: "" },
  "llm.refused": { title: "AI menolak menerjemahkan", hint: "Balon kata tetap memakai teks aslinya." },
  "llm.missing": {
    title: "Belum diterjemahkan",
    hint: "Gunakan “Terjemahkan ulang” untuk mencoba lagi balon kata ini saja.",
  },
  "llm.format": { title: "Format jawaban AI rusak, mencoba lagi", hint: "" },
  "image.url_blocked": { title: "Gambar diblokir demi keamanan", hint: "" },
  "image.http": {
    title: "Tidak dapat memuat gambar",
    hint: "Jika situs mengharuskan Anda masuk, aktifkan “Kirim cookie bersama permintaan gambar” di popup.",
  },
  "image.not_image": { title: "Bukan file gambar", hint: "" },
  "image.too_large": { title: "Gambar terlalu besar", hint: "" },
  "image.decode": { title: "Tidak dapat mendekode gambar", hint: "" },
  "image.capture_unavailable": { title: "Gulir ke gambar untuk menerjemahkannya", hint: "" },
  "image.capture_blocked": {
    title: "Gambar ini hanya bisa dibaca lewat tangkapan layar",
    hint: "Aktifkan terjemahan untuk situs ini dan biarkan tab ini tetap di depan, lalu coba lagi.",
  },
  "detector.webgpu_unavailable": { title: "Mendeteksi teks dengan CPU (lebih lambat)", hint: "" },
  "detector.canary_mismatch": { title: "Hasil GPU tidak konsisten, beralih ke CPU", hint: "" },
  "detector.model_integrity": {
    title: "Model pendeteksi teks rusak",
    hint: "Instal ulang ekstensi (pengembang: npm run fetch-models, lalu npm run build).",
  },
  "detector.init": { title: "Tidak dapat memulai deteksi teks", hint: "Ekspor log debug dari Opsi." },
  "detector.run": { title: "Deteksi teks gagal", hint: "" },
  "offline.pair_unsupported": {
    title: "Pasangan bahasa ini tidak tersedia secara offline",
    hint: "Pilih NLLB-200 sebagai model offline di Opsi, atau bahasa tujuan lain.",
  },
  "offline.download": {
    title: "Tidak dapat mengunduh model offline",
    hint: "Periksa koneksi ke huggingface.co. Terjemahan akan dicoba ulang secara otomatis.",
  },
  "offline.model_integrity": {
    title: "Model offline yang diunduh rusak",
    hint: "Terjemahkan lagi untuk mengunduhnya sekali lagi.",
  },
  "offline.run": { title: "Model offline gagal", hint: "Ekspor log debug dari Opsi." },
  "offline.out_of_memory": {
    title: "Memori tidak cukup untuk model offline",
    hint: "Model terjemahan dimulai ulang dan mesin tetap berjalan. Pilih Opus-MT (jauh lebih kecil) di Opsi, atau tutup tab lain.",
  },
  "engine.unavailable": {
    title: "Tidak dapat memulai mesin terjemahan",
    hint: "Muat ulang halaman atau nonaktifkan lalu aktifkan kembali ekstensi.",
  },
  "engine.closing": { title: "Mesin terjemahan sedang dimulai ulang", hint: "" },
  "engine.overloaded": { title: "Mesin terjemahan sedang sibuk", hint: "" },
  "engine.protocol": { title: "Versi ekstensi tidak cocok", hint: "Muat ulang halaman." },
  "engine.internal": { title: "Kesalahan internal", hint: "Ekspor log debug dari Opsi." },
  "msg.too_large": { title: "Data terlalu besar, memuat ulang lewat URL", hint: "" },
  "ctx.invalidated": {
    title: "Ekstensi baru saja dimuat ulang",
    hint: "Muat ulang halaman untuk melanjutkan penerjemahan.",
  },
  "dnr.failed": { title: "Tidak dapat mengatur Referer gambar", hint: "" },
  "store.io": { title: "Tidak dapat membaca atau menulis cache", hint: "" },
  "store.quota": { title: "Cache penuh", hint: "Hapus sebagian cache di Opsi." },
  "site.disabled": { title: "Terjemahan nonaktif untuk situs ini", hint: "" },
  "privacy.consent": {
    title: "Pengiriman gambar ke AI belum dikonfirmasi",
    hint: "Baca pemberitahuan privasi dan izinkan pengiriman untuk mulai menerjemahkan.",
  },
  cancelled: { title: "Dibatalkan", hint: "" },
};

export const ID: Catalog = {
  errors,
  readiness: {
    unknown: { label: "Memeriksa endpoint AI…", hint: "" },
    ready: { label: "Endpoint AI siap", hint: "" },
    unauthorized: { label: "Kunci API ditolak", hint: errors["api.unauthorized"].hint },
    unreachable: { label: "Endpoint AI tidak dapat dijangkau", hint: errors["api.unreachable"].hint },
    lna_blocked: { label: "Chrome memblokir server AI lokal", hint: errors["api.lna_blocked"].hint },
    misconfigured: { label: "Endpoint AI belum dikonfigurasi", hint: errors["api.config"].hint },
  },
  imageState: {
    queued: "Dalam antrean",
    acquiring: "Memuat gambar",
    detecting: "Mencari teks",
    waiting: "Menunggu diterjemahkan",
    translating: "Menerjemahkan",
    done: "Diterjemahkan",
    "no-text": "Tidak ada teks",
    partial: "Diterjemahkan sebagian",
    refused: "AI menolak",
    paused: "Dijeda",
    error: "Kesalahan",
    stale: "Terjemahan usang",
  },
  unitStatus: {
    pending: "Menunggu",
    translating: "Menerjemahkan",
    ok: "Diterjemahkan",
    "keep-original": "Tetap asli",
    manual: "Diedit",
    untranslated: "Belum diterjemahkan",
    refused: "AI menolak",
    ignored: "Diabaikan",
    error: "Kesalahan",
    stale: "Usang",
  },
  enginePhase: {
    booting: "Mesin terjemahan sedang dimulai",
    ready: "Mesin terjemahan berjalan",
    closing: "Mesin terjemahan sedang berhenti",
    failed: "Mesin terjemahan gagal",
  },
  detectorBackend: { webgpu: "GPU (WebGPU)", wasm: "CPU (WASM)", none: "belum dipilih" },
  detectorState: { unloaded: "belum dimuat", loading: "memuat", ready: "siap", failed: "gagal" },
  detectorCanary: {
    pass: "GPU terverifikasi",
    fail: "hasil GPU tidak konsisten, dialihkan ke CPU",
    pending: "memverifikasi GPU",
    skipped: "",
  },
  offlineState: {
    idle: "Model dimuat saat pertama kali digunakan",
    downloading: "Mengunduh model",
    loading: "Memuat model",
    ready: "Siap",
    failed: "Gagal",
  },
  ui: {
    appName: "Panelingo",
    siteEnable: "Terjemahkan situs ini",
    siteDisable: "Berhenti menerjemahkan situs ini",
    modeAuto: "Terjemahkan saat menggulir",
    modeManual: "Terjemahkan hanya saat diminta",
    translateVisible: "Terjemahkan gambar yang terlihat",
    translateImage: "Terjemahkan",
    retranslate: "Terjemahkan ulang",
    showOriginal: "Tampilkan aslinya",
    uploadsToday: (count: number, mb: number): string =>
      `Dikirim ke AI hari ini: ${count} gambar gabungan (${mb.toFixed(1).replace(".", ",")} MB)`,
    progress: (done: number, total: number, etaSec?: number): string =>
      etaSec === undefined || !Number.isFinite(etaSec)
        ? `Menerjemahkan ${done}/${total}`
        : `Menerjemahkan ${done}/${total} · ~${Math.max(1, Math.round(etaSec))} dtk`,
    privacyTitle: "Sebelum gambar dikirim ke AI",
    privacyBody:
      "Untuk menerjemahkan, ekstensi mengirim gambar gabungan dari panel komik yang berisi teks (hanya di situs yang " +
      "Anda aktifkan atau saat Anda memintanya) ke endpoint AI yang Anda konfigurasi. Penyedia AI dapat menyimpan " +
      "data yang diterimanya sesuai ketentuannya sendiri. Pastikan hal ini dapat diterima, baik bagi Anda maupun " +
      "bagi konten yang Anda baca.",
    privacyAccept: "Saya mengerti, izinkan pengiriman",
    privacyDecline: "Jangan kirim",
  },
  bubble: {
    original: "Teks asli",
    translation: "Terjemahan",
    save: "Simpan",
    revert: "Gunakan terjemahan AI",
    retranslate: "Terjemahkan ulang",
    close: "Tutup",
    dialog: "Balon terjemahan",
    copy: "Salin",
    editLabel: "Edit terjemahan",
    shortened: "Teks dipersingkat agar muat di balon.",
    saved: "Tersimpan.",
    retranslating: "Menerjemahkan ulang…",
  },
  menu: {
    translateImage: "Terjemahkan gambar ini",
    retranslateImage: "Terjemahkan ulang gambar ini",
  },
  sidepanel: {
    title: "Panelingo – Transkrip",
    heading: "Transkrip",
    empty: "Belum ada baris yang diterjemahkan di tab ini.",
    emptyHint:
      "Buka halaman komik di situs yang sudah Anda aktifkan. Baris akan muncul di sini saat diterjemahkan.",
    refresh: "Muat ulang",
    copy: "Salin semua",
    copied: "Disalin ke papan klip.",
    page: (n: number): string => `Halaman ${n}`,
    jump: "Tampilkan",
    jumpHint: "Gulir halaman ke balon ini",
    edit: "Edit",
    save: "Simpan",
    cancel: "Batal",
    retranslate: "Terjemahkan ulang",
    revert: "Batalkan edit",
    noTranslation: "Belum ada terjemahan",
    notFound: "Balon ini sudah tidak ada di halaman.",
    failed: "Gagal. Coba lagi.",
    types: {
      dialogue: "Dialog",
      thought: "Pikiran",
      narration: "Narasi",
      sign: "Papan",
      sfx: "Efek suara",
      ignore: "Diabaikan",
    },
    inconsistent: "Berbeda dari glosarium",
    tabs: { transcript: "Transkrip", glossary: "Glosarium" },
    glossary: {
      noSeries: "Buka halaman komik untuk melihat glosarium serinya.",
      untitled: "Seri tanpa judul",
      states: {
        manual: "Entri Anda",
        confirmed: "Dikonfirmasi",
        learned: "Dipelajari",
        candidate: "Saran",
      },
      hints: {
        manual: "Selalu dipakai. AI tidak pernah mengubahnya.",
        confirmed: "Saran yang Anda terima. Selalu dipakai.",
        learned: "Nama dan istilah yang dipakai AI di beberapa permintaan. Dikirim di setiap permintaan.",
        candidate: "Baru sekali dikenali AI. Tidak dikirim sampai dikonfirmasi atau terlihat lagi.",
      },
      empty: "Belum ada entri. Nama dan istilah muncul di sini saat AI mengenalinya, atau tambahkan sendiri.",
      original: "Teks asli",
      translation: "Terjemahan",
      note: "Catatan (opsional)",
      add: "Tambah",
      delete: "Hapus",
      confirm: "Konfirmasi",
      seen: (count: number): string => `Terlihat ${count} kali`,
      incomplete: "Masukkan teks asli dan terjemahannya.",
      profileHeading: "Pengaturan seri",
      sourceLang: "Bahasa sumber",
      langAuto: "Deteksi otomatis",
      langs: {
        ja: "Jepang",
        ko: "Korea",
        zh: "Mandarin",
        en: "Inggris",
        es: "Spanyol",
        other: "Lainnya",
      },
      koNames: "Nama Korea",
      koRomanized: "Romanisasi (Minjun)",
      koHanViet: "Sino-Vietnam (untuk terjemahan bahasa Vietnam)",
      keepHonorifics: "Pertahankan honorifik Jepang (-san, -kun)",
      summary: "Kirim ringkasan cerita yang terus diperbarui",
      saveProfile: "Simpan pengaturan",
      saved: "Tersimpan.",
      export: "Ekspor",
      import: "Impor",
      imported: (count: number): string => `${count} entri diimpor.`,
      importFailed: "File ini bukan glosarium Panelingo.",
      address: {
        heading: "Bentuk sapaan",
        hint: "Cara tiap tokoh menyebut dirinya dan lawan bicaranya. AI mengisinya selama Anda membaca dan menjaganya tetap sama; aturan Anda sendiri tidak pernah diubah.",
        speaker: "Penutur",
        listener: "Lawan bicara",
        self: "Menyebut dirinya",
        other: "Memanggil lawan bicara",
        learned: "Dipelajari AI",
        mine: "Milik Anda",
        keep: "Simpan",
        addHeading: "Tambah bentuk sapaan",
        incomplete: "Isi kedua nama dan setidaknya satu bentuk sapaan.",
        full: "Daftar sudah penuh. Hapus satu aturan dulu.",
        empty: "Belum ada. Pasangan muncul di sini saat AI menemuinya.",
      },
    },
  },
  debug: { heading: "Debug (khusus build dev/uji)" },
  duration: (ms: number): string => {
    const seconds = Math.round(Math.abs(ms) / 1000);
    if (seconds < 60) return `${seconds} dtk`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} mnt`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} jam`;
    return `${Math.round(hours / 24)} hari`;
  },
  popup: {
    siteToggle: "Terjemahkan di situs ini",
    progressDone: (count: number): string => `Selesai: ${count} gambar di halaman ini`,
    more: "Lainnya untuk situs ini",
    siteSettings: "Semua setelan untuk situs ini",
    openTranscript: "Buka transkrip",
    cookies: "Kirim cookie saat memuat gambar",
    cookiesHint:
      "Untuk situs yang hanya menampilkan gambar kepada pembaca yang sudah masuk. Cookie hanya dikirim ke server gambar, tidak pernah ke AI.",
    engineHeading: "Mesin terjemahan",
    siteHeading: "Situs ini",
    checking: "Memeriksa…",
    model: (model: string): string => `Model: ${model}`,
    endpoint: (url: string): string => `Endpoint: ${url}`,
    cause: (cause: string): string => `Detail: ${cause}`,
    engineStopped: "Mesin terjemahan sedang tidak aktif dan akan mulai saat Anda menerjemahkan.",
    engineUnreadable: "Tidak dapat membaca status mesin terjemahan.",
    offlineHeading: "Mode offline (eksperimental)",
    offlineHint:
      "Tidak ada endpoint AI yang digunakan: pengenalan teks dan terjemahan berjalan di perangkat ini.",
    offlineDownload: (doneMb: number, totalMb: number): string =>
      `Mengunduh ${Math.round(doneMb)} dari ${Math.round(totalMb)} MB`,
    offlineModels: (models: string): string => `Model: ${models}`,
    detectorLine: (backend: string, state: string, canary: string): string =>
      `Deteksi teks: ${backend}, ${state}${canary === "" ? "" : ` (${canary})`}`,
    queueLine: (queued: number, inFlight: number, done: number, failed: number): string =>
      `Antrean: ${queued} menunggu · ${inFlight} sedang dikirim · ${done} selesai · ${failed} gagal`,
    pausedBy: (title: string): string => `Dijeda: ${title}`,
    siteUnsupported: "Halaman ini tidak dapat diterjemahkan (hanya halaman http/https).",
    modeLabel: "Mode",
    visibleSent: (count: number): string =>
      count > 0 ? `${count} gambar dikirim untuk diterjemahkan.` : "Tidak ada gambar komik yang terlihat.",
    visibleUnavailable: "Ekstensi tidak dapat berjalan di halaman ini.",
    retranslatePage: "Terjemahkan ulang halaman",
    retranslateQueued: (count: number): string => `${count} balon kata ditambahkan kembali ke antrean.`,
    actionFailed: (title: string): string => `Tindakan gagal: ${title}`,
    privacyDetails: "Lihat apa yang dikirim",
    options: "Opsi",
    setupHint: "Siapkan endpoint AI Anda (URL dasar, kunci API, model) di Opsi untuk memulai.",
    consentHint:
      "Klik ikon Panelingo untuk membaca pemberitahuan privasi sebelum mengaktifkan terjemahan di sini.",
    build: (id: string): string => `Build ${id}`,
  },
  options: {
    tabs: {
      engine: {
        label: "Terjemahan",
        intro:
          "Apa yang menerjemahkan komik: model AI yang Anda hubungkan, atau model offline eksperimental di perangkat ini.",
      },
      display: {
        label: "Bahasa & tampilan",
        intro: "Bahasa yang Anda baca, bahasa antarmuka, dan tampilan terjemahan di halaman.",
      },
      sites: {
        label: "Situs",
        intro:
          "Situs tempat Panelingo menerjemahkan. Aktifkan situs dari popup di bilah alat saat Anda membacanya.",
      },
      privacy: {
        label: "Privasi & data",
        intro: "Apa yang dikirim ke AI, apa yang tetap di perangkat ini, dan cara mencadangkan setelan Anda.",
      },
      advanced: {
        label: "Lanjutan",
        intro:
          "Penyetelan halus untuk permintaan, deteksi teks, pencarian gambar, dan cache. Nilai bawaan cocok untuk sebagian besar penggunaan; setiap perubahan disimpan saat Anda meninggalkan kolom.",
      },
    },
    controlsHeading: "Tombol dan klik",
    exportLog: "Ekspor log debug",
    exportFailed: "Log debug tidak dapat diekspor.",
    exportEmpty: "Log debug kosong.",
    title: "Opsi",
    apiHeading: "Endpoint AI (kompatibel dengan OpenAI)",
    apiIntro:
      "Layanan apa pun yang mendukung API chat completions OpenAI dan menerima gambar dapat digunakan: OpenAI, " +
      "OpenRouter, Azure OpenAI, Google Gemini (mode OpenAI), atau server lokal seperti Ollama, LM Studio, vLLM, " +
      "atau LiteLLM.",
    preset: "Preset",
    presetCustom: "Kustom",
    baseUrl: "URL dasar",
    baseUrlHint:
      "Sertakan jalur versinya, misalnya https://api.openai.com/v1 atau http://127.0.0.1:11434/v1.",
    baseUrlInvalid: "Bukan URL http(s) yang valid.",
    apiKey: "Kunci API",
    apiKeyHint:
      "Hanya disimpan di profil browser ini; kosongkan untuk server lokal yang tidak memerlukannya.",
    model: "Model",
    modelHint:
      "Model harus menerima input gambar (vision), misalnya gpt-4o-mini, gemini-2.5-flash, qwen2.5-vl.",
    modelInvalid: "Masukkan ID model.",
    testConnection: "Uji koneksi",
    testing: "Menguji…",
    testOk: (detail: string): string => `Terhubung. ${detail}`,
    testFailed: (detail: string): string => `Gagal: ${detail}`,
    concurrency: "Permintaan terjemahan paralel",
    concurrencyHint: "Bawaan 2; maksimal 4. Turunkan jika penyedia Anda membatasi laju permintaan.",
    concurrencyInvalid: "Pilih angka dari 1 sampai 4.",
    languageHeading: "Bahasa",
    uiLanguage: "Bahasa antarmuka",
    targetLanguage: "Terjemahkan ke",
    languageAuto: "Sama dengan browser",
    save: "Simpan",
    saved: "Tersimpan.",
    saveFailed: "Tidak dapat menyimpan.",
    sitesEmpty:
      "Belum ada situs. Buka halaman komik, klik ikon ekstensi, lalu aktifkan terjemahan untuk situs itu.",
    siteEnabled: "Aktif",
    siteMode: "Mode",
    siteRemove: "Hapus",
    privacyHeading: "Privasi: apa yang dikirim ke AI",
    privacyPoints: [
      "Untuk setiap terjemahan, ekstensi mengirim satu gambar gabungan JPEG ke endpoint AI yang Anda konfigurasi: " +
        "gambar mini dari setiap gambar (atau potongan webtoon) yang berisi teks, kotak bernomor di sekitar setiap " +
        "area teks, dan versi yang diperbesar dari area-area tersebut.",
      "Teks yang ikut dikirim: aturan format dan bahasa, glosarium seri (hingga 60 entri), hingga 20 baris " +
        "sebelumnya dari bab yang sama, serta ringkasan singkat.",
      "Tidak pernah dikirim: gambar tanpa teks, alamat halaman yang Anda baca, cookie, alamat IP Anda, atau header " +
        "browser (selain yang memang disertakan oleh setiap permintaan ke endpoint Anda).",
      "Penyedia AI dapat menyimpan data yang diterimanya sesuai ketentuannya sendiri. Anggap semua yang dikirim " +
        "telah disimpan.",
      "Hanya situs yang Anda aktifkan yang diterjemahkan saat Anda menggulir. Halaman lain hanya diterjemahkan saat " +
        "Anda memintanya (melalui menu konteks atau pintasan). Ekstensi juga selalu meminta izin sebelum unggahan " +
        "pertama.",
      "Popup menampilkan jumlah gambar gabungan yang dikirim hari ini.",
      "Di perangkat ini, terjemahan, posisi balon kata, dan lapisan penghapus teks disimpan di IndexedDB milik " +
        "ekstensi; Anda dapat menghapusnya di bagian Cache di bawah.",
    ],
    privacyAcked: (when: string): string =>
      `Anda telah mengonfirmasi pemberitahuan pengiriman gambar pada ${when}.`,
    privacyNotAcked:
      "Anda belum mengonfirmasi pemberitahuan pengiriman gambar; ekstensi akan meminta izin sebelum unggahan pertama.",
    cacheHeading: "Cache",
    cacheHint:
      "Hapus semua terjemahan, posisi balon kata, dan lapisan penghapus teks yang tersimpan di perangkat ini. Saat " +
      "dibaca lagi, gambar akan diterjemahkan (dan dikirim) ulang.",
    cacheClear: "Hapus seluruh cache",
    cacheConfirm: "Hapus seluruh cache? Saat Anda membaca lagi, gambar akan diterjemahkan dan dikirim ulang.",
    cacheCleared: (count: number): string => `Berhasil menghapus ${count} entri.`,
    cacheFailed: (title: string): string => `Tidak dapat menghapus cache: ${title}`,
    debugHeading: "Log debug",
    logLevel: "Tingkat log",
    logLevels: {
      debug: "Terperinci (debug)",
      info: "Info",
      warn: "Peringatan",
      error: "Hanya kesalahan",
    },
  },
  optionsAdvanced: {
    search: "Cari setelan",
    modifiedOnly: "Hanya setelan yang diubah",
    matches: (count: number): string => `${count} setelan`,
    noMatch: "Tidak ada setelan yang cocok dengan pencarian Anda.",
    defaultIs: (value: string): string => `Bawaan: ${value}`,
    range: (min: string, max: string): string => `Diizinkan: ${min} sampai ${max}`,
    automatic: "otomatis",
    on: "aktif",
    off: "nonaktif",
    reset: "Setel ulang",
    resetLabel: (label: string): string => `Setel ulang “${label}” ke nilai bawaan`,
    resetAll: "Setel ulang semua pengaturan lanjutan",
    resetAllConfirm: "Setel ulang semua pengaturan lanjutan ke nilai bawaannya?",
    resetAllDone: "Semua pengaturan lanjutan sudah kembali ke nilai bawaan.",
    notANumber: "Masukkan angka.",
    adjusted: (value: string): string => `Disimpan sebagai ${value}, nilai terdekat yang diizinkan.`,
    badKey: "Gunakan kode tombol seperti Backquote atau KeyH, atau biarkan kosong.",
    verticalChoices: { auto: "Otomatis", never: "Tidak pernah" },
    groups: {
      api: "Permintaan AI",
      translate: "Isi permintaan",
      detector: "Deteksi teks",
      engine: "Mesin terjemahan",
      discovery: "Pencarian gambar",
      render: "Tampilan terjemahan",
      memory: "Memori seri",
      cache: "Cache",
      privacy: "Batas gambar",
      debug: "Log debug",
    },
    fields: {
      "api.temperature": {
        label: "Temperatur",
        hint: "Seberapa bervariasi jawabannya. Kosongkan untuk memakai nilai bawaan penyedia.",
      },
      "api.urgentLane": {
        label: "Jalur tambahan untuk gambar di layar",
        hint: "Menambah satu jalur permintaan khusus untuk gambar yang sedang Anda lihat.",
      },
      "api.maxInFlight": {
        label: "Permintaan maksimum sekaligus",
        hint: "Batas mutlak, termasuk jalur tambahan. Tidak pernah lebih rendah dari permintaan terjemahan paralel.",
      },
      "api.firstByteTimeoutMs": {
        label: "Tunggu respons pertama (detik)",
        hint: "Menyerah jika endpoint tidak mengirim apa pun selama ini.",
      },
      "api.idleTimeoutMs": {
        label: "Batas waktu jawaban macet (detik)",
        hint: "Menyerah jika jawaban berhenti mengalir selama ini.",
      },
      "api.totalTimeoutMs": {
        label: "Waktu permintaan maksimum (detik)",
        hint: "Menyerah pada permintaan apa pun setelah selama ini.",
      },
      "api.healthTimeoutMs": {
        label: "Batas waktu pemeriksaan koneksi (detik)",
        hint: "Dipakai oleh pemeriksaan endpoint dan oleh Uji koneksi.",
      },
      "translate.boxBudget": {
        label: "Area teks per permintaan",
        hint: "Kosongkan untuk memakai profil model (12, 16, atau 20).",
      },
      "translate.packWaitMs": {
        label: "Jeda untuk mengelompokkan gambar (ms)",
        hint: "Berapa lama teks satu gambar menunggu gambar berikutnya di halaman agar berbagi satu permintaan. 0 mengirim setiap gambar langsung.",
      },
      "translate.urgentPackMax": {
        label: "Balon pada permintaan pertama di layar",
        hint: "Permintaan pertama gambar yang tampil berisi paling banyak sejumlah balon ini agar muncul lebih cepat. 0 = tanpa batas tersendiri.",
      },
      "translate.jpegQuality": {
        label: "Kualitas JPEG",
        hint: "Kualitas gambar gabungan yang dikirim ke AI.",
      },
      "translate.requestBodyCapMb": {
        label: "Ukuran permintaan maksimum (MB)",
        hint: "Gambar gabungan yang lebih besar dikompresi lebih kuat, lalu dipecah.",
      },
      "translate.promptCharCap": {
        label: "Panjang prompt maksimum (karakter)",
        hint: "Jika permintaan lebih panjang, konteksnya dipersingkat lebih dulu.",
      },
      "translate.maxLadderRequestsPerPack": {
        label: "Permintaan tambahan untuk teks yang terlewat",
        hint: "Meminta ulang dan memecah permintaan saat AI melewatkan area teks.",
      },
      "translate.maxHttpRetriesPerRequest": {
        label: "Percobaan ulang setelah kesalahan jaringan",
        hint: "Per permintaan, untuk kegagalan HTTP dan jaringan yang bersifat sementara.",
      },
      "translate.engine": {
        label: "Mesin terjemahan",
        hint: "Mode offline masih eksperimental: lihat Mode offline di atas.",
      },
      "translate.offlineModel": {
        label: "Model terjemahan offline",
        hint: "Hanya digunakan dalam mode offline.",
      },
      "translate.splitOnRefusal": {
        label: "Pecah permintaan yang ditolak",
        hint: "Saat AI menolak, coba kedua bagiannya secara terpisah alih-alih menyerah.",
      },
      "detector.backend": {
        label: "Perangkat keras deteksi",
        hint: "Otomatis memakai GPU jika lolos uji mandiri, jika tidak memakai CPU.",
      },
      "detector.scoreMin": {
        label: "Skor deteksi minimum",
        hint: "Nilai lebih rendah menemukan lebih banyak teks, juga lebih banyak deteksi keliru.",
      },
      "detector.sliceTriggerRatio": {
        label: "Potong gambar yang lebih panjang dari (rasio)",
        hint: "Gambar dan strip webtoon yang sisi panjangnya melebihi kelipatan sisi pendek ini dipotong menjadi beberapa bagian.",
      },
      "detector.sliceHeightRatio": {
        label: "Panjang potongan (× sisi pendek)",
        hint: "Panjang setiap potongan sebagai kelipatan sisi pendek gambar.",
      },
      "detector.sliceOverlap": {
        label: "Tumpang tindih potongan (pecahan)",
        hint: "Tumpang tindih antara potongan yang bersebelahan, sebagai pecahan dari satu potongan.",
      },
      "detector.sliceOverlapMinPx": {
        label: "Tumpang tindih potongan minimum (piksel)",
        hint: "Potongan yang bersebelahan selalu berbagi minimal sejumlah piksel ini.",
      },
      "detector.quietRows": {
        label: "Potong di antara baris teks",
        hint: "Eksperimental: memindahkan garis potong ke baris tanpa tinta.",
      },
      "engine.idleCloseMin": {
        label: "Tutup mesin yang menganggur setelah (menit)",
        hint: "Membebaskan memori jika tidak ada halaman yang memakai mesin selama ini.",
      },
      "engine.detectorReleaseMin": {
        label: "Lepas deteksi teks setelah (menit)",
        hint: "Melepas model deteksi jika tidak berjalan selama ini.",
      },
      "engine.portIdleMin": {
        label: "Putuskan halaman yang menganggur setelah (menit)",
        hint: "Halaman melepas mesin setelah selama ini tanpa pekerjaan.",
      },
      "discovery.minNaturalSide": {
        label: "Abaikan gambar yang lebih kecil dari (piksel)",
        hint: "Ukuran asli sisi pendek. Melewati ikon, avatar, dan iklan.",
      },
      "discovery.minDisplayedSide": {
        label: "Abaikan gambar yang tampil lebih kecil dari (piksel)",
        hint: "Ukuran sisi pendek di layar.",
      },
      "discovery.secondsPerScreenDefault": {
        label: "Kecepatan baca awal (detik per layar)",
        hint: "Perkiraan awal hingga kecepatan baca Anda terukur.",
      },
      "discovery.lookaheadMinScreens": {
        label: "Terjemahan di depan, minimum (layar)",
        hint: "Gambar sejauh ini di bawah tampilan selalu diterjemahkan sebelum Anda sampai.",
      },
      "discovery.lookaheadMaxScreens": {
        label: "Terjemahan di depan, maksimum (layar)",
        hint: "Batas atas saat Anda membaca cepat atau AI lambat.",
      },
      "discovery.lookaheadMaxScreensStrip": {
        label: "Terjemahan di depan pada strip webtoon, maksimum (layar)",
        hint: "Batas atas untuk strip vertikal yang panjang.",
      },
      "discovery.detectAheadMinScreens": {
        label: "Deteksi di depan, minimum (layar)",
        hint: "Gambar yang belum dimuat halaman dideteksi sejauh ini di depan (tanpa unggahan).",
      },
      "discovery.detectAheadMaxScreens": {
        label: "Deteksi di depan, maksimum (layar)",
        hint: "Batas atas untuk pembaca cepat.",
      },
      "discovery.detectMaxImages": {
        label: "Gambar yang dideteksi di depan, paling banyak",
        hint: "Menghitung setiap gambar di depan Anda, sudah dimuat atau belum.",
      },
      "discovery.fetchPerHostConcurrency": {
        label: "Unduhan gambar paralel per server",
        hint: "Jumlah gambar yang diunduh sekaligus dari server gambar yang sama.",
      },
      "discovery.prefetchSpacingMs": {
        label: "Jeda antar-unduhan gambar (milidetik)",
        hint: "Waktu minimum antara dua unduhan dari server yang sama.",
      },
      "discovery.scrollDebounceMs": {
        label: "Jeda reaksi gulir (milidetik)",
        hint: "Tunggu selama ini setelah menggulir sebelum menyusun ulang pekerjaan.",
      },
      "discovery.mutationDebounceMs": {
        label: "Jeda reaksi perubahan halaman (milidetik)",
        hint: "Tunggu selama ini setelah halaman berubah (lazy loading, aplikasi pembaca) sebelum mencari gambar baru.",
      },
      "discovery.stripGapPx": {
        label: "Celah maksimum dalam strip webtoon (piksel)",
        hint: "Gambar yang lebih dekat dari ini membentuk satu strip bersambung.",
      },
      "discovery.translateHiddenTabs": {
        label: "Terjemahkan di tab latar belakang",
        hint: "Nonaktif: mode otomatis menunggu sampai tab pernah ditampilkan.",
      },
      "render.font": {
        label: "Font dialog",
        hint: "Font teks terjemahan di balon kata.",
      },
      "render.verticalText": {
        label: "Teks vertikal",
        hint: "Terjemahan bahasa Jepang atau Tionghoa Tradisional ditulis dari atas ke bawah di balon vertikal. Pilihan Tidak pernah membuat semua terjemahan tetap mendatar.",
      },
      "render.minFontPx": {
        label: "Ukuran teks terkecil (piksel)",
        hint: "Teks yang tidak muat pada ukuran ini dipersingkat dengan “…”.",
      },
      "render.maxFontPx": {
        label: "Ukuran teks terbesar (piksel)",
        hint: "Teks juga tetap mendekati ukuran tulisan aslinya.",
      },
      "render.eraseSfx": {
        label: "Hapus efek suara",
        hint: "Hapus efek suara dari gambar alih-alih memberinya label.",
      },
      "render.sfxLabels": {
        label: "Beri label efek suara",
        hint: "Tampilkan terjemahan efek suara sebagai label kecil.",
      },
      "render.showDoneBadge": {
        label: "Tandai gambar yang sudah diterjemahkan",
        hint: "Menampilkan lencana kecil pada setiap gambar yang sudah diterjemahkan.",
      },
      "render.peekKey": {
        label: "Tahan untuk melihat aslinya (kode tombol)",
        hint: "Kode tombol seperti Backquote atau KeyH. Kosongkan untuk menonaktifkan.",
      },
      "render.peekWithAlt": {
        label: "Tampilkan juga aslinya saat Alt ditahan",
        hint: "Menahan tombol Alt saja juga menyembunyikan terjemahan.",
      },
      "render.popupWithAltClick": {
        label: "Alt+klik membuka jendela balon kata",
        hint: "Jendela ini menampilkan teks asli dan memungkinkan Anda menyunting terjemahan. Tekan lama selalu membukanya.",
      },
      "memory.enabled": {
        label: "Gunakan memori seri",
        hint: "Mengirim glosarium, baris sebelumnya, dan ringkasan cerita bersama setiap permintaan, serta mempelajari nama dari jawaban.",
      },
      "memory.glossaryInPrompt": {
        label: "Entri glosarium per permintaan",
        hint: "Entri Anda lebih dulu, lalu yang dikonfirmasi, lalu yang dipelajari.",
      },
      "memory.termMinSightings": {
        label: "Kemunculan sebelum istilah dipelajari",
        hint: "Jumlah permintaan berbeda yang harus menyebut suatu istilah sebelum istilah itu dikirim.",
      },
      "memory.historyMaxLines": {
        label: "Baris sebelumnya yang dikirim sebagai konteks",
        hint: "Baris dari bab yang sama. 0 berarti tidak ada yang dikirim.",
      },
      "memory.historyMaxTokens": {
        label: "Anggaran token untuk baris sebelumnya",
        hint: "Baris tertua dibuang lebih dulu.",
      },
      "memory.summaryMaxWords": {
        label: "Panjang ringkasan cerita (kata)",
        hint: "0 menonaktifkan ringkasan yang terus diperbarui.",
      },
      "memory.warmUp": {
        label: "Panaskan seri baru",
        hint: "Selama seri belum punya memori, permintaan pertamanya dikirim sendiri agar halaman berikutnya memakai ulang nama dan sapaan darinya. Halaman pertama sedikit lebih lama.",
      },
      "cache.translationTtlDays": {
        label: "Simpan terjemahan yang tidak dipakai selama (hari)",
        hint: "Hasil edit Anda sendiri tidak pernah kedaluwarsa.",
      },
      "cache.encodedBytesLruMb": {
        label: "Cache gambar yang diunduh (MB)",
        hint: "Memori yang dipakai mesin untuk menyimpan gambar yang diunduh.",
      },
      "privacy.maxImageBytes": {
        label: "File gambar terbesar (MiB)",
        hint: "File gambar yang lebih besar dilewati.",
      },
      "privacy.maxImagePixels": {
        label: "Gambar terbesar (megapiksel)",
        hint: "Gambar dengan jumlah piksel lebih banyak dilewati.",
      },
      "debug.logCapacity": {
        label: "Entri log yang disimpan",
        hint: "Ukuran log debug yang disimpan mesin.",
      },
    },
    site: {
      settings: "Pengaturan",
      settingsFor: (site: string): string => `Pengaturan untuk ${site}`,
      layout: "Tata letak dan arah baca",
      layouts: {
        auto: "Deteksi otomatis",
        webtoon: "Webtoon (strip vertikal)",
        "paged-rtl": "Per halaman, kanan ke kiri (manga)",
        "paged-ltr": "Per halaman, kiri ke kanan (komik)",
      },
      sourceLangHint: "Memilih instruksi khusus bahasa untuk AI dan seberapa besar potongan teks diperbesar.",
      referer: "Referer untuk unduhan gambar",
      referers: {
        auto: "Otomatis",
        "page-url": "Alamat halaman lengkap",
        origin: "Hanya alamat situs",
      },
      refererHint:
        "Otomatis mengikuti halaman, lalu mencoba lagi dengan alamat halaman lengkap jika server gambar " +
        "menolak. Ubah hanya jika gambar gagal dimuat.",
      subdomains: "Juga di subdomain",
      subdomainsHint: "Terjemahkan di setiap subdomain situs ini dengan pengaturan yang sama.",
      prefetch: "Siapkan gambar lebih awal",
      prefetchHint:
        "Mendeteksi gambar di bawah tampilan yang belum dimuat halaman agar siap saat Anda sampai. Tidak ada yang diunggah sampai gambar sudah dekat.",
      frames: "Frame pembaca dari situs lain",
      framesHint:
        "Satu origin per baris, mis. https://viewer.example.com, jika halaman ditampilkan di dalam frame " +
        "yang disajikan dari situs lain.",
      framesInvalid: (lines: string): string => `Bukan origin http(s): ${lines}`,
    },
    transfer: {
      heading: "Cadangkan dan pulihkan",
      hint:
        "Simpan pengaturan dan daftar situs Anda ke file JSON, atau muat dari file tersebut. Konfirmasi " +
        "privasi tidak pernah diekspor.",
      includeKey: "Sertakan kunci API",
      includeKeyHint: "Biarkan nonaktif sebelum membagikan file: siapa pun dapat membaca kunci di dalamnya.",
      export: "Ekspor pengaturan",
      import: "Impor pengaturan",
      importConfirm:
        "Ganti pengaturan Anda dengan yang ada di file? Situs dalam file akan ditambahkan atau diperbarui.",
      notJson: "File ini bukan JSON yang valid.",
      notSettings: "File ini bukan ekspor pengaturan Panelingo.",
      tooNew: "File ini dibuat oleh versi Panelingo yang lebih baru.",
      imported: (settings: number, sites: number): string =>
        `Diimpor. Pengaturan yang berubah: ${settings}. Situs: ${sites}.`,
      keyImported: "Kunci API dari file telah diimpor.",
      keyKept: "Kunci API Anda tetap dipakai (file tidak berisi kunci).",
    },
  },
  offline: {
    heading: "Mode offline (eksperimental)",
    intro:
      "Terjemahkan tanpa endpoint AI apa pun: model sumber terbuka untuk pengenalan teks (PaddleOCR) dan terjemahan berjalan di perangkat ini. Kualitasnya jelas lebih rendah daripada model vision: tidak ada konteks antarbalon, tidak ada nama tokoh, huruf bergaya sering salah terbaca, dan efek suara dibiarkan tanpa terjemahan.",
    download:
      "Model diunduh sekali dari Hugging Face saat pertama kali diperlukan, diperiksa, lalu disimpan di perangkat ini; setelah itu terjemahan tidak memerlukan jaringan. Ukuran: pengenalan teks 8 sampai 17 MB per bahasa, Opus-MT sekitar 115 MB per pasangan bahasa (dua kali lipat jika melalui bahasa Inggris), NLLB-200 sekitar 910 MB.",
    engine: "Mesin terjemahan",
    engineChoices: {
      api: "Endpoint AI (kompatibel dengan OpenAI)",
      offline: "Offline di perangkat ini (eksperimental)",
    },
    model: "Model terjemahan offline",
    modelChoices: {
      "opus-mt": "Opus-MT: kecil, satu model per pasangan bahasa",
      "nllb-600m": "NLLB-200 600M: semua pasangan, besar, nonkomersial",
    },
    pairs:
      "Opus-MT menerjemahkan bahasa Korea, Jepang, Tionghoa, dan Spanyol ke bahasa Inggris, serta bahasa Inggris ke bahasa Vietnam, Spanyol, Prancis, Jerman, Italia, dan Indonesia; pasangan lain melalui bahasa Inggris. NLLB-200 menerjemahkan antarsemua bahasa yang tercantum di sini.",
    license:
      "Lisensi: PaddleOCR dan sebagian besar model Opus-MT Apache-2.0, dua model Opus-MT CC-BY-4.0, NLLB-200 CC-BY-NC-4.0 (hanya untuk penggunaan nonkomersial).",
    stored: (mb: number): string => `Model yang diunduh di perangkat ini: ${Math.round(mb)} MB`,
    deleteModels: "Hapus model yang diunduh",
    deleteConfirm: "Hapus model offline yang sudah diunduh? Model akan diunduh lagi saat diperlukan.",
    deleted: "Model yang diunduh telah dihapus.",
  },
  manifest: {
    description:
      "Terjemahkan komik, manga, dan webtoon langsung di halaman saat membaca, dengan AI apa pun yang kompatibel dengan OpenAI.",
    commands: {
      "toggle-overlay": "Tampilkan atau sembunyikan lapisan terjemahan",
      "translate-visible": "Terjemahkan gambar yang terlihat",
      "toggle-site": "Aktifkan atau nonaktifkan terjemahan otomatis untuk situs ini",
      "open-side-panel": "Buka panel samping transkrip",
    },
  },
};
