// German UI catalog. PURE.

import type { Catalog } from "./en.ts";

/** German plural: singular only for exactly 1 (0 takes the plural). */
const plural = (n: number, one: string, other: string): string => (n === 1 ? one : other);

/** One decimal with a decimal comma (1,3). */
const decimal = (value: number): string => value.toFixed(1).replace(".", ",");

const errors: Catalog["errors"] = {
  "api.unreachable": {
    title: "KI-Endpunkt nicht erreichbar",
    hint: "Prüfen Sie die Basis-URL in den Optionen und stellen Sie sicher, dass der Server (oder Ihr lokales Modell) läuft.",
  },
  "api.lna_blocked": {
    title: "Chrome hat die Verbindung zu Ihrem lokalen KI-Server blockiert",
    hint: "Öffnen Sie die Website-Einstellungen der Erweiterung → Zugriff auf lokales Netzwerk (Local network access) → Zulassen.",
  },
  "api.unauthorized": {
    title: "Der KI-Endpunkt hat den API-Schlüssel abgelehnt",
    hint: "Geben Sie in den Optionen einen gültigen API-Schlüssel ein. Die Übersetzung wird automatisch fortgesetzt.",
  },
  "api.config": {
    title: "KI-Endpunkt oder Modell falsch konfiguriert",
    hint: "Prüfen Sie in den Optionen die Basis-URL und wählen Sie ein Modell, das Bildeingaben (Vision) unterstützt.",
  },
  "api.rate_limit": {
    title: "Der KI-Anbieter drosselt die Anfragen",
    hint: "Die Erweiterung sendet langsamer und versucht es automatisch erneut.",
  },
  "api.upstream": { title: "KI-Serverfehler, wird erneut versucht", hint: "" },
  "api.context_length": { title: "Anfrage zu lang, wird aufgeteilt", hint: "" },
  "api.timeout": {
    title: "Die KI hat zu lange zum Antworten gebraucht",
    hint: "Die Erweiterung versucht es noch einmal.",
  },
  "api.truncated": { title: "Antwort abgeschnitten, wird fortgesetzt", hint: "" },
  "api.partial": { title: "Die KI hat einige Sprechblasen ausgelassen, erneute Anfrage läuft", hint: "" },
  "api.empty": { title: "Leere Antwort der KI, wird erneut versucht", hint: "" },
  "api.too_large": { title: "Bild zu groß zum Senden, wird verkleinert", hint: "" },
  "api.bad_request": {
    title: "Die Anfrage wurde abgelehnt (Programmfehler)",
    hint: "Exportieren Sie das Debug-Protokoll in den Optionen.",
  },
  "api.protocol": { title: "Unerwartetes Antwortformat vom KI-Endpunkt", hint: "" },
  "llm.refused": {
    title: "Die KI hat die Übersetzung verweigert",
    hint: "Die Sprechblase behält ihren Originaltext.",
  },
  "llm.missing": {
    title: "Nicht übersetzt",
    hint: "Klicken Sie auf „Neu übersetzen“, um nur diese Sprechblase erneut zu übersetzen.",
  },
  "llm.format": { title: "Fehlerhafte Antwort der KI, wird erneut versucht", hint: "" },
  "image.url_blocked": { title: "Bild aus Sicherheitsgründen blockiert", hint: "" },
  "image.http": {
    title: "Bild konnte nicht geladen werden",
    hint: "Wenn die Website eine Anmeldung erfordert, aktivieren Sie im Pop-up „Cookies mit Bildanfragen senden“.",
  },
  "image.not_image": { title: "Keine Bilddatei", hint: "" },
  "image.too_large": { title: "Bild zu groß", hint: "" },
  "image.decode": { title: "Bild konnte nicht dekodiert werden", hint: "" },
  "image.capture_unavailable": { title: "Scrollen Sie zum Bild, um es zu übersetzen", hint: "" },
  "image.capture_blocked": {
    title: "Dieses Bild lässt sich nur per Bildschirmaufnahme lesen",
    hint: "Aktivieren Sie die Übersetzung für diese Website, lassen Sie diesen Tab im Vordergrund und versuchen Sie es erneut.",
  },
  "detector.webgpu_unavailable": { title: "Texterkennung auf der CPU (langsamer)", hint: "" },
  "detector.canary_mismatch": { title: "Widersprüchliche Ergebnisse der GPU, CPU wird verwendet", hint: "" },
  "detector.model_integrity": {
    title: "Das Texterkennungsmodell ist beschädigt",
    hint: "Installieren Sie die Erweiterung neu (Entwickler: npm run fetch-models, dann npm run build).",
  },
  "detector.init": {
    title: "Texterkennung konnte nicht gestartet werden",
    hint: "Exportieren Sie das Debug-Protokoll in den Optionen.",
  },
  "detector.run": { title: "Texterkennung fehlgeschlagen", hint: "" },
  "offline.pair_unsupported": {
    title: "Dieses Sprachpaar ist offline nicht verfügbar",
    hint: "Wählen Sie in den Optionen NLLB-200 als Offline-Modell oder eine andere Zielsprache.",
  },
  "offline.download": {
    title: "Die Offline-Modelle konnten nicht heruntergeladen werden",
    hint: "Prüfen Sie die Verbindung zu huggingface.co. Die Übersetzung wird automatisch erneut versucht.",
  },
  "offline.model_integrity": {
    title: "Ein heruntergeladenes Offline-Modell ist beschädigt",
    hint: "Übersetzen Sie erneut, um es noch einmal herunterzuladen.",
  },
  "offline.run": {
    title: "Die Offline-Modelle sind fehlgeschlagen",
    hint: "Exportieren Sie das Debug-Protokoll in den Optionen.",
  },
  "offline.out_of_memory": {
    title: "Nicht genug Speicher für die Offline-Modelle",
    hint: "Die Übersetzungsmodelle wurden neu gestartet, die Engine läuft weiter. Wählen Sie in den Optionen Opus-MT (viel kleiner) oder schließen Sie andere Tabs.",
  },
  "engine.unavailable": {
    title: "Die Übersetzungs-Engine konnte nicht gestartet werden",
    hint: "Laden Sie die Seite neu oder deaktivieren und aktivieren Sie die Erweiterung erneut.",
  },
  "engine.closing": { title: "Die Engine wird neu gestartet", hint: "" },
  "engine.overloaded": { title: "Die Engine ist ausgelastet", hint: "" },
  "engine.protocol": { title: "Versionskonflikt der Erweiterung", hint: "Laden Sie die Seite neu." },
  "engine.internal": {
    title: "Interner Fehler",
    hint: "Exportieren Sie das Debug-Protokoll in den Optionen.",
  },
  "msg.too_large": { title: "Daten zu groß, werden per URL neu geladen", hint: "" },
  "ctx.invalidated": {
    title: "Die Erweiterung wurde gerade neu geladen",
    hint: "Laden Sie die Seite neu, um weiter zu übersetzen.",
  },
  "dnr.failed": { title: "Referer für das Bild konnte nicht gesetzt werden", hint: "" },
  "store.io": { title: "Cache konnte nicht gelesen oder geschrieben werden", hint: "" },
  "store.quota": {
    title: "Der Cache ist voll",
    hint: "Geben Sie in den Optionen Speicherplatz im Cache frei.",
  },
  "site.disabled": { title: "Übersetzung ist für diese Website deaktiviert", hint: "" },
  "privacy.consent": {
    title: "Senden von Bildern an die KI noch nicht bestätigt",
    hint: "Lesen Sie den Datenschutzhinweis und erlauben Sie das Senden, um mit der Übersetzung zu beginnen.",
  },
  cancelled: { title: "Abgebrochen", hint: "" },
};

export const DE: Catalog = {
  errors,
  readiness: {
    unknown: { label: "KI-Endpunkt wird geprüft…", hint: "" },
    ready: { label: "KI-Endpunkt bereit", hint: "" },
    unauthorized: { label: "API-Schlüssel abgelehnt", hint: errors["api.unauthorized"].hint },
    unreachable: { label: "KI-Endpunkt nicht erreichbar", hint: errors["api.unreachable"].hint },
    lna_blocked: {
      label: "Chrome hat den lokalen KI-Server blockiert",
      hint: errors["api.lna_blocked"].hint,
    },
    misconfigured: { label: "KI-Endpunkt nicht konfiguriert", hint: errors["api.config"].hint },
  },
  imageState: {
    queued: "In der Warteschlange",
    acquiring: "Bild wird geladen",
    detecting: "Text wird gesucht",
    waiting: "Wartet auf Übersetzung",
    translating: "Wird übersetzt",
    done: "Übersetzt",
    "no-text": "Kein Text",
    partial: "Teilweise übersetzt",
    refused: "Von der KI abgelehnt",
    paused: "Pausiert",
    error: "Fehler",
    stale: "Veraltete Übersetzung",
  },
  unitStatus: {
    pending: "Wartet",
    translating: "Wird übersetzt",
    ok: "Übersetzt",
    "keep-original": "Original beibehalten",
    manual: "Bearbeitet",
    untranslated: "Nicht übersetzt",
    refused: "Von der KI abgelehnt",
    ignored: "Ignoriert",
    error: "Fehler",
    stale: "Veraltet",
  },
  enginePhase: {
    booting: "Engine startet",
    ready: "Engine läuft",
    closing: "Engine wird beendet",
    failed: "Engine-Fehler",
  },
  detectorBackend: { webgpu: "GPU (WebGPU)", wasm: "CPU (WASM)", none: "noch nicht gewählt" },
  detectorState: {
    unloaded: "nicht geladen",
    loading: "wird geladen",
    ready: "bereit",
    failed: "fehlgeschlagen",
  },
  detectorCanary: {
    pass: "GPU geprüft",
    fail: "GPU-Ergebnisse widersprüchlich, auf CPU umgestellt",
    pending: "GPU wird geprüft",
    skipped: "",
  },
  offlineState: {
    idle: "Modelle werden bei der ersten Verwendung geladen",
    downloading: "Modelle werden heruntergeladen",
    loading: "Modelle werden geladen",
    ready: "Bereit",
    failed: "Fehlgeschlagen",
  },
  ui: {
    appName: "Panelingo",
    siteEnable: "Diese Website übersetzen",
    siteDisable: "Diese Website nicht mehr übersetzen",
    modeAuto: "Beim Scrollen übersetzen",
    modeManual: "Nur auf Anforderung übersetzen",
    translateVisible: "Sichtbare Bilder übersetzen",
    translateImage: "Übersetzen",
    retranslate: "Neu übersetzen",
    showOriginal: "Original anzeigen",
    uploadsToday: (count: number, mb: number): string =>
      `Heute ${count} ${plural(count, "Kompositbild", "Kompositbilder")} (${decimal(mb)} MB) an die KI gesendet`,
    progress: (done: number, total: number, etaSec?: number): string =>
      etaSec === undefined || !Number.isFinite(etaSec)
        ? `Übersetzung ${done}/${total}`
        : `Übersetzung ${done}/${total} · ~${Math.max(1, Math.round(etaSec))} s`,
    privacyTitle: "Bevor Bilder an die KI gesendet werden",
    privacyBody:
      "Zum Übersetzen sendet die Erweiterung Kompositbilder von Comic-Panels, die Text enthalten (nur auf Websites, " +
      "die Sie aktivieren, oder wenn Sie es anfordern), an den von Ihnen konfigurierten KI-Endpunkt. Der KI-Anbieter " +
      "kann die empfangenen Daten gemäß seinen eigenen Bedingungen speichern. Stellen Sie sicher, dass das für Sie " +
      "und für die Inhalte, die Sie lesen, in Ordnung ist.",
    privacyAccept: "Verstanden, Senden erlauben",
    privacyDecline: "Nicht senden",
  },
  bubble: {
    original: "Original",
    translation: "Übersetzung",
    save: "Speichern",
    revert: "KI-Übersetzung verwenden",
    retranslate: "Neu übersetzen",
    close: "Schließen",
    dialog: "Übersetzte Sprechblase",
    copy: "Kopieren",
    editLabel: "Übersetzung bearbeiten",
    shortened: "Der Text wurde gekürzt, damit er in die Sprechblase passt.",
    saved: "Gespeichert.",
    retranslating: "Wird neu übersetzt…",
  },
  menu: {
    translateImage: "Dieses Bild übersetzen",
    retranslateImage: "Dieses Bild neu übersetzen",
  },
  sidepanel: {
    title: "Panelingo – Transkript",
    heading: "Transkript",
    empty: "In diesem Tab gibt es noch keine übersetzten Zeilen.",
    emptyHint:
      "Öffne eine Comicseite auf einer Website, die du aktiviert hast. Die Zeilen erscheinen hier, sobald sie übersetzt sind.",
    refresh: "Aktualisieren",
    copy: "Alles kopieren",
    copied: "In die Zwischenablage kopiert.",
    page: (n: number): string => `Seite ${n}`,
    jump: "Zeigen",
    jumpHint: "Zur Sprechblase auf der Seite scrollen",
    edit: "Bearbeiten",
    save: "Speichern",
    cancel: "Abbrechen",
    retranslate: "Neu übersetzen",
    revert: "Bearbeitung verwerfen",
    noTranslation: "Keine Übersetzung",
    notFound: "Diese Sprechblase ist nicht mehr auf der Seite.",
    failed: "Das hat nicht geklappt. Bitte erneut versuchen.",
    types: {
      dialogue: "Dialog",
      thought: "Gedanke",
      narration: "Erzählung",
      sign: "Schild",
      sfx: "Soundeffekt",
      ignore: "Ignoriert",
    },
    inconsistent: "Weicht vom Glossar ab",
    tabs: { transcript: "Transkript", glossary: "Glossar" },
    glossary: {
      noSeries: "Öffne eine Comicseite, um das Glossar ihrer Serie zu sehen.",
      untitled: "Serie ohne Titel",
      states: {
        manual: "Deine Einträge",
        confirmed: "Bestätigt",
        learned: "Gelernt",
        candidate: "Vorschläge",
      },
      hints: {
        manual: "Werden immer verwendet. Die KI ändert sie nie.",
        confirmed: "Von dir angenommene Vorschläge. Werden immer verwendet.",
        learned:
          "Namen und Begriffe, die die KI in mehreren Anfragen verwendet hat. Gehen mit jeder Anfrage mit.",
        candidate: "Einmal von der KI bemerkt. Erst nach Bestätigung oder erneutem Auftreten gesendet.",
      },
      empty:
        "Noch keine Einträge. Namen und Begriffe erscheinen hier, sobald die KI sie bemerkt, oder füge eigene hinzu.",
      original: "Originaltext",
      translation: "Übersetzung",
      note: "Notiz (optional)",
      add: "Hinzufügen",
      delete: "Löschen",
      confirm: "Bestätigen",
      seen: (count: number): string => `${count}-mal gesehen`,
      incomplete: "Gib den Originaltext und seine Übersetzung ein.",
      profileHeading: "Serieneinstellungen",
      sourceLang: "Ausgangssprache",
      langAuto: "Automatisch erkennen",
      langs: {
        ja: "Japanisch",
        ko: "Koreanisch",
        zh: "Chinesisch",
        en: "Englisch",
        es: "Spanisch",
        other: "Andere",
      },
      koNames: "Koreanische Namen",
      koRomanized: "Romanisiert (Minjun)",
      koHanViet: "Sino-Vietnamesisch (für vietnamesische Übersetzungen)",
      keepHonorifics: "Japanische Anreden behalten (-san, -kun)",
      summary: "Laufende Zusammenfassung der Handlung senden",
      saveProfile: "Einstellungen speichern",
      saved: "Gespeichert.",
      export: "Exportieren",
      import: "Importieren",
      imported: (count: number): string => `${count} ${plural(count, "Eintrag", "Einträge")} importiert.`,
      importFailed: "Diese Datei ist kein Panelingo-Glossar.",
    },
  },
  debug: { heading: "Debug (nur Dev-/Test-Builds)" },
  duration: (ms: number): string => {
    const seconds = Math.round(Math.abs(ms) / 1000);
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} Min.`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} Std.`;
    const days = Math.round(hours / 24);
    return `${days} ${plural(days, "Tag", "Tage")}`;
  },
  popup: {
    openTranscript: "Transkript öffnen",
    cookies: "Cookies bei Bildanfragen senden",
    cookiesHint:
      "Für Seiten, die Bilder nur angemeldeten Lesern zeigen. Cookies gehen nur an den Bildserver, nie an die KI.",
    apiHeading: "KI-Endpunkt",
    engineHeading: "Übersetzungs-Engine",
    siteHeading: "Diese Website",
    checking: "Wird geprüft…",
    model: (model: string): string => `Modell: ${model}`,
    endpoint: (url: string): string => `Endpunkt: ${url}`,
    cause: (cause: string): string => `Details: ${cause}`,
    engineStopped: "Die Engine ruht; sie startet, sobald Sie übersetzen.",
    engineUnreadable: "Engine-Status konnte nicht gelesen werden.",
    offlineHeading: "Offline-Modus (experimentell)",
    offlineHint: "Es wird kein KI-Endpunkt verwendet: Texterkennung und Übersetzung laufen auf diesem Gerät.",
    offlineDownload: (doneMb: number, totalMb: number): string =>
      `Herunterladen: ${Math.round(doneMb)} von ${Math.round(totalMb)} MB`,
    offlineModels: (models: string): string => `Modelle: ${models}`,
    detectorLine: (backend: string, state: string, canary: string): string =>
      `Texterkennung: ${backend}, ${state}${canary === "" ? "" : ` (${canary})`}`,
    queueLine: (queued: number, inFlight: number, done: number, failed: number): string =>
      `Warteschlange: ${queued} wartend · ${inFlight} laufend · ${done} fertig · ${failed} fehlgeschlagen`,
    pausedBy: (title: string): string => `Pausiert: ${title}`,
    siteUnsupported: "Diese Seite kann nicht übersetzt werden (nur http/https-Seiten).",
    siteOn: "Die Übersetzung ist für diese Website aktiviert.",
    siteOff: "Die Übersetzung ist für diese Website deaktiviert.",
    modeLabel: "Modus",
    visibleSent: (count: number): string =>
      count > 0
        ? `${count} ${plural(count, "Bild", "Bilder")} zur Übersetzung gesendet.`
        : "Keine Comicbilder sichtbar.",
    visibleUnavailable: "Die Erweiterung kann auf dieser Seite nicht ausgeführt werden.",
    retranslatePage: "Seite neu übersetzen",
    retranslateQueued: (count: number): string =>
      `${count} ${plural(count, "Sprechblase", "Sprechblasen")} erneut in die Warteschlange gestellt.`,
    actionFailed: (title: string): string => `Aktion fehlgeschlagen: ${title}`,
    privacyDetails: "Was wird gesendet?",
    options: "Optionen",
    setupHint: "Richten Sie zuerst in den Optionen Ihren KI-Endpunkt ein (Basis-URL, API-Schlüssel, Modell).",
    consentHint:
      "Klicken Sie auf das Symbol von Panelingo, um den Datenschutzhinweis zu lesen, bevor Sie die " +
      "Übersetzung hier aktivieren.",
    build: (id: string): string => `Build ${id}`,
  },
  options: {
    exportLog: "Debug-Protokoll exportieren",
    exportFailed: "Das Debug-Protokoll konnte nicht exportiert werden.",
    exportEmpty: "Das Debug-Protokoll ist leer.",
    title: "Optionen",
    apiHeading: "KI-Endpunkt (OpenAI-kompatibel)",
    apiIntro:
      "Es funktioniert jeder Dienst, der die Chat-Completions-API von OpenAI unterstützt und Bilder akzeptiert: " +
      "OpenAI, OpenRouter, Azure OpenAI, Google Gemini (OpenAI-Modus) oder ein lokaler Server wie Ollama, LM Studio, " +
      "vLLM oder LiteLLM.",
    preset: "Vorlage",
    presetCustom: "Benutzerdefiniert",
    baseUrl: "Basis-URL",
    baseUrlHint:
      "Einschließlich Versionspfad, z. B. https://api.openai.com/v1 oder http://127.0.0.1:11434/v1.",
    baseUrlInvalid: "Keine gültige http(s)-URL.",
    apiKey: "API-Schlüssel",
    apiKeyHint: "Wird nur in diesem Browserprofil gespeichert; für lokale Server ohne Schlüssel leer lassen.",
    model: "Modell",
    modelHint:
      "Das Modell muss Bildeingaben (Vision) unterstützen, z. B. gpt-4o-mini, gemini-2.5-flash, qwen2.5-vl.",
    modelInvalid: "Geben Sie eine Modell-ID ein.",
    testConnection: "Verbindung testen",
    testing: "Wird getestet…",
    testOk: (detail: string): string => `Verbunden. ${detail}`,
    testFailed: (detail: string): string => `Fehlgeschlagen: ${detail}`,
    concurrency: "Parallele Übersetzungsanfragen",
    concurrencyHint: "Standard: 2, maximal 4. Verringern Sie den Wert, wenn Ihr Anbieter Anfragen drosselt.",
    concurrencyInvalid: "Wählen Sie eine Zahl von 1 bis 4.",
    languageHeading: "Sprachen",
    uiLanguage: "Sprache der Benutzeroberfläche",
    targetLanguage: "Übersetzen in",
    languageAuto: "Wie im Browser",
    save: "Speichern",
    saved: "Gespeichert.",
    saveFailed: "Speichern fehlgeschlagen.",
    sitesHeading: "Websites",
    sitesEmpty:
      "Noch keine Websites. Öffnen Sie eine Comicseite, klicken Sie auf das Symbol der Erweiterung und aktivieren " +
      "Sie die Übersetzung für diese Website.",
    siteEnabled: "Aktiv",
    siteMode: "Modus",
    siteRemove: "Entfernen",
    privacyHeading: "Datenschutz: Was an die KI gesendet wird",
    privacyPoints: [
      "Für jede Übersetzung sendet die Erweiterung ein JPEG-Kompositbild an den von Ihnen konfigurierten " +
        "KI-Endpunkt: Miniaturansichten der Bilder (oder Webtoon-Abschnitte), die Text enthalten, nummerierte Rahmen " +
        "um jeden Textbereich und vergrößerte Ausschnitte dieser Bereiche.",
      "Zusätzlich gesendeter Text: Formatierungs- und Sprachregeln, das Glossar der Serie (bis zu 60 Einträge), bis " +
        "zu 20 vorherige Dialogzeilen desselben Kapitels und eine kurze Zusammenfassung.",
      "Niemals gesendet: Bilder ohne Text, die Adresse der gelesenen Seite, Cookies, Ihre IP-Adresse oder " +
        "Browser-Header (über das hinaus, was jede Anfrage an Ihren Endpunkt ohnehin enthält).",
      "Der KI-Anbieter kann die empfangenen Daten gemäß seinen eigenen Bedingungen aufbewahren. Gehen Sie davon aus, " +
        "dass alles Gesendete gespeichert wird.",
      "Beim Scrollen werden nur Websites übersetzt, die Sie aktiviert haben. Andere Seiten werden nur auf Ihre " +
        "Anforderung hin übersetzt (Kontextmenü oder Tastenkürzel), und die Erweiterung fragt immer vor dem ersten " +
        "Senden nach.",
      "Das Pop-up zeigt, wie viele Kompositbilder heute gesendet wurden.",
      "Übersetzungen, Sprechblasenpositionen und Übermalungen des Originaltexts bleiben auf diesem Gerät in der " +
        "IndexedDB der Erweiterung; Sie können sie unten unter „Cache“ löschen.",
    ],
    privacyAcked: (when: string): string =>
      `Sie haben den Hinweis zum Senden von Bildern am ${when} bestätigt.`,
    privacyNotAcked:
      "Sie haben den Hinweis zum Senden von Bildern noch nicht bestätigt; die Erweiterung fragt vor dem ersten " +
      "Senden nach.",
    cacheHeading: "Cache",
    cacheHint:
      "Löscht alle auf diesem Gerät gespeicherten Übersetzungen, Sprechblasenpositionen und Übermalungen. Beim " +
      "erneuten Lesen wird wieder übersetzt (und es werden erneut Bilder gesendet).",
    cacheClear: "Gesamten Cache leeren",
    cacheConfirm:
      "Gesamten Cache leeren? Beim nächsten Lesen wird wieder übersetzt und es werden erneut Bilder gesendet.",
    cacheCleared: (count: number): string => `${count} ${plural(count, "Eintrag", "Einträge")} gelöscht.`,
    cacheFailed: (title: string): string => `Cache konnte nicht geleert werden: ${title}`,
    debugHeading: "Debug-Protokoll",
    logLevel: "Protokollstufe",
    logLevels: {
      debug: "Ausführlich (Debug)",
      info: "Info",
      warn: "Warnungen",
      error: "Nur Fehler",
    },
  },
  optionsAdvanced: {
    heading: "Erweiterte Einstellungen",
    intro:
      "Feineinstellungen für Anfragen, Texterkennung, Textdarstellung und Caches. Die Standardwerte passen für " +
      "die meisten Fälle. Jede Änderung wird gespeichert, sobald Sie das Feld verlassen.",
    defaultIs: (value: string): string => `Standard: ${value}`,
    range: (min: string, max: string): string => `Erlaubt: ${min} bis ${max}`,
    automatic: "automatisch",
    on: "aktiviert",
    off: "deaktiviert",
    reset: "Zurücksetzen",
    resetLabel: (label: string): string => `„${label}“ auf den Standardwert zurücksetzen`,
    resetAll: "Alle erweiterten Einstellungen zurücksetzen",
    resetAllConfirm: "Alle erweiterten Einstellungen auf ihre Standardwerte zurücksetzen?",
    resetAllDone: "Alle erweiterten Einstellungen wurden auf ihre Standardwerte zurückgesetzt.",
    notANumber: "Geben Sie eine Zahl ein.",
    adjusted: (value: string): string => `Als ${value} gespeichert (nächster erlaubter Wert).`,
    badKey: "Verwenden Sie einen Tastencode wie Backquote oder KeyH, oder lassen Sie das Feld leer.",
    verticalChoices: { auto: "Automatisch", never: "Nie" },
    groups: {
      api: "KI-Anfragen",
      translate: "Inhalt der Anfragen",
      detector: "Texterkennung",
      engine: "Übersetzungs-Engine",
      discovery: "Bilder finden",
      render: "Textdarstellung",
      memory: "Seriengedächtnis",
      cache: "Cache",
      privacy: "Limits für Bilder",
      debug: "Debug-Protokoll",
    },
    fields: {
      "api.temperature": {
        label: "Temperatur",
        hint: "Wie unterschiedlich die Antworten ausfallen. Leer lassen, um den Standardwert des Anbieters zu verwenden.",
      },
      "api.urgentLane": {
        label: "Zusätzlicher Kanal für sichtbare Bilder",
        hint: "Fügt einen Anfragekanal hinzu, der für die Bilder reserviert ist, die Sie gerade ansehen.",
      },
      "api.maxInFlight": {
        label: "Maximal gleichzeitige Anfragen",
        hint: "Feste Obergrenze, einschließlich des zusätzlichen Kanals. Nie niedriger als die parallelen Übersetzungsanfragen.",
      },
      "api.firstByteTimeoutMs": {
        label: "Warten auf die erste Antwort (Sekunden)",
        hint: "Abbrechen, wenn der Endpunkt so lange nichts sendet.",
      },
      "api.idleTimeoutMs": {
        label: "Zeitlimit bei stockender Antwort (Sekunden)",
        hint: "Abbrechen, wenn das Streaming einer Antwort so lange stockt.",
      },
      "api.totalTimeoutMs": {
        label: "Maximale Anfragedauer (Sekunden)",
        hint: "Jede Anfrage nach dieser Zeit abbrechen.",
      },
      "api.healthTimeoutMs": {
        label: "Zeitlimit für die Verbindungsprüfung (Sekunden)",
        hint: "Gilt für die Endpunktprüfung und für „Verbindung testen“.",
      },
      "translate.boxBudget": {
        label: "Textbereiche pro Anfrage",
        hint: "Leer lassen, um das Profil des Modells zu verwenden (12, 16 oder 20).",
      },
      "translate.jpegQuality": {
        label: "JPEG-Qualität",
        hint: "Qualität des Kompositbilds, das an die KI gesendet wird.",
      },
      "translate.requestBodyCapMb": {
        label: "Maximale Anfragegröße (MB)",
        hint: "Größere Kompositbilder werden stärker komprimiert und dann aufgeteilt.",
      },
      "translate.promptCharCap": {
        label: "Maximale Prompt-Länge (Zeichen)",
        hint: "Ist eine Anfrage länger, wird zuerst der Kontext gekürzt.",
      },
      "translate.maxLadderRequestsPerPack": {
        label: "Zusätzliche Anfragen für ausgelassenen Text",
        hint: "Erneutes Fragen und Aufteilen, wenn die KI Textbereiche auslässt.",
      },
      "translate.maxHttpRetriesPerRequest": {
        label: "Wiederholungen nach Netzwerkfehlern",
        hint: "Pro Anfrage, bei vorübergehenden HTTP- und Netzwerkfehlern.",
      },
      "translate.engine": {
        label: "Übersetzungs-Engine",
        hint: "Der Offline-Modus ist experimentell: siehe Offline-Modus oben.",
      },
      "translate.offlineModel": {
        label: "Offline-Übersetzungsmodell",
        hint: "Wird nur im Offline-Modus verwendet.",
      },
      "translate.splitOnRefusal": {
        label: "Abgelehnte Anfragen aufteilen",
        hint: "Wenn die KI ablehnt, beide Hälften einzeln versuchen, statt aufzugeben.",
      },
      "detector.backend": {
        label: "Hardware für die Texterkennung",
        hint: "Die automatische Wahl nutzt die GPU, wenn sie einen Selbsttest besteht, andernfalls die CPU.",
      },
      "detector.scoreMin": {
        label: "Mindestwert für die Erkennung",
        hint: "Niedrigere Werte finden mehr Text, aber auch mehr Fehltreffer.",
      },
      "detector.sliceTriggerRatio": {
        label: "Bilder zerteilen, wenn länger als (Verhältnis)",
        hint: "Bilder und Webtoon-Streifen, deren lange Seite dieses Vielfache der kurzen Seite überschreitet, werden in Abschnitte zerteilt.",
      },
      "detector.sliceHeightRatio": {
        label: "Abschnittslänge (× kurze Seite)",
        hint: "Länge jedes Abschnitts als Vielfaches der kurzen Bildseite.",
      },
      "detector.sliceOverlap": {
        label: "Überlappung der Abschnitte (Anteil)",
        hint: "Überlappung benachbarter Abschnitte als Anteil eines Abschnitts.",
      },
      "detector.sliceOverlapMinPx": {
        label: "Minimale Überlappung der Abschnitte (Pixel)",
        hint: "Benachbarte Abschnitte teilen sich immer mindestens so viele Pixel.",
      },
      "detector.quietRows": {
        label: "Abschnitte zwischen Textzeilen schneiden",
        hint: "Experimentell: verschiebt die Schnitte in Pixelzeilen ohne Tinte.",
      },
      "engine.idleCloseMin": {
        label: "Untätige Engine schließen nach (Minuten)",
        hint: "Gibt Speicher frei, wenn keine Seite die Engine so lange genutzt hat.",
      },
      "engine.detectorReleaseMin": {
        label: "Texterkennung entladen nach (Minuten)",
        hint: "Gibt das Erkennungsmodell frei, wenn es so lange nicht gelaufen ist.",
      },
      "engine.portIdleMin": {
        label: "Untätige Seiten trennen nach (Minuten)",
        hint: "Eine Seite gibt die Engine frei, wenn sie so lange nichts zu tun hatte.",
      },
      "discovery.minNaturalSide": {
        label: "Bilder ignorieren, wenn kleiner als (Pixel)",
        hint: "Tatsächliche Größe der kurzen Seite. Überspringt Symbole, Avatare und Werbung.",
      },
      "discovery.minDisplayedSide": {
        label: "Bilder ignorieren, wenn kleiner angezeigt als (Pixel)",
        hint: "Größe der kurzen Seite auf dem Bildschirm.",
      },
      "discovery.secondsPerScreenDefault": {
        label: "Anfängliche Lesegeschwindigkeit (Sekunden pro Bildschirm)",
        hint: "Startwert, bis Ihre Lesegeschwindigkeit gemessen ist.",
      },
      "discovery.lookaheadMinScreens": {
        label: "Übersetzungsvorlauf, mindestens (Bildschirme)",
        hint: "Bilder so viele Bildschirme unterhalb der Ansicht werden immer im Voraus übersetzt.",
      },
      "discovery.lookaheadMaxScreens": {
        label: "Übersetzungsvorlauf, höchstens (Bildschirme)",
        hint: "Obergrenze, wenn Sie schnell lesen oder die KI langsam antwortet.",
      },
      "discovery.lookaheadMaxScreensStrip": {
        label: "Übersetzungsvorlauf bei Webtoon-Streifen, höchstens (Bildschirme)",
        hint: "Obergrenze für lange vertikale Streifen.",
      },
      "discovery.detectAheadMinScreens": {
        label: "Erkennungsvorlauf, mindestens (Bildschirme)",
        hint: "Noch nicht geladene Bilder werden so weit im Voraus erkannt (ohne Upload).",
      },
      "discovery.detectAheadMaxScreens": {
        label: "Erkennungsvorlauf, höchstens (Bildschirme)",
        hint: "Obergrenze für schnelle Leser.",
      },
      "discovery.detectMaxImages": {
        label: "Höchstens im Voraus erkannte Bilder",
        hint: "Zählt jedes Bild vor Ihnen, geladen oder nicht.",
      },
      "discovery.fetchPerHostConcurrency": {
        label: "Parallele Bild-Downloads pro Server",
        hint: "Gleichzeitige Bild-Downloads vom selben Bildserver.",
      },
      "discovery.prefetchSpacingMs": {
        label: "Pause zwischen Bild-Downloads (ms)",
        hint: "Mindestabstand zwischen zwei Downloads vom selben Server.",
      },
      "discovery.scrollDebounceMs": {
        label: "Reaktionsverzögerung beim Scrollen (ms)",
        hint: "So lange nach dem Scrollen warten, bevor die Arbeit neu geordnet wird.",
      },
      "discovery.mutationDebounceMs": {
        label: "Reaktionsverzögerung bei Seitenänderungen (ms)",
        hint: "So lange nach einer Änderung der Seite (Lazy Loading, Reader-Apps) warten, bevor nach neuen Bildern gesucht wird.",
      },
      "discovery.stripGapPx": {
        label: "Maximaler Abstand in einem Webtoon-Streifen (Pixel)",
        hint: "Bilder, die näher beieinander liegen, bilden einen durchgehenden Streifen.",
      },
      "discovery.translateHiddenTabs": {
        label: "In Hintergrund-Tabs übersetzen",
        hint: "Aus: Der automatische Modus wartet, bis der Tab angezeigt wurde.",
      },
      "render.font": {
        label: "Schriftart für Dialoge",
        hint: "Schriftart des übersetzten Texts in Sprechblasen.",
      },
      "render.verticalText": {
        label: "Vertikale Beschriftung",
        hint: "Übersetzungen ins Japanische oder traditionelle Chinesisch werden in senkrechten Sprechblasen von oben nach unten gesetzt. „Nie“ setzt jede Übersetzung waagerecht.",
      },
      "render.minFontPx": {
        label: "Kleinste Textgröße (Pixel)",
        hint: "Text, der in dieser Größe nicht passt, wird mit „…“ gekürzt.",
      },
      "render.maxFontPx": {
        label: "Größte Textgröße (Pixel)",
        hint: "Der Text bleibt außerdem nah an der Größe der Originalschrift.",
      },
      "render.eraseSfx": {
        label: "Soundeffekte entfernen",
        hint: "Soundeffekte aus dem Bild entfernen, statt sie zu beschriften.",
      },
      "render.sfxLabels": {
        label: "Soundeffekte beschriften",
        hint: "Zeigt die Übersetzung von Soundeffekten als kleine Beschriftungen.",
      },
      "render.showDoneBadge": {
        label: "Übersetzte Bilder markieren",
        hint: "Zeigt auf jedem übersetzten Bild ein kleines Symbol.",
      },
      "render.peekKey": {
        label: "Gedrückt halten, um das Original zu sehen (Tastencode)",
        hint: "Ein Tastencode wie Backquote oder KeyH. Leer lassen, um die Funktion zu deaktivieren.",
      },
      "render.peekWithAlt": {
        label: "Original auch beim Halten von Alt zeigen",
        hint: "Auch das Halten der Alt-Taste allein blendet die Übersetzung aus.",
      },
      "render.popupWithAltClick": {
        label: "Alt+Klick öffnet das Sprechblasen-Fenster",
        hint: "Das Fenster zeigt das Original, die Übersetzung lässt sich dort bearbeiten. Langes Drücken öffnet es immer.",
      },
      "memory.enabled": {
        label: "Seriengedächtnis verwenden",
        hint: "Sendet mit jeder Anfrage das Glossar, vorherige Zeilen und eine Zusammenfassung der Handlung und lernt Namen aus den Antworten.",
      },
      "memory.glossaryInPrompt": {
        label: "Glossareinträge pro Anfrage",
        hint: "Zuerst Ihre Einträge, dann bestätigte, dann gelernte.",
      },
      "memory.termMinSightings": {
        label: "Vorkommen, bevor ein Begriff gelernt wird",
        hint: "Anzahl verschiedener Anfragen, die einen Begriff nennen müssen, bevor er gesendet wird.",
      },
      "memory.historyMaxLines": {
        label: "Vorherige Zeilen als Kontext",
        hint: "Zeilen aus demselben Kapitel. 0 sendet keine.",
      },
      "memory.historyMaxTokens": {
        label: "Token-Budget für vorherige Zeilen",
        hint: "Die ältesten Zeilen werden zuerst weggelassen.",
      },
      "memory.summaryMaxWords": {
        label: "Länge der Handlungszusammenfassung (Wörter)",
        hint: "0 schaltet die laufende Zusammenfassung ab.",
      },
      "cache.translationTtlDays": {
        label: "Unbenutzte Übersetzungen behalten für (Tage)",
        hint: "Ihre eigenen Bearbeitungen verfallen nie.",
      },
      "cache.encodedBytesLruMb": {
        label: "Cache für heruntergeladene Bilder (MB)",
        hint: "Speicher, den die Engine für heruntergeladene Bilder nutzt.",
      },
      "privacy.maxImageBytes": {
        label: "Größte Bilddatei (MiB)",
        hint: "Größere Bilddateien werden übersprungen.",
      },
      "privacy.maxImagePixels": {
        label: "Größtes Bild (Megapixel)",
        hint: "Bilder mit mehr Pixeln werden übersprungen.",
      },
      "debug.logCapacity": {
        label: "Gespeicherte Protokolleinträge",
        hint: "Größe des Debug-Protokolls, das die Engine speichert.",
      },
    },
    site: {
      settings: "Einstellungen",
      settingsFor: (site: string): string => `Einstellungen für ${site}`,
      layout: "Layout und Leserichtung",
      layouts: {
        auto: "Automatisch erkennen",
        webtoon: "Webtoon (vertikaler Streifen)",
        "paged-rtl": "Seiten, von rechts nach links (Manga)",
        "paged-ltr": "Seiten, von links nach rechts (Comics)",
      },
      sourceLangHint:
        "Bestimmt die sprachspezifischen Anweisungen für die KI und wie stark Textausschnitte vergrößert werden.",
      referer: "Referer für Bild-Downloads",
      referers: {
        auto: "Automatisch",
        "page-url": "Vollständige Seitenadresse",
        origin: "Nur die Website-Adresse",
      },
      refererHint:
        "Die automatische Einstellung folgt der Seite und versucht es dann mit der vollständigen Seitenadresse, " +
        "wenn der Bildserver ablehnt. Ändern Sie sie nur, wenn Bilder nicht geladen werden.",
      subdomains: "Auch auf Subdomains",
      subdomainsHint: "Auf allen Subdomains dieser Website mit denselben Einstellungen übersetzen.",
      prefetch: "Bilder im Voraus vorbereiten",
      prefetchHint:
        "Erkennt Bilder unterhalb der Ansicht, die die Seite noch nicht geladen hat, damit sie bereit sind, wenn Sie dort ankommen. Hochgeladen wird erst, wenn sie nah sind.",
      frames: "Reader-Frames anderer Websites",
      framesHint:
        "Ein Ursprung pro Zeile, z. B. https://viewer.example.com, wenn die Seiten in einem Frame angezeigt " +
        "werden, der von einer anderen Website stammt.",
      framesInvalid: (lines: string): string => `Kein http(s)-Ursprung: ${lines}`,
    },
    transfer: {
      heading: "Sichern und wiederherstellen",
      hint:
        "Speichern Sie Ihre Einstellungen und die Website-Liste in einer JSON-Datei oder laden Sie sie daraus. " +
        "Die Datenschutzbestätigung wird nie exportiert.",
      includeKey: "API-Schlüssel einschließen",
      includeKeyHint:
        "Lassen Sie dies vor dem Teilen der Datei deaktiviert: Jeder könnte den Schlüssel darin lesen.",
      export: "Einstellungen exportieren",
      import: "Einstellungen importieren",
      importConfirm:
        "Ihre Einstellungen durch die aus der Datei ersetzen? Websites aus der Datei werden hinzugefügt oder " +
        "aktualisiert.",
      notJson: "Diese Datei ist kein gültiges JSON.",
      notSettings: "Diese Datei ist kein Panelingo-Einstellungsexport.",
      tooNew: "Diese Datei wurde mit einer neueren Version von Panelingo erstellt.",
      imported: (settings: number, sites: number): string =>
        `Importiert. Geänderte Einstellungen: ${settings}. Websites: ${sites}.`,
      keyImported: "Der API-Schlüssel aus der Datei wurde importiert.",
      keyKept: "Ihr API-Schlüssel wurde beibehalten (die Datei enthält keinen).",
    },
  },
  offline: {
    heading: "Offline-Modus (experimentell)",
    intro:
      "Übersetzen ohne KI-Endpunkt: Open-Source-Modelle für Texterkennung (PaddleOCR) und Übersetzung laufen auf diesem Gerät. Die Qualität ist deutlich geringer als mit einem Vision-Modell: kein Kontext zwischen Sprechblasen, keine Figurennamen, stilisierte Schrift wird oft falsch gelesen, und Soundeffekte bleiben unübersetzt.",
    download:
      "Die Modelle werden bei Bedarf einmalig von Hugging Face heruntergeladen, geprüft und auf diesem Gerät gespeichert; danach braucht die Übersetzung kein Netzwerk. Größen: Texterkennung 8 bis 17 MB pro Sprache, Opus-MT etwa 115 MB pro Sprachpaar (doppelt so viel über Englisch), NLLB-200 etwa 910 MB.",
    engine: "Übersetzungs-Engine",
    engineChoices: {
      api: "KI-Endpunkt (OpenAI-kompatibel)",
      offline: "Offline auf diesem Gerät (experimentell)",
    },
    model: "Offline-Übersetzungsmodell",
    modelChoices: {
      "opus-mt": "Opus-MT: klein, ein Modell pro Sprachpaar",
      "nllb-600m": "NLLB-200 600M: alle Paare, groß, nicht kommerziell",
    },
    pairs:
      "Opus-MT übersetzt Koreanisch, Japanisch, Chinesisch und Spanisch ins Englische sowie Englisch ins Vietnamesische, Spanische, Französische, Deutsche, Italienische und Indonesische; andere Paare laufen über Englisch. NLLB-200 übersetzt zwischen allen hier aufgeführten Sprachen.",
    license:
      "Lizenzen: PaddleOCR und die meisten Opus-MT-Modelle Apache-2.0, zwei Opus-MT-Modelle CC-BY-4.0, NLLB-200 CC-BY-NC-4.0 (nur nicht kommerzielle Nutzung).",
    stored: (mb: number): string => `Heruntergeladene Modelle auf diesem Gerät: ${Math.round(mb)} MB`,
    deleteModels: "Heruntergeladene Modelle löschen",
    deleteConfirm:
      "Die heruntergeladenen Offline-Modelle löschen? Sie werden bei Bedarf erneut heruntergeladen.",
    deleted: "Die heruntergeladenen Modelle wurden gelöscht.",
  },
  manifest: {
    description:
      "Übersetzt Comics, Manga und Webtoons direkt beim Lesen auf der Seite – mit jeder OpenAI-kompatiblen KI.",
    commands: {
      "toggle-overlay": "Übersetzungsebene ein-/ausblenden",
      "translate-visible": "Sichtbare Bilder übersetzen",
      "toggle-site": "Automatische Übersetzung dieser Website ein-/ausschalten",
      "open-side-panel": "Transkript in der Seitenleiste öffnen",
    },
  },
};
