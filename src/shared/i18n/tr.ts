// Turkish UI catalog. PURE.
// Turkish keeps nouns singular after numerals ("5 görsel"), so no plural helper is needed. Interpolated values
// never take case suffixes (vowel harmony depends on the value); sentences are phrased so each value stands alone.

import type { Catalog } from "./en.ts";

const decimal = (value: number): string => value.toFixed(1).replace(".", ",");

const errors: Catalog["errors"] = {
  "api.unreachable": {
    title: "Yapay zeka uç noktasına ulaşılamıyor",
    hint: "Seçenekler'de Temel URL ayarını kontrol edin ve sunucunun (veya yerel modelinizin) çalıştığından emin olun.",
  },
  "api.lna_blocked": {
    title: "Chrome, yerel yapay zeka sunucunuzla bağlantıyı engelledi",
    hint: "Eklentinin site ayarlarını açın → Yerel ağ erişimi (Local network access) → İzin ver.",
  },
  "api.unauthorized": {
    title: "Yapay zeka uç noktası API anahtarını reddetti",
    hint: "Seçenekler'de geçerli bir API anahtarı girin. Çeviri otomatik olarak devam eder.",
  },
  "api.config": {
    title: "Yapay zeka uç noktası veya model yanlış yapılandırılmış",
    hint: "Seçenekler'de Temel URL ayarını kontrol edin ve görsel kabul eden (vision) bir model seçin.",
  },
  "api.rate_limit": {
    title: "Yapay zeka sağlayıcısı istekleri sınırlıyor",
    hint: "Eklenti kendiliğinden yavaşlar ve yeniden dener.",
  },
  "api.upstream": { title: "Yapay zeka sunucusu hatası, yeniden deneniyor", hint: "" },
  "api.context_length": { title: "İstek çok uzun, bölünüyor", hint: "" },
  "api.timeout": { title: "Yapay zekanın yanıtı çok uzun sürdü", hint: "Eklenti bir kez daha dener." },
  "api.truncated": { title: "Yanıt yarıda kesildi, devam ediliyor", hint: "" },
  "api.partial": { title: "Yapay zeka bazı balonları atladı, yeniden soruluyor", hint: "" },
  "api.empty": { title: "Yapay zekadan boş yanıt geldi, yeniden deneniyor", hint: "" },
  "api.too_large": { title: "Görsel gönderilemeyecek kadar büyük, küçültülüyor", hint: "" },
  "api.bad_request": {
    title: "İstek reddedildi (yazılım hatası)",
    hint: "Seçenekler'den hata ayıklama günlüğünü dışa aktarın.",
  },
  "api.protocol": { title: "Yapay zeka uç noktasından beklenmeyen yanıt biçimi", hint: "" },
  "llm.refused": { title: "Yapay zeka çevirmeyi reddetti", hint: "Balon orijinal metnini korur." },
  "llm.missing": {
    title: "Çevrilmedi",
    hint: "Yalnızca bu balonu yeniden denemek için “Yeniden çevir” seçeneğini kullanın.",
  },
  "llm.format": { title: "Yapay zekadan hatalı biçimli yanıt geldi, yeniden deneniyor", hint: "" },
  "image.url_blocked": { title: "Görsel güvenlik nedeniyle engellendi", hint: "" },
  "image.http": {
    title: "Görsel yüklenemedi",
    hint: "Site oturum açmanızı gerektiriyorsa açılır pencerede “Görsel isteklerinde çerezleri gönder” seçeneğini etkinleştirin.",
  },
  "image.not_image": { title: "Görsel dosyası değil", hint: "" },
  "image.too_large": { title: "Görsel çok büyük", hint: "" },
  "image.decode": { title: "Görselin kodu çözülemedi", hint: "" },
  "image.capture_unavailable": { title: "Çevirmek için görsele kaydırın", hint: "" },
  "image.capture_blocked": {
    title: "Bu görsel yalnızca ekran görüntüsüyle okunabilir",
    hint: "Bu sitede çeviriyi açın ve bu sekmeyi önde tutun, ardından yeniden deneyin.",
  },
  "detector.webgpu_unavailable": { title: "Metin CPU ile algılanıyor (daha yavaş)", hint: "" },
  "detector.canary_mismatch": { title: "GPU tutarsız sonuçlar verdi, CPU kullanılıyor", hint: "" },
  "detector.model_integrity": {
    title: "Metin algılama modeli bozuk",
    hint: "Eklentiyi yeniden kurun (geliştiriciler: npm run fetch-models, ardından npm run build).",
  },
  "detector.init": {
    title: "Metin algılama başlatılamadı",
    hint: "Seçenekler'den hata ayıklama günlüğünü dışa aktarın.",
  },
  "detector.run": { title: "Metin algılama başarısız oldu", hint: "" },
  "offline.pair_unsupported": {
    title: "Bu dil çifti çevrimdışı kullanılamıyor",
    hint: "Seçenekler'de çevrimdışı model olarak NLLB-200'ü veya başka bir hedef dili seçin.",
  },
  "offline.download": {
    title: "Çevrimdışı modeller indirilemedi",
    hint: "huggingface.co bağlantısını kontrol edin. Çeviri kendiliğinden yeniden denenir.",
  },
  "offline.model_integrity": {
    title: "İndirilen bir çevrimdışı model bozuk",
    hint: "Modeli yeniden indirmek için tekrar çevirin.",
  },
  "offline.run": {
    title: "Çevrimdışı modeller başarısız oldu",
    hint: "Seçenekler'den hata ayıklama günlüğünü dışa aktarın.",
  },
  "offline.out_of_memory": {
    title: "Çevrimdışı modeller için yeterli bellek yok",
    hint: "Çeviri modelleri yeniden başlatıldı, motor çalışmaya devam ediyor. Seçenekler'den Opus-MT'yi (çok daha küçük) seçin veya diğer sekmeleri kapatın.",
  },
  "engine.unavailable": {
    title: "Çeviri motoru başlatılamadı",
    hint: "Sayfayı yenileyin ya da eklentiyi kapatıp yeniden açın.",
  },
  "engine.closing": { title: "Motor yeniden başlatılıyor", hint: "" },
  "engine.overloaded": { title: "Motor meşgul", hint: "" },
  "engine.protocol": { title: "Eklenti sürümü uyuşmuyor", hint: "Sayfayı yenileyin." },
  "engine.internal": { title: "Dahili hata", hint: "Seçenekler'den hata ayıklama günlüğünü dışa aktarın." },
  "msg.too_large": { title: "Veri çok büyük, URL üzerinden yeniden yükleniyor", hint: "" },
  "ctx.invalidated": {
    title: "Eklenti az önce yeniden yüklendi",
    hint: "Çeviriye devam etmek için sayfayı yenileyin.",
  },
  "dnr.failed": { title: "Görsel için Referer ayarlanamadı", hint: "" },
  "store.io": { title: "Önbellek okunamadı veya yazılamadı", hint: "" },
  "store.quota": { title: "Önbellek dolu", hint: "Seçenekler'de önbelleğin bir kısmını temizleyin." },
  "site.disabled": { title: "Bu sitede çeviri kapalı", hint: "" },
  "privacy.consent": {
    title: "Görsellerin yapay zekaya gönderilmesi henüz onaylanmadı",
    hint: "Çeviriye başlamak için gizlilik bildirimini okuyun ve göndermeye izin verin.",
  },
  cancelled: { title: "İptal edildi", hint: "" },
};

export const TR: Catalog = {
  errors,
  readiness: {
    unknown: { label: "Yapay zeka uç noktası kontrol ediliyor…", hint: "" },
    ready: { label: "Yapay zeka uç noktası hazır", hint: "" },
    unauthorized: { label: "API anahtarı reddedildi", hint: errors["api.unauthorized"].hint },
    unreachable: { label: "Yapay zeka uç noktasına ulaşılamıyor", hint: errors["api.unreachable"].hint },
    lna_blocked: {
      label: "Chrome yerel yapay zeka sunucusunu engelledi",
      hint: errors["api.lna_blocked"].hint,
    },
    misconfigured: { label: "Yapay zeka uç noktası yapılandırılmamış", hint: errors["api.config"].hint },
  },
  imageState: {
    queued: "Sırada",
    acquiring: "Görsel yükleniyor",
    detecting: "Metin aranıyor",
    waiting: "Çeviri bekleniyor",
    translating: "Çevriliyor",
    done: "Çevrildi",
    "no-text": "Metin yok",
    partial: "Kısmen çevrildi",
    refused: "Yapay zeka reddetti",
    paused: "Duraklatıldı",
    error: "Hata",
    stale: "Güncel olmayan çeviri",
  },
  unitStatus: {
    pending: "Bekliyor",
    translating: "Çevriliyor",
    ok: "Çevrildi",
    "keep-original": "Olduğu gibi bırakıldı",
    manual: "Düzenlendi",
    untranslated: "Çevrilmedi",
    refused: "Yapay zeka reddetti",
    ignored: "Yok sayıldı",
    error: "Hata",
    stale: "Güncel değil",
  },
  enginePhase: {
    booting: "Motor başlatılıyor",
    ready: "Motor çalışıyor",
    closing: "Motor durduruluyor",
    failed: "Motor hatası",
  },
  detectorBackend: { webgpu: "GPU (WebGPU)", wasm: "CPU (WASM)", none: "henüz seçilmedi" },
  detectorState: { unloaded: "yüklenmedi", loading: "yükleniyor", ready: "hazır", failed: "başarısız" },
  detectorCanary: {
    pass: "GPU doğrulandı",
    fail: "GPU tutarsız sonuçlar verdi, CPU'ya geçildi",
    pending: "GPU doğrulanıyor",
    skipped: "",
  },
  offlineState: {
    idle: "Modeller ilk kullanımda yüklenir",
    downloading: "Modeller indiriliyor",
    loading: "Modeller yükleniyor",
    ready: "Hazır",
    failed: "Başarısız",
  },
  ui: {
    appName: "Panelingo",
    siteEnable: "Bu sitede çeviriyi aç",
    siteDisable: "Bu sitede çeviriyi kapat",
    modeAuto: "Kaydırırken çevir",
    modeManual: "Yalnızca istendiğinde çevir",
    translateVisible: "Görünen görselleri çevir",
    translateImage: "Çevir",
    retranslate: "Yeniden çevir",
    showOriginal: "Orijinali göster",
    uploadsToday: (count: number, mb: number): string =>
      `Bugün yapay zekaya ${count} birleşik görsel (${decimal(mb)} MB) gönderildi`,
    progress: (done: number, total: number, etaSec?: number): string =>
      etaSec === undefined || !Number.isFinite(etaSec)
        ? `Çevriliyor: ${done}/${total}`
        : `Çevriliyor: ${done}/${total} · ~${Math.max(1, Math.round(etaSec))} sn`,
    privacyTitle: "Görseller yapay zekaya gönderilmeden önce",
    privacyBody:
      "Eklenti, çeviri yapmak için metin içeren çizgi roman karelerinden oluşan birleşik görselleri (yalnızca " +
      "etkinleştirdiğiniz sitelerde veya siz istediğinizde) yapılandırdığınız yapay zeka uç noktasına gönderir. " +
      "Yapay zeka sağlayıcısı, aldığı verileri kendi koşulları çerçevesinde saklayabilir. Bunun sizin ve " +
      "okuduğunuz içerik için uygun olduğundan emin olun.",
    privacyAccept: "Anladım, göndermeye izin ver",
    privacyDecline: "Gönderme",
  },
  bubble: {
    original: "Orijinal",
    translation: "Çeviri",
    save: "Kaydet",
    revert: "Yapay zeka çevirisini kullan",
    retranslate: "Yeniden çevir",
    close: "Kapat",
    dialog: "Çevrilmiş balon",
    copy: "Kopyala",
    editLabel: "Çeviriyi düzenle",
    shortened: "Metin balona sığması için kısaltıldı.",
    saved: "Kaydedildi.",
    retranslating: "Yeniden çevriliyor…",
  },
  menu: {
    translateImage: "Bu görseli çevir",
    retranslateImage: "Bu görseli yeniden çevir",
  },
  sidepanel: {
    title: "Panelingo – Metin dökümü",
    heading: "Metin dökümü",
    empty: "Bu sekmede henüz çevrilmiş satır yok.",
    emptyHint:
      "Etkinleştirdiğiniz bir sitede bir çizgi roman sayfası açın. Satırlar çevrildikçe burada görünür.",
    refresh: "Yenile",
    copy: "Tümünü kopyala",
    copied: "Panoya kopyalandı.",
    page: (n: number): string => `Sayfa ${n}`,
    jump: "Göster",
    jumpHint: "Sayfayı bu balona kaydır",
    edit: "Düzenle",
    save: "Kaydet",
    cancel: "İptal",
    retranslate: "Yeniden çevir",
    revert: "Düzenlemeyi geri al",
    noTranslation: "Çeviri yok",
    notFound: "Bu balon artık sayfada değil.",
    failed: "Olmadı. Tekrar deneyin.",
    types: {
      dialogue: "Diyalog",
      thought: "Düşünce",
      narration: "Anlatım",
      sign: "Tabela",
      sfx: "Ses efekti",
      ignore: "Yok sayıldı",
    },
    inconsistent: "Sözlükten farklı",
    tabs: { transcript: "Metin dökümü", glossary: "Sözlük" },
    glossary: {
      noSeries: "Serisinin sözlüğünü görmek için bir çizgi roman sayfası açın.",
      untitled: "Adsız seri",
      states: {
        manual: "Girdileriniz",
        confirmed: "Onaylananlar",
        learned: "Öğrenilenler",
        candidate: "Öneriler",
      },
      hints: {
        manual: "Her zaman kullanılır. Yapay zeka bunları asla değiştirmez.",
        confirmed: "Kabul ettiğiniz öneriler. Her zaman kullanılır.",
        learned: "Yapay zekanın birden çok istekte kullandığı adlar ve terimler. Her istekle gönderilir.",
        candidate: "Yapay zeka bir kez fark etti. Onaylanana veya yeniden görülene kadar gönderilmez.",
      },
      empty:
        "Henüz girdi yok. Adlar ve terimler yapay zeka fark ettikçe burada görünür ya da kendinizinkileri ekleyin.",
      original: "Özgün metin",
      translation: "Çeviri",
      note: "Not (isteğe bağlı)",
      add: "Ekle",
      delete: "Sil",
      confirm: "Onayla",
      seen: (count: number): string => `${count} kez görüldü`,
      incomplete: "Özgün metni ve çevirisini girin.",
      profileHeading: "Seri ayarları",
      sourceLang: "Kaynak dil",
      langAuto: "Otomatik algıla",
      langs: {
        ja: "Japonca",
        ko: "Korece",
        zh: "Çince",
        en: "İngilizce",
        es: "İspanyolca",
        other: "Diğer",
      },
      koNames: "Korece adlar",
      koRomanized: "Latin harfleriyle (Minjun)",
      koHanViet: "Çin-Vietnam okunuşu (Vietnamca çeviriler için)",
      keepHonorifics: "Japonca hitap eklerini koru (-san, -kun)",
      summary: "Sürekli güncellenen bir hikâye özeti gönder",
      saveProfile: "Ayarları kaydet",
      saved: "Kaydedildi.",
      export: "Dışa aktar",
      import: "İçe aktar",
      imported: (count: number): string => `${count} girdi içe aktarıldı.`,
      importFailed: "Bu dosya bir Panelingo sözlüğü değil.",
    },
  },
  debug: { heading: "Hata ayıklama (yalnızca dev/test derlemelerinde)" },
  duration: (ms: number): string => {
    const seconds = Math.round(Math.abs(ms) / 1000);
    if (seconds < 60) return `${seconds} sn`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} dk`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} sa`;
    return `${Math.round(hours / 24)} gün`;
  },
  popup: {
    openTranscript: "Metin dökümünü aç",
    cookies: "Görsel isteklerinde çerezleri gönder",
    cookiesHint:
      "Görselleri yalnızca oturum açmış okurlara gösteren siteler için. Çerezler yalnızca görsel sunucusuna gider, yapay zekâya asla gitmez.",
    apiHeading: "Yapay zeka uç noktası",
    engineHeading: "Çeviri motoru",
    siteHeading: "Bu site",
    checking: "Kontrol ediliyor…",
    model: (model: string): string => `Model: ${model}`,
    endpoint: (url: string): string => `Uç nokta: ${url}`,
    cause: (cause: string): string => `Ayrıntılar: ${cause}`,
    engineStopped: "Motor boşta; çeviri yaptığınızda başlar.",
    engineUnreadable: "Motor durumu okunamadı.",
    offlineHeading: "Çevrimdışı mod (deneysel)",
    offlineHint: "Hiçbir yapay zeka uç noktası kullanılmaz: metin tanıma ve çeviri bu cihazda çalışır.",
    offlineDownload: (doneMb: number, totalMb: number): string =>
      `İndiriliyor: ${Math.round(totalMb)} MB içinden ${Math.round(doneMb)} MB`,
    offlineModels: (models: string): string => `Modeller: ${models}`,
    detectorLine: (backend: string, state: string, canary: string): string =>
      `Metin algılama: ${backend}, ${state}${canary === "" ? "" : ` (${canary})`}`,
    queueLine: (queued: number, inFlight: number, done: number, failed: number): string =>
      `Kuyruk: ${queued} bekliyor · ${inFlight} gönderiliyor · ${done} tamamlandı · ${failed} başarısız`,
    pausedBy: (title: string): string => `Duraklatıldı: ${title}`,
    siteUnsupported: "Bu sayfa çevrilemez (yalnızca http/https sayfaları).",
    siteOn: "Bu sitede çeviri açık.",
    siteOff: "Bu sitede çeviri kapalı.",
    modeLabel: "Mod",
    visibleSent: (count: number): string =>
      count > 0 ? `Çeviri için ${count} görsel gönderildi.` : "Görünürde çizgi roman görseli yok.",
    visibleUnavailable: "Eklenti bu sayfada çalışamaz.",
    retranslatePage: "Sayfayı yeniden çevir",
    retranslateQueued: (count: number): string => `${count} balon yeniden sıraya alındı.`,
    actionFailed: (title: string): string => `İşlem gerçekleştirilemedi: ${title}`,
    privacyDetails: "Nelerin gönderildiğini görün",
    options: "Seçenekler",
    setupHint:
      "Başlamak için Seçenekler'de yapay zeka uç noktanızı (Temel URL, API anahtarı, model) ayarlayın.",
    consentHint:
      "Burada çeviriyi açmadan önce gizlilik bildirimini okumak için Panelingo simgesine tıklayın.",
    build: (id: string): string => `Derleme ${id}`,
  },
  options: {
    exportLog: "Hata ayıklama günlüğünü dışa aktar",
    exportFailed: "Hata ayıklama günlüğü dışa aktarılamadı.",
    exportEmpty: "Hata ayıklama günlüğü boş.",
    title: "Seçenekler",
    apiHeading: "Yapay zeka uç noktası (OpenAI uyumlu)",
    apiIntro:
      "OpenAI chat completions API'sini destekleyen ve görsel kabul eden her hizmet çalışır: OpenAI, OpenRouter, " +
      "Azure OpenAI, Google Gemini (OpenAI modu) veya Ollama, LM Studio, vLLM ya da LiteLLM gibi yerel bir sunucu.",
    preset: "Hazır ayar",
    presetCustom: "Özel",
    baseUrl: "Temel URL",
    baseUrlHint: "Sürüm yolu dahil; ör. https://api.openai.com/v1 veya http://127.0.0.1:11434/v1.",
    baseUrlInvalid: "Geçerli bir http(s) URL'si değil.",
    apiKey: "API anahtarı",
    apiKeyHint:
      "Yalnızca bu tarayıcı profilinde saklanır; anahtar gerektirmeyen yerel sunucular için boş bırakın.",
    model: "Model",
    modelHint:
      "Model görsel girişini (vision) desteklemelidir; ör. gpt-4o-mini, gemini-2.5-flash, qwen2.5-vl.",
    modelInvalid: "Bir model kimliği girin.",
    testConnection: "Bağlantıyı test et",
    testing: "Test ediliyor…",
    testOk: (detail: string): string => `Bağlantı kuruldu. ${detail}`,
    testFailed: (detail: string): string => `Başarısız: ${detail}`,
    concurrency: "Paralel çeviri istekleri",
    concurrencyHint: "Varsayılan 2, en fazla 4. Sağlayıcınız istekleri sınırlıyorsa düşürün.",
    concurrencyInvalid: "1 ile 4 arasında bir sayı seçin.",
    languageHeading: "Diller",
    uiLanguage: "Arayüz dili",
    targetLanguage: "Çeviri dili",
    languageAuto: "Tarayıcıyla aynı",
    save: "Kaydet",
    saved: "Kaydedildi.",
    saveFailed: "Kaydedilemedi.",
    sitesHeading: "Siteler",
    sitesEmpty:
      "Henüz site yok. Bir çizgi roman sayfası açın, eklenti simgesine tıklayın ve o sitede çeviriyi açın.",
    siteEnabled: "Açık",
    siteMode: "Mod",
    siteRemove: "Kaldır",
    privacyHeading: "Gizlilik: yapay zekaya neler gönderilir",
    privacyPoints: [
      "Eklenti her çeviri için yapılandırdığınız yapay zeka uç noktasına tek bir JPEG birleşik görsel gönderir: " +
        "metin içeren görsellerin (veya webtoon dilimlerinin) küçük resimleri, her metin alanının çevresinde " +
        "numaralı kutular ve bu alanların büyütülmüş kırpıntıları.",
      "Görselle birlikte gönderilen metin: biçimlendirme ve dil kuralları, serinin terim sözlüğü (en fazla 60 " +
        "giriş), aynı bölümün önceki satırları (en fazla 20) ve kısa bir özet.",
      "Asla gönderilmez: metin içermeyen görseller, okuduğunuz sayfanın adresi, çerezler, IP adresiniz veya " +
        "tarayıcı başlıkları (uç noktanıza yapılan her isteğin zaten taşıdıkları dışında).",
      "Yapay zeka sağlayıcısı, aldığı verileri kendi koşulları çerçevesinde saklayabilir. Gönderilen her şeyin " +
        "saklandığını varsayın.",
      "Kaydırırken yalnızca etkinleştirdiğiniz siteler çevrilir. Diğer sayfalar yalnızca siz istediğinizde (sağ " +
        "tık menüsü veya kısayol) çevrilir ve eklenti ilk göndermeden önce her zaman izin ister.",
      "Açılır pencere, bugün kaç birleşik görsel gönderildiğini gösterir.",
      "Çeviriler, balon konumları ve silme yamaları bu cihazda, eklentinin IndexedDB veritabanında saklanır; " +
        "bunları aşağıdaki Önbellek bölümünden temizleyebilirsiniz.",
    ],
    privacyAcked: (when: string): string => `Görsel gönderme bildirimini onayladığınız tarih: ${when}.`,
    privacyNotAcked:
      "Görsel gönderme bildirimini henüz onaylamadınız; eklenti ilk göndermeden önce izin isteyecek.",
    cacheHeading: "Önbellek",
    cacheHint:
      "Bu cihazda saklanan tüm çevirileri, balon konumlarını ve silme yamalarını siler. Yeniden okuduğunuzda " +
      "görseller yeniden çevrilir (ve gönderilir).",
    cacheClear: "Tüm önbelleği temizle",
    cacheConfirm: "Tüm önbellek temizlensin mi? Bir sonraki okumada görseller yeniden çevrilip gönderilecek.",
    cacheCleared: (count: number): string => `${count} kayıt silindi.`,
    cacheFailed: (title: string): string => `Önbellek temizlenemedi: ${title}`,
    debugHeading: "Hata ayıklama günlüğü",
    logLevel: "Günlük düzeyi",
    logLevels: {
      debug: "Ayrıntılı (debug)",
      info: "Bilgi",
      warn: "Uyarılar",
      error: "Yalnızca hatalar",
    },
  },
  optionsAdvanced: {
    heading: "Gelişmiş ayarlar",
    intro:
      "İstekler, metin algılama, metin yerleşimi ve önbellekler için ince ayarlar. Varsayılanlar çoğu kullanım " +
      "için uygundur. Her değişiklik, alandan ayrıldığınızda kaydedilir.",
    defaultIs: (value: string): string => `Varsayılan: ${value}`,
    range: (min: string, max: string): string => `İzin verilen aralık: ${min} – ${max}`,
    automatic: "otomatik",
    on: "açık",
    off: "kapalı",
    reset: "Sıfırla",
    resetLabel: (label: string): string => `“${label}” ayarını varsayılana sıfırla`,
    resetAll: "Tüm gelişmiş ayarları sıfırla",
    resetAllConfirm: "Tüm gelişmiş ayarlar varsayılan değerlerine sıfırlansın mı?",
    resetAllDone: "Tüm gelişmiş ayarlar varsayılan değerlerine döndürüldü.",
    notANumber: "Bir sayı girin.",
    adjusted: (value: string): string => `İzin verilen en yakın değer kaydedildi: ${value}.`,
    badKey: "Backquote veya KeyH gibi bir tuş kodu kullanın ya da boş bırakın.",
    verticalChoices: { auto: "Otomatik", never: "Asla" },
    groups: {
      api: "Yapay zeka istekleri",
      translate: "İstek içeriği",
      detector: "Metin algılama",
      engine: "Motor",
      discovery: "Görsel bulma",
      render: "Metin yerleşimi",
      memory: "Seri hafızası",
      cache: "Önbellek",
      privacy: "Görsel sınırları",
      debug: "Hata ayıklama günlüğü",
    },
    fields: {
      "api.temperature": {
        label: "Sıcaklık",
        hint: "Yanıtların ne kadar çeşitli olacağı. Sağlayıcının varsayılanını kullanmak için boş bırakın.",
      },
      "api.urgentLane": {
        label: "Ekrandaki görseller için ek kanal",
        hint: "Yalnızca baktığınız görsellere ayrılmış bir istek kanalı daha ekler.",
      },
      "api.maxInFlight": {
        label: "Aynı anda en fazla istek",
        hint: "Ek kanal dahil kesin üst sınır. Paralel çeviri isteklerinden asla düşük olamaz.",
      },
      "api.firstByteTimeoutMs": {
        label: "İlk yanıt için bekleme süresi (saniye)",
        hint: "Uç nokta bu süre boyunca hiçbir şey göndermezse vazgeçilir.",
      },
      "api.idleTimeoutMs": {
        label: "Takılan yanıt zaman aşımı (saniye)",
        hint: "Yanıtın akışı bu süre boyunca durursa vazgeçilir.",
      },
      "api.totalTimeoutMs": {
        label: "En uzun istek süresi (saniye)",
        hint: "Bu süre dolduğunda her istekten vazgeçilir.",
      },
      "api.healthTimeoutMs": {
        label: "Bağlantı kontrolü zaman aşımı (saniye)",
        hint: "Uç nokta kontrolünde ve “Bağlantıyı test et” düğmesinde kullanılır.",
      },
      "translate.boxBudget": {
        label: "İstek başına metin alanı",
        hint: "Modelin profilini (12, 16 veya 20) kullanmak için boş bırakın.",
      },
      "translate.jpegQuality": {
        label: "JPEG kalitesi",
        hint: "Yapay zekaya gönderilen birleşik görselin kalitesi.",
      },
      "translate.requestBodyCapMb": {
        label: "En büyük istek boyutu (MB)",
        hint: "Daha büyük birleşik görseller önce daha fazla sıkıştırılır, sonra bölünür.",
      },
      "translate.promptCharCap": {
        label: "En uzun istem uzunluğu (karakter)",
        hint: "Bir istek daha uzunsa önce bağlam kısaltılır.",
      },
      "translate.maxLadderRequestsPerPack": {
        label: "Atlanan metni kurtarmak için ek istek",
        hint: "Yapay zeka metin alanlarını atladığında yeniden sorma ve bölme.",
      },
      "translate.maxHttpRetriesPerRequest": {
        label: "Ağ hatalarından sonra yeniden deneme",
        hint: "İstek başına; geçici HTTP ve ağ hataları için.",
      },
      "translate.engine": {
        label: "Çeviri motoru",
        hint: "Çevrimdışı mod deneyseldir: yukarıdaki Çevrimdışı mod bölümüne bakın.",
      },
      "translate.offlineModel": {
        label: "Çevrimdışı çeviri modeli",
        hint: "Yalnızca çevrimdışı modda kullanılır.",
      },
      "translate.splitOnRefusal": {
        label: "Reddedilen istekleri böl",
        hint: "Yapay zeka reddettiğinde vazgeçmek yerine iki yarıyı ayrı ayrı dener.",
      },
      "detector.backend": {
        label: "Algılama donanımı",
        hint: "Otomatik ayar, öz testi geçerse GPU'yu, aksi halde CPU'yu kullanır.",
      },
      "detector.scoreMin": {
        label: "En düşük algılama puanı",
        hint: "Düşük değerler daha fazla metin bulur ama daha fazla yanlış pozitif de verir.",
      },
      "detector.sliceTriggerRatio": {
        label: "Şundan uzun görselleri dilimle (oran)",
        hint: "Uzun kenarı kısa kenarının bu katını aşan görseller ve webtoon şeritleri dilimlere bölünür.",
      },
      "detector.sliceHeightRatio": {
        label: "Dilim uzunluğu (× kısa kenar)",
        hint: "Her dilimin uzunluğu, görselin kısa kenarının katı olarak.",
      },
      "detector.sliceOverlap": {
        label: "Dilim örtüşmesi (oran)",
        hint: "Komşu dilimler arasındaki örtüşme, bir dilimin kesri olarak.",
      },
      "detector.sliceOverlapMinPx": {
        label: "En az dilim örtüşmesi (piksel)",
        hint: "Komşu dilimler her zaman en az bu kadar pikseli paylaşır.",
      },
      "detector.quietRows": {
        label: "Dilimleri metin satırlarının arasından kes",
        hint: "Deneysel: dilim kesimlerini mürekkep olmayan piksel satırlarına kaydırır.",
      },
      "engine.idleCloseMin": {
        label: "Boştaki motoru kapatma süresi (dakika)",
        hint: "Hiçbir sayfa motoru bu süre boyunca kullanmadığında belleği boşaltır.",
      },
      "engine.detectorReleaseMin": {
        label: "Metin algılamayı bellekten kaldırma süresi (dakika)",
        hint: "Algılama modeli bu süre boyunca çalışmadığında onu serbest bırakır.",
      },
      "engine.portIdleMin": {
        label: "Boştaki sayfaların bağlantısını kesme süresi (dakika)",
        hint: "Bir sayfa bu süre boyunca iş yapmazsa motoru bırakır.",
      },
      "discovery.minNaturalSide": {
        label: "Şundan küçük görselleri yok say (piksel)",
        hint: "Kısa kenarın gerçek boyutu. Simgeleri, avatarları ve reklamları atlar.",
      },
      "discovery.minDisplayedSide": {
        label: "Ekranda şundan küçük görünen görselleri yok say (piksel)",
        hint: "Kısa kenarın ekrandaki boyutu.",
      },
      "discovery.secondsPerScreenDefault": {
        label: "Başlangıç okuma hızı (ekran başına saniye)",
        hint: "Okuma hızınız ölçülene kadar kullanılan ilk tahmin.",
      },
      "discovery.lookaheadMinScreens": {
        label: "Önceden çeviri, en az (ekran)",
        hint: "Görünümün bu kadar altındaki görseller siz gelmeden her zaman çevrilir.",
      },
      "discovery.lookaheadMaxScreens": {
        label: "Önceden çeviri, en fazla (ekran)",
        hint: "Hızlı okuduğunuzda veya yapay zekâ yavaş olduğunda üst sınır.",
      },
      "discovery.lookaheadMaxScreensStrip": {
        label: "Webtoon şeritlerinde önceden çeviri, en fazla (ekran)",
        hint: "Uzun dikey şeritler için üst sınır.",
      },
      "discovery.detectAheadMinScreens": {
        label: "Önceden algılama, en az (ekran)",
        hint: "Sayfanın henüz yüklemediği görseller bu kadar önceden algılanır (yükleme yapılmaz).",
      },
      "discovery.detectAheadMaxScreens": {
        label: "Önceden algılama, en fazla (ekran)",
        hint: "Hızlı okuyanlar için üst sınır.",
      },
      "discovery.detectMaxImages": {
        label: "Önceden algılanan görsel sayısı, en fazla",
        hint: "Önünüzdeki her görseli sayar, yüklenmiş olsun ya da olmasın.",
      },
      "discovery.fetchPerHostConcurrency": {
        label: "Sunucu başına paralel görsel indirme",
        hint: "Aynı görsel sunucusundan aynı anda yapılan görsel indirme sayısı.",
      },
      "discovery.prefetchSpacingMs": {
        label: "Görsel indirmeleri arasındaki bekleme (ms)",
        hint: "Aynı sunucudan yapılan iki indirme arasındaki en kısa süre.",
      },
      "discovery.scrollDebounceMs": {
        label: "Kaydırmaya tepki gecikmesi (ms)",
        hint: "Kaydırmadan sonra işler yeniden sıralanmadan önce bu kadar beklenir.",
      },
      "discovery.mutationDebounceMs": {
        label: "Sayfa değişikliğine tepki gecikmesi (ms)",
        hint: "Sayfa değiştikten sonra (geç yükleme, okuyucu uygulamaları) yeni görseller aranmadan önce bu kadar beklenir.",
      },
      "discovery.stripGapPx": {
        label: "Webtoon şeridindeki en büyük boşluk (piksel)",
        hint: "Birbirine bundan daha yakın görseller tek bir kesintisiz şerit oluşturur.",
      },
      "discovery.translateHiddenTabs": {
        label: "Arka plan sekmelerinde çevir",
        hint: "Kapalıyken otomatik mod, sekme gösterilene kadar bekler.",
      },
      "render.font": {
        label: "Diyalog yazı tipi",
        hint: "Konuşma balonlarındaki çevrilmiş metnin yazı tipi.",
      },
      "render.verticalText": {
        label: "Dikey yazı",
        hint: "Japonca veya Geleneksel Çince çeviriler dikey balonlarda yukarıdan aşağıya yazılır. “Asla” tüm çevirileri yatay tutar.",
      },
      "render.minFontPx": {
        label: "En küçük metin boyutu (piksel)",
        hint: "Bu boyutta sığmayan metin “…” ile kısaltılır.",
      },
      "render.maxFontPx": {
        label: "En büyük metin boyutu (piksel)",
        hint: "Metin ayrıca orijinal yazının boyutuna yakın kalır.",
      },
      "render.eraseSfx": {
        label: "Ses efektlerini sil",
        hint: "Ses efektlerini etiketlemek yerine görselden kaldırır.",
      },
      "render.sfxLabels": {
        label: "Ses efektlerini etiketle",
        hint: "Ses efektlerinin çevirisini küçük etiketler olarak gösterir.",
      },
      "render.showDoneBadge": {
        label: "Çevrilen görselleri işaretle",
        hint: "Çevrilen her görselde küçük bir rozet gösterir.",
      },
      "render.peekKey": {
        label: "Orijinali görmek için basılı tut (tuş kodu)",
        hint: "Backquote veya KeyH gibi bir tuş kodu. Kapatmak için boş bırakın.",
      },
      "render.peekWithAlt": {
        label: "Alt basılıyken de orijinali göster",
        hint: "Yalnızca Alt tuşunu basılı tutmak da çeviriyi gizler.",
      },
      "render.popupWithAltClick": {
        label: "Alt+tıklama balon penceresini açar",
        hint: "Pencere orijinali gösterir ve çeviriyi düzenlemenizi sağlar. Uzun basış her zaman açar.",
      },
      "memory.enabled": {
        label: "Seri hafızasını kullan",
        hint: "Her istekle sözlüğü, önceki satırları ve bir hikâye özetini gönderir; yanıtlardan adları öğrenir.",
      },
      "memory.glossaryInPrompt": {
        label: "İstek başına sözlük girdisi",
        hint: "Önce sizin girdileriniz, sonra onaylananlar, sonra öğrenilenler.",
      },
      "memory.termMinSightings": {
        label: "Bir terimin öğrenilmesi için gereken görülme sayısı",
        hint: "Bir terimin gönderilmeden önce kaç farklı istekte geçmesi gerektiği.",
      },
      "memory.historyMaxLines": {
        label: "Bağlam olarak gönderilen önceki satırlar",
        hint: "Aynı bölümden satırlar. 0 girilirse hiçbiri gönderilmez.",
      },
      "memory.historyMaxTokens": {
        label: "Önceki satırlar için token bütçesi",
        hint: "Önce en eski satırlar çıkarılır.",
      },
      "memory.summaryMaxWords": {
        label: "Hikâye özeti uzunluğu (kelime)",
        hint: "0 girilirse sürekli güncellenen özet kapanır.",
      },
      "cache.translationTtlDays": {
        label: "Kullanılmayan çevirileri saklama süresi (gün)",
        hint: "Kendi düzenlemelerinizin süresi asla dolmaz.",
      },
      "cache.encodedBytesLruMb": {
        label: "İndirilen görsel önbelleği (MB)",
        hint: "Motorun indirilen görselleri tutmak için kullandığı bellek.",
      },
      "privacy.maxImageBytes": {
        label: "En büyük görsel dosyası (MiB)",
        hint: "Daha büyük görsel dosyaları atlanır.",
      },
      "privacy.maxImagePixels": {
        label: "En büyük görsel (megapiksel)",
        hint: "Daha fazla piksele sahip görseller atlanır.",
      },
      "debug.logCapacity": {
        label: "Saklanan günlük kaydı sayısı",
        hint: "Motorun sakladığı hata ayıklama günlüğünün boyutu.",
      },
    },
    site: {
      settings: "Ayarlar",
      settingsFor: (site: string): string => `${site} için ayarlar`,
      layout: "Düzen ve okuma yönü",
      layouts: {
        auto: "Otomatik algıla",
        webtoon: "Webtoon (dikey şerit)",
        "paged-rtl": "Sayfalı, sağdan sola (manga)",
        "paged-ltr": "Sayfalı, soldan sağa (çizgi roman)",
      },
      sourceLangHint:
        "Yapay zeka için dile özgü talimatları ve metin kırpıntılarının ne kadar büyütüleceğini belirler.",
      referer: "Görsel indirmeleri için Referer",
      referers: {
        auto: "Otomatik",
        "page-url": "Tam sayfa adresi",
        origin: "Yalnızca site adresi",
      },
      refererHint:
        "Otomatik ayar sayfayı izler; görsel sunucusu reddederse tam sayfa adresiyle yeniden dener. " +
        "Yalnızca görseller yüklenmediğinde değiştirin.",
      subdomains: "Alt alan adlarında da",
      subdomainsHint: "Bu sitenin tüm alt alan adlarında aynı ayarlarla çevir.",
      prefetch: "Görselleri önceden hazırla",
      prefetchHint:
        "Görünümün altında sayfanın henüz yüklemediği görselleri algılar, böylece oraya vardığınızda hazır olurlar. Yaklaşana kadar hiçbir şey yüklenmez.",
      frames: "Diğer sitelerden okuyucu çerçeveleri",
      framesHint:
        "Sayfalar başka bir siteden sunulan bir çerçevenin içinde gösteriliyorsa her satıra bir kaynak " +
        "(origin) yazın; ör. https://viewer.example.com.",
      framesInvalid: (lines: string): string => `http(s) kaynağı değil: ${lines}`,
    },
    transfer: {
      heading: "Yedekle ve geri yükle",
      hint:
        "Ayarlarınızı ve site listenizi bir JSON dosyasına kaydedin ya da bir dosyadan yükleyin. Gizlilik onayı " +
        "asla dışa aktarılmaz.",
      includeKey: "API anahtarını dahil et",
      includeKeyHint: "Dosyayı paylaşmadan önce bunu kapalı bırakın: dosyadaki anahtarı herkes okuyabilir.",
      export: "Ayarları dışa aktar",
      import: "Ayarları içe aktar",
      importConfirm:
        "Ayarlarınız dosyadakilerle değiştirilsin mi? Dosyadaki siteler eklenir veya güncellenir.",
      notJson: "Bu dosya geçerli bir JSON değil.",
      notSettings: "Bu dosya bir Panelingo ayar dışa aktarımı değil.",
      tooNew: "Bu dosya, Panelingo'nun daha yeni bir sürümüyle oluşturulmuş.",
      imported: (settings: number, sites: number): string =>
        `İçe aktarıldı. Değişen ayarlar: ${settings}. Siteler: ${sites}.`,
      keyImported: "Dosyadaki API anahtarı içe aktarıldı.",
      keyKept: "API anahtarınız korundu (dosyada anahtar yok).",
    },
  },
  offline: {
    heading: "Çevrimdışı mod (deneysel)",
    intro:
      "Hiçbir yapay zeka uç noktası olmadan çevirin: açık kaynaklı metin tanıma (PaddleOCR) ve çeviri modelleri bu cihazda çalışır. Kalite bir görsel modele göre belirgin biçimde düşüktür: balonlar arasında bağlam yoktur, karakter adları bilinmez, stilize yazılar sık sık yanlış okunur ve ses efektleri çevrilmeden bırakılır.",
    download:
      "Modeller ilk gerektiğinde Hugging Face'ten bir kez indirilir, doğrulanır ve bu cihazda saklanır; sonrasında çeviri için ağ gerekmez. Boyutlar: metin tanıma dil başına 8 ila 17 MB, Opus-MT dil çifti başına yaklaşık 115 MB (İngilizce üzerinden iki katı), NLLB-200 yaklaşık 910 MB.",
    engine: "Çeviri motoru",
    engineChoices: {
      api: "Yapay zeka uç noktası (OpenAI uyumlu)",
      offline: "Bu cihazda çevrimdışı (deneysel)",
    },
    model: "Çevrimdışı çeviri modeli",
    modelChoices: {
      "opus-mt": "Opus-MT: küçük, her dil çifti için bir model",
      "nllb-600m": "NLLB-200 600M: tüm çiftler, büyük, ticari olmayan",
    },
    pairs:
      "Opus-MT Korece, Japonca, Çince ve İspanyolcayı İngilizceye, İngilizceyi de Vietnamca, İspanyolca, Fransızca, Almanca, İtalyanca ve Endonezceye çevirir; diğer çiftler İngilizce üzerinden gider. NLLB-200 burada listelenen tüm diller arasında çeviri yapar.",
    license:
      "Lisanslar: PaddleOCR ve Opus-MT modellerinin çoğu Apache-2.0, iki Opus-MT modeli CC-BY-4.0, NLLB-200 CC-BY-NC-4.0 (yalnızca ticari olmayan kullanım).",
    stored: (mb: number): string => `Bu cihazdaki indirilmiş modeller: ${Math.round(mb)} MB`,
    deleteModels: "İndirilen modelleri sil",
    deleteConfirm: "İndirilen çevrimdışı modeller silinsin mi? Gerektiğinde yeniden indirilirler.",
    deleted: "İndirilen modeller silindi.",
  },
  manifest: {
    description:
      "Çizgi roman, manga ve webtoon okurken metinleri sayfada çevirin. OpenAI uyumlu her yapay zekayla çalışır.",
    commands: {
      "toggle-overlay": "Çeviri katmanını göster veya gizle",
      "translate-visible": "Görünen görselleri çevir",
      "toggle-site": "Bu sitede otomatik çeviriyi aç veya kapat",
      "open-side-panel": "Metin dökümü yan panelini aç",
    },
  },
};
