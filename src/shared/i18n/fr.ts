// French UI catalog. PURE.

import type { Catalog } from "./en.ts";

/** French plural: the singular form covers 0 and 1 (CLDR "one"). */
const plural = (count: number, one: string, other: string): string => (Math.abs(count) < 2 ? one : other);

const errors: Catalog["errors"] = {
  "api.unreachable": {
    title: "Impossible de joindre le point de terminaison IA",
    hint: "Vérifiez l'URL de base dans les Options et assurez-vous que le serveur (ou votre modèle local) est en marche.",
  },
  "api.lna_blocked": {
    title: "Chrome a bloqué la connexion à votre serveur d'IA local",
    hint: "Ouvrez les paramètres du site de l'extension → Accès au réseau local (Local network access) → Autoriser.",
  },
  "api.unauthorized": {
    title: "Le point de terminaison IA a refusé la clé API",
    hint: "Saisissez une clé API valide dans les Options. La traduction reprendra automatiquement.",
  },
  "api.config": {
    title: "Point de terminaison IA ou modèle mal configuré",
    hint: "Vérifiez l'URL de base et choisissez dans les Options un modèle qui accepte les images (vision).",
  },
  "api.rate_limit": {
    title: "Le fournisseur d'IA limite le nombre de requêtes",
    hint: "L'extension ralentit et réessaie d'elle-même.",
  },
  "api.upstream": { title: "Erreur du serveur d'IA, nouvelle tentative", hint: "" },
  "api.context_length": { title: "Requête trop longue, découpage en cours", hint: "" },
  "api.timeout": { title: "L'IA a mis trop de temps à répondre", hint: "L'extension réessaie une fois." },
  "api.truncated": { title: "Réponse tronquée, récupération de la suite", hint: "" },
  "api.partial": { title: "L'IA a omis des bulles, nouvelle demande en cours", hint: "" },
  "api.empty": { title: "Réponse vide de l'IA, nouvelle tentative", hint: "" },
  "api.too_large": { title: "Image trop grande pour être envoyée, réduction en cours", hint: "" },
  "api.bad_request": {
    title: "La requête a été refusée (bug)",
    hint: "Exportez le journal de débogage dans les Options.",
  },
  "api.protocol": { title: "Format de réponse inattendu du point de terminaison IA", hint: "" },
  "llm.refused": { title: "L'IA a refusé de traduire", hint: "La bulle garde son texte d'origine." },
  "llm.missing": {
    title: "Non traduite",
    hint: "Utilisez « Retraduire » pour relancer la traduction de cette bulle uniquement.",
  },
  "llm.format": { title: "Réponse de l'IA mal formée, nouvelle tentative", hint: "" },
  "image.url_blocked": { title: "Image bloquée par sécurité", hint: "" },
  "image.http": {
    title: "Impossible de charger l'image",
    hint:
      "Si le site exige une connexion à votre compte, activez « Envoyer les cookies avec les requêtes " +
      "d'images » dans la fenêtre pop-up.",
  },
  "image.not_image": { title: "Ce fichier n'est pas une image", hint: "" },
  "image.too_large": { title: "Image trop volumineuse", hint: "" },
  "image.decode": { title: "Impossible de décoder l'image", hint: "" },
  "image.capture_unavailable": { title: "Faites défiler jusqu'à l'image pour la traduire", hint: "" },
  "image.capture_blocked": {
    title: "Seule une capture d'écran peut lire cette image",
    hint: "Activez la traduction sur ce site et gardez cet onglet au premier plan, puis réessayez.",
  },
  "detector.webgpu_unavailable": { title: "Détection du texte sur le CPU (plus lente)", hint: "" },
  "detector.canary_mismatch": { title: "Résultats du GPU incohérents, passage au CPU", hint: "" },
  "detector.model_integrity": {
    title: "Le modèle de détection du texte est endommagé",
    hint: "Réinstallez l'extension (développeurs : npm run fetch-models, puis npm run build).",
  },
  "detector.init": {
    title: "Impossible de démarrer la détection du texte",
    hint: "Exportez le journal de débogage dans les Options.",
  },
  "detector.run": { title: "Échec de la détection du texte", hint: "" },
  "offline.pair_unsupported": {
    title: "Cette paire de langues n'est pas disponible hors ligne",
    hint: "Choisissez NLLB-200 comme modèle hors ligne dans les Options, ou une autre langue cible.",
  },
  "offline.download": {
    title: "Impossible de télécharger les modèles hors ligne",
    hint: "Vérifiez la connexion à huggingface.co. La traduction réessaie d'elle-même.",
  },
  "offline.model_integrity": {
    title: "Un modèle hors ligne téléchargé est endommagé",
    hint: "Relancez la traduction pour le télécharger à nouveau.",
  },
  "offline.run": {
    title: "Les modèles hors ligne ont échoué",
    hint: "Exportez le journal de débogage dans les Options.",
  },
  "offline.out_of_memory": {
    title: "Mémoire insuffisante pour les modèles hors ligne",
    hint: "Les modèles de traduction ont été redémarrés et le moteur continue de fonctionner. Choisissez Opus-MT (beaucoup plus petit) dans les Options ou fermez d'autres onglets.",
  },
  "engine.unavailable": {
    title: "Impossible de démarrer le moteur de traduction",
    hint: "Rechargez la page, ou désactivez puis réactivez l'extension.",
  },
  "engine.closing": { title: "Le moteur redémarre", hint: "" },
  "engine.overloaded": { title: "Le moteur est occupé", hint: "" },
  "engine.protocol": { title: "Versions de l'extension incompatibles", hint: "Rechargez la page." },
  "engine.internal": { title: "Erreur interne", hint: "Exportez le journal de débogage dans les Options." },
  "msg.too_large": { title: "Données trop volumineuses, rechargement via l'URL", hint: "" },
  "ctx.invalidated": {
    title: "L'extension vient d'être rechargée",
    hint: "Rechargez la page pour continuer à traduire.",
  },
  "dnr.failed": { title: "Impossible de définir le Referer de l'image", hint: "" },
  "store.io": { title: "Impossible de lire ou d'écrire le cache", hint: "" },
  "store.quota": { title: "Le cache est plein", hint: "Videz une partie du cache dans les Options." },
  "site.disabled": { title: "Traduction désactivée pour ce site", hint: "" },
  "privacy.consent": {
    title: "L'envoi d'images à l'IA n'est pas encore confirmé",
    hint: "Lisez l'avis de confidentialité et autorisez l'envoi pour commencer à traduire.",
  },
  cancelled: { title: "Annulé", hint: "" },
};

export const FR: Catalog = {
  errors,
  readiness: {
    unknown: { label: "Vérification du point de terminaison IA…", hint: "" },
    ready: { label: "Point de terminaison IA prêt", hint: "" },
    unauthorized: { label: "Clé API refusée", hint: errors["api.unauthorized"].hint },
    unreachable: { label: "Point de terminaison IA injoignable", hint: errors["api.unreachable"].hint },
    lna_blocked: { label: "Chrome a bloqué le serveur d'IA local", hint: errors["api.lna_blocked"].hint },
    misconfigured: { label: "Point de terminaison IA non configuré", hint: errors["api.config"].hint },
  },
  imageState: {
    queued: "En file d'attente",
    acquiring: "Chargement de l'image",
    detecting: "Recherche du texte",
    waiting: "En attente de traduction",
    translating: "Traduction en cours",
    done: "Traduite",
    "no-text": "Aucun texte",
    partial: "Partiellement traduite",
    refused: "L'IA a refusé",
    paused: "En pause",
    error: "Erreur",
    stale: "Traduction obsolète",
  },
  unitStatus: {
    pending: "En attente",
    translating: "Traduction en cours",
    ok: "Traduite",
    "keep-original": "Conservée telle quelle",
    manual: "Modifiée",
    untranslated: "Non traduite",
    refused: "L'IA a refusé",
    ignored: "Ignorée",
    error: "Erreur",
    stale: "Obsolète",
  },
  enginePhase: {
    booting: "Démarrage du moteur",
    ready: "Moteur actif",
    closing: "Arrêt du moteur",
    failed: "Échec du moteur",
  },
  detectorBackend: {
    webgpu: "GPU (WebGPU)",
    wasm: "CPU (WASM)",
    none: "pas encore choisi",
  },
  detectorState: {
    unloaded: "non chargé",
    loading: "en chargement",
    ready: "prêt",
    failed: "en échec",
  },
  detectorCanary: {
    pass: "GPU vérifié",
    fail: "le GPU a donné des résultats incohérents, passage au CPU",
    pending: "vérification du GPU",
    skipped: "",
  },
  offlineState: {
    idle: "Les modèles se chargent à la première utilisation",
    downloading: "Téléchargement des modèles",
    loading: "Chargement des modèles",
    ready: "Prêt",
    failed: "Échec",
  },
  ui: {
    appName: "Panelingo",
    siteEnable: "Traduire ce site",
    siteDisable: "Ne plus traduire ce site",
    modeAuto: "Traduire pendant le défilement",
    modeManual: "Traduire uniquement sur demande",
    translateVisible: "Traduire les images visibles",
    translateImage: "Traduire",
    retranslate: "Retraduire",
    showOriginal: "Afficher l'original",
    uploadsToday: (count: number, mb: number): string =>
      `${count} ${plural(count, "image composite", "images composites")} (${mb.toFixed(1).replace(".", ",")} Mo) ` +
      `${plural(count, "envoyée", "envoyées")} à l'IA aujourd'hui`,
    progress: (done: number, total: number, etaSec?: number): string =>
      etaSec === undefined || !Number.isFinite(etaSec)
        ? `Traduction ${done}/${total}`
        : `Traduction ${done}/${total} · ~${Math.max(1, Math.round(etaSec))} s`,
    privacyTitle: "Avant d'envoyer des images à l'IA",
    privacyBody:
      "Pour traduire, l'extension envoie des images composites des cases de BD qui contiennent du texte (uniquement " +
      "sur les sites que vous activez, ou lorsque vous le demandez) au point de terminaison IA que vous avez configuré. " +
      "Le fournisseur d'IA peut conserver ce qu'il reçoit selon ses propres conditions. Assurez-vous que c'est " +
      "acceptable pour vous et pour le contenu que vous lisez.",
    privacyAccept: "J'ai compris, autoriser l'envoi",
    privacyDecline: "Ne pas envoyer",
  },
  bubble: {
    original: "Original",
    translation: "Traduction",
    save: "Enregistrer",
    revert: "Utiliser la traduction de l'IA",
    retranslate: "Retraduire",
    close: "Fermer",
    dialog: "Bulle traduite",
    copy: "Copier",
    editLabel: "Modifier la traduction",
    shortened: "Le texte a été raccourci pour tenir dans la bulle.",
    saved: "Enregistré.",
    retranslating: "Nouvelle traduction en cours…",
  },
  menu: {
    translateImage: "Traduire cette image",
    retranslateImage: "Retraduire cette image",
  },
  sidepanel: {
    title: "Panelingo – Transcription",
    heading: "Transcription",
    empty: "Aucune ligne traduite dans cet onglet pour l'instant.",
    emptyHint:
      "Ouvrez une page de BD sur un site que vous avez activé. Les lignes s'affichent ici au fur et à mesure de la traduction.",
    refresh: "Actualiser",
    copy: "Tout copier",
    copied: "Copié dans le presse-papiers.",
    page: (n: number): string => `Page ${n}`,
    jump: "Afficher",
    jumpHint: "Faire défiler la page jusqu'à cette bulle",
    edit: "Modifier",
    save: "Enregistrer",
    cancel: "Annuler",
    retranslate: "Retraduire",
    revert: "Annuler la modification",
    noTranslation: "Pas de traduction",
    notFound: "Cette bulle n'est plus sur la page.",
    failed: "Cela n'a pas fonctionné. Réessayez.",
    types: {
      dialogue: "Dialogue",
      thought: "Pensée",
      narration: "Narration",
      sign: "Panneau",
      sfx: "Onomatopée",
      ignore: "Ignoré",
    },
    inconsistent: "Diffère du glossaire",
    tabs: { transcript: "Transcription", glossary: "Glossaire" },
    glossary: {
      noSeries: "Ouvrez une page de BD pour voir le glossaire de sa série.",
      untitled: "Série sans titre",
      states: {
        manual: "Vos entrées",
        confirmed: "Confirmées",
        learned: "Apprises",
        candidate: "Propositions",
      },
      hints: {
        manual: "Toujours utilisées. L'IA ne les modifie jamais.",
        confirmed: "Propositions que vous avez acceptées. Toujours utilisées.",
        learned: "Noms et termes que l'IA a utilisés dans plusieurs requêtes. Envoyés avec chaque requête.",
        candidate: "Repérés une fois par l'IA. Pas envoyés avant d'être confirmés ou revus.",
      },
      empty:
        "Aucune entrée pour l'instant. Les noms et termes apparaissent ici quand l'IA les repère, ou ajoutez les vôtres.",
      original: "Texte original",
      translation: "Traduction",
      note: "Note (facultative)",
      add: "Ajouter",
      delete: "Supprimer",
      confirm: "Confirmer",
      seen: (count: number): string => `Vu ${count} fois`,
      incomplete: "Saisissez le texte original et sa traduction.",
      profileHeading: "Réglages de la série",
      sourceLang: "Langue source",
      langAuto: "Détecter automatiquement",
      langs: {
        ja: "Japonais",
        ko: "Coréen",
        zh: "Chinois",
        en: "Anglais",
        es: "Espagnol",
        other: "Autre",
      },
      koNames: "Noms coréens",
      koRomanized: "Romanisés (Minjun)",
      koHanViet: "Sino-vietnamien (pour les traductions en vietnamien)",
      keepHonorifics: "Garder les suffixes honorifiques japonais (-san, -kun)",
      summary: "Envoyer un résumé continu de l'histoire",
      saveProfile: "Enregistrer les réglages",
      saved: "Enregistré.",
      export: "Exporter",
      import: "Importer",
      imported: (count: number): string =>
        `${count} ${plural(count, "entrée importée", "entrées importées")}.`,
      importFailed: "Ce fichier n'est pas un glossaire Panelingo.",
      address: {
        heading: "Formes d'adresse",
        hint: "Comment chaque personnage se désigne et s'adresse à son interlocuteur. L'IA les remplit pendant la lecture et les garde identiques ; vos propres règles ne changent jamais.",
        speaker: "Locuteur",
        listener: "Interlocuteur",
        self: "Se désigne comme",
        other: "Appelle l'interlocuteur",
        learned: "Apprise par l'IA",
        mine: "La vôtre",
        keep: "Garder",
        addHeading: "Ajouter une forme d'adresse",
        incomplete: "Saisissez les deux noms et au moins une forme d'adresse.",
        full: "La liste est pleine. Supprimez d'abord une règle.",
        empty: "Aucune pour l'instant. Les paires apparaissent ici quand l'IA les rencontre.",
      },
    },
  },
  debug: {
    heading: "Débogage (versions dev/test uniquement)",
  },
  duration: (ms: number): string => {
    const seconds = Math.round(Math.abs(ms) / 1000);
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h`;
    const days = Math.round(hours / 24);
    return `${days} ${plural(days, "jour", "jours")}`;
  },
  popup: {
    siteToggle: "Traduire sur ce site",
    progressDone: (count: number): string =>
      `Terminé : ${count} ${plural(count, "image", "images")} sur cette page`,
    more: "Plus pour ce site",
    siteSettings: "Tous les paramètres de ce site",
    openTranscript: "Ouvrir la transcription",
    cookies: "Envoyer les cookies avec les requêtes d'images",
    cookiesHint:
      "Pour les sites qui n'affichent les images qu'aux lecteurs connectés. Les cookies ne vont qu'au serveur d'images, jamais à l'IA.",
    engineHeading: "Moteur de traduction",
    siteHeading: "Ce site",
    checking: "Vérification…",
    model: (model: string): string => `Modèle : ${model}`,
    endpoint: (url: string): string => `Point de terminaison : ${url}`,
    cause: (cause: string): string => `Détails : ${cause}`,
    engineStopped: "Le moteur est en veille ; il démarre dès que vous traduisez.",
    engineUnreadable: "Impossible de lire l'état du moteur.",
    offlineHeading: "Mode hors ligne (expérimental)",
    offlineHint:
      "Aucun point de terminaison IA n'est utilisé : la reconnaissance du texte et la traduction se font sur cet appareil.",
    offlineDownload: (doneMb: number, totalMb: number): string =>
      `Téléchargement : ${Math.round(doneMb)} sur ${Math.round(totalMb)} Mo`,
    offlineModels: (models: string): string => `Modèles : ${models}`,
    detectorLine: (backend: string, state: string, canary: string): string =>
      `Détecteur de texte : ${backend}, ${state}${canary === "" ? "" : ` (${canary})`}`,
    queueLine: (queued: number, inFlight: number, done: number, failed: number): string =>
      `Requêtes : ${queued} en file d'attente · ${inFlight} en cours d'envoi · ${done} ` +
      `${plural(done, "terminée", "terminées")} · ${failed} en échec`,
    pausedBy: (title: string): string => `En pause : ${title}`,
    siteUnsupported: "Impossible de traduire cette page (pages http/https uniquement).",
    modeLabel: "Mode",
    visibleSent: (count: number): string =>
      count > 0
        ? `${count} ${plural(count, "image envoyée", "images envoyées")} pour traduction.`
        : "Aucune image de BD visible.",
    visibleUnavailable: "L'extension ne peut pas fonctionner sur cette page.",
    retranslatePage: "Retraduire la page",
    retranslateQueued: (count: number): string =>
      `${count} ${plural(count, "bulle remise", "bulles remises")} en file d'attente.`,
    actionFailed: (title: string): string => `Action impossible : ${title}`,
    privacyDetails: "Voir ce qui est envoyé",
    options: "Options",
    setupHint:
      "Configurez votre point de terminaison IA (URL de base, clé API, modèle) dans les Options pour commencer.",
    consentHint:
      "Cliquez sur l'icône Panelingo pour lire l'avis de confidentialité avant d'activer la traduction ici.",
    build: (id: string): string => `Version ${id}`,
  },
  options: {
    tabs: {
      engine: {
        label: "Traduction",
        intro:
          "Ce qui traduit les bandes dessinées : un modèle d'IA que vous connectez, ou les modèles hors ligne expérimentaux de cet appareil.",
      },
      display: {
        label: "Langue et affichage",
        intro:
          "La langue dans laquelle vous lisez, la langue de l'interface et l'apparence des traductions sur la page.",
      },
      sites: {
        label: "Sites",
        intro:
          "Les sites où Panelingo traduit. Activez un site depuis la fenêtre de la barre d'outils pendant que vous le lisez.",
      },
      privacy: {
        label: "Confidentialité et données",
        intro:
          "Ce qui est envoyé à l'IA, ce qui reste sur cet appareil et comment sauvegarder vos paramètres.",
      },
      advanced: {
        label: "Avancé",
        intro:
          "Réglages fins des requêtes, de la détection du texte, de la recherche d'images et des caches. Les valeurs par défaut conviennent dans la plupart des cas ; chaque modification est enregistrée quand vous quittez le champ.",
      },
    },
    controlsHeading: "Touches et clics",
    exportLog: "Exporter le journal de débogage",
    exportFailed: "Impossible d'exporter le journal de débogage.",
    exportEmpty: "Le journal de débogage est vide.",
    title: "Options",
    apiHeading: "Point de terminaison IA (compatible OpenAI)",
    apiIntro:
      "Tout service compatible avec l'API chat completions d'OpenAI et acceptant les images fonctionne : OpenAI, " +
      "OpenRouter, Azure OpenAI, Google Gemini (mode OpenAI) ou un serveur local comme Ollama, LM Studio, vLLM ou " +
      "LiteLLM.",
    preset: "Préréglage",
    presetCustom: "Personnalisé",
    baseUrl: "URL de base",
    baseUrlHint:
      "Incluez le chemin de version, par exemple https://api.openai.com/v1 ou http://127.0.0.1:11434/v1.",
    baseUrlInvalid: "URL http(s) non valide.",
    apiKey: "Clé API",
    apiKeyHint:
      "Enregistrée uniquement dans ce profil de navigateur ; laissez le champ vide pour les serveurs locaux " +
      "qui n'en ont pas besoin.",
    model: "Modèle",
    modelHint:
      "Le modèle doit accepter les images en entrée (vision), par exemple gpt-4o-mini, gemini-2.5-flash, qwen2.5-vl.",
    modelInvalid: "Saisissez un identifiant de modèle.",
    testConnection: "Tester la connexion",
    testing: "Test en cours…",
    testOk: (detail: string): string => `Connexion établie. ${detail}`,
    testFailed: (detail: string): string => `Échec : ${detail}`,
    concurrency: "Requêtes de traduction en parallèle",
    concurrencyHint:
      "2 par défaut, 4 au maximum. Réduisez ce nombre si votre fournisseur limite votre débit.",
    concurrencyInvalid: "Choisissez un nombre entre 1 et 4.",
    languageHeading: "Langues",
    uiLanguage: "Langue de l'interface",
    targetLanguage: "Traduire en",
    languageAuto: "Identique au navigateur",
    save: "Enregistrer",
    saved: "Modifications enregistrées.",
    saveFailed: "Impossible d'enregistrer.",
    sitesEmpty:
      "Aucun site pour le moment. Ouvrez une page de BD, cliquez sur l'icône de l'extension et activez la traduction " +
      "pour ce site.",
    siteEnabled: "Activé",
    siteMode: "Mode",
    siteRemove: "Retirer",
    privacyHeading: "Confidentialité : ce qui est envoyé à l'IA",
    privacyPoints: [
      "À chaque traduction, l'extension envoie une image composite JPEG au point de terminaison IA que vous avez " +
        "configuré : des miniatures des images (ou des tranches de webtoon) qui contiennent du texte, des cadres " +
        "numérotés autour de chaque zone de texte et des recadrages agrandis de ces zones.",
      "Texte joint à l'image : les règles de mise en forme et de langue, le glossaire de la série (60 entrées au " +
        "maximum), jusqu'à 20 répliques précédentes du même chapitre et un court résumé.",
      "Ne sont jamais envoyés : les images sans texte, l'adresse de la page que vous lisez, les cookies, votre adresse " +
        "IP ou les en-têtes du navigateur (au-delà de ce que transmet toute requête vers votre point de terminaison).",
      "Le fournisseur d'IA peut conserver ce qu'il reçoit selon ses propres conditions. Considérez tout ce qui est " +
        "envoyé comme stocké.",
      "Seuls les sites que vous activez sont traduits pendant le défilement. Les autres pages ne sont traduites que " +
        "sur demande (menu contextuel ou raccourci clavier), et l'extension demande toujours votre accord avant le " +
        "premier envoi.",
      "La fenêtre pop-up indique combien d'images composites ont été envoyées aujourd'hui.",
      "Sur cet appareil, les traductions, les positions des bulles et les masques d'effacement restent dans " +
        "l'IndexedDB de l'extension ; vous pouvez les supprimer dans la section Cache ci-dessous.",
    ],
    privacyAcked: (when: string): string => `Vous avez confirmé l'avis sur l'envoi d'images le ${when}.`,
    privacyNotAcked:
      "Vous n'avez pas encore confirmé l'avis sur l'envoi d'images ; l'extension vous demandera votre accord avant " +
      "le premier envoi.",
    cacheHeading: "Cache",
    cacheHint:
      "Supprime toutes les traductions, positions de bulles et masques d'effacement enregistrés sur cet appareil. " +
      "Si vous relisez ensuite, tout sera retraduit (et les images seront renvoyées).",
    cacheClear: "Vider tout le cache",
    cacheConfirm: "Vider tout le cache ? La prochaine lecture retraduira tout et renverra les images.",
    cacheCleared: (count: number): string =>
      `${count} ${plural(count, "enregistrement supprimé", "enregistrements supprimés")}.`,
    cacheFailed: (title: string): string => `Impossible de vider le cache : ${title}`,
    debugHeading: "Journal de débogage",
    logLevel: "Niveau de journalisation",
    logLevels: {
      debug: "Détaillé (débogage)",
      info: "Informations",
      warn: "Avertissements",
      error: "Erreurs uniquement",
    },
  },
  optionsAdvanced: {
    search: "Rechercher un paramètre",
    modifiedOnly: "Paramètres modifiés uniquement",
    matches: (count: number): string => `${count} ${plural(count, "paramètre", "paramètres")}`,
    noMatch: "Aucun paramètre ne correspond à votre recherche.",
    defaultIs: (value: string): string => `Par défaut : ${value}`,
    range: (min: string, max: string): string => `Valeurs autorisées : de ${min} à ${max}`,
    automatic: "automatique",
    on: "activé",
    off: "désactivé",
    reset: "Réinitialiser",
    resetLabel: (label: string): string => `Réinitialiser «\u00a0${label}\u00a0» à la valeur par défaut`,
    resetAll: "Réinitialiser tous les paramètres avancés",
    resetAllConfirm: "Rétablir la valeur par défaut de tous les paramètres avancés ?",
    resetAllDone: "Tous les paramètres avancés ont retrouvé leur valeur par défaut.",
    notANumber: "Saisissez un nombre.",
    adjusted: (value: string): string =>
      `Valeur enregistrée : ${value} (la valeur autorisée la plus proche).`,
    badKey: "Utilisez un code de touche comme Backquote ou KeyH, ou laissez le champ vide.",
    verticalChoices: { auto: "Automatique", never: "Jamais" },
    groups: {
      api: "Requêtes à l'IA",
      translate: "Contenu des requêtes",
      detector: "Détection du texte",
      engine: "Moteur",
      discovery: "Recherche des images",
      render: "Lettrage",
      memory: "Mémoire de la série",
      cache: "Cache",
      privacy: "Limites des images",
      debug: "Journal de débogage",
    },
    fields: {
      "api.temperature": {
        label: "Température",
        hint: "Degré de variété des réponses. Laissez vide pour utiliser la valeur par défaut du fournisseur.",
      },
      "api.urgentLane": {
        label: "Canal supplémentaire pour les images à l'écran",
        hint: "Ajoute un canal de requêtes réservé aux images que vous êtes en train de regarder.",
      },
      "api.maxInFlight": {
        label: "Nombre maximal de requêtes simultanées",
        hint: "Plafond absolu, canal supplémentaire compris. Jamais inférieur au nombre de requêtes de traduction en parallèle.",
      },
      "api.firstByteTimeoutMs": {
        label: "Attente de la première réponse (secondes)",
        hint: "Abandonner si le point de terminaison n'envoie rien pendant cette durée.",
      },
      "api.idleTimeoutMs": {
        label: "Délai d'inactivité d'une réponse (secondes)",
        hint: "Abandonner si le flux d'une réponse s'interrompt pendant cette durée.",
      },
      "api.totalTimeoutMs": {
        label: "Durée maximale d'une requête (secondes)",
        hint: "Abandonner toute requête au-delà de cette durée.",
      },
      "api.healthTimeoutMs": {
        label: "Délai de vérification de la connexion (secondes)",
        hint: "Utilisé par la vérification du point de terminaison et par « Tester la connexion ».",
      },
      "translate.boxBudget": {
        label: "Zones de texte par requête",
        hint: "Laissez vide pour utiliser le profil du modèle (12, 16 ou 20).",
      },
      "translate.packWaitMs": {
        label: "Attente pour regrouper les images (ms)",
        hint: "Durée pendant laquelle le texte d'une image attend les images suivantes de la page pour partager une requête. 0 envoie chaque image aussitôt.",
      },
      "translate.urgentPackMax": {
        label: "Bulles dans la première requête à l'écran",
        hint: "La première requête d'une image à l'écran contient au plus ce nombre de bulles, pour qu'elles s'affichent plus tôt. 0 = pas de limite à part.",
      },
      "translate.jpegQuality": {
        label: "Qualité JPEG",
        hint: "Qualité de l'image composite envoyée à l'IA.",
      },
      "translate.requestBodyCapMb": {
        label: "Taille maximale d'une requête (Mo)",
        hint: "Les images composites plus grandes sont davantage compressées, puis découpées.",
      },
      "translate.promptCharCap": {
        label: "Longueur maximale du prompt (caractères)",
        hint: "Si une requête est plus longue, le contexte est raccourci en premier.",
      },
      "translate.maxLadderRequestsPerPack": {
        label: "Requêtes supplémentaires pour récupérer le texte manqué",
        hint: "Redemander et découper lorsque l'IA omet des zones de texte.",
      },
      "translate.maxHttpRetriesPerRequest": {
        label: "Nouvelles tentatives après une erreur réseau",
        hint: "Par requête, en cas de défaillance HTTP ou réseau temporaire.",
      },
      "translate.engine": {
        label: "Moteur de traduction",
        hint: "Le mode hors ligne est expérimental : voir Mode hors ligne plus haut.",
      },
      "translate.offlineModel": {
        label: "Modèle de traduction hors ligne",
        hint: "Utilisé uniquement en mode hors ligne.",
      },
      "translate.splitOnRefusal": {
        label: "Découper les requêtes refusées",
        hint: "Si l'IA refuse, essayer les deux moitiés séparément au lieu d'abandonner.",
      },
      "detector.backend": {
        label: "Matériel de détection",
        hint: "Le mode automatique utilise le GPU s'il réussit un autotest, sinon le CPU.",
      },
      "detector.scoreMin": {
        label: "Score de détection minimal",
        hint: "Une valeur plus basse trouve plus de texte, mais aussi plus de faux positifs.",
      },
      "detector.sliceTriggerRatio": {
        label: "Découper les images plus longues que (rapport)",
        hint: "Les images et bandes de webtoon dont le grand côté dépasse ce multiple du petit côté sont découpées en tranches.",
      },
      "detector.sliceHeightRatio": {
        label: "Longueur des tranches (× petit côté)",
        hint: "Longueur de chaque tranche, en multiple du petit côté de l'image.",
      },
      "detector.sliceOverlap": {
        label: "Chevauchement des tranches (fraction)",
        hint: "Chevauchement entre tranches voisines, en fraction d'une tranche.",
      },
      "detector.sliceOverlapMinPx": {
        label: "Chevauchement minimal des tranches (pixels)",
        hint: "Deux tranches voisines partagent toujours au moins ce nombre de pixels.",
      },
      "detector.quietRows": {
        label: "Couper les tranches entre les lignes de texte",
        hint: "Expérimental : déplace les coupes vers des rangées de pixels sans encre.",
      },
      "engine.idleCloseMin": {
        label: "Fermer le moteur inactif après (minutes)",
        hint: "Libère la mémoire lorsqu'aucune page n'a utilisé le moteur pendant cette durée.",
      },
      "engine.detectorReleaseMin": {
        label: "Décharger la détection du texte après (minutes)",
        hint: "Libère le modèle de détection lorsqu'il n'a pas servi pendant cette durée.",
      },
      "engine.portIdleMin": {
        label: "Déconnecter les pages inactives après (minutes)",
        hint: "Une page se détache du moteur après cette durée sans activité.",
      },
      "discovery.minNaturalSide": {
        label: "Ignorer les images plus petites que (pixels)",
        hint: "Taille réelle du petit côté. Écarte les icônes, avatars et publicités.",
      },
      "discovery.minDisplayedSide": {
        label: "Ignorer les images affichées plus petites que (pixels)",
        hint: "Taille à l'écran du petit côté.",
      },
      "discovery.secondsPerScreenDefault": {
        label: "Vitesse de lecture initiale (secondes par écran)",
        hint: "Estimation de départ, en attendant que votre vitesse de lecture soit mesurée.",
      },
      "discovery.lookaheadMinScreens": {
        label: "Traduction anticipée, minimum (écrans)",
        hint: "Les images situées à cette distance sous la vue sont toujours traduites avant que vous y arriviez.",
      },
      "discovery.lookaheadMaxScreens": {
        label: "Traduction anticipée, maximum (écrans)",
        hint: "Limite haute quand vous lisez vite ou que l'IA est lente.",
      },
      "discovery.lookaheadMaxScreensStrip": {
        label: "Traduction anticipée sur les bandes webtoon, maximum (écrans)",
        hint: "Limite haute pour les longues bandes verticales.",
      },
      "discovery.detectAheadMinScreens": {
        label: "Détection anticipée, minimum (écrans)",
        hint: "Les images que la page n'a pas encore chargées sont détectées à cette distance (sans envoi).",
      },
      "discovery.detectAheadMaxScreens": {
        label: "Détection anticipée, maximum (écrans)",
        hint: "Limite haute pour les lecteurs rapides.",
      },
      "discovery.detectMaxImages": {
        label: "Images détectées à l'avance, au plus",
        hint: "Compte chaque image devant vous, chargée ou non.",
      },
      "discovery.fetchPerHostConcurrency": {
        label: "Téléchargements d'images parallèles par serveur",
        hint: "Nombre d'images téléchargées en même temps depuis un même serveur d'images.",
      },
      "discovery.prefetchSpacingMs": {
        label: "Pause entre deux téléchargements d'images (ms)",
        hint: "Délai minimal entre deux téléchargements depuis le même serveur.",
      },
      "discovery.scrollDebounceMs": {
        label: "Délai de réaction au défilement (ms)",
        hint: "Temps d'attente après un défilement avant de réorganiser le travail.",
      },
      "discovery.mutationDebounceMs": {
        label: "Délai de réaction aux changements de page (ms)",
        hint: "Temps d'attente après une modification de la page (chargement différé, liseuses en ligne) avant de chercher de nouvelles images.",
      },
      "discovery.stripGapPx": {
        label: "Écart maximal dans une bande de webtoon (pixels)",
        hint: "Les images plus proches que cette valeur forment une seule bande continue.",
      },
      "discovery.translateHiddenTabs": {
        label: "Traduire dans les onglets en arrière-plan",
        hint: "Désactivé : le mode automatique attend que l'onglet ait été affiché.",
      },
      "render.font": {
        label: "Police des dialogues",
        hint: "Police du texte traduit dans les bulles.",
      },
      "render.verticalText": {
        label: "Lettrage vertical",
        hint: "Les traductions en japonais ou en chinois traditionnel sont lettrées de haut en bas dans les bulles verticales. « Jamais » garde toutes les traductions à l'horizontale.",
      },
      "render.minFontPx": {
        label: "Taille de texte minimale (pixels)",
        hint: "Le texte qui ne tient pas à cette taille est raccourci avec « … ».",
      },
      "render.maxFontPx": {
        label: "Taille de texte maximale (pixels)",
        hint: "Le texte reste aussi proche de la taille du lettrage d'origine.",
      },
      "render.eraseSfx": {
        label: "Effacer les onomatopées",
        hint: "Retirer les onomatopées de l'image au lieu de les étiqueter.",
      },
      "render.sfxLabels": {
        label: "Étiqueter les onomatopées",
        hint: "Afficher la traduction des onomatopées dans de petites étiquettes.",
      },
      "render.showDoneBadge": {
        label: "Marquer les images traduites",
        hint: "Affiche un petit badge sur chaque image traduite.",
      },
      "render.peekKey": {
        label: "Maintenir pour voir l'original (code de touche)",
        hint: "Un code de touche comme Backquote ou KeyH. Laissez vide pour désactiver.",
      },
      "render.peekWithAlt": {
        label: "Voir aussi l'original en maintenant Alt",
        hint: "Maintenir la touche Alt seule masque aussi la traduction.",
      },
      "render.popupWithAltClick": {
        label: "Alt+clic ouvre la fenêtre de la bulle",
        hint: "La fenêtre montre l'original et permet de modifier la traduction. Un appui long l'ouvre toujours.",
      },
      "memory.enabled": {
        label: "Utiliser la mémoire de la série",
        hint: "Envoie le glossaire, les répliques précédentes et un résumé de l'histoire avec chaque requête, et apprend les noms à partir des réponses.",
      },
      "memory.glossaryInPrompt": {
        label: "Entrées du glossaire par requête",
        hint: "Vos entrées d'abord, puis les confirmées, puis les apprises.",
      },
      "memory.termMinSightings": {
        label: "Occurrences avant qu'un terme soit appris",
        hint: "Nombre de requêtes différentes qui doivent citer un terme avant qu'il soit envoyé.",
      },
      "memory.historyMaxLines": {
        label: "Répliques précédentes envoyées comme contexte",
        hint: "Répliques du même chapitre. 0 n'en envoie aucune.",
      },
      "memory.historyMaxTokens": {
        label: "Budget de tokens pour les répliques précédentes",
        hint: "Les répliques les plus anciennes sont retirées en premier.",
      },
      "memory.summaryMaxWords": {
        label: "Longueur du résumé de l'histoire (mots)",
        hint: "0 désactive le résumé continu.",
      },
      "memory.warmUp": {
        label: "Préparer une nouvelle série",
        hint: "Tant qu'une série n'a pas encore de mémoire, sa première requête part seule pour que les pages suivantes reprennent ses noms et ses formes d'adresse. Les premières pages prennent un peu plus de temps.",
      },
      "cache.translationTtlDays": {
        label: "Conserver les traductions inutilisées pendant (jours)",
        hint: "Vos propres modifications n'expirent jamais.",
      },
      "cache.encodedBytesLruMb": {
        label: "Cache des images téléchargées (Mo)",
        hint: "Mémoire utilisée par le moteur pour conserver les images téléchargées.",
      },
      "privacy.maxImageBytes": {
        label: "Taille maximale d'un fichier image (Mio)",
        hint: "Les fichiers image plus gros sont ignorés.",
      },
      "privacy.maxImagePixels": {
        label: "Définition maximale d'une image (mégapixels)",
        hint: "Les images comportant plus de pixels sont ignorées.",
      },
      "debug.logCapacity": {
        label: "Entrées conservées dans le journal",
        hint: "Taille du journal de débogage conservé par le moteur.",
      },
    },
    site: {
      settings: "Paramètres",
      settingsFor: (site: string): string => `Paramètres de ${site}`,
      layout: "Mise en page et sens de lecture",
      layouts: {
        auto: "Détecter automatiquement",
        webtoon: "Webtoon (bande verticale)",
        "paged-rtl": "Pages, de droite à gauche (manga)",
        "paged-ltr": "Pages, de gauche à droite (BD)",
      },
      sourceLangHint:
        "Détermine les instructions propres à la langue envoyées à l'IA et le degré d'agrandissement des recadrages de texte.",
      referer: "Referer pour le téléchargement des images",
      referers: {
        auto: "Automatique",
        "page-url": "Adresse complète de la page",
        origin: "Adresse du site uniquement",
      },
      refererHint:
        "Le mode automatique suit la page, puis réessaie avec l'adresse complète de la page si le serveur " +
        "d'images refuse. Ne le modifiez que si les images ne se chargent pas.",
      subdomains: "Aussi sur les sous-domaines",
      subdomainsHint: "Traduire sur tous les sous-domaines de ce site avec les mêmes paramètres.",
      prefetch: "Préparer les images à l'avance",
      prefetchHint:
        "Détecte les images que la page n'a pas encore chargées, sous la vue, pour qu'elles soient prêtes à votre arrivée. Rien n'est envoyé avant qu'elles soient proches.",
      frames: "Cadres de lecture provenant d'autres sites",
      framesHint:
        "Une origine par ligne, p. ex. https://viewer.example.com, lorsque les pages sont affichées dans un " +
        "cadre servi par un autre site.",
      framesInvalid: (lines: string): string => `Origine http(s) non valide : ${lines}`,
    },
    transfer: {
      heading: "Sauvegarde et restauration",
      hint:
        "Enregistrez vos paramètres et votre liste de sites dans un fichier JSON, ou chargez-les depuis un tel " +
        "fichier. La confirmation de confidentialité n'est jamais exportée.",
      includeKey: "Inclure la clé API",
      includeKeyHint:
        "Laissez cette option désactivée avant de partager le fichier : n'importe qui pourrait y lire la clé.",
      export: "Exporter les paramètres",
      import: "Importer les paramètres",
      importConfirm:
        "Remplacer vos paramètres par ceux du fichier ? Les sites du fichier sont ajoutés ou mis à jour.",
      notJson: "Ce fichier n'est pas un JSON valide.",
      notSettings: "Ce fichier n'est pas un export de paramètres Panelingo.",
      tooNew: "Ce fichier a été créé par une version plus récente de Panelingo.",
      imported: (settings: number, sites: number): string =>
        `Import terminé. Paramètres modifiés : ${settings}. Sites : ${sites}.`,
      keyImported: "La clé API du fichier a été importée.",
      keyKept: "Votre clé API a été conservée (le fichier n'en contient pas).",
    },
  },
  offline: {
    heading: "Mode hors ligne (expérimental)",
    intro:
      "Traduire sans aucun point de terminaison IA : des modèles open source de reconnaissance du texte (PaddleOCR) et de traduction tournent sur cet appareil. La qualité est nettement inférieure à celle d'un modèle de vision : pas de contexte entre les bulles, pas de noms de personnages, le lettrage stylisé est souvent mal lu, et les onomatopées ne sont pas traduites.",
    download:
      "Les modèles sont téléchargés une seule fois depuis Hugging Face au premier besoin, vérifiés et conservés sur cet appareil ; ensuite, la traduction n'a plus besoin du réseau. Tailles : reconnaissance du texte de 8 à 17 Mo par langue, Opus-MT environ 115 Mo par paire de langues (le double en passant par l'anglais), NLLB-200 environ 910 Mo.",
    engine: "Moteur de traduction",
    engineChoices: {
      api: "Point de terminaison IA (compatible OpenAI)",
      offline: "Hors ligne sur cet appareil (expérimental)",
    },
    model: "Modèle de traduction hors ligne",
    modelChoices: {
      "opus-mt": "Opus-MT : léger, un modèle par paire de langues",
      "nllb-600m": "NLLB-200 600M : toutes les paires, volumineux, non commercial",
    },
    pairs:
      "Opus-MT traduit le coréen, le japonais, le chinois et l'espagnol vers l'anglais, et l'anglais vers le vietnamien, l'espagnol, le français, l'allemand, l'italien et l'indonésien ; les autres paires passent par l'anglais. NLLB-200 traduit entre toutes les langues listées ici.",
    license:
      "Licences : PaddleOCR et la plupart des modèles Opus-MT Apache-2.0, deux modèles Opus-MT CC-BY-4.0, NLLB-200 CC-BY-NC-4.0 (usage non commercial uniquement).",
    stored: (mb: number): string => `Modèles téléchargés sur cet appareil : ${Math.round(mb)} Mo`,
    deleteModels: "Supprimer les modèles téléchargés",
    deleteConfirm:
      "Supprimer les modèles hors ligne téléchargés ? Ils seront téléchargés à nouveau si nécessaire.",
    deleted: "Les modèles téléchargés ont été supprimés.",
  },
  manifest: {
    description:
      "Traduisez BD, mangas et webtoons sur la page pendant votre lecture, avec n'importe quelle IA " +
      "compatible OpenAI.",
    commands: {
      "toggle-overlay": "Afficher ou masquer la traduction superposée",
      "translate-visible": "Traduire les images visibles",
      "toggle-site": "Activer ou désactiver la traduction automatique sur ce site",
      "open-side-panel": "Ouvrir le panneau latéral de transcription",
    },
  },
};
