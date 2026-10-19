// Polish UI catalog. PURE.

import type { Catalog } from "./en.ts";

/**
 * Polish plural (CLDR): one for 1; few when the last digit is 2–4 and the last two digits are not 12–14;
 * many otherwise (0, 5–21, 25–31, 112, …).
 */
const plural = (n: number, one: string, few: string, many: string): string => {
  if (n === 1) return one;
  const mod10 = n % 10;
  const mod100 = n % 100;
  return mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
};

/** One decimal with a decimal comma (1,3). */
const decimal = (value: number): string => value.toFixed(1).replace(".", ",");

const errors: Catalog["errors"] = {
  "api.unreachable": {
    title: "Nie można połączyć się z endpointem AI",
    hint: "Sprawdź bazowy URL w Opcjach i upewnij się, że serwer (lub lokalny model) działa.",
  },
  "api.lna_blocked": {
    title: "Chrome zablokował połączenie z Twoim lokalnym serwerem AI",
    hint: "Otwórz ustawienia witryny rozszerzenia → Dostęp do sieci lokalnej (Local network access) → Zezwalaj.",
  },
  "api.unauthorized": {
    title: "Endpoint AI odrzucił klucz API",
    hint: "Wpisz prawidłowy klucz API w Opcjach. Tłumaczenie wznowi się automatycznie.",
  },
  "api.config": {
    title: "Endpoint AI lub model jest źle skonfigurowany",
    hint: "Sprawdź bazowy URL i wybierz w Opcjach model, który obsługuje obrazy (vision).",
  },
  "api.rate_limit": {
    title: "Dostawca AI ogranicza liczbę zapytań",
    hint: "Rozszerzenie samo zwolni tempo i ponowi próbę.",
  },
  "api.upstream": { title: "Błąd serwera AI, ponawianie próby", hint: "" },
  "api.context_length": { title: "Zapytanie za długie, dzielenie na części", hint: "" },
  "api.timeout": {
    title: "Przekroczono czas oczekiwania na odpowiedź AI",
    hint: "Rozszerzenie spróbuje jeszcze raz.",
  },
  "api.truncated": { title: "Odpowiedź ucięta, pobieranie dalszej części", hint: "" },
  "api.partial": { title: "W odpowiedzi AI brakuje części dymków, ponowne zapytanie", hint: "" },
  "api.empty": { title: "Pusta odpowiedź AI, ponawianie próby", hint: "" },
  "api.too_large": { title: "Obraz za duży do wysłania, zmniejszanie", hint: "" },
  "api.bad_request": {
    title: "Zapytanie zostało odrzucone (błąd programu)",
    hint: "Wyeksportuj dziennik debugowania w Opcjach.",
  },
  "api.protocol": { title: "Nieoczekiwany format odpowiedzi endpointu AI", hint: "" },
  "llm.refused": { title: "AI odmawia tłumaczenia", hint: "Dymek zachowuje oryginalny tekst." },
  "llm.missing": {
    title: "Bez tłumaczenia",
    hint: "Użyj opcji „Przetłumacz ponownie”, aby ponowić próbę tylko dla tego dymka.",
  },
  "llm.format": { title: "Błędna odpowiedź AI, ponawianie próby", hint: "" },
  "image.url_blocked": { title: "Obraz zablokowany ze względów bezpieczeństwa", hint: "" },
  "image.http": {
    title: "Nie udało się wczytać obrazu",
    hint: "Jeśli witryna wymaga zalogowania, włącz w okienku rozszerzenia opcję „Wysyłaj pliki cookie z żądaniami obrazów”.",
  },
  "image.not_image": { title: "To nie jest plik obrazu", hint: "" },
  "image.too_large": { title: "Obraz za duży", hint: "" },
  "image.decode": { title: "Nie udało się zdekodować obrazu", hint: "" },
  "image.capture_unavailable": { title: "Przewiń do obrazu, aby go przetłumaczyć", hint: "" },
  "image.capture_blocked": {
    title: "Ten obraz można odczytać tylko ze zrzutu ekranu",
    hint: "Włącz tłumaczenie na tej stronie i pozostaw tę kartę na wierzchu, a potem spróbuj ponownie.",
  },
  "detector.webgpu_unavailable": { title: "Wykrywanie tekstu na CPU (wolniej)", hint: "" },
  "detector.canary_mismatch": { title: "Niespójne wyniki z GPU, przełączono na CPU", hint: "" },
  "detector.model_integrity": {
    title: "Model wykrywania tekstu jest uszkodzony",
    hint: "Zainstaluj rozszerzenie ponownie (programiści: npm run fetch-models, a potem npm run build).",
  },
  "detector.init": {
    title: "Nie udało się uruchomić wykrywania tekstu",
    hint: "Wyeksportuj dziennik debugowania w Opcjach.",
  },
  "detector.run": { title: "Wykrywanie tekstu nie powiodło się", hint: "" },
  "offline.pair_unsupported": {
    title: "Ta para języków nie jest dostępna offline",
    hint: "Wybierz NLLB-200 jako model offline w Opcjach albo inny język docelowy.",
  },
  "offline.download": {
    title: "Nie udało się pobrać modeli offline",
    hint: "Sprawdź połączenie z huggingface.co. Tłumaczenie zostanie ponowione automatycznie.",
  },
  "offline.model_integrity": {
    title: "Pobrany model offline jest uszkodzony",
    hint: "Przetłumacz ponownie, aby pobrać go jeszcze raz.",
  },
  "offline.run": {
    title: "Modele offline nie zadziałały",
    hint: "Wyeksportuj dziennik debugowania w Opcjach.",
  },
  "offline.out_of_memory": {
    title: "Za mało pamięci dla modeli offline",
    hint: "Modele tłumaczenia zostały uruchomione ponownie, silnik działa dalej. Wybierz w Opcjach Opus-MT (znacznie mniejszy) albo zamknij inne karty.",
  },
  "engine.unavailable": {
    title: "Nie udało się uruchomić silnika tłumaczenia",
    hint: "Załaduj stronę ponownie albo wyłącz i włącz rozszerzenie.",
  },
  "engine.closing": { title: "Silnik uruchamia się ponownie", hint: "" },
  "engine.overloaded": { title: "Silnik jest zajęty", hint: "" },
  "engine.protocol": { title: "Niezgodna wersja rozszerzenia", hint: "Załaduj stronę ponownie." },
  "engine.internal": { title: "Błąd wewnętrzny", hint: "Wyeksportuj dziennik debugowania w Opcjach." },
  "msg.too_large": { title: "Za dużo danych, ponowne wczytywanie z adresu URL", hint: "" },
  "ctx.invalidated": {
    title: "Rozszerzenie zostało właśnie ponownie załadowane",
    hint: "Załaduj stronę ponownie, aby dalej tłumaczyć.",
  },
  "dnr.failed": { title: "Nie udało się ustawić nagłówka Referer dla obrazu", hint: "" },
  "store.io": { title: "Nie udało się odczytać ani zapisać pamięci podręcznej", hint: "" },
  "store.quota": {
    title: "Pamięć podręczna jest pełna",
    hint: "Zwolnij miejsce, czyszcząc pamięć podręczną w Opcjach.",
  },
  "site.disabled": { title: "Tłumaczenie jest wyłączone dla tej witryny", hint: "" },
  "privacy.consent": {
    title: "Nie potwierdzono jeszcze wysyłania obrazów do AI",
    hint: "Przeczytaj informację o prywatności i zezwól na wysyłanie, aby zacząć tłumaczyć.",
  },
  cancelled: { title: "Anulowano", hint: "" },
};

export const PL: Catalog = {
  errors,
  readiness: {
    unknown: { label: "Sprawdzanie endpointu AI…", hint: "" },
    ready: { label: "Endpoint AI gotowy", hint: "" },
    unauthorized: { label: "Klucz API odrzucony", hint: errors["api.unauthorized"].hint },
    unreachable: { label: "Brak połączenia z endpointem AI", hint: errors["api.unreachable"].hint },
    lna_blocked: { label: "Chrome zablokował lokalny serwer AI", hint: errors["api.lna_blocked"].hint },
    misconfigured: { label: "Endpoint AI nie jest skonfigurowany", hint: errors["api.config"].hint },
  },
  imageState: {
    queued: "W kolejce",
    acquiring: "Wczytywanie obrazu",
    detecting: "Wyszukiwanie tekstu",
    waiting: "Oczekiwanie na tłumaczenie",
    translating: "Trwa tłumaczenie",
    done: "Przetłumaczono",
    "no-text": "Brak tekstu",
    partial: "Przetłumaczono częściowo",
    refused: "Odmowa AI",
    paused: "Wstrzymano",
    error: "Błąd",
    stale: "Nieaktualne tłumaczenie",
  },
  unitStatus: {
    pending: "Oczekuje",
    translating: "Trwa tłumaczenie",
    ok: "Przetłumaczono",
    "keep-original": "Pozostawiono oryginał",
    manual: "Edytowano",
    untranslated: "Bez tłumaczenia",
    refused: "Odmowa AI",
    ignored: "Pominięto",
    error: "Błąd",
    stale: "Nieaktualne",
  },
  enginePhase: {
    booting: "Uruchamianie silnika",
    ready: "Silnik działa",
    closing: "Zatrzymywanie silnika",
    failed: "Awaria silnika",
  },
  detectorBackend: { webgpu: "GPU (WebGPU)", wasm: "CPU (WASM)", none: "jeszcze nie wybrano" },
  detectorState: { unloaded: "nie wczytano", loading: "wczytywanie", ready: "gotowe", failed: "błąd" },
  detectorCanary: {
    pass: "zweryfikowano GPU",
    fail: "niespójne wyniki z GPU, przełączono na CPU",
    pending: "weryfikacja GPU",
    skipped: "",
  },
  offlineState: {
    idle: "Modele wczytują się przy pierwszym użyciu",
    downloading: "Pobieranie modeli",
    loading: "Wczytywanie modeli",
    ready: "Gotowe",
    failed: "Błąd",
  },
  ui: {
    appName: "Panelingo",
    siteEnable: "Tłumacz tę witrynę",
    siteDisable: "Nie tłumacz tej witryny",
    modeAuto: "Tłumacz podczas przewijania",
    modeManual: "Tłumacz tylko na żądanie",
    translateVisible: "Przetłumacz widoczne obrazy",
    translateImage: "Przetłumacz",
    retranslate: "Przetłumacz ponownie",
    showOriginal: "Pokaż oryginał",
    uploadsToday: (count: number, mb: number): string =>
      `Dzisiaj wysłano do AI ${count} ` +
      `${plural(count, "obraz zbiorczy", "obrazy zbiorcze", "obrazów zbiorczych")} (${decimal(mb)} MB)`,
    progress: (done: number, total: number, etaSec?: number): string =>
      etaSec === undefined || !Number.isFinite(etaSec)
        ? `Tłumaczenie ${done}/${total}`
        : `Tłumaczenie ${done}/${total} · ~${Math.max(1, Math.round(etaSec))} s`,
    privacyTitle: "Zanim obrazy zostaną wysłane do AI",
    privacyBody:
      "Aby tłumaczyć, rozszerzenie wysyła do skonfigurowanego przez Ciebie endpointu AI obrazy zbiorcze z kadrami " +
      "komiksu, które zawierają tekst (tylko na włączonych przez Ciebie witrynach lub na Twoje żądanie). Dostawca AI " +
      "może przechowywać otrzymane dane zgodnie z własnymi warunkami. Upewnij się, że jest to akceptowalne dla Ciebie " +
      "i dopuszczalne w przypadku czytanych treści.",
    privacyAccept: "Rozumiem, zezwól na wysyłanie",
    privacyDecline: "Nie wysyłaj",
  },
  bubble: {
    original: "Oryginał",
    translation: "Tłumaczenie",
    save: "Zapisz",
    revert: "Użyj tłumaczenia AI",
    retranslate: "Przetłumacz ponownie",
    close: "Zamknij",
    dialog: "Przetłumaczony dymek",
    copy: "Kopiuj",
    editLabel: "Edytuj tłumaczenie",
    shortened: "Tekst skrócono, aby zmieścił się w dymku.",
    saved: "Zapisano.",
    retranslating: "Trwa ponowne tłumaczenie…",
  },
  menu: {
    translateImage: "Przetłumacz ten obraz",
    retranslateImage: "Przetłumacz ten obraz ponownie",
  },
  sidepanel: {
    title: "Panelingo – Transkrypcja",
    heading: "Transkrypcja",
    empty: "Na tej karcie nie ma jeszcze przetłumaczonych kwestii.",
    emptyHint:
      "Otwórz stronę komiksu w witrynie, dla której włączono tłumaczenie. Kwestie pojawią się tutaj w miarę tłumaczenia.",
    refresh: "Odśwież",
    copy: "Kopiuj wszystko",
    copied: "Skopiowano do schowka.",
    page: (n: number): string => `Strona ${n}`,
    jump: "Pokaż",
    jumpHint: "Przewiń stronę do tego dymku",
    edit: "Edytuj",
    save: "Zapisz",
    cancel: "Anuluj",
    retranslate: "Przetłumacz ponownie",
    revert: "Cofnij edycję",
    noTranslation: "Brak tłumaczenia",
    notFound: "Tego dymku nie ma już na stronie.",
    failed: "Nie udało się. Spróbuj ponownie.",
    types: {
      dialogue: "Dialog",
      thought: "Myśl",
      narration: "Narracja",
      sign: "Szyld",
      sfx: "Efekt dźwiękowy",
      ignore: "Pominięte",
    },
    inconsistent: "Niezgodne ze słowniczkiem",
    tabs: { transcript: "Transkrypcja", glossary: "Słowniczek" },
    glossary: {
      noSeries: "Otwórz stronę komiksu, aby zobaczyć słowniczek jego serii.",
      untitled: "Seria bez tytułu",
      states: {
        manual: "Twoje wpisy",
        confirmed: "Potwierdzone",
        learned: "Wyuczone",
        candidate: "Propozycje",
      },
      hints: {
        manual: "Używane zawsze. AI nigdy ich nie zmienia.",
        confirmed: "Zaakceptowane przez Ciebie propozycje. Używane zawsze.",
        learned: "Nazwy i terminy, których AI użyła w kilku zapytaniach. Wysyłane z każdym zapytaniem.",
        candidate:
          "AI zauważyła je tylko raz. Nie są wysyłane, dopóki ich nie potwierdzisz lub nie pojawią się ponownie.",
      },
      empty: "Brak wpisów. Nazwy i terminy pojawią się tutaj, gdy AI je zauważy. Możesz też dodać własne.",
      original: "Tekst oryginalny",
      translation: "Tłumaczenie",
      note: "Notatka (opcjonalnie)",
      add: "Dodaj",
      delete: "Usuń",
      confirm: "Potwierdź",
      seen: (count: number): string => `Widziane ${count} ${plural(count, "raz", "razy", "razy")}`,
      incomplete: "Wpisz tekst oryginalny i jego tłumaczenie.",
      profileHeading: "Ustawienia serii",
      sourceLang: "Język źródłowy",
      langAuto: "Wykrywaj automatycznie",
      langs: {
        ja: "Japoński",
        ko: "Koreański",
        zh: "Chiński",
        en: "Angielski",
        es: "Hiszpański",
        other: "Inny",
      },
      koNames: "Imiona koreańskie",
      koRomanized: "Latynizacja (Minjun)",
      koHanViet: "Chińsko-wietnamskie (dla tłumaczeń na wietnamski)",
      keepHonorifics: "Zachowaj japońskie zwroty grzecznościowe (-san, -kun)",
      summary: "Wysyłaj bieżące streszczenie fabuły",
      saveProfile: "Zapisz ustawienia",
      saved: "Zapisano.",
      export: "Eksportuj",
      import: "Importuj",
      imported: (count: number): string =>
        `Zaimportowano ${count} ${plural(count, "wpis", "wpisy", "wpisów")}.`,
      importFailed: "Ten plik nie jest słowniczkiem Panelingo.",
    },
  },
  debug: { heading: "Debugowanie (tylko wersje dev/test)" },
  duration: (ms: number): string => {
    const seconds = Math.round(Math.abs(ms) / 1000);
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} godz.`;
    const days = Math.round(hours / 24);
    return `${days} ${days === 1 ? "dzień" : "dni"}`;
  },
  popup: {
    openTranscript: "Otwórz transkrypcję",
    cookies: "Wysyłaj pliki cookie przy pobieraniu obrazów",
    cookiesHint:
      "Dla stron, które pokazują obrazy tylko zalogowanym czytelnikom. Pliki cookie trafiają tylko do serwera obrazów, nigdy do AI.",
    apiHeading: "Endpoint AI",
    engineHeading: "Silnik tłumaczenia",
    siteHeading: "Ta witryna",
    checking: "Sprawdzanie…",
    model: (model: string): string => `Model: ${model}`,
    endpoint: (url: string): string => `Endpoint: ${url}`,
    cause: (cause: string): string => `Szczegóły: ${cause}`,
    engineStopped: "Silnik jest bezczynny; uruchomi się, gdy zaczniesz tłumaczyć.",
    engineUnreadable: "Nie udało się odczytać stanu silnika.",
    offlineHeading: "Tryb offline (eksperymentalny)",
    offlineHint:
      "Nie jest używany żaden endpoint AI: rozpoznawanie tekstu i tłumaczenie działają na tym urządzeniu.",
    offlineDownload: (doneMb: number, totalMb: number): string =>
      `Pobieranie: ${Math.round(doneMb)} z ${Math.round(totalMb)} MB`,
    offlineModels: (models: string): string => `Modele: ${models}`,
    detectorLine: (backend: string, state: string, canary: string): string =>
      `Wykrywanie tekstu: ${backend}, ${state}${canary === "" ? "" : ` (${canary})`}`,
    queueLine: (queued: number, inFlight: number, done: number, failed: number): string =>
      `Kolejka: oczekujące ${queued} · wysyłane ${inFlight} · gotowe ${done} · nieudane ${failed}`,
    pausedBy: (title: string): string => `Wstrzymano: ${title}`,
    siteUnsupported: "Tej strony nie można przetłumaczyć (tylko strony http/https).",
    siteOn: "Tłumaczenie jest włączone dla tej witryny.",
    siteOff: "Tłumaczenie jest wyłączone dla tej witryny.",
    modeLabel: "Tryb",
    visibleSent: (count: number): string =>
      count > 0
        ? `Wysłano do tłumaczenia ${count} ${plural(count, "obraz", "obrazy", "obrazów")}.`
        : "Brak widocznych obrazów komiksu.",
    visibleUnavailable: "Rozszerzenie nie może działać na tej stronie.",
    retranslatePage: "Przetłumacz stronę ponownie",
    retranslateQueued: (count: number): string =>
      `Ponownie dodano do kolejki ${count} ${plural(count, "dymek", "dymki", "dymków")}.`,
    actionFailed: (title: string): string => `Operacja nie powiodła się: ${title}`,
    privacyDetails: "Zobacz, co jest wysyłane",
    options: "Opcje",
    setupHint: "Aby zacząć, skonfiguruj endpoint AI (bazowy URL, klucz API, model) w Opcjach.",
    consentHint:
      "Kliknij ikonę Panelingo, aby przeczytać informację o prywatności, zanim włączysz tutaj tłumaczenie.",
    build: (id: string): string => `Kompilacja ${id}`,
  },
  options: {
    exportLog: "Eksportuj dziennik debugowania",
    exportFailed: "Nie udało się wyeksportować dziennika debugowania.",
    exportEmpty: "Dziennik debugowania jest pusty.",
    title: "Opcje",
    apiHeading: "Endpoint AI (zgodny z OpenAI)",
    apiIntro:
      "Działa każda usługa, która obsługuje API chat completions OpenAI i przyjmuje obrazy: OpenAI, OpenRouter, " +
      "Azure OpenAI, Google Gemini (tryb OpenAI) lub lokalny serwer, np. Ollama, LM Studio, vLLM czy LiteLLM.",
    preset: "Szablon",
    presetCustom: "Własny",
    baseUrl: "Bazowy URL",
    baseUrlHint: "Razem ze ścieżką wersji, np. https://api.openai.com/v1 lub http://127.0.0.1:11434/v1.",
    baseUrlInvalid: "To nie jest prawidłowy adres URL http(s).",
    apiKey: "Klucz API",
    apiKeyHint:
      "Przechowywany tylko w tym profilu przeglądarki. Zostaw pole puste, jeśli lokalny serwer nie wymaga klucza.",
    model: "Model",
    modelHint:
      "Model musi obsługiwać obrazy na wejściu (vision), np. gpt-4o-mini, gemini-2.5-flash, qwen2.5-vl.",
    modelInvalid: "Wpisz identyfikator modelu.",
    testConnection: "Sprawdź połączenie",
    testing: "Sprawdzanie…",
    testOk: (detail: string): string => `Połączono. ${detail}`,
    testFailed: (detail: string): string => `Niepowodzenie: ${detail}`,
    concurrency: "Równoległe zapytania o tłumaczenie",
    concurrencyHint:
      "Domyślnie 2, maksymalnie 4. Zmniejsz tę wartość, jeśli dostawca ogranicza liczbę zapytań.",
    concurrencyInvalid: "Wybierz liczbę od 1 do 4.",
    languageHeading: "Języki",
    uiLanguage: "Język interfejsu",
    targetLanguage: "Tłumacz na",
    languageAuto: "Jak w przeglądarce",
    save: "Zapisz",
    saved: "Zapisano.",
    saveFailed: "Nie udało się zapisać.",
    sitesHeading: "Witryny",
    sitesEmpty:
      "Brak witryn. Otwórz stronę z komiksem, kliknij ikonę rozszerzenia i włącz tłumaczenie dla tej witryny.",
    siteEnabled: "Włączone",
    siteMode: "Tryb",
    siteRemove: "Usuń",
    privacyHeading: "Prywatność: co jest wysyłane do AI",
    privacyPoints: [
      "Przy każdym tłumaczeniu rozszerzenie wysyła do skonfigurowanego przez Ciebie endpointu AI jeden obraz " +
        "zbiorczy JPEG: miniatury obrazów (lub fragmentów webtoonu) zawierających tekst, ponumerowane ramki wokół " +
        "każdego obszaru tekstu i powiększone wycinki tych obszarów.",
      "Razem z nim wysyłany jest tekst: zasady formatowania i języka, glosariusz serii (do 60 haseł), do 20 " +
        "wcześniejszych kwestii z tego samego rozdziału i krótkie streszczenie.",
      "Nigdy nie są wysyłane: obrazy bez tekstu, adres czytanej strony, pliki cookie, Twój adres IP ani nagłówki " +
        "przeglądarki (poza tym, co zawiera każde zapytanie do Twojego endpointu).",
      "Dostawca AI może przechowywać otrzymane dane zgodnie z własnymi warunkami. Traktuj wszystko, co wysłano, " +
        "jako zapisane.",
      "Podczas przewijania tłumaczone są tylko witryny, które włączysz. Inne strony są tłumaczone tylko na Twoje " +
        "żądanie (menu kontekstowe lub skrót klawiszowy), a rozszerzenie zawsze pyta przed pierwszym wysłaniem.",
      "Okienko rozszerzenia pokazuje, ile obrazów zbiorczych wysłano dzisiaj.",
      "Tłumaczenia, pozycje dymków i maski zakrywające tekst pozostają na tym urządzeniu w bazie IndexedDB rozszerzenia; " +
        "możesz je usunąć poniżej, w sekcji „Pamięć podręczna”.",
    ],
    privacyAcked: (when: string): string => `Informację o wysyłaniu obrazów potwierdzono ${when}.`,
    privacyNotAcked:
      "Informacja o wysyłaniu obrazów nie została jeszcze potwierdzona; rozszerzenie zapyta przed pierwszym wysłaniem.",
    cacheHeading: "Pamięć podręczna",
    cacheHint:
      "Usuwa wszystkie tłumaczenia, pozycje dymków i maski zakrywające tekst zapisane na tym urządzeniu. Przy ponownym czytaniu " +
      "obrazy zostaną znowu wysłane i przetłumaczone.",
    cacheClear: "Wyczyść całą pamięć podręczną",
    cacheConfirm:
      "Wyczyścić całą pamięć podręczną? Przy następnym czytaniu obrazy zostaną ponownie wysłane i przetłumaczone.",
    cacheCleared: (count: number): string =>
      `Usunięto ${count} ${plural(count, "rekord", "rekordy", "rekordów")}.`,
    cacheFailed: (title: string): string => `Nie udało się wyczyścić pamięci podręcznej: ${title}`,
    debugHeading: "Dziennik debugowania",
    logLevel: "Poziom logowania",
    logLevels: {
      debug: "Szczegółowy (debug)",
      info: "Informacje",
      warn: "Ostrzeżenia",
      error: "Tylko błędy",
    },
  },
  optionsAdvanced: {
    heading: "Ustawienia zaawansowane",
    intro:
      "Dostrajanie zapytań, wykrywania tekstu, liternictwa i pamięci podręcznej. Wartości domyślne sprawdzą się " +
      "w większości przypadków. Każda zmiana jest zapisywana po opuszczeniu pola.",
    defaultIs: (value: string): string => `Domyślnie: ${value}`,
    range: (min: string, max: string): string => `Dozwolone: od ${min} do ${max}`,
    automatic: "automatycznie",
    on: "włączone",
    off: "wyłączone",
    reset: "Przywróć",
    resetLabel: (label: string): string => `Przywróć domyślną wartość pola „${label}”`,
    resetAll: "Przywróć domyślne wartości wszystkich ustawień zaawansowanych",
    resetAllConfirm: "Przywrócić domyślne wartości wszystkich ustawień zaawansowanych?",
    resetAllDone: "Przywrócono domyślne wartości wszystkich ustawień zaawansowanych.",
    notANumber: "Wpisz liczbę.",
    adjusted: (value: string): string => `Zapisano wartość ${value} – najbliższą dozwoloną.`,
    badKey: "Użyj kodu klawisza, np. Backquote lub KeyH, albo zostaw pole puste.",
    verticalChoices: { auto: "Automatycznie", never: "Nigdy" },
    groups: {
      api: "Zapytania do AI",
      translate: "Zawartość zapytań",
      detector: "Wykrywanie tekstu",
      engine: "Silnik",
      discovery: "Wyszukiwanie obrazów",
      render: "Liternictwo",
      memory: "Pamięć serii",
      cache: "Pamięć podręczna",
      privacy: "Limity obrazów",
      debug: "Dziennik debugowania",
    },
    fields: {
      "api.temperature": {
        label: "Temperatura",
        hint: "Jak bardzo zróżnicowane są odpowiedzi. Zostaw puste, aby użyć wartości domyślnej dostawcy.",
      },
      "api.urgentLane": {
        label: "Dodatkowy kanał dla obrazów na ekranie",
        hint: "Dodaje jeden kanał zapytań zarezerwowany dla obrazów, które właśnie oglądasz.",
      },
      "api.maxInFlight": {
        label: "Maksymalna liczba jednoczesnych zapytań",
        hint: "Twardy limit, łącznie z dodatkowym kanałem. Nigdy niższy niż liczba równoległych zapytań o tłumaczenie.",
      },
      "api.firstByteTimeoutMs": {
        label: "Oczekiwanie na pierwszą odpowiedź (sekundy)",
        hint: "Przerwij, jeśli endpoint przez tyle czasu nic nie wyśle.",
      },
      "api.idleTimeoutMs": {
        label: "Limit czasu dla zatrzymanej odpowiedzi (sekundy)",
        hint: "Przerwij, jeśli strumień odpowiedzi zatrzyma się na tyle czasu.",
      },
      "api.totalTimeoutMs": {
        label: "Maksymalny czas zapytania (sekundy)",
        hint: "Przerwij każde zapytanie po tym czasie.",
      },
      "api.healthTimeoutMs": {
        label: "Limit czasu sprawdzania połączenia (sekundy)",
        hint: "Używany przy sprawdzaniu endpointu i przez przycisk „Sprawdź połączenie”.",
      },
      "translate.boxBudget": {
        label: "Obszary tekstu na zapytanie",
        hint: "Zostaw puste, aby użyć profilu modelu (12, 16 lub 20).",
      },
      "translate.packWaitMs": {
        label: "Czas oczekiwania na grupowanie obrazów (ms)",
        hint: "Jak długo tekst jednego obrazu czeka na kolejne obrazy strony, aby wysłać je w jednym żądaniu. 0 wysyła każdy obraz od razu.",
      },
      "translate.urgentPackMax": {
        label: "Dymki w pierwszym żądaniu na ekranie",
        hint: "Pierwsze żądanie obrazu na ekranie zawiera co najwyżej tyle dymków, aby pojawiły się szybciej. 0 = bez osobnego limitu.",
      },
      "translate.jpegQuality": {
        label: "Jakość JPEG",
        hint: "Jakość obrazu zbiorczego wysyłanego do AI.",
      },
      "translate.requestBodyCapMb": {
        label: "Maksymalny rozmiar zapytania (MB)",
        hint: "Większe obrazy zbiorcze są mocniej kompresowane, a potem dzielone.",
      },
      "translate.promptCharCap": {
        label: "Maksymalna długość promptu (znaki)",
        hint: "Gdy zapytanie jest dłuższe, najpierw skracany jest kontekst.",
      },
      "translate.maxLadderRequestsPerPack": {
        label: "Dodatkowe zapytania o pominięty tekst",
        hint: "Ponowne pytanie i dzielenie, gdy AI pomija obszary tekstu.",
      },
      "translate.maxHttpRetriesPerRequest": {
        label: "Ponowne próby po błędach sieci",
        hint: "Na zapytanie, przy chwilowych błędach HTTP i sieci.",
      },
      "translate.engine": {
        label: "Silnik tłumaczenia",
        hint: "Tryb offline jest eksperymentalny: zobacz Tryb offline powyżej.",
      },
      "translate.offlineModel": {
        label: "Model tłumaczenia offline",
        hint: "Używany tylko w trybie offline.",
      },
      "translate.splitOnRefusal": {
        label: "Dziel odrzucone zapytania",
        hint: "Gdy AI odmawia, spróbuj osobno obu połówek, zamiast rezygnować.",
      },
      "detector.backend": {
        label: "Sprzęt do wykrywania tekstu",
        hint: "Tryb automatyczny używa GPU, jeśli przejdzie ono autotest, a w przeciwnym razie CPU.",
      },
      "detector.scoreMin": {
        label: "Minimalny wynik wykrywania",
        hint: "Niższe wartości znajdują więcej tekstu, ale też więcej fałszywych trafień.",
      },
      "detector.sliceTriggerRatio": {
        label: "Dziel obrazy dłuższe niż (proporcja)",
        hint: "Obrazy i pasy webtoonu, których dłuższy bok przekracza tę wielokrotność krótszego, są dzielone na fragmenty.",
      },
      "detector.sliceHeightRatio": {
        label: "Długość fragmentu (× krótszy bok)",
        hint: "Długość każdego fragmentu jako wielokrotność krótszego boku obrazu.",
      },
      "detector.sliceOverlap": {
        label: "Nakładanie się fragmentów (ułamek)",
        hint: "Część wspólna sąsiednich fragmentów jako ułamek fragmentu.",
      },
      "detector.sliceOverlapMinPx": {
        label: "Minimalne nakładanie się fragmentów (piksele)",
        hint: "Sąsiednie fragmenty zawsze mają co najmniej tyle wspólnych pikseli.",
      },
      "detector.quietRows": {
        label: "Tnij fragmenty między wierszami tekstu",
        hint: "Eksperymentalne: przesuwa cięcia na wiersze pikseli bez tuszu.",
      },
      "engine.idleCloseMin": {
        label: "Zamknij bezczynny silnik po (minuty)",
        hint: "Zwalnia pamięć, gdy żadna strona nie używała silnika przez ten czas.",
      },
      "engine.detectorReleaseMin": {
        label: "Wyładuj wykrywanie tekstu po (minuty)",
        hint: "Zwalnia model wykrywania, gdy nie był używany przez ten czas.",
      },
      "engine.portIdleMin": {
        label: "Odłącz bezczynne strony po (minuty)",
        hint: "Strona zwalnia silnik po takim czasie bez pracy.",
      },
      "discovery.minNaturalSide": {
        label: "Pomijaj obrazy mniejsze niż (piksele)",
        hint: "Rzeczywisty rozmiar krótszego boku. Odsiewa ikony, awatary i reklamy.",
      },
      "discovery.minDisplayedSide": {
        label: "Pomijaj obrazy wyświetlane jako mniejsze niż (piksele)",
        hint: "Rozmiar krótszego boku na ekranie.",
      },
      "discovery.secondsPerScreenDefault": {
        label: "Początkowe tempo czytania (sekundy na ekran)",
        hint: "Wstępny szacunek, dopóki tempo Twojego czytania nie zostanie zmierzone.",
      },
      "discovery.lookaheadMinScreens": {
        label: "Tłumaczenie z wyprzedzeniem, minimum (ekrany)",
        hint: "Obrazy w tej odległości poniżej widoku są zawsze tłumaczone, zanim do nich dotrzesz.",
      },
      "discovery.lookaheadMaxScreens": {
        label: "Tłumaczenie z wyprzedzeniem, maksimum (ekrany)",
        hint: "Górny limit, gdy czytasz szybko lub AI odpowiada wolno.",
      },
      "discovery.lookaheadMaxScreensStrip": {
        label: "Tłumaczenie z wyprzedzeniem w paskach webtoon, maksimum (ekrany)",
        hint: "Górny limit dla długich pionowych pasków.",
      },
      "discovery.detectAheadMinScreens": {
        label: "Wykrywanie z wyprzedzeniem, minimum (ekrany)",
        hint: "Obrazy, których strona jeszcze nie wczytała, są wykrywane z takim wyprzedzeniem (bez wysyłania).",
      },
      "discovery.detectAheadMaxScreens": {
        label: "Wykrywanie z wyprzedzeniem, maksimum (ekrany)",
        hint: "Górny limit dla szybko czytających.",
      },
      "discovery.detectMaxImages": {
        label: "Obrazy wykrywane z wyprzedzeniem, najwyżej",
        hint: "Liczy każdy obraz przed tobą, wczytany lub nie.",
      },
      "discovery.fetchPerHostConcurrency": {
        label: "Równoległe pobieranie obrazów z jednego serwera",
        hint: "Liczba obrazów pobieranych jednocześnie z tego samego serwera obrazów.",
      },
      "discovery.prefetchSpacingMs": {
        label: "Przerwa między pobraniami obrazów (ms)",
        hint: "Minimalny odstęp między dwoma pobraniami z tego samego serwera.",
      },
      "discovery.scrollDebounceMs": {
        label: "Opóźnienie reakcji na przewijanie (ms)",
        hint: "Czas oczekiwania po przewinięciu, zanim kolejność pracy zostanie zmieniona.",
      },
      "discovery.mutationDebounceMs": {
        label: "Opóźnienie reakcji na zmiany strony (ms)",
        hint: "Czas oczekiwania po zmianie strony (leniwe ładowanie, czytniki online) przed szukaniem nowych obrazów.",
      },
      "discovery.stripGapPx": {
        label: "Maksymalna przerwa w pasie webtoonu (piksele)",
        hint: "Obrazy położone bliżej siebie tworzą jeden ciągły pas.",
      },
      "discovery.translateHiddenTabs": {
        label: "Tłumacz na kartach w tle",
        hint: "Wyłączone: tryb automatyczny czeka, aż karta zostanie wyświetlona.",
      },
      "render.font": {
        label: "Czcionka dialogów",
        hint: "Czcionka przetłumaczonego tekstu w dymkach.",
      },
      "render.verticalText": {
        label: "Pionowy tekst",
        hint: "Tłumaczenia na japoński lub chiński tradycyjny są wpisywane z góry na dół w pionowych dymkach. „Nigdy” zostawia wszystkie tłumaczenia poziomo.",
      },
      "render.minFontPx": {
        label: "Najmniejszy rozmiar tekstu (piksele)",
        hint: "Tekst, który nie mieści się w tym rozmiarze, jest skracany i kończony znakiem „…”.",
      },
      "render.maxFontPx": {
        label: "Największy rozmiar tekstu (piksele)",
        hint: "Tekst pozostaje też zbliżony do rozmiaru oryginalnego liternictwa.",
      },
      "render.eraseSfx": {
        label: "Usuwaj efekty dźwiękowe",
        hint: "Usuwa efekty dźwiękowe z obrazu zamiast je opisywać.",
      },
      "render.sfxLabels": {
        label: "Opisuj efekty dźwiękowe",
        hint: "Pokazuje tłumaczenie efektów dźwiękowych na małych etykietach.",
      },
      "render.showDoneBadge": {
        label: "Oznaczaj przetłumaczone obrazy",
        hint: "Pokazuje małą plakietkę na każdym przetłumaczonym obrazie.",
      },
      "render.peekKey": {
        label: "Przytrzymaj, aby zobaczyć oryginał (kod klawisza)",
        hint: "Kod klawisza, np. Backquote lub KeyH. Zostaw puste, aby wyłączyć.",
      },
      "render.peekWithAlt": {
        label: "Pokazuj oryginał także przy wciśniętym Alt",
        hint: "Samo przytrzymanie klawisza Alt też ukrywa tłumaczenie.",
      },
      "render.popupWithAltClick": {
        label: "Alt+klik otwiera okno dymku",
        hint: "Okno pokazuje oryginał i pozwala edytować tłumaczenie. Długie naciśnięcie zawsze je otwiera.",
      },
      "memory.enabled": {
        label: "Używaj pamięci serii",
        hint: "Wysyła z każdym zapytaniem słowniczek, wcześniejsze kwestie i streszczenie fabuły oraz uczy się nazw z odpowiedzi.",
      },
      "memory.glossaryInPrompt": {
        label: "Wpisy słowniczka na zapytanie",
        hint: "Najpierw Twoje wpisy, potem potwierdzone, potem wyuczone.",
      },
      "memory.termMinSightings": {
        label: "Wystąpienia potrzebne do nauczenia się terminu",
        hint: "Liczba różnych zapytań, w których termin musi się pojawić, zanim zostanie wysłany.",
      },
      "memory.historyMaxLines": {
        label: "Wcześniejsze kwestie wysyłane jako kontekst",
        hint: "Kwestie z tego samego rozdziału. 0 wyłącza ich wysyłanie.",
      },
      "memory.historyMaxTokens": {
        label: "Budżet tokenów na wcześniejsze kwestie",
        hint: "Najstarsze kwestie są pomijane jako pierwsze.",
      },
      "memory.summaryMaxWords": {
        label: "Długość streszczenia fabuły (słowa)",
        hint: "0 wyłącza bieżące streszczenie.",
      },
      "cache.translationTtlDays": {
        label: "Przechowuj nieużywane tłumaczenia przez (dni)",
        hint: "Twoje własne poprawki nigdy nie wygasają.",
      },
      "cache.encodedBytesLruMb": {
        label: "Pamięć podręczna pobranych obrazów (MB)",
        hint: "Pamięć, której silnik używa do przechowywania pobranych obrazów.",
      },
      "privacy.maxImageBytes": {
        label: "Największy plik obrazu (MiB)",
        hint: "Większe pliki obrazów są pomijane.",
      },
      "privacy.maxImagePixels": {
        label: "Największy obraz (megapiksele)",
        hint: "Obrazy z większą liczbą pikseli są pomijane.",
      },
      "debug.logCapacity": {
        label: "Liczba przechowywanych wpisów dziennika",
        hint: "Rozmiar dziennika debugowania przechowywanego przez silnik.",
      },
    },
    site: {
      settings: "Ustawienia",
      settingsFor: (site: string): string => `Ustawienia dla ${site}`,
      layout: "Układ i kierunek czytania",
      layouts: {
        auto: "Wykrywaj automatycznie",
        webtoon: "Webtoon (pionowy pas)",
        "paged-rtl": "Strony, od prawej do lewej (manga)",
        "paged-ltr": "Strony, od lewej do prawej (komiksy)",
      },
      sourceLangHint:
        "Wybiera instrukcje dla AI właściwe dla danego języka i stopień powiększenia wycinków z tekstem.",
      referer: "Nagłówek Referer przy pobieraniu obrazów",
      referers: {
        auto: "Automatycznie",
        "page-url": "Pełny adres strony",
        origin: "Tylko adres witryny",
      },
      refererHint:
        "Tryb automatyczny podąża za stroną, a jeśli serwer obrazów odmówi, ponawia próbę z pełnym adresem " +
        "strony. Zmieniaj to tylko wtedy, gdy obrazy się nie wczytują.",
      subdomains: "Także w subdomenach",
      subdomainsHint: "Tłumacz we wszystkich subdomenach tej witryny z tymi samymi ustawieniami.",
      prefetch: "Przygotowuj obrazy z wyprzedzeniem",
      prefetchHint:
        "Wykrywa obrazy poniżej widoku, których strona jeszcze nie wczytała, aby były gotowe, gdy do nich dotrzesz. Nic nie jest wysyłane, dopóki nie są blisko.",
      frames: "Ramki czytnika z innych witryn",
      framesHint:
        "Jedno źródło (origin) w wierszu, np. https://viewer.example.com, gdy strony są wyświetlane w ramce " +
        "dostarczanej przez inną witrynę.",
      framesInvalid: (lines: string): string => `To nie jest źródło http(s): ${lines}`,
    },
    transfer: {
      heading: "Kopia zapasowa i przywracanie",
      hint:
        "Zapisz ustawienia i listę witryn w pliku JSON lub wczytaj je z takiego pliku. Potwierdzenie informacji " +
        "o prywatności nigdy nie jest eksportowane.",
      includeKey: "Dołącz klucz API",
      includeKeyHint:
        "Przed udostępnieniem pliku pozostaw tę opcję wyłączoną: każdy mógłby odczytać z niego klucz.",
      export: "Eksportuj ustawienia",
      import: "Importuj ustawienia",
      importConfirm:
        "Zastąpić Twoje ustawienia ustawieniami z pliku? Witryny z pliku zostaną dodane lub zaktualizowane.",
      notJson: "Ten plik nie jest prawidłowym plikiem JSON.",
      notSettings: "Ten plik nie jest eksportem ustawień Panelingo.",
      tooNew: "Ten plik został utworzony w nowszej wersji Panelingo.",
      imported: (settings: number, sites: number): string =>
        `Zaimportowano. Zmienione ustawienia: ${settings}. Witryny: ${sites}.`,
      keyImported: "Zaimportowano klucz API z pliku.",
      keyKept: "Zachowano Twój klucz API (plik go nie zawiera).",
    },
  },
  offline: {
    heading: "Tryb offline (eksperymentalny)",
    intro:
      "Tłumacz bez żadnego endpointu AI: otwarte modele rozpoznawania tekstu (PaddleOCR) i tłumaczenia działają na tym urządzeniu. Jakość jest wyraźnie niższa niż przy modelu wizyjnym: brak kontekstu między dymkami, brak imion postaci, stylizowane napisy często są źle odczytywane, a efekty dźwiękowe pozostają nieprzetłumaczone.",
    download:
      "Modele są pobierane z Hugging Face jednorazowo, gdy są potrzebne, sprawdzane i przechowywane na tym urządzeniu; potem tłumaczenie nie wymaga sieci. Rozmiary: rozpoznawanie tekstu od 8 do 17 MB na język, Opus-MT około 115 MB na parę języków (dwa razy tyle przez angielski), NLLB-200 około 910 MB.",
    engine: "Silnik tłumaczenia",
    engineChoices: {
      api: "Endpoint AI (zgodny z OpenAI)",
      offline: "Offline na tym urządzeniu (eksperymentalnie)",
    },
    model: "Model tłumaczenia offline",
    modelChoices: {
      "opus-mt": "Opus-MT: mały, jeden model na parę języków",
      "nllb-600m": "NLLB-200 600M: każda para, duży, niekomercyjny",
    },
    pairs:
      "Opus-MT tłumaczy z koreańskiego, japońskiego, chińskiego i hiszpańskiego na angielski oraz z angielskiego na wietnamski, hiszpański, francuski, niemiecki, włoski i indonezyjski; pozostałe pary przechodzą przez angielski. NLLB-200 tłumaczy między wszystkimi wymienionymi tu językami.",
    license:
      "Licencje: PaddleOCR i większość modeli Opus-MT Apache-2.0, dwa modele Opus-MT CC-BY-4.0, NLLB-200 CC-BY-NC-4.0 (wyłącznie do użytku niekomercyjnego).",
    stored: (mb: number): string => `Pobrane modele na tym urządzeniu: ${Math.round(mb)} MB`,
    deleteModels: "Usuń pobrane modele",
    deleteConfirm: "Usunąć pobrane modele offline? Zostaną pobrane ponownie, gdy będą potrzebne.",
    deleted: "Pobrane modele zostały usunięte.",
  },
  manifest: {
    description:
      "Tłumaczy komiksy, mangi i webtoony wprost na stronie podczas czytania – z dowolnym modelem AI zgodnym z OpenAI.",
    commands: {
      "toggle-overlay": "Pokaż lub ukryj nakładkę z tłumaczeniem",
      "translate-visible": "Przetłumacz widoczne obrazy",
      "toggle-site": "Włącz lub wyłącz automatyczne tłumaczenie tej witryny",
      "open-side-panel": "Otwórz transkrypcję w panelu bocznym",
    },
  },
};
