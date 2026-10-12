// Italian UI catalog. PURE.

import type { Catalog } from "./en.ts";

/** Italian plural: the singular form is used only for exactly 1. */
const plural = (count: number, one: string, other: string): string => (count === 1 ? one : other);

const errors: Catalog["errors"] = {
  "api.unreachable": {
    title: "Impossibile raggiungere l'endpoint IA",
    hint: "Controlla l'URL di base nelle Opzioni e verifica che il server (o il tuo modello locale) sia in esecuzione.",
  },
  "api.lna_blocked": {
    title: "Chrome ha bloccato la connessione al tuo server IA locale",
    hint: "Apri le impostazioni sito dell'estensione → Accesso alla rete locale (Local network access) → Consenti.",
  },
  "api.unauthorized": {
    title: "L'endpoint IA ha rifiutato la chiave API",
    hint: "Inserisci una chiave API valida nelle Opzioni. La traduzione riprenderà automaticamente.",
  },
  "api.config": {
    title: "Endpoint IA o modello non configurati correttamente",
    hint: "Controlla l'URL di base e scegli nelle Opzioni un modello che accetti immagini (vision).",
  },
  "api.rate_limit": {
    title: "Il provider IA sta limitando le richieste",
    hint: "L'estensione rallenta e riprova da sola.",
  },
  "api.upstream": { title: "Errore del server IA, nuovo tentativo in corso", hint: "" },
  "api.context_length": { title: "Richiesta troppo lunga, suddivisione in corso", hint: "" },
  "api.timeout": {
    title: "L'IA ha impiegato troppo tempo a rispondere",
    hint: "L'estensione riprova una volta.",
  },
  "api.truncated": { title: "Risposta troncata, recupero della parte mancante", hint: "" },
  "api.partial": { title: "L'IA ha saltato alcune nuvolette, nuova richiesta in corso", hint: "" },
  "api.empty": { title: "Risposta vuota dall'IA, nuovo tentativo in corso", hint: "" },
  "api.too_large": { title: "Immagine troppo grande da inviare, riduzione in corso", hint: "" },
  "api.bad_request": {
    title: "La richiesta è stata rifiutata (bug)",
    hint: "Esporta il log di debug dalle Opzioni.",
  },
  "api.protocol": { title: "Formato di risposta inatteso dall'endpoint IA", hint: "" },
  "llm.refused": {
    title: "L'IA si è rifiutata di tradurre",
    hint: "La nuvoletta mantiene il testo originale.",
  },
  "llm.missing": {
    title: "Non tradotta",
    hint: "Usa «Traduci di nuovo» per riprovare la traduzione di questa sola nuvoletta.",
  },
  "llm.format": { title: "Risposta dell'IA non valida, nuovo tentativo in corso", hint: "" },
  "image.url_blocked": { title: "Immagine bloccata per sicurezza", hint: "" },
  "image.http": {
    title: "Impossibile caricare l'immagine",
    hint: "Se il sito richiede l'accesso, attiva «Invia i cookie con le richieste di immagini» nel popup.",
  },
  "image.not_image": { title: "Il file non è un'immagine", hint: "" },
  "image.too_large": { title: "Immagine troppo grande", hint: "" },
  "image.decode": { title: "Impossibile decodificare l'immagine", hint: "" },
  "image.capture_unavailable": { title: "Scorri fino all'immagine per tradurla", hint: "" },
  "image.capture_blocked": {
    title: "Questa immagine si può leggere solo con una cattura dello schermo",
    hint: "Attiva la traduzione per questo sito e tieni questa scheda in primo piano, poi riprova.",
  },
  "detector.webgpu_unavailable": { title: "Rilevamento del testo sulla CPU (più lento)", hint: "" },
  "detector.canary_mismatch": { title: "Risultati della GPU incoerenti, passaggio alla CPU", hint: "" },
  "detector.model_integrity": {
    title: "Il modello di rilevamento del testo è danneggiato",
    hint: "Reinstalla l'estensione (sviluppatori: npm run fetch-models, poi npm run build).",
  },
  "detector.init": {
    title: "Impossibile avviare il rilevamento del testo",
    hint: "Esporta il log di debug dalle Opzioni.",
  },
  "detector.run": { title: "Rilevamento del testo non riuscito", hint: "" },
  "engine.unavailable": {
    title: "Impossibile avviare il motore di traduzione",
    hint: "Ricarica la pagina oppure disattiva e riattiva l'estensione.",
  },
  "engine.closing": { title: "Il motore si sta riavviando", hint: "" },
  "engine.overloaded": { title: "Il motore è occupato", hint: "" },
  "engine.protocol": { title: "Versioni dell'estensione non corrispondenti", hint: "Ricarica la pagina." },
  "engine.internal": { title: "Errore interno", hint: "Esporta il log di debug dalle Opzioni." },
  "msg.too_large": { title: "Dati troppo grandi, ricaricamento tramite URL", hint: "" },
  "ctx.invalidated": {
    title: "L'estensione è appena stata ricaricata",
    hint: "Ricarica la pagina per continuare a tradurre.",
  },
  "dnr.failed": { title: "Impossibile impostare il Referer dell'immagine", hint: "" },
  "store.io": { title: "Impossibile leggere o scrivere la cache", hint: "" },
  "store.quota": { title: "La cache è piena", hint: "Svuota in parte la cache nelle Opzioni." },
  "site.disabled": { title: "Traduzione disattivata per questo sito", hint: "" },
  "privacy.consent": {
    title: "Invio delle immagini all'IA non ancora confermato",
    hint: "Leggi l'informativa sulla privacy e consenti l'invio per iniziare a tradurre.",
  },
  cancelled: { title: "Annullato", hint: "" },
};

export const IT: Catalog = {
  errors,
  readiness: {
    unknown: { label: "Verifica dell'endpoint IA…", hint: "" },
    ready: { label: "Endpoint IA pronto", hint: "" },
    unauthorized: { label: "Chiave API rifiutata", hint: errors["api.unauthorized"].hint },
    unreachable: { label: "Endpoint IA non raggiungibile", hint: errors["api.unreachable"].hint },
    lna_blocked: { label: "Chrome ha bloccato il server IA locale", hint: errors["api.lna_blocked"].hint },
    misconfigured: { label: "Endpoint IA non configurato", hint: errors["api.config"].hint },
  },
  imageState: {
    queued: "In coda",
    acquiring: "Caricamento dell'immagine",
    detecting: "Ricerca del testo",
    waiting: "In attesa di traduzione",
    translating: "Traduzione in corso",
    done: "Tradotta",
    "no-text": "Nessun testo",
    partial: "Tradotta in parte",
    refused: "L'IA si è rifiutata",
    paused: "In pausa",
    error: "Errore",
    stale: "Traduzione obsoleta",
  },
  unitStatus: {
    pending: "In attesa",
    translating: "Traduzione in corso",
    ok: "Tradotta",
    "keep-original": "Lasciata invariata",
    manual: "Modificata",
    untranslated: "Non tradotta",
    refused: "L'IA si è rifiutata",
    ignored: "Ignorata",
    error: "Errore",
    stale: "Obsoleta",
  },
  enginePhase: {
    booting: "Avvio del motore",
    ready: "Motore attivo",
    closing: "Arresto del motore",
    failed: "Errore del motore",
  },
  detectorBackend: {
    webgpu: "GPU (WebGPU)",
    wasm: "CPU (WASM)",
    none: "non ancora scelto",
  },
  detectorState: {
    unloaded: "non caricato",
    loading: "in caricamento",
    ready: "pronto",
    failed: "in errore",
  },
  detectorCanary: {
    pass: "GPU verificata",
    fail: "la GPU ha dato risultati incoerenti, ora si usa la CPU",
    pending: "verifica della GPU",
    skipped: "",
  },
  ui: {
    appName: "Panelingo",
    siteEnable: "Traduci questo sito",
    siteDisable: "Non tradurre più questo sito",
    modeAuto: "Traduci durante lo scorrimento",
    modeManual: "Traduci solo su richiesta",
    translateVisible: "Traduci le immagini visibili",
    translateImage: "Traduci",
    retranslate: "Traduci di nuovo",
    showOriginal: "Mostra l'originale",
    uploadsToday: (count: number, mb: number): string =>
      `${count} ${plural(count, "immagine composita", "immagini composite")} ` +
      `(${mb.toFixed(1).replace(".", ",")} MB) ${plural(count, "inviata", "inviate")} oggi all'IA`,
    progress: (done: number, total: number, etaSec?: number): string =>
      etaSec === undefined || !Number.isFinite(etaSec)
        ? `Traduzione ${done}/${total}`
        : `Traduzione ${done}/${total} · ~${Math.max(1, Math.round(etaSec))} s`,
    privacyTitle: "Prima di inviare immagini all'IA",
    privacyBody:
      "Per tradurre, l'estensione invia immagini composite delle vignette che contengono testo (solo sui siti che " +
      "attivi o quando lo chiedi tu) all'endpoint IA che hai configurato. Il provider IA potrebbe conservare ciò che " +
      "riceve secondo i propri termini. Assicurati che sia accettabile per te e per i contenuti che leggi.",
    privacyAccept: "Ho capito, consenti l'invio",
    privacyDecline: "Non inviare",
  },
  bubble: {
    original: "Originale",
    translation: "Traduzione",
    save: "Salva",
    revert: "Usa la traduzione dell'IA",
    retranslate: "Traduci di nuovo",
    close: "Chiudi",
    dialog: "Fumetto tradotto",
    copy: "Copia",
    editLabel: "Modifica la traduzione",
    shortened: "Il testo è stato accorciato per stare nel fumetto.",
    saved: "Salvato.",
    retranslating: "Nuova traduzione in corso…",
  },
  menu: {
    translateImage: "Traduci questa immagine",
    retranslateImage: "Traduci di nuovo questa immagine",
  },
  sidepanel: {
    title: "Panelingo – Trascrizione",
    heading: "Trascrizione",
    empty: "Ancora nessuna battuta tradotta in questa scheda.",
    emptyHint:
      "Apri una pagina di fumetti su un sito che hai attivato. Le battute compaiono qui man mano che vengono tradotte.",
    refresh: "Aggiorna",
    copy: "Copia tutto",
    copied: "Copiato negli appunti.",
    page: (n: number): string => `Pagina ${n}`,
    jump: "Mostra",
    jumpHint: "Scorri la pagina fino a questo fumetto",
    edit: "Modifica",
    save: "Salva",
    cancel: "Annulla",
    retranslate: "Traduci di nuovo",
    revert: "Annulla modifica",
    noTranslation: "Nessuna traduzione",
    notFound: "Questo fumetto non è più nella pagina.",
    failed: "Non ha funzionato. Riprova.",
    types: {
      dialogue: "Dialogo",
      thought: "Pensiero",
      narration: "Narrazione",
      sign: "Cartello",
      sfx: "Onomatopea",
      ignore: "Ignorato",
    },
    inconsistent: "Diverso dal glossario",
    tabs: { transcript: "Trascrizione", glossary: "Glossario" },
    glossary: {
      noSeries: "Apri una pagina di fumetto per vedere il glossario della sua serie.",
      untitled: "Serie senza titolo",
      states: {
        manual: "Le tue voci",
        confirmed: "Confermate",
        learned: "Apprese",
        candidate: "Suggerimenti",
      },
      hints: {
        manual: "Usate sempre. L'IA non le modifica mai.",
        confirmed: "Suggerimenti che hai accettato. Usati sempre.",
        learned: "Nomi e termini che l'IA ha usato in più richieste. Inviati con ogni richiesta.",
        candidate: "Notati una volta dall'IA. Non inviati finché non li confermi o ricompaiono.",
      },
      empty: "Ancora nessuna voce. Nomi e termini compaiono qui quando l'IA li nota, oppure aggiungi i tuoi.",
      original: "Testo originale",
      translation: "Traduzione",
      note: "Nota (facoltativa)",
      add: "Aggiungi",
      delete: "Elimina",
      confirm: "Conferma",
      seen: (count: number): string => `Visto ${count} ${plural(count, "volta", "volte")}`,
      incomplete: "Inserisci il testo originale e la sua traduzione.",
      profileHeading: "Impostazioni della serie",
      sourceLang: "Lingua di origine",
      langAuto: "Rileva automaticamente",
      langs: {
        ja: "Giapponese",
        ko: "Coreano",
        zh: "Cinese",
        en: "Inglese",
        es: "Spagnolo",
        other: "Altra",
      },
      koNames: "Nomi coreani",
      koRomanized: "Romanizzati (Minjun)",
      koHanViet: "Sino-vietnamita (per traduzioni in vietnamita)",
      keepHonorifics: "Mantieni gli onorifici giapponesi (-san, -kun)",
      summary: "Invia un riassunto progressivo della storia",
      saveProfile: "Salva impostazioni",
      saved: "Salvato.",
      export: "Esporta",
      import: "Importa",
      imported: (count: number): string =>
        `${plural(count, "Importata", "Importate")} ${count} ${plural(count, "voce", "voci")}.`,
      importFailed: "Questo file non è un glossario di Panelingo.",
    },
  },
  debug: {
    heading: "Debug (solo versioni di sviluppo e test)",
  },
  duration: (ms: number): string => {
    const seconds = Math.round(Math.abs(ms) / 1000);
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h`;
    const days = Math.round(hours / 24);
    return `${days} ${plural(days, "giorno", "giorni")}`;
  },
  popup: {
    openTranscript: "Apri la trascrizione",
    cookies: "Invia i cookie con le richieste di immagini",
    cookiesHint:
      "Per i siti che mostrano le immagini solo ai lettori connessi. I cookie vanno solo al server delle immagini, mai all'IA.",
    apiHeading: "Endpoint IA",
    engineHeading: "Motore di traduzione",
    siteHeading: "Questo sito",
    checking: "Verifica in corso…",
    model: (model: string): string => `Modello: ${model}`,
    endpoint: (url: string): string => `Endpoint: ${url}`,
    cause: (cause: string): string => `Dettagli: ${cause}`,
    engineStopped: "Il motore è inattivo; si avvia quando traduci.",
    engineUnreadable: "Impossibile leggere lo stato del motore.",
    detectorLine: (backend: string, state: string, canary: string): string =>
      `Rilevatore di testo: ${backend}, ${state}${canary === "" ? "" : ` (${canary})`}`,
    queueLine: (queued: number, inFlight: number, done: number, failed: number): string =>
      `Richieste: ${queued} in coda · ${inFlight} in invio · ${done} ${plural(done, "completata", "completate")} · ` +
      `${failed} in errore`,
    pausedBy: (title: string): string => `In pausa: ${title}`,
    siteUnsupported: "Questa pagina non può essere tradotta (solo pagine http/https).",
    siteOn: "La traduzione è attiva per questo sito.",
    siteOff: "La traduzione è disattivata per questo sito.",
    modeLabel: "Modalità",
    visibleSent: (count: number): string =>
      count > 0
        ? `${count} ${plural(count, "immagine inviata", "immagini inviate")} per la traduzione.`
        : "Nessuna immagine di fumetti visibile.",
    visibleUnavailable: "L'estensione non può funzionare su questa pagina.",
    retranslatePage: "Traduci di nuovo la pagina",
    retranslateQueued: (count: number): string =>
      `${count} ${plural(count, "nuvoletta rimessa", "nuvolette rimesse")} in coda.`,
    actionFailed: (title: string): string => `Operazione non riuscita: ${title}`,
    privacyDetails: "Scopri cosa viene inviato",
    options: "Opzioni",
    setupHint: "Configura il tuo endpoint IA (URL di base, chiave API, modello) nelle Opzioni per iniziare.",
    consentHint:
      "Fai clic sull'icona di Panelingo per leggere l'informativa sulla privacy prima di attivare la traduzione " +
      "qui.",
    build: (id: string): string => `Versione ${id}`,
  },
  options: {
    exportLog: "Esporta il registro di debug",
    exportFailed: "Impossibile esportare il registro di debug.",
    exportEmpty: "Il registro di debug è vuoto.",
    title: "Opzioni",
    apiHeading: "Endpoint IA (compatibile con OpenAI)",
    apiIntro:
      "Funziona qualsiasi servizio che supporti l'API chat completions di OpenAI e accetti immagini: OpenAI, " +
      "OpenRouter, Azure OpenAI, Google Gemini (modalità OpenAI) o un server locale come Ollama, LM Studio, vLLM o " +
      "LiteLLM.",
    preset: "Preimpostazione",
    presetCustom: "Personalizzata",
    baseUrl: "URL di base",
    baseUrlHint:
      "Includi il percorso della versione, ad es. https://api.openai.com/v1 o http://127.0.0.1:11434/v1.",
    baseUrlInvalid: "URL http(s) non valido.",
    apiKey: "Chiave API",
    apiKeyHint:
      "Salvata solo in questo profilo del browser; lasciala vuota per i server locali che non la richiedono.",
    model: "Modello",
    modelHint:
      "Il modello deve accettare immagini in input (vision), ad es. gpt-4o-mini, gemini-2.5-flash, qwen2.5-vl.",
    modelInvalid: "Inserisci l'ID di un modello.",
    testConnection: "Verifica la connessione",
    testing: "Verifica in corso…",
    testOk: (detail: string): string => `Connessione riuscita. ${detail}`,
    testFailed: (detail: string): string => `Connessione non riuscita: ${detail}`,
    concurrency: "Richieste di traduzione in parallelo",
    concurrencyHint: "Valore predefinito 2, massimo 4. Riducilo se il tuo provider limita le richieste.",
    concurrencyInvalid: "Scegli un numero da 1 a 4.",
    languageHeading: "Lingue",
    uiLanguage: "Lingua dell'interfaccia",
    targetLanguage: "Traduci in",
    languageAuto: "Come il browser",
    save: "Salva",
    saved: "Modifiche salvate.",
    saveFailed: "Impossibile salvare.",
    sitesHeading: "Siti",
    sitesEmpty:
      "Ancora nessun sito. Apri una pagina di fumetti, fai clic sull'icona dell'estensione e attiva la traduzione per " +
      "quel sito.",
    siteEnabled: "Attivo",
    siteMode: "Modalità",
    siteRemove: "Rimuovi",
    privacyHeading: "Privacy: cosa viene inviato all'IA",
    privacyPoints: [
      "Per ogni traduzione l'estensione invia un'unica immagine composita JPEG all'endpoint IA che hai configurato: " +
        "miniature delle immagini (o delle sezioni di webtoon) che contengono testo, riquadri numerati attorno a ogni " +
        "area di testo e ritagli ingranditi di quelle aree.",
      "Testo inviato insieme all'immagine: regole di formattazione e di lingua, il glossario della serie (fino a 60 " +
        "voci), fino a 20 battute precedenti dello stesso capitolo e un breve riassunto.",
      "Non vengono mai inviati: immagini senza testo, l'indirizzo della pagina che stai leggendo, cookie, il tuo " +
        "indirizzo IP o le intestazioni del browser (oltre a quanto contiene già qualsiasi richiesta al tuo endpoint).",
      "Il provider IA potrebbe conservare ciò che riceve secondo i propri termini. Considera tutto ciò che viene " +
        "inviato come archiviato.",
      "Durante lo scorrimento vengono tradotti solo i siti che attivi. Le altre pagine vengono tradotte solo quando " +
        "lo chiedi (menu contestuale o scorciatoia da tastiera) e l'estensione chiede sempre conferma prima del primo " +
        "invio.",
      "Il popup mostra quante immagini composite sono state inviate oggi.",
      "Su questo dispositivo, traduzioni, posizioni delle nuvolette e maschere di cancellazione restano nell'IndexedDB " +
        "dell'estensione; puoi eliminarle nella sezione Cache qui sotto.",
    ],
    privacyAcked: (when: string): string =>
      `Hai confermato l'avviso sull'invio delle immagini in data ${when}.`,
    privacyNotAcked:
      "Non hai ancora confermato l'avviso sull'invio delle immagini; l'estensione chiede conferma prima del primo " +
      "invio.",
    cacheHeading: "Cache",
    cacheHint:
      "Elimina tutte le traduzioni, le posizioni delle nuvolette e le maschere di cancellazione salvate su questo " +
      "dispositivo. Se rileggi, tutto verrà ritradotto e le immagini verranno inviate di nuovo.",
    cacheClear: "Svuota tutta la cache",
    cacheConfirm:
      "Svuotare tutta la cache? Alla prossima lettura le immagini verranno tradotte e inviate di nuovo.",
    cacheCleared: (count: number): string => `${count} ${plural(count, "voce eliminata", "voci eliminate")}.`,
    cacheFailed: (title: string): string => `Impossibile svuotare la cache: ${title}`,
    debugHeading: "Log di debug",
    logLevel: "Livello di log",
    logLevels: {
      debug: "Dettagliato (debug)",
      info: "Informazioni",
      warn: "Avvisi",
      error: "Solo errori",
    },
  },
  optionsAdvanced: {
    heading: "Impostazioni avanzate",
    intro:
      "Regolazioni fini per richieste, rilevamento del testo, lettering e cache. I valori predefiniti vanno bene " +
      "nella maggior parte dei casi. Ogni modifica viene salvata quando esci dal campo.",
    defaultIs: (value: string): string => `Predefinito: ${value}`,
    range: (min: string, max: string): string => `Intervallo consentito: da ${min} a ${max}`,
    automatic: "automatico",
    on: "attivato",
    off: "disattivato",
    reset: "Ripristina",
    resetLabel: (label: string): string => `Ripristina «${label}» al valore predefinito`,
    resetAll: "Ripristina tutte le impostazioni avanzate",
    resetAllConfirm: "Ripristinare tutte le impostazioni avanzate ai valori predefiniti?",
    resetAllDone: "Tutte le impostazioni avanzate sono tornate ai valori predefiniti.",
    notANumber: "Inserisci un numero.",
    adjusted: (value: string): string => `Salvato come ${value}, il valore consentito più vicino.`,
    badKey: "Usa un codice tasto come Backquote o KeyH, oppure lascia vuoto.",
    verticalChoices: { auto: "Automatico", never: "Mai" },
    groups: {
      api: "Richieste all'IA",
      translate: "Contenuto delle richieste",
      detector: "Rilevamento del testo",
      engine: "Motore",
      discovery: "Ricerca delle immagini",
      render: "Lettering e visualizzazione",
      memory: "Memoria della serie",
      cache: "Cache",
      privacy: "Limiti delle immagini",
      debug: "Log di debug",
    },
    fields: {
      "api.temperature": {
        label: "Temperatura",
        hint: "Quanto variano le risposte. Lascia vuoto per usare il valore predefinito del provider.",
      },
      "api.urgentLane": {
        label: "Corsia extra per le immagini sullo schermo",
        hint: "Aggiunge una corsia di richieste riservata alle immagini che stai guardando.",
      },
      "api.maxInFlight": {
        label: "Numero massimo di richieste simultanee",
        hint: "Limite rigido, corsia extra inclusa. Mai inferiore alle richieste di traduzione in parallelo.",
      },
      "api.firstByteTimeoutMs": {
        label: "Attesa della prima risposta (secondi)",
        hint: "Rinuncia se l'endpoint non invia nulla per questo tempo.",
      },
      "api.idleTimeoutMs": {
        label: "Timeout per risposta bloccata (secondi)",
        hint: "Rinuncia se una risposta smette di arrivare per questo tempo.",
      },
      "api.totalTimeoutMs": {
        label: "Durata massima di una richiesta (secondi)",
        hint: "Rinuncia a qualsiasi richiesta dopo questo tempo.",
      },
      "api.healthTimeoutMs": {
        label: "Timeout della verifica di connessione (secondi)",
        hint: "Usato dal controllo dell'endpoint e da «Verifica la connessione».",
      },
      "translate.boxBudget": {
        label: "Aree di testo per richiesta",
        hint: "Lascia vuoto per usare il profilo del modello (12, 16 o 20).",
      },
      "translate.jpegQuality": {
        label: "Qualità JPEG",
        hint: "Qualità dell'immagine composita inviata all'IA.",
      },
      "translate.requestBodyCapMb": {
        label: "Dimensione massima della richiesta (MB)",
        hint: "Le immagini composite più grandi vengono compresse di più, poi suddivise.",
      },
      "translate.promptCharCap": {
        label: "Lunghezza massima del prompt (caratteri)",
        hint: "Se una richiesta è più lunga, viene accorciato prima il contesto.",
      },
      "translate.maxLadderRequestsPerPack": {
        label: "Richieste extra per recuperare il testo mancante",
        hint: "Nuove richieste e suddivisioni quando l'IA salta delle aree di testo.",
      },
      "translate.maxHttpRetriesPerRequest": {
        label: "Nuovi tentativi dopo errori di rete",
        hint: "Per richiesta, in caso di errori HTTP e di rete temporanei.",
      },
      "translate.splitOnRefusal": {
        label: "Suddividi le richieste rifiutate",
        hint: "Se l'IA rifiuta, prova le due metà separatamente invece di rinunciare.",
      },
      "detector.backend": {
        label: "Hardware di rilevamento",
        hint: "Automatico usa la GPU se supera un autotest, altrimenti la CPU.",
      },
      "detector.scoreMin": {
        label: "Punteggio minimo di rilevamento",
        hint: "Valori più bassi trovano più testo, ma anche più falsi positivi.",
      },
      "detector.sliceTriggerRatio": {
        label: "Dividi in sezioni le immagini più lunghe di (rapporto)",
        hint: "Le immagini e le strisce webtoon il cui lato lungo supera questo multiplo del lato corto vengono tagliate in sezioni.",
      },
      "detector.sliceHeightRatio": {
        label: "Lunghezza della sezione (× lato corto)",
        hint: "Lunghezza di ogni sezione come multiplo del lato corto dell'immagine.",
      },
      "detector.sliceOverlap": {
        label: "Sovrapposizione delle sezioni (frazione)",
        hint: "Sovrapposizione tra sezioni adiacenti, come frazione di una sezione.",
      },
      "detector.sliceOverlapMinPx": {
        label: "Sovrapposizione minima delle sezioni (pixel)",
        hint: "Le sezioni adiacenti condividono sempre almeno questo numero di pixel.",
      },
      "detector.quietRows": {
        label: "Taglia le sezioni tra le righe di testo",
        hint: "Sperimentale: sposta i tagli delle sezioni su righe senza inchiostro.",
      },
      "engine.idleCloseMin": {
        label: "Chiudi il motore inattivo dopo (minuti)",
        hint: "Libera memoria quando nessuna pagina usa il motore da questo tempo.",
      },
      "engine.detectorReleaseMin": {
        label: "Libera il rilevamento del testo dopo (minuti)",
        hint: "Rimuove dalla memoria il modello di rilevamento quando non viene usato da questo tempo.",
      },
      "engine.portIdleMin": {
        label: "Disconnetti le pagine inattive dopo (minuti)",
        hint: "Una pagina si scollega dal motore dopo questo tempo senza attività.",
      },
      "discovery.minNaturalSide": {
        label: "Ignora le immagini più piccole di (pixel)",
        hint: "Dimensione reale del lato corto. Esclude icone, avatar e pubblicità.",
      },
      "discovery.minDisplayedSide": {
        label: "Ignora le immagini mostrate più piccole di (pixel)",
        hint: "Dimensione sullo schermo del lato corto.",
      },
      "discovery.secondsPerScreenDefault": {
        label: "Velocità di lettura iniziale (secondi per schermata)",
        hint: "Stima iniziale finché la tua velocità di lettura non viene misurata.",
      },
      "discovery.lookaheadMinScreens": {
        label: "Traduzione in anticipo, minimo (schermate)",
        hint: "Le immagini a questa distanza sotto la vista vengono sempre tradotte prima che tu arrivi.",
      },
      "discovery.lookaheadMaxScreens": {
        label: "Traduzione in anticipo, massimo (schermate)",
        hint: "Limite superiore quando leggi in fretta o l'IA è lenta.",
      },
      "discovery.lookaheadMaxScreensStrip": {
        label: "Traduzione in anticipo sulle strisce webtoon, massimo (schermate)",
        hint: "Limite superiore per le lunghe strisce verticali.",
      },
      "discovery.detectAheadMinScreens": {
        label: "Rilevamento in anticipo, minimo (schermate)",
        hint: "Le immagini non ancora caricate dalla pagina vengono rilevate con questo anticipo (senza caricamenti).",
      },
      "discovery.detectAheadMaxScreens": {
        label: "Rilevamento in anticipo, massimo (schermate)",
        hint: "Limite superiore per chi legge in fretta.",
      },
      "discovery.detectMaxImages": {
        label: "Immagini rilevate in anticipo, al massimo",
        hint: "Conta ogni immagine davanti a te, caricata o no.",
      },
      "discovery.fetchPerHostConcurrency": {
        label: "Download di immagini in parallelo per server",
        hint: "Download contemporanei dallo stesso server di immagini.",
      },
      "discovery.prefetchSpacingMs": {
        label: "Pausa tra i download di immagini (ms)",
        hint: "Tempo minimo tra due download dallo stesso server.",
      },
      "discovery.scrollDebounceMs": {
        label: "Ritardo di reazione allo scorrimento (ms)",
        hint: "Attesa dopo lo scorrimento prima di riordinare il lavoro.",
      },
      "discovery.mutationDebounceMs": {
        label: "Ritardo di reazione alle modifiche della pagina (ms)",
        hint: "Attesa dopo una modifica della pagina (caricamento differito, app di lettura) prima di cercare nuove immagini.",
      },
      "discovery.stripGapPx": {
        label: "Spazio massimo in una striscia webtoon (pixel)",
        hint: "Le immagini più vicine di così formano un'unica striscia continua.",
      },
      "discovery.translateHiddenTabs": {
        label: "Traduci nelle schede in background",
        hint: "Disattivato: la modalità automatica attende che la scheda venga mostrata.",
      },
      "render.font": {
        label: "Carattere dei dialoghi",
        hint: "Carattere del testo tradotto nelle nuvolette.",
      },
      "render.verticalText": {
        label: "Lettering verticale",
        hint: "Le traduzioni in giapponese o cinese tradizionale sono scritte dall'alto in basso nei fumetti verticali. «Mai» lascia orizzontali tutte le traduzioni.",
      },
      "render.minFontPx": {
        label: "Dimensione minima del testo (pixel)",
        hint: "Il testo che non entra a questa dimensione viene accorciato con «…».",
      },
      "render.maxFontPx": {
        label: "Dimensione massima del testo (pixel)",
        hint: "Il testo resta comunque vicino alla dimensione del lettering originale.",
      },
      "render.eraseSfx": {
        label: "Cancella le onomatopee",
        hint: "Rimuove le onomatopee dall'immagine invece di etichettarle.",
      },
      "render.sfxLabels": {
        label: "Etichetta le onomatopee",
        hint: "Mostra la traduzione delle onomatopee in piccole etichette.",
      },
      "render.showDoneBadge": {
        label: "Segna le immagini tradotte",
        hint: "Mostra un piccolo indicatore su ogni immagine tradotta.",
      },
      "render.peekKey": {
        label: "Tieni premuto per vedere l'originale (codice tasto)",
        hint: "Un codice tasto come Backquote o KeyH. Lascia vuoto per disattivarlo.",
      },
      "render.peekWithAlt": {
        label: "Mostra l'originale anche tenendo premuto Alt",
        hint: "Anche tenere premuto solo il tasto Alt nasconde la traduzione.",
      },
      "render.popupWithAltClick": {
        label: "Alt+clic apre la finestra della nuvoletta",
        hint: "La finestra mostra l'originale e permette di modificare la traduzione. Una pressione prolungata la apre sempre.",
      },
      "memory.enabled": {
        label: "Usa la memoria della serie",
        hint: "Invia con ogni richiesta il glossario, le battute precedenti e un riassunto della storia, e apprende i nomi dalle risposte.",
      },
      "memory.glossaryInPrompt": {
        label: "Voci di glossario per richiesta",
        hint: "Prima le tue voci, poi quelle confermate, poi quelle apprese.",
      },
      "memory.termMinSightings": {
        label: "Occorrenze prima di apprendere un termine",
        hint: "Richieste diverse che devono nominare un termine prima che venga inviato.",
      },
      "memory.historyMaxLines": {
        label: "Battute precedenti inviate come contesto",
        hint: "Battute dello stesso capitolo. 0 non ne invia nessuna.",
      },
      "memory.historyMaxTokens": {
        label: "Budget di token per le battute precedenti",
        hint: "Le battute più vecchie vengono scartate per prime.",
      },
      "memory.summaryMaxWords": {
        label: "Lunghezza del riassunto della storia (parole)",
        hint: "0 disattiva il riassunto progressivo.",
      },
      "cache.translationTtlDays": {
        label: "Conserva le traduzioni inutilizzate per (giorni)",
        hint: "Le tue modifiche non scadono mai.",
      },
      "cache.encodedBytesLruMb": {
        label: "Cache delle immagini scaricate (MB)",
        hint: "Memoria che il motore usa per conservare le immagini scaricate.",
      },
      "privacy.maxImageBytes": {
        label: "Dimensione massima del file immagine (MiB)",
        hint: "I file immagine più grandi vengono saltati.",
      },
      "privacy.maxImagePixels": {
        label: "Risoluzione massima dell'immagine (megapixel)",
        hint: "Le immagini con più pixel vengono saltate.",
      },
      "debug.logCapacity": {
        label: "Voci di log conservate",
        hint: "Dimensione del log di debug salvato dal motore.",
      },
    },
    site: {
      settings: "Impostazioni",
      settingsFor: (site: string): string => `Impostazioni per ${site}`,
      layout: "Layout e senso di lettura",
      layouts: {
        auto: "Rileva automaticamente",
        webtoon: "Webtoon (striscia verticale)",
        "paged-rtl": "Pagine, da destra a sinistra (manga)",
        "paged-ltr": "Pagine, da sinistra a destra (fumetti)",
      },
      sourceLangHint:
        "Seleziona le istruzioni specifiche della lingua per l'IA e quanto vengono ingranditi i ritagli di testo.",
      referer: "Referer per il download delle immagini",
      referers: {
        auto: "Automatico",
        "page-url": "Indirizzo completo della pagina",
        origin: "Solo l'indirizzo del sito",
      },
      refererHint:
        "Automatico segue la pagina, poi riprova con l'indirizzo completo della pagina se il server delle " +
        "immagini rifiuta. Modificalo solo se le immagini non si caricano.",
      subdomains: "Anche sui sottodomini",
      subdomainsHint: "Traduci su tutti i sottodomini di questo sito con le stesse impostazioni.",
      prefetch: "Prepara le immagini in anticipo",
      prefetchHint:
        "Rileva le immagini sotto la vista che la pagina non ha ancora caricato, così sono pronte quando ci arrivi. Nulla viene inviato finché non sono vicine.",
      frames: "Frame di lettori da altri siti",
      framesHint:
        "Un'origine per riga, ad es. https://viewer.example.com, quando le pagine sono mostrate in un frame " +
        "servito da un altro sito.",
      framesInvalid: (lines: string): string => `Non è un'origine http(s): ${lines}`,
    },
    transfer: {
      heading: "Backup e ripristino",
      hint:
        "Salva le impostazioni e l'elenco dei siti in un file JSON, oppure caricali da un file. La conferma " +
        "sulla privacy non viene mai esportata.",
      includeKey: "Includi la chiave API",
      includeKeyHint:
        "Lascia disattivato prima di condividere il file: chiunque potrebbe leggervi la chiave.",
      export: "Esporta impostazioni",
      import: "Importa impostazioni",
      importConfirm:
        "Sostituire le impostazioni con quelle del file? I siti presenti nel file vengono aggiunti o aggiornati.",
      notJson: "Questo file non è un JSON valido.",
      notSettings: "Questo file non è un'esportazione di impostazioni di Panelingo.",
      tooNew: "Questo file è stato creato da una versione più recente di Panelingo.",
      imported: (settings: number, sites: number): string =>
        `Importazione completata. Impostazioni modificate: ${settings}. Siti: ${sites}.`,
      keyImported: "La chiave API del file è stata importata.",
      keyKept: "La tua chiave API è stata mantenuta (il file non ne contiene una).",
    },
  },
  manifest: {
    description:
      "Traduci fumetti, manga e webtoon direttamente sulla pagina mentre leggi, con qualsiasi IA compatibile con " +
      "OpenAI.",
    commands: {
      "toggle-overlay": "Mostra o nascondi la traduzione sovrapposta",
      "translate-visible": "Traduci le immagini visibili",
      "toggle-site": "Attiva o disattiva la traduzione automatica su questo sito",
      "open-side-panel": "Apri il pannello laterale della trascrizione",
    },
  },
};
