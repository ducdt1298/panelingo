// Spanish UI catalog (neutral Spanish for Spain and Latin America, "tú"). PURE.

import type { Catalog } from "./en.ts";

/** Spanish plural: singular only for exactly 1 (0 takes the plural). */
const plural = (n: number, one: string, other: string): string => (n === 1 ? one : other);

/** Decimal comma. */
const decimal = (value: number): string => value.toFixed(1).replace(".", ",");

const errors: Catalog["errors"] = {
  "api.unreachable": {
    title: "No se puede conectar con el endpoint de IA",
    hint: "Revisa la URL base en Opciones y asegúrate de que el servidor (o tu modelo local) esté funcionando.",
  },
  "api.lna_blocked": {
    title: "Chrome bloqueó la conexión con tu servidor de IA local",
    hint: "Abre la configuración del sitio de la extensión → Acceso a la red local (Local network access) → Permitir.",
  },
  "api.unauthorized": {
    title: "El endpoint de IA rechazó la clave de API",
    hint: "Escribe una clave de API válida en Opciones. La traducción se reanudará automáticamente.",
  },
  "api.config": {
    title: "El endpoint de IA o el modelo no están bien configurados",
    hint: "Revisa la URL base y elige en Opciones un modelo que acepte imágenes (visión).",
  },
  "api.rate_limit": {
    title: "El proveedor de IA está limitando las solicitudes",
    hint: "La extensión reduce el ritmo y vuelve a intentarlo por sí sola.",
  },
  "api.upstream": { title: "Error del servidor de IA, reintentando", hint: "" },
  "api.context_length": { title: "Solicitud demasiado larga, dividiéndola", hint: "" },
  "api.timeout": {
    title: "La IA tardó demasiado en responder",
    hint: "La extensión vuelve a intentarlo una vez.",
  },
  "api.truncated": { title: "La respuesta se cortó, continuando", hint: "" },
  "api.partial": { title: "La IA omitió algunos globos de texto, volviendo a preguntar", hint: "" },
  "api.empty": { title: "Respuesta vacía de la IA, reintentando", hint: "" },
  "api.too_large": { title: "Imagen demasiado grande para enviarla, reduciéndola", hint: "" },
  "api.bad_request": {
    title: "Se rechazó la solicitud (error de la extensión)",
    hint: "Exporta el registro de depuración desde Opciones.",
  },
  "api.protocol": { title: "Formato de respuesta inesperado del endpoint de IA", hint: "" },
  "llm.refused": { title: "La IA se negó a traducir", hint: "Se mantiene el texto original." },
  "llm.missing": {
    title: "Sin traducir",
    hint: "Usa “Volver a traducir” para reintentar solo este globo de texto.",
  },
  "llm.format": { title: "Respuesta de la IA con formato incorrecto, reintentando", hint: "" },
  "image.url_blocked": { title: "Imagen bloqueada por seguridad", hint: "" },
  "image.http": {
    title: "No se pudo cargar la imagen",
    hint: "Si el sitio requiere iniciar sesión, activa “Enviar cookies con las solicitudes de imágenes” en la ventana emergente.",
  },
  "image.not_image": { title: "No es un archivo de imagen", hint: "" },
  "image.too_large": { title: "Imagen demasiado grande", hint: "" },
  "image.decode": { title: "No se pudo decodificar la imagen", hint: "" },
  "image.capture_unavailable": { title: "Desplázate hasta la imagen para traducirla", hint: "" },
  "image.capture_blocked": {
    title: "Esta imagen solo se puede leer con una captura de pantalla",
    hint: "Activa la traducción en este sitio y mantén esta pestaña en primer plano; luego vuelve a intentarlo.",
  },
  "detector.webgpu_unavailable": { title: "Detectando texto en la CPU (más lento)", hint: "" },
  "detector.canary_mismatch": { title: "La GPU dio resultados inconsistentes; se usa la CPU", hint: "" },
  "detector.model_integrity": {
    title: "El modelo de detección de texto está dañado",
    hint: "Reinstala la extensión (desarrolladores: npm run fetch-models y luego npm run build).",
  },
  "detector.init": {
    title: "No se pudo iniciar la detección de texto",
    hint: "Exporta el registro de depuración desde Opciones.",
  },
  "detector.run": { title: "Falló la detección de texto", hint: "" },
  "offline.pair_unsupported": {
    title: "Este par de idiomas no está disponible sin conexión",
    hint: "Elige NLLB-200 como modelo sin conexión en Opciones, u otro idioma de destino.",
  },
  "offline.download": {
    title: "No se pudieron descargar los modelos sin conexión",
    hint: "Revisa la conexión con huggingface.co. La traducción se reintenta sola.",
  },
  "offline.model_integrity": {
    title: "Un modelo sin conexión descargado está dañado",
    hint: "Traduce de nuevo para descargarlo otra vez.",
  },
  "offline.run": {
    title: "Fallaron los modelos sin conexión",
    hint: "Exporta el registro de depuración desde Opciones.",
  },
  "offline.out_of_memory": {
    title: "No hay memoria suficiente para los modelos sin conexión",
    hint: "Los modelos de traducción se reiniciaron y el motor sigue funcionando. Elige Opus-MT (mucho más pequeño) en Opciones o cierra otras pestañas.",
  },
  "engine.unavailable": {
    title: "No se pudo iniciar el motor de traducción",
    hint: "Recarga la página o desactiva la extensión y vuelve a activarla.",
  },
  "engine.closing": { title: "El motor se está reiniciando", hint: "" },
  "engine.overloaded": { title: "El motor está ocupado", hint: "" },
  "engine.protocol": { title: "Las versiones de la extensión no coinciden", hint: "Recarga la página." },
  "engine.internal": { title: "Error interno", hint: "Exporta el registro de depuración desde Opciones." },
  "msg.too_large": { title: "Datos demasiado grandes, recargando desde la URL", hint: "" },
  "ctx.invalidated": {
    title: "La extensión se acaba de recargar",
    hint: "Recarga la página para seguir traduciendo.",
  },
  "dnr.failed": { title: "No se pudo establecer el Referer de la imagen", hint: "" },
  "store.io": { title: "No se pudo leer ni escribir la caché", hint: "" },
  "store.quota": { title: "La caché está llena", hint: "Borra parte de la caché en Opciones." },
  "site.disabled": { title: "La traducción está desactivada en este sitio", hint: "" },
  "privacy.consent": {
    title: "Falta confirmar el envío de imágenes a la IA",
    hint: "Lee el aviso de privacidad y permite el envío para empezar a traducir.",
  },
  cancelled: { title: "Cancelado", hint: "" },
};

export const ES: Catalog = {
  errors,
  readiness: {
    unknown: { label: "Comprobando el endpoint de IA…", hint: "" },
    ready: { label: "Endpoint de IA listo", hint: "" },
    unauthorized: { label: "Clave de API rechazada", hint: errors["api.unauthorized"].hint },
    unreachable: { label: "Endpoint de IA inaccesible", hint: errors["api.unreachable"].hint },
    lna_blocked: { label: "Chrome bloqueó el servidor de IA local", hint: errors["api.lna_blocked"].hint },
    misconfigured: { label: "Endpoint de IA sin configurar", hint: errors["api.config"].hint },
  },
  imageState: {
    queued: "En cola",
    acquiring: "Cargando imagen",
    detecting: "Buscando texto",
    waiting: "En espera de traducción",
    translating: "Traduciendo",
    done: "Traducida",
    "no-text": "Sin texto",
    partial: "Traducida en parte",
    refused: "La IA se negó",
    paused: "En pausa",
    error: "Error",
    stale: "Traducción desactualizada",
  },
  unitStatus: {
    pending: "En espera",
    translating: "Traduciendo",
    ok: "Traducido",
    "keep-original": "Sin cambios",
    manual: "Editado",
    untranslated: "Sin traducir",
    refused: "La IA se negó",
    ignored: "Ignorado",
    error: "Error",
    stale: "Desactualizado",
  },
  enginePhase: {
    booting: "Iniciando el motor",
    ready: "Motor en funcionamiento",
    closing: "Deteniendo el motor",
    failed: "Error del motor",
  },
  detectorBackend: { webgpu: "GPU (WebGPU)", wasm: "CPU (WASM)", none: "aún sin elegir" },
  detectorState: { unloaded: "sin cargar", loading: "cargando", ready: "lista", failed: "con error" },
  detectorCanary: {
    pass: "GPU verificada",
    fail: "la GPU dio resultados inconsistentes; ahora se usa la CPU",
    pending: "verificando la GPU",
    skipped: "",
  },
  offlineState: {
    idle: "Los modelos se cargan al usarlos por primera vez",
    downloading: "Descargando modelos",
    loading: "Cargando modelos",
    ready: "Listo",
    failed: "Con error",
  },
  ui: {
    appName: "Panelingo",
    siteEnable: "Traducir este sitio",
    siteDisable: "Dejar de traducir este sitio",
    modeAuto: "Traducir al desplazarte",
    modeManual: "Traducir solo cuando lo pidas",
    translateVisible: "Traducir imágenes visibles",
    translateImage: "Traducir",
    retranslate: "Volver a traducir",
    showOriginal: "Ver original",
    uploadsToday: (count: number, mb: number): string =>
      `Hoy se ${plural(count, "envió", "enviaron")} ${count} ${plural(count, "imagen compuesta", "imágenes compuestas")} ` +
      `(${decimal(mb)} MB) a la IA`,
    progress: (done: number, total: number, etaSec?: number): string =>
      etaSec === undefined || !Number.isFinite(etaSec)
        ? `Traduciendo ${done}/${total}`
        : `Traduciendo ${done}/${total} · ~${Math.max(1, Math.round(etaSec))} s`,
    privacyTitle: "Antes de enviar imágenes a la IA",
    privacyBody:
      "Para traducir, la extensión envía imágenes compuestas de las viñetas que contienen texto (solo en los sitios " +
      "que actives o cuando lo pidas) al endpoint de IA configurado. El proveedor de IA puede guardar lo que recibe " +
      "según sus propias condiciones. Asegúrate de que esto sea aceptable para ti y para el contenido que lees.",
    privacyAccept: "Entiendo, permitir el envío",
    privacyDecline: "No enviar",
  },
  bubble: {
    original: "Original",
    translation: "Traducción",
    save: "Guardar",
    revert: "Usar la traducción de la IA",
    retranslate: "Volver a traducir",
    close: "Cerrar",
    dialog: "Globo traducido",
    copy: "Copiar",
    editLabel: "Editar la traducción",
    shortened: "El texto se acortó para que quepa en el globo.",
    saved: "Guardado.",
    retranslating: "Traduciendo de nuevo…",
  },
  menu: {
    translateImage: "Traducir esta imagen",
    retranslateImage: "Volver a traducir esta imagen",
  },
  sidepanel: {
    title: "Panelingo – Transcripción",
    heading: "Transcripción",
    empty: "Aún no hay líneas traducidas en esta pestaña.",
    emptyHint:
      "Abre una página de cómic en un sitio que hayas activado. Las líneas aparecerán aquí a medida que se traduzcan.",
    refresh: "Actualizar",
    copy: "Copiar todo",
    copied: "Copiado al portapapeles.",
    page: (n: number): string => `Página ${n}`,
    jump: "Mostrar",
    jumpHint: "Desplazar la página hasta este globo",
    edit: "Editar",
    save: "Guardar",
    cancel: "Cancelar",
    retranslate: "Traducir de nuevo",
    revert: "Deshacer edición",
    noTranslation: "Sin traducción",
    notFound: "Este globo ya no está en la página.",
    failed: "No funcionó. Inténtalo de nuevo.",
    types: {
      dialogue: "Diálogo",
      thought: "Pensamiento",
      narration: "Narración",
      sign: "Cartel",
      sfx: "Onomatopeya",
      ignore: "Ignorado",
    },
    inconsistent: "Difiere del glosario",
    tabs: { transcript: "Transcripción", glossary: "Glosario" },
    glossary: {
      noSeries: "Abre una página de cómic para ver el glosario de su serie.",
      untitled: "Serie sin título",
      states: {
        manual: "Tus entradas",
        confirmed: "Confirmadas",
        learned: "Aprendidas",
        candidate: "Sugerencias",
      },
      hints: {
        manual: "Se usan siempre. La IA nunca las cambia.",
        confirmed: "Sugerencias que aceptaste. Se usan siempre.",
        learned: "Nombres y términos que la IA usó en varias solicitudes. Se envían con cada solicitud.",
        candidate: "La IA los detectó una vez. No se envían hasta confirmarlos o volver a verlos.",
      },
      empty:
        "Aún no hay entradas. Los nombres y términos aparecen aquí cuando la IA los detecta, o añade los tuyos.",
      original: "Texto original",
      translation: "Traducción",
      note: "Nota (opcional)",
      add: "Añadir",
      delete: "Eliminar",
      confirm: "Confirmar",
      seen: (count: number): string => `Visto ${count} ${plural(count, "vez", "veces")}`,
      incomplete: "Escribe el texto original y su traducción.",
      profileHeading: "Ajustes de la serie",
      sourceLang: "Idioma de origen",
      langAuto: "Detectar automáticamente",
      langs: {
        ja: "Japonés",
        ko: "Coreano",
        zh: "Chino",
        en: "Inglés",
        es: "Español",
        other: "Otro",
      },
      koNames: "Nombres coreanos",
      koRomanized: "Romanizados (Minjun)",
      koHanViet: "Sino-vietnamita (para traducciones al vietnamita)",
      keepHonorifics: "Conservar los honoríficos japoneses (-san, -kun)",
      summary: "Enviar un resumen continuo de la historia",
      saveProfile: "Guardar ajustes",
      saved: "Guardado.",
      export: "Exportar",
      import: "Importar",
      imported: (count: number): string =>
        `${plural(count, "Se importó", "Se importaron")} ${count} ${plural(count, "entrada", "entradas")}.`,
      importFailed: "Este archivo no es un glosario de Panelingo.",
    },
  },
  debug: { heading: "Depuración (solo en versiones de desarrollo y prueba)" },
  duration: (ms: number): string => {
    const seconds = Math.round(Math.abs(ms) / 1000);
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h`;
    const days = Math.round(hours / 24);
    return `${days} ${plural(days, "día", "días")}`;
  },
  popup: {
    openTranscript: "Abrir la transcripción",
    cookies: "Enviar cookies al cargar imágenes",
    cookiesHint:
      "Para sitios que solo muestran imágenes a lectores con sesión iniciada. Las cookies van solo al servidor de imágenes, nunca a la IA.",
    apiHeading: "Endpoint de IA",
    engineHeading: "Motor de traducción",
    siteHeading: "Este sitio",
    checking: "Comprobando…",
    model: (model: string): string => `Modelo: ${model}`,
    endpoint: (url: string): string => `Endpoint: ${url}`,
    cause: (cause: string): string => `Detalles: ${cause}`,
    engineStopped: "El motor está inactivo; se inicia cuando traduces.",
    engineUnreadable: "No se pudo leer el estado del motor.",
    offlineHeading: "Modo sin conexión (experimental)",
    offlineHint:
      "No se usa ningún endpoint de IA: el reconocimiento de texto y la traducción se hacen en este dispositivo.",
    offlineDownload: (doneMb: number, totalMb: number): string =>
      `Descargando ${Math.round(doneMb)} de ${Math.round(totalMb)} MB`,
    offlineModels: (models: string): string => `Modelos: ${models}`,
    detectorLine: (backend: string, state: string, canary: string): string =>
      `Detección de texto: ${backend}, ${state}${canary === "" ? "" : ` (${canary})`}`,
    queueLine: (queued: number, inFlight: number, done: number, failed: number): string =>
      `Cola: ${queued} en espera · ${inFlight} enviando · ${done} completados · ${failed} con error`,
    pausedBy: (title: string): string => `En pausa: ${title}`,
    siteUnsupported: "Esta página no se puede traducir (solo páginas http/https).",
    siteOn: "La traducción está activada en este sitio.",
    siteOff: "La traducción está desactivada en este sitio.",
    modeLabel: "Modo",
    visibleSent: (count: number): string =>
      count > 0
        ? `Se ${plural(count, "envió", "enviaron")} ${count} ${plural(count, "imagen", "imágenes")} para traducir.`
        : "No hay imágenes de cómic visibles.",
    visibleUnavailable: "La extensión no puede ejecutarse en esta página.",
    retranslatePage: "Volver a traducir la página",
    retranslateQueued: (count: number): string =>
      `Se ${plural(count, "volvió", "volvieron")} a poner en cola ${count} ` +
      `${plural(count, "globo de texto", "globos de texto")}.`,
    actionFailed: (title: string): string => `No se pudo completar la acción: ${title}`,
    privacyDetails: "Ver qué se envía",
    options: "Opciones",
    setupHint: "Configura tu endpoint de IA (URL base, clave de API, modelo) en Opciones para empezar.",
    consentHint:
      "Haz clic en el icono de Panelingo para leer el aviso de privacidad antes de activar la traducción aquí.",
    build: (id: string): string => `Compilación ${id}`,
  },
  options: {
    exportLog: "Exportar el registro de depuración",
    exportFailed: "No se pudo exportar el registro de depuración.",
    exportEmpty: "El registro de depuración está vacío.",
    title: "Opciones",
    apiHeading: "Endpoint de IA (compatible con OpenAI)",
    apiIntro:
      "Funciona cualquier servicio que admita la API de chat completions de OpenAI y acepte imágenes: OpenAI, " +
      "OpenRouter, Azure OpenAI, Google Gemini (modo OpenAI) o un servidor local como Ollama, LM Studio, vLLM o LiteLLM.",
    preset: "Configuración predefinida",
    presetCustom: "Personalizada",
    baseUrl: "URL base",
    baseUrlHint:
      "Incluye la ruta de la versión, por ejemplo https://api.openai.com/v1 o http://127.0.0.1:11434/v1.",
    baseUrlInvalid: "No es una URL http(s) válida.",
    apiKey: "Clave de API",
    apiKeyHint:
      "Solo se guarda en este perfil del navegador; déjala vacía para servidores locales que no la necesiten.",
    model: "Modelo",
    modelHint:
      "El modelo debe aceptar imágenes como entrada (visión), por ejemplo gpt-4o-mini, gemini-2.5-flash, qwen2.5-vl.",
    modelInvalid: "Escribe el ID de un modelo.",
    testConnection: "Probar conexión",
    testing: "Probando…",
    testOk: (detail: string): string => `Conexión correcta. ${detail}`,
    testFailed: (detail: string): string => `Error: ${detail}`,
    concurrency: "Solicitudes de traducción en paralelo",
    concurrencyHint: "Predeterminado: 2; máximo: 4. Reduce el valor si tu proveedor limita tus solicitudes.",
    concurrencyInvalid: "Elige un número del 1 al 4.",
    languageHeading: "Idiomas",
    uiLanguage: "Idioma de la interfaz",
    targetLanguage: "Traducir a",
    languageAuto: "Igual que el navegador",
    save: "Guardar",
    saved: "Guardado.",
    saveFailed: "No se pudo guardar.",
    sitesHeading: "Sitios",
    sitesEmpty:
      "Aún no hay sitios. Abre una página de cómics, haz clic en el icono de la extensión y activa la traducción " +
      "para ese sitio.",
    siteEnabled: "Activado",
    siteMode: "Modo",
    siteRemove: "Quitar",
    privacyHeading: "Privacidad: qué se envía a la IA",
    privacyPoints: [
      "En cada traducción, la extensión envía una sola imagen compuesta en formato JPEG al endpoint de IA configurado: " +
        "miniaturas de las imágenes (o fragmentos de webtoon) que contienen texto, recuadros numerados alrededor de " +
        "cada zona de texto y recortes ampliados de esas zonas.",
      "Con ella también se envía texto: reglas de formato e idioma, el glosario de la serie (hasta 60 entradas), " +
        "hasta 20 líneas de diálogo anteriores del mismo capítulo y un breve resumen.",
      "Nunca se envían: imágenes sin texto, la dirección de la página que lees, cookies, tu dirección IP ni las " +
        "cabeceras del navegador (más allá de lo que incluye cualquier solicitud a tu endpoint).",
      "El proveedor de IA puede conservar lo que recibe según sus propias condiciones. Da por hecho que todo lo " +
        "enviado queda almacenado.",
      "Mientras te desplazas, solo se traducen los sitios que hayas activado. Las demás páginas se traducen " +
        "únicamente cuando lo pides (menú contextual o atajo de teclado), y la extensión siempre pregunta antes del " +
        "primer envío.",
      "La ventana emergente muestra cuántas imágenes compuestas se enviaron hoy.",
      "En este dispositivo, las traducciones, las posiciones de los globos de texto y las capas de borrado se guardan " +
        "en el almacenamiento IndexedDB de la extensión; puedes borrarlas en Caché, más abajo.",
    ],
    privacyAcked: (when: string): string => `Confirmaste el aviso de envío de imágenes el ${when}.`,
    privacyNotAcked:
      "Aún no has confirmado el aviso de envío de imágenes; la extensión preguntará antes del primer envío.",
    cacheHeading: "Caché",
    cacheHint:
      "Elimina todas las traducciones, posiciones de globos de texto y capas de borrado guardadas en este " +
      "dispositivo. Al volver a leer, se traducirá todo de nuevo (y se volverán a enviar imágenes).",
    cacheClear: "Borrar toda la caché",
    cacheConfirm:
      "¿Borrar toda la caché? La próxima vez que leas, se traducirá todo de nuevo y se volverán a enviar las imágenes.",
    cacheCleared: (count: number): string =>
      `Se ${plural(count, "eliminó", "eliminaron")} ${count} ${plural(count, "registro", "registros")}.`,
    cacheFailed: (title: string): string => `No se pudo borrar la caché: ${title}`,
    debugHeading: "Registro de depuración",
    logLevel: "Nivel de registro",
    logLevels: {
      debug: "Detallado (debug)",
      info: "Información",
      warn: "Advertencias",
      error: "Solo errores",
    },
  },
  optionsAdvanced: {
    heading: "Ajustes avanzados",
    intro:
      "Ajustes finos de las solicitudes, la detección de texto, la rotulación y las cachés. Los valores " +
      "predeterminados sirven para la mayoría de los casos. Cada cambio se guarda al salir del campo.",
    defaultIs: (value: string): string => `Predeterminado: ${value}`,
    range: (min: string, max: string): string => `Rango permitido: de ${min} a ${max}`,
    automatic: "automático",
    on: "activado",
    off: "desactivado",
    reset: "Restablecer",
    resetLabel: (label: string): string => `Restablecer “${label}” al valor predeterminado`,
    resetAll: "Restablecer todos los ajustes avanzados",
    resetAllConfirm: "¿Restablecer todos los ajustes avanzados a sus valores predeterminados?",
    resetAllDone: "Todos los ajustes avanzados volvieron a sus valores predeterminados.",
    notANumber: "Escribe un número.",
    adjusted: (value: string): string => `Se guardó como ${value}, el valor permitido más cercano.`,
    badKey: "Usa un código de tecla como Backquote o KeyH, o déjalo vacío.",
    verticalChoices: { auto: "Automático", never: "Nunca" },
    groups: {
      api: "Solicitudes a la IA",
      translate: "Contenido de las solicitudes",
      detector: "Detección de texto",
      engine: "Motor",
      discovery: "Búsqueda de imágenes",
      render: "Rotulación",
      memory: "Memoria de la serie",
      cache: "Caché",
      privacy: "Límites de imagen",
      debug: "Registro de depuración",
    },
    fields: {
      "api.temperature": {
        label: "Temperatura",
        hint: "Cuánto varían las respuestas. Déjalo vacío para usar el valor predeterminado del proveedor.",
      },
      "api.urgentLane": {
        label: "Canal adicional para las imágenes en pantalla",
        hint: "Añade un canal de solicitudes reservado para las imágenes que estás viendo.",
      },
      "api.maxInFlight": {
        label: "Máximo de solicitudes simultáneas",
        hint: "Límite estricto, canal adicional incluido. Nunca es menor que las solicitudes de traducción en paralelo.",
      },
      "api.firstByteTimeoutMs": {
        label: "Espera máxima de la primera respuesta (segundos)",
        hint: "Se cancela si el endpoint no envía nada durante este tiempo.",
      },
      "api.idleTimeoutMs": {
        label: "Tiempo límite para respuestas detenidas (segundos)",
        hint: "Se cancela si una respuesta deja de transmitirse durante este tiempo.",
      },
      "api.totalTimeoutMs": {
        label: "Duración máxima de una solicitud (segundos)",
        hint: "Cualquier solicitud se cancela pasado este tiempo.",
      },
      "api.healthTimeoutMs": {
        label: "Tiempo límite de la comprobación de conexión (segundos)",
        hint: "Lo usan la comprobación del endpoint y el botón “Probar conexión”.",
      },
      "translate.boxBudget": {
        label: "Zonas de texto por solicitud",
        hint: "Déjalo vacío para usar el perfil del modelo (12, 16 o 20).",
      },
      "translate.packWaitMs": {
        label: "Espera para agrupar imágenes (ms)",
        hint: "Cuánto espera el texto de una imagen a las siguientes de la página para compartir una solicitud. 0 envía cada imagen enseguida.",
      },
      "translate.urgentPackMax": {
        label: "Globos en la primera solicitud en pantalla",
        hint: "La primera solicitud de una imagen en pantalla lleva como máximo estos globos, para que aparezcan antes. 0 = sin límite aparte.",
      },
      "translate.jpegQuality": {
        label: "Calidad JPEG",
        hint: "Calidad de la imagen compuesta que se envía a la IA.",
      },
      "translate.requestBodyCapMb": {
        label: "Tamaño máximo de la solicitud (MB)",
        hint: "Las imágenes compuestas más grandes se comprimen más y luego se dividen.",
      },
      "translate.promptCharCap": {
        label: "Longitud máxima del prompt (caracteres)",
        hint: "Si una solicitud es más larga, primero se acorta el contexto.",
      },
      "translate.maxLadderRequestsPerPack": {
        label: "Solicitudes extra para recuperar texto omitido",
        hint: "Se vuelve a preguntar y se divide la solicitud cuando la IA omite zonas de texto.",
      },
      "translate.maxHttpRetriesPerRequest": {
        label: "Reintentos tras errores de red",
        hint: "Por solicitud, para fallos temporales de HTTP y de red.",
      },
      "translate.engine": {
        label: "Motor de traducción",
        hint: "El modo sin conexión es experimental: consulta Modo sin conexión más arriba.",
      },
      "translate.offlineModel": {
        label: "Modelo de traducción sin conexión",
        hint: "Solo se usa en el modo sin conexión.",
      },
      "translate.splitOnRefusal": {
        label: "Dividir las solicitudes rechazadas",
        hint: "Si la IA se niega, prueba las dos mitades por separado en lugar de abandonar.",
      },
      "detector.backend": {
        label: "Hardware de detección",
        hint: "Automático usa la GPU si supera una autoprueba; si no, la CPU.",
      },
      "detector.scoreMin": {
        label: "Puntuación mínima de detección",
        hint: "Los valores más bajos encuentran más texto, y también más falsos positivos.",
      },
      "detector.sliceTriggerRatio": {
        label: "Fragmentar imágenes más largas que (proporción)",
        hint: "Las imágenes y tiras de webtoon cuyo lado largo supera este múltiplo del lado corto se cortan en fragmentos.",
      },
      "detector.sliceHeightRatio": {
        label: "Longitud del fragmento (× lado corto)",
        hint: "Longitud de cada fragmento como múltiplo del lado corto de la imagen.",
      },
      "detector.sliceOverlap": {
        label: "Solapamiento de fragmentos (fracción)",
        hint: "Solapamiento entre fragmentos contiguos, como fracción de un fragmento.",
      },
      "detector.sliceOverlapMinPx": {
        label: "Solapamiento mínimo de fragmentos (píxeles)",
        hint: "Los fragmentos contiguos siempre comparten al menos esta cantidad de píxeles.",
      },
      "detector.quietRows": {
        label: "Cortar fragmentos entre filas de texto",
        hint: "Experimental: mueve los cortes a filas sin tinta.",
      },
      "engine.idleCloseMin": {
        label: "Cerrar el motor inactivo tras (minutos)",
        hint: "Libera memoria cuando ninguna página ha usado el motor durante este tiempo.",
      },
      "engine.detectorReleaseMin": {
        label: "Liberar la detección de texto tras (minutos)",
        hint: "Quita de la memoria el modelo de detección cuando no se ha usado durante este tiempo.",
      },
      "engine.portIdleMin": {
        label: "Desconectar páginas inactivas tras (minutos)",
        hint: "Una página se desconecta del motor tras este tiempo sin actividad.",
      },
      "discovery.minNaturalSide": {
        label: "Ignorar imágenes menores de (píxeles)",
        hint: "Tamaño real del lado corto. Omite iconos, avatares y anuncios.",
      },
      "discovery.minDisplayedSide": {
        label: "Ignorar imágenes que se muestran a menos de (píxeles)",
        hint: "Tamaño en pantalla del lado corto.",
      },
      "discovery.secondsPerScreenDefault": {
        label: "Velocidad de lectura inicial (segundos por pantalla)",
        hint: "Estimación inicial hasta que se mida tu velocidad de lectura.",
      },
      "discovery.lookaheadMinScreens": {
        label: "Traducción anticipada, mínimo (pantallas)",
        hint: "Las imágenes a esta distancia por debajo de la vista siempre se traducen antes de que llegues.",
      },
      "discovery.lookaheadMaxScreens": {
        label: "Traducción anticipada, máximo (pantallas)",
        hint: "Límite superior cuando lees rápido o la IA es lenta.",
      },
      "discovery.lookaheadMaxScreensStrip": {
        label: "Traducción anticipada en tiras webtoon, máximo (pantallas)",
        hint: "Límite superior para tiras verticales largas.",
      },
      "discovery.detectAheadMinScreens": {
        label: "Detección anticipada, mínimo (pantallas)",
        hint: "Las imágenes que la página aún no ha cargado se detectan con esta antelación (sin subir nada).",
      },
      "discovery.detectAheadMaxScreens": {
        label: "Detección anticipada, máximo (pantallas)",
        hint: "Límite superior para lectores rápidos.",
      },
      "discovery.detectMaxImages": {
        label: "Imágenes detectadas por adelantado, como máximo",
        hint: "Cuenta cada imagen por delante de ti, cargada o no.",
      },
      "discovery.fetchPerHostConcurrency": {
        label: "Descargas de imágenes en paralelo por servidor",
        hint: "Descargas simultáneas desde un mismo servidor de imágenes.",
      },
      "discovery.prefetchSpacingMs": {
        label: "Pausa entre descargas de imágenes (ms)",
        hint: "Tiempo mínimo entre dos descargas del mismo servidor.",
      },
      "discovery.scrollDebounceMs": {
        label: "Retardo de reacción al desplazamiento (ms)",
        hint: "Tiempo de espera tras desplazarte antes de reordenar el trabajo.",
      },
      "discovery.mutationDebounceMs": {
        label: "Retardo de reacción a cambios en la página (ms)",
        hint: "Tiempo de espera tras un cambio en la página (carga diferida, apps de lectura) antes de buscar imágenes nuevas.",
      },
      "discovery.stripGapPx": {
        label: "Separación máxima dentro de una tira de webtoon (píxeles)",
        hint: "Las imágenes más cercanas que esto forman una sola tira continua.",
      },
      "discovery.translateHiddenTabs": {
        label: "Traducir en pestañas en segundo plano",
        hint: "Desactivado: el modo automático espera a que la pestaña se haya mostrado.",
      },
      "render.font": {
        label: "Fuente de los diálogos",
        hint: "Fuente del texto traducido en los globos de texto.",
      },
      "render.verticalText": {
        label: "Rotulado vertical",
        hint: "Las traducciones al japonés o al chino tradicional se rotulan de arriba abajo en los globos verticales. «Nunca» deja todas las traducciones en horizontal.",
      },
      "render.minFontPx": {
        label: "Tamaño de texto mínimo (píxeles)",
        hint: "El texto que no cabe a este tamaño se acorta con “…”.",
      },
      "render.maxFontPx": {
        label: "Tamaño de texto máximo (píxeles)",
        hint: "El texto también se mantiene cerca del tamaño de la rotulación original.",
      },
      "render.eraseSfx": {
        label: "Borrar onomatopeyas",
        hint: "Quita las onomatopeyas de la imagen en lugar de etiquetarlas.",
      },
      "render.sfxLabels": {
        label: "Etiquetar onomatopeyas",
        hint: "Muestra la traducción de las onomatopeyas en pequeñas etiquetas.",
      },
      "render.showDoneBadge": {
        label: "Marcar imágenes traducidas",
        hint: "Muestra una pequeña insignia en cada imagen traducida.",
      },
      "render.peekKey": {
        label: "Mantén una tecla para ver el original (código de tecla)",
        hint: "Un código de tecla como Backquote o KeyH. Déjalo vacío para desactivarlo.",
      },
      "render.peekWithAlt": {
        label: "Ver también el original mientras se mantiene Alt",
        hint: "Mantener solo la tecla Alt también oculta la traducción.",
      },
      "render.popupWithAltClick": {
        label: "Alt+clic abre la ventana del globo",
        hint: "La ventana muestra el original y permite editar la traducción. Una pulsación larga siempre la abre.",
      },
      "memory.enabled": {
        label: "Usar la memoria de la serie",
        hint: "Envía con cada solicitud el glosario, las líneas anteriores y un resumen de la historia, y aprende nombres de las respuestas.",
      },
      "memory.glossaryInPrompt": {
        label: "Entradas del glosario por solicitud",
        hint: "Primero tus entradas, luego las confirmadas y después las aprendidas.",
      },
      "memory.termMinSightings": {
        label: "Apariciones antes de aprender un término",
        hint: "Solicitudes distintas que deben nombrar un término antes de que se envíe.",
      },
      "memory.historyMaxLines": {
        label: "Líneas anteriores enviadas como contexto",
        hint: "Líneas del mismo capítulo. 0 no envía ninguna.",
      },
      "memory.historyMaxTokens": {
        label: "Presupuesto de tokens para líneas anteriores",
        hint: "Las líneas más antiguas se descartan primero.",
      },
      "memory.summaryMaxWords": {
        label: "Longitud del resumen de la historia (palabras)",
        hint: "0 desactiva el resumen continuo.",
      },
      "cache.translationTtlDays": {
        label: "Conservar traducciones sin usar durante (días)",
        hint: "Tus propias ediciones nunca caducan.",
      },
      "cache.encodedBytesLruMb": {
        label: "Caché de imágenes descargadas (MB)",
        hint: "Memoria que usa el motor para guardar las imágenes descargadas.",
      },
      "privacy.maxImageBytes": {
        label: "Tamaño máximo del archivo de imagen (MiB)",
        hint: "Se omiten los archivos de imagen más grandes.",
      },
      "privacy.maxImagePixels": {
        label: "Resolución máxima de imagen (megapíxeles)",
        hint: "Se omiten las imágenes con más píxeles.",
      },
      "debug.logCapacity": {
        label: "Entradas del registro que se conservan",
        hint: "Tamaño del registro de depuración que guarda el motor.",
      },
    },
    site: {
      settings: "Ajustes",
      settingsFor: (site: string): string => `Ajustes de ${site}`,
      layout: "Diseño y sentido de lectura",
      layouts: {
        auto: "Detectar automáticamente",
        webtoon: "Webtoon (tira vertical)",
        "paged-rtl": "Páginas, de derecha a izquierda (manga)",
        "paged-ltr": "Páginas, de izquierda a derecha (cómics)",
      },
      sourceLangHint:
        "Selecciona las instrucciones específicas del idioma para la IA y cuánto se amplían los recortes de texto.",
      referer: "Referer para descargar imágenes",
      referers: {
        auto: "Automático",
        "page-url": "Dirección completa de la página",
        origin: "Solo la dirección del sitio",
      },
      refererHint:
        "Automático sigue a la página y, si el servidor de imágenes rechaza la descarga, reintenta con la " +
        "dirección completa de la página. Cámbialo solo cuando las imágenes no carguen.",
      subdomains: "También en subdominios",
      subdomainsHint: "Traducir en todos los subdominios de este sitio con los mismos ajustes.",
      prefetch: "Preparar imágenes por adelantado",
      prefetchHint:
        "Detecta las imágenes que la página aún no ha cargado, debajo de la vista, para que estén listas cuando llegues. No se sube nada hasta que estén cerca.",
      frames: "Marcos de lectores de otros sitios",
      framesHint:
        "Un origen por línea, p. ej. https://viewer.example.com, cuando las páginas se muestran dentro de un " +
        "marco servido desde otro sitio.",
      framesInvalid: (lines: string): string => `No es un origen http(s): ${lines}`,
    },
    transfer: {
      heading: "Copia de seguridad y restauración",
      hint:
        "Guarda tus ajustes y tu lista de sitios en un archivo JSON, o cárgalos desde uno. La confirmación de " +
        "privacidad nunca se exporta.",
      includeKey: "Incluir la clave de API",
      includeKeyHint: "Desactívalo antes de compartir el archivo: cualquiera podría leer la clave.",
      export: "Exportar ajustes",
      import: "Importar ajustes",
      importConfirm:
        "¿Reemplazar tus ajustes por los del archivo? Los sitios del archivo se añaden o se actualizan.",
      notJson: "Este archivo no es un JSON válido.",
      notSettings: "Este archivo no es una exportación de ajustes de Panelingo.",
      tooNew: "Este archivo se creó con una versión más reciente de Panelingo.",
      imported: (settings: number, sites: number): string =>
        `Importado. Ajustes cambiados: ${settings}. Sitios: ${sites}.`,
      keyImported: "Se importó la clave de API del archivo.",
      keyKept: "Se mantuvo tu clave de API (el archivo no incluye ninguna).",
    },
  },
  offline: {
    heading: "Modo sin conexión (experimental)",
    intro:
      "Traduce sin ningún endpoint de IA: modelos de código abierto de reconocimiento de texto (PaddleOCR) y de traducción se ejecutan en este dispositivo. La calidad es claramente inferior a la de un modelo de visión: sin contexto entre bocadillos, sin nombres de personajes, la rotulación estilizada suele leerse mal y las onomatopeyas se dejan sin traducir.",
    download:
      "Los modelos se descargan una sola vez desde Hugging Face cuando hacen falta, se verifican y se guardan en este dispositivo; después, la traducción no necesita red. Tamaños: reconocimiento de texto de 8 a 17 MB por idioma, Opus-MT unos 115 MB por par de idiomas (el doble pasando por el inglés), NLLB-200 unos 910 MB.",
    engine: "Motor de traducción",
    engineChoices: {
      api: "Endpoint de IA (compatible con OpenAI)",
      offline: "Sin conexión en este dispositivo (experimental)",
    },
    model: "Modelo de traducción sin conexión",
    modelChoices: {
      "opus-mt": "Opus-MT: pequeño, un modelo por par de idiomas",
      "nllb-600m": "NLLB-200 600M: todos los pares, grande, no comercial",
    },
    pairs:
      "Opus-MT traduce coreano, japonés, chino y español al inglés, y del inglés al vietnamita, español, francés, alemán, italiano e indonesio; los demás pares pasan por el inglés. NLLB-200 traduce entre todos los idiomas de esta lista.",
    license:
      "Licencias: PaddleOCR y la mayoría de los modelos Opus-MT Apache-2.0, dos modelos Opus-MT CC-BY-4.0, NLLB-200 CC-BY-NC-4.0 (solo uso no comercial).",
    stored: (mb: number): string => `Modelos descargados en este dispositivo: ${Math.round(mb)} MB`,
    deleteModels: "Borrar los modelos descargados",
    deleteConfirm:
      "¿Borrar los modelos sin conexión descargados? Se volverán a descargar cuando hagan falta.",
    deleted: "Se borraron los modelos descargados.",
  },
  manifest: {
    description:
      "Traduce cómics, mangas y webtoons en la misma página mientras lees, con cualquier IA compatible con OpenAI.",
    commands: {
      "toggle-overlay": "Mostrar u ocultar la capa de traducción",
      "translate-visible": "Traducir imágenes visibles",
      "toggle-site": "Activar o desactivar la traducción automática en este sitio",
      "open-side-panel": "Abrir el panel lateral de transcripción",
    },
  },
};
