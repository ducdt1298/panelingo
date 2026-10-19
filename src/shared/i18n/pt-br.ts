// Brazilian Portuguese UI catalog ("você"). PURE.

import type { Catalog } from "./en.ts";

/** Brazilian Portuguese plural: singular only for exactly 1 (0 takes the plural). */
const plural = (n: number, one: string, other: string): string => (n === 1 ? one : other);

/** Decimal comma. */
const decimal = (value: number): string => value.toFixed(1).replace(".", ",");

const errors: Catalog["errors"] = {
  "api.unreachable": {
    title: "Não foi possível acessar o endpoint de IA",
    hint: "Verifique a URL base em Opções e confirme que o servidor (ou seu modelo local) está em execução.",
  },
  "api.lna_blocked": {
    title: "O Chrome bloqueou a conexão com seu servidor de IA local",
    hint: "Abra as configurações do site da extensão → Acesso à rede local (Local network access) → Permitir.",
  },
  "api.unauthorized": {
    title: "O endpoint de IA recusou a chave de API",
    hint: "Insira uma chave de API válida em Opções. A tradução será retomada automaticamente.",
  },
  "api.config": {
    title: "O endpoint de IA ou o modelo está mal configurado",
    hint: "Verifique a URL base e escolha em Opções um modelo que aceite imagens (visão).",
  },
  "api.rate_limit": {
    title: "O provedor de IA está limitando as solicitações",
    hint: "A extensão diminui o ritmo e tenta de novo sozinha.",
  },
  "api.upstream": { title: "Erro no servidor de IA, tentando novamente", hint: "" },
  "api.context_length": { title: "Solicitação longa demais, dividindo em partes", hint: "" },
  "api.timeout": { title: "A IA demorou demais para responder", hint: "A extensão tenta mais uma vez." },
  "api.truncated": { title: "A resposta foi cortada, continuando", hint: "" },
  "api.partial": { title: "A IA pulou alguns balões, perguntando de novo", hint: "" },
  "api.empty": { title: "Resposta vazia da IA, tentando novamente", hint: "" },
  "api.too_large": { title: "Imagem grande demais para enviar, reduzindo o tamanho", hint: "" },
  "api.bad_request": {
    title: "A solicitação foi recusada (erro da extensão)",
    hint: "Exporte o log de depuração em Opções.",
  },
  "api.protocol": { title: "Formato de resposta inesperado do endpoint de IA", hint: "" },
  "llm.refused": { title: "A IA se recusou a traduzir", hint: "O balão mantém o texto original." },
  "llm.missing": {
    title: "Não traduzido",
    hint: "Use “Traduzir novamente” para tentar de novo só este balão.",
  },
  "llm.format": { title: "Resposta malformada da IA, tentando novamente", hint: "" },
  "image.url_blocked": { title: "Imagem bloqueada por segurança", hint: "" },
  "image.http": {
    title: "Não foi possível carregar a imagem",
    hint: "Se o site exigir login, ative “Enviar cookies nas solicitações de imagem” no pop-up.",
  },
  "image.not_image": { title: "Não é um arquivo de imagem", hint: "" },
  "image.too_large": { title: "Imagem grande demais", hint: "" },
  "image.decode": { title: "Não foi possível decodificar a imagem", hint: "" },
  "image.capture_unavailable": { title: "Role até a imagem para traduzi-la", hint: "" },
  "image.capture_blocked": {
    title: "Esta imagem só pode ser lida por uma captura de tela",
    hint: "Ative a tradução neste site e mantenha esta aba em primeiro plano; depois tente de novo.",
  },
  "detector.webgpu_unavailable": { title: "Detectando texto na CPU (mais lento)", hint: "" },
  "detector.canary_mismatch": { title: "A GPU deu resultados inconsistentes; usando a CPU", hint: "" },
  "detector.model_integrity": {
    title: "O modelo de detecção de texto está corrompido",
    hint: "Reinstale a extensão (desenvolvedores: npm run fetch-models e depois npm run build).",
  },
  "detector.init": {
    title: "Não foi possível iniciar a detecção de texto",
    hint: "Exporte o log de depuração em Opções.",
  },
  "detector.run": { title: "Falha na detecção de texto", hint: "" },
  "offline.pair_unsupported": {
    title: "Este par de idiomas não está disponível offline",
    hint: "Escolha NLLB-200 como modelo offline em Opções, ou outro idioma de destino.",
  },
  "offline.download": {
    title: "Não foi possível baixar os modelos offline",
    hint: "Verifique a conexão com huggingface.co. A tradução é tentada de novo automaticamente.",
  },
  "offline.model_integrity": {
    title: "Um modelo offline baixado está corrompido",
    hint: "Traduza novamente para baixá-lo mais uma vez.",
  },
  "offline.run": { title: "Os modelos offline falharam", hint: "Exporte o log de depuração em Opções." },
  "offline.out_of_memory": {
    title: "Memória insuficiente para os modelos offline",
    hint: "Os modelos de tradução foram reiniciados e o mecanismo continua funcionando. Escolha o Opus-MT (bem menor) em Opções ou feche outras abas.",
  },
  "engine.unavailable": {
    title: "Não foi possível iniciar o mecanismo de tradução",
    hint: "Recarregue a página ou desative e ative a extensão de novo.",
  },
  "engine.closing": { title: "O mecanismo está sendo reiniciado", hint: "" },
  "engine.overloaded": { title: "O mecanismo está ocupado", hint: "" },
  "engine.protocol": { title: "Versões da extensão incompatíveis", hint: "Recarregue a página." },
  "engine.internal": { title: "Erro interno", hint: "Exporte o log de depuração em Opções." },
  "msg.too_large": { title: "Dados grandes demais, recarregando pela URL", hint: "" },
  "ctx.invalidated": {
    title: "A extensão acabou de ser recarregada",
    hint: "Recarregue a página para continuar traduzindo.",
  },
  "dnr.failed": { title: "Não foi possível definir o Referer da imagem", hint: "" },
  "store.io": { title: "Não foi possível ler ou gravar o cache", hint: "" },
  "store.quota": { title: "O cache está cheio", hint: "Limpe parte do cache em Opções." },
  "site.disabled": { title: "A tradução está desativada neste site", hint: "" },
  "privacy.consent": {
    title: "O envio de imagens para a IA ainda não foi confirmado",
    hint: "Leia o aviso de privacidade e permita o envio para começar a traduzir.",
  },
  cancelled: { title: "Cancelado", hint: "" },
};

export const PT_BR: Catalog = {
  errors,
  readiness: {
    unknown: { label: "Verificando o endpoint de IA…", hint: "" },
    ready: { label: "Endpoint de IA pronto", hint: "" },
    unauthorized: { label: "Chave de API recusada", hint: errors["api.unauthorized"].hint },
    unreachable: { label: "Endpoint de IA inacessível", hint: errors["api.unreachable"].hint },
    lna_blocked: { label: "O Chrome bloqueou o servidor de IA local", hint: errors["api.lna_blocked"].hint },
    misconfigured: { label: "Endpoint de IA não configurado", hint: errors["api.config"].hint },
  },
  imageState: {
    queued: "Na fila",
    acquiring: "Carregando imagem",
    detecting: "Procurando texto",
    waiting: "Aguardando tradução",
    translating: "Traduzindo",
    done: "Traduzida",
    "no-text": "Sem texto",
    partial: "Parcialmente traduzida",
    refused: "A IA se recusou",
    paused: "Em pausa",
    error: "Erro",
    stale: "Tradução desatualizada",
  },
  unitStatus: {
    pending: "Aguardando",
    translating: "Traduzindo",
    ok: "Traduzido",
    "keep-original": "Sem alterações",
    manual: "Editado",
    untranslated: "Não traduzido",
    refused: "A IA se recusou",
    ignored: "Ignorado",
    error: "Erro",
    stale: "Desatualizado",
  },
  enginePhase: {
    booting: "Iniciando o mecanismo",
    ready: "Mecanismo em execução",
    closing: "Encerrando o mecanismo",
    failed: "Falha no mecanismo",
  },
  detectorBackend: { webgpu: "GPU (WebGPU)", wasm: "CPU (WASM)", none: "ainda não escolhido" },
  detectorState: { unloaded: "não carregada", loading: "carregando", ready: "pronta", failed: "com falha" },
  detectorCanary: {
    pass: "GPU verificada",
    fail: "a GPU deu resultados inconsistentes; agora usa a CPU",
    pending: "verificando a GPU",
    skipped: "",
  },
  offlineState: {
    idle: "Os modelos são carregados no primeiro uso",
    downloading: "Baixando modelos",
    loading: "Carregando modelos",
    ready: "Pronto",
    failed: "Com falha",
  },
  ui: {
    appName: "Panelingo",
    siteEnable: "Traduzir este site",
    siteDisable: "Parar de traduzir este site",
    modeAuto: "Traduzir ao rolar a página",
    modeManual: "Traduzir só quando solicitado",
    translateVisible: "Traduzir imagens visíveis",
    translateImage: "Traduzir",
    retranslate: "Traduzir novamente",
    showOriginal: "Ver original",
    uploadsToday: (count: number, mb: number): string =>
      `${count} ${plural(count, "imagem composta", "imagens compostas")} (${decimal(mb)} MB) ` +
      `${plural(count, "enviada", "enviadas")} para a IA hoje`,
    progress: (done: number, total: number, etaSec?: number): string =>
      etaSec === undefined || !Number.isFinite(etaSec)
        ? `Traduzindo ${done}/${total}`
        : `Traduzindo ${done}/${total} · ~${Math.max(1, Math.round(etaSec))} s`,
    privacyTitle: "Antes de enviar imagens para a IA",
    privacyBody:
      "Para traduzir, a extensão envia imagens compostas dos quadros que contêm texto (apenas nos sites que você " +
      "ativar ou quando pedir) para o endpoint de IA configurado. O provedor de IA pode armazenar o que recebe de " +
      "acordo com os próprios termos. Verifique se isso é aceitável para você e para o conteúdo que lê.",
    privacyAccept: "Entendi, permitir o envio",
    privacyDecline: "Não enviar",
  },
  bubble: {
    original: "Original",
    translation: "Tradução",
    save: "Salvar",
    revert: "Usar a tradução da IA",
    retranslate: "Traduzir novamente",
    close: "Fechar",
    dialog: "Balão traduzido",
    copy: "Copiar",
    editLabel: "Editar a tradução",
    shortened: "O texto foi encurtado para caber no balão.",
    saved: "Salvo.",
    retranslating: "Traduzindo novamente…",
  },
  menu: {
    translateImage: "Traduzir esta imagem",
    retranslateImage: "Traduzir esta imagem novamente",
  },
  sidepanel: {
    title: "Panelingo – Transcrição",
    heading: "Transcrição",
    empty: "Ainda não há falas traduzidas nesta aba.",
    emptyHint:
      "Abra uma página de quadrinhos em um site que você ativou. As falas aparecem aqui conforme são traduzidas.",
    refresh: "Atualizar",
    copy: "Copiar tudo",
    copied: "Copiado para a área de transferência.",
    page: (n: number): string => `Página ${n}`,
    jump: "Mostrar",
    jumpHint: "Rolar a página até este balão",
    edit: "Editar",
    save: "Salvar",
    cancel: "Cancelar",
    retranslate: "Traduzir de novo",
    revert: "Desfazer edição",
    noTranslation: "Sem tradução",
    notFound: "Este balão não está mais na página.",
    failed: "Não deu certo. Tente de novo.",
    types: {
      dialogue: "Fala",
      thought: "Pensamento",
      narration: "Narração",
      sign: "Placa",
      sfx: "Onomatopeia",
      ignore: "Ignorado",
    },
    inconsistent: "Difere do glossário",
    tabs: { transcript: "Transcrição", glossary: "Glossário" },
    glossary: {
      noSeries: "Abra uma página de quadrinhos para ver o glossário da série.",
      untitled: "Série sem título",
      states: {
        manual: "Suas entradas",
        confirmed: "Confirmadas",
        learned: "Aprendidas",
        candidate: "Sugestões",
      },
      hints: {
        manual: "Sempre usadas. A IA nunca as altera.",
        confirmed: "Sugestões que você aceitou. Sempre usadas.",
        learned: "Nomes e termos que a IA usou em várias solicitações. Enviados em toda solicitação.",
        candidate: "Notados uma vez pela IA. Não são enviados até serem confirmados ou vistos de novo.",
      },
      empty: "Nenhuma entrada ainda. Nomes e termos aparecem aqui quando a IA os nota, ou adicione os seus.",
      original: "Texto original",
      translation: "Tradução",
      note: "Nota (opcional)",
      add: "Adicionar",
      delete: "Excluir",
      confirm: "Confirmar",
      seen: (count: number): string => `Visto ${count} ${plural(count, "vez", "vezes")}`,
      incomplete: "Digite o texto original e a tradução.",
      profileHeading: "Configurações da série",
      sourceLang: "Idioma de origem",
      langAuto: "Detectar automaticamente",
      langs: {
        ja: "Japonês",
        ko: "Coreano",
        zh: "Chinês",
        en: "Inglês",
        es: "Espanhol",
        other: "Outro",
      },
      koNames: "Nomes coreanos",
      koRomanized: "Romanizados (Minjun)",
      koHanViet: "Sino-vietnamita (para traduções em vietnamita)",
      keepHonorifics: "Manter os honoríficos japoneses (-san, -kun)",
      summary: "Enviar um resumo contínuo da história",
      saveProfile: "Salvar configurações",
      saved: "Salvo.",
      export: "Exportar",
      import: "Importar",
      imported: (count: number): string =>
        `${count} ${plural(count, "entrada importada", "entradas importadas")}.`,
      importFailed: "Este arquivo não é um glossário do Panelingo.",
    },
  },
  debug: { heading: "Depuração (apenas em versões de desenvolvimento e teste)" },
  duration: (ms: number): string => {
    const seconds = Math.round(Math.abs(ms) / 1000);
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h`;
    const days = Math.round(hours / 24);
    return `${days} ${plural(days, "dia", "dias")}`;
  },
  popup: {
    openTranscript: "Abrir a transcrição",
    cookies: "Enviar cookies ao carregar imagens",
    cookiesHint:
      "Para sites que só mostram imagens a leitores conectados. Os cookies vão só para o servidor de imagens, nunca para a IA.",
    apiHeading: "Endpoint de IA",
    engineHeading: "Mecanismo de tradução",
    siteHeading: "Este site",
    checking: "Verificando…",
    model: (model: string): string => `Modelo: ${model}`,
    endpoint: (url: string): string => `Endpoint: ${url}`,
    cause: (cause: string): string => `Detalhes: ${cause}`,
    engineStopped: "O mecanismo está ocioso e começa a funcionar quando você traduz.",
    engineUnreadable: "Não foi possível ler o status do mecanismo.",
    offlineHeading: "Modo offline (experimental)",
    offlineHint:
      "Nenhum endpoint de IA é usado: o reconhecimento de texto e a tradução rodam neste dispositivo.",
    offlineDownload: (doneMb: number, totalMb: number): string =>
      `Baixando ${Math.round(doneMb)} de ${Math.round(totalMb)} MB`,
    offlineModels: (models: string): string => `Modelos: ${models}`,
    detectorLine: (backend: string, state: string, canary: string): string =>
      `Detecção de texto: ${backend}, ${state}${canary === "" ? "" : ` (${canary})`}`,
    queueLine: (queued: number, inFlight: number, done: number, failed: number): string =>
      `Fila: ${queued} aguardando · ${inFlight} enviando · ${done} concluídos · ${failed} com falha`,
    pausedBy: (title: string): string => `Em pausa: ${title}`,
    siteUnsupported: "Esta página não pode ser traduzida (apenas páginas http/https).",
    siteOn: "A tradução está ativada neste site.",
    siteOff: "A tradução está desativada neste site.",
    modeLabel: "Modo",
    visibleSent: (count: number): string =>
      count > 0
        ? `${count} ${plural(count, "imagem enviada", "imagens enviadas")} para tradução.`
        : "Nenhuma imagem de quadrinhos visível.",
    visibleUnavailable: "A extensão não pode ser executada nesta página.",
    retranslatePage: "Traduzir a página novamente",
    retranslateQueued: (count: number): string =>
      `${count} ${plural(count, "balão colocado", "balões colocados")} de novo na fila.`,
    actionFailed: (title: string): string => `Não foi possível concluir a ação: ${title}`,
    privacyDetails: "Ver o que é enviado",
    options: "Opções",
    setupHint: "Configure seu endpoint de IA (URL base, chave de API, modelo) em Opções para começar.",
    consentHint:
      "Clique no ícone do Panelingo para ler o aviso de privacidade antes de ativar a tradução aqui.",
    build: (id: string): string => `Compilação ${id}`,
  },
  options: {
    exportLog: "Exportar o log de depuração",
    exportFailed: "Não foi possível exportar o log de depuração.",
    exportEmpty: "O log de depuração está vazio.",
    title: "Opções",
    apiHeading: "Endpoint de IA (compatível com OpenAI)",
    apiIntro:
      "Funciona com qualquer serviço que use a API de chat completions da OpenAI e aceite imagens: OpenAI, " +
      "OpenRouter, Azure OpenAI, Google Gemini (modo OpenAI) ou um servidor local como Ollama, LM Studio, vLLM ou " +
      "LiteLLM.",
    preset: "Predefinição",
    presetCustom: "Personalizada",
    baseUrl: "URL base",
    baseUrlHint:
      "Inclua o caminho da versão, por exemplo https://api.openai.com/v1 ou http://127.0.0.1:11434/v1.",
    baseUrlInvalid: "URL http(s) inválida.",
    apiKey: "Chave de API",
    apiKeyHint:
      "Armazenada apenas neste perfil do navegador; deixe em branco para servidores locais que não precisam de chave.",
    model: "Modelo",
    modelHint:
      "O modelo precisa aceitar imagens como entrada (visão), por exemplo gpt-4o-mini, gemini-2.5-flash, qwen2.5-vl.",
    modelInvalid: "Insira o ID de um modelo.",
    testConnection: "Testar conexão",
    testing: "Testando…",
    testOk: (detail: string): string => `Conectado. ${detail}`,
    testFailed: (detail: string): string => `Falha: ${detail}`,
    concurrency: "Solicitações de tradução em paralelo",
    concurrencyHint: "Padrão: 2; máximo: 4. Diminua se o seu provedor limitar a taxa de solicitações.",
    concurrencyInvalid: "Escolha um número de 1 a 4.",
    languageHeading: "Idiomas",
    uiLanguage: "Idioma da interface",
    targetLanguage: "Traduzir para",
    languageAuto: "Igual ao navegador",
    save: "Salvar",
    saved: "Salvo.",
    saveFailed: "Não foi possível salvar.",
    sitesHeading: "Sites",
    sitesEmpty:
      "Nenhum site ainda. Abra uma página de quadrinhos, clique no ícone da extensão e ative a tradução nela.",
    siteEnabled: "Ativado",
    siteMode: "Modo",
    siteRemove: "Remover",
    privacyHeading: "Privacidade: o que é enviado para a IA",
    privacyPoints: [
      "Em cada tradução, a extensão envia uma única imagem composta em JPEG para o endpoint de IA configurado: " +
        "miniaturas das imagens (ou fatias de webtoon) que contêm texto, caixas numeradas em volta de cada área de " +
        "texto e recortes ampliados dessas áreas.",
      "Também é enviado texto: regras de formatação e idioma, o glossário da série (até 60 entradas), até 20 " +
        "falas anteriores do mesmo capítulo e um breve resumo.",
      "Nunca são enviados: imagens sem texto, o endereço da página que você lê, cookies, seu endereço IP ou " +
        "cabeçalhos do navegador (além do que qualquer solicitação ao seu endpoint já inclui).",
      "O provedor de IA pode guardar o que recebe de acordo com os próprios termos. Considere que tudo o que foi " +
        "enviado fica armazenado.",
      "Somente os sites que você ativar são traduzidos enquanto você rola a página. As outras páginas só são " +
        "traduzidas quando você pede (menu de contexto ou atalho de teclado), e a extensão sempre pergunta antes do " +
        "primeiro envio.",
      "O pop-up mostra quantas imagens compostas foram enviadas hoje.",
      "Neste dispositivo, as traduções, as posições dos balões e as camadas de apagamento ficam no IndexedDB da " +
        "extensão; você pode limpá-las em Cache, logo abaixo.",
    ],
    privacyAcked: (when: string): string => `Você confirmou o aviso de envio de imagens em ${when}.`,
    privacyNotAcked:
      "Você ainda não confirmou o aviso de envio de imagens; a extensão pergunta antes do primeiro envio.",
    cacheHeading: "Cache",
    cacheHint:
      "Exclui todas as traduções, posições de balões e camadas de apagamento armazenadas neste dispositivo. Ao ler " +
      "de novo, tudo será traduzido (e as imagens serão enviadas) outra vez.",
    cacheClear: "Limpar todo o cache",
    cacheConfirm:
      "Limpar todo o cache? Na próxima leitura, as imagens serão traduzidas e enviadas novamente.",
    cacheCleared: (count: number): string =>
      `${count} ${plural(count, "registro excluído", "registros excluídos")}.`,
    cacheFailed: (title: string): string => `Não foi possível limpar o cache: ${title}`,
    debugHeading: "Log de depuração",
    logLevel: "Nível de log",
    logLevels: {
      debug: "Detalhado (debug)",
      info: "Informações",
      warn: "Avisos",
      error: "Somente erros",
    },
  },
  optionsAdvanced: {
    heading: "Configurações avançadas",
    intro:
      "Ajustes finos para solicitações, detecção de texto, letreiramento e caches. Os padrões servem para a " +
      "maioria dos usos. Cada alteração é salva quando você sai do campo.",
    defaultIs: (value: string): string => `Padrão: ${value}`,
    range: (min: string, max: string): string => `Intervalo permitido: de ${min} a ${max}`,
    automatic: "automático",
    on: "ativado",
    off: "desativado",
    reset: "Redefinir",
    resetLabel: (label: string): string => `Redefinir “${label}” para o padrão`,
    resetAll: "Redefinir todas as configurações avançadas",
    resetAllConfirm: "Redefinir todas as configurações avançadas para o padrão?",
    resetAllDone: "Todas as configurações avançadas voltaram ao padrão.",
    notANumber: "Insira um número.",
    adjusted: (value: string): string => `Salvo como ${value}, o valor permitido mais próximo.`,
    badKey: "Use um código de tecla como Backquote ou KeyH, ou deixe em branco.",
    verticalChoices: { auto: "Automático", never: "Nunca" },
    groups: {
      api: "Solicitações à IA",
      translate: "Conteúdo das solicitações",
      detector: "Detecção de texto",
      engine: "Mecanismo",
      discovery: "Busca de imagens",
      render: "Letreiramento",
      memory: "Memória da série",
      cache: "Cache",
      privacy: "Limites de imagem",
      debug: "Log de depuração",
    },
    fields: {
      "api.temperature": {
        label: "Temperatura",
        hint: "O quanto as respostas variam. Deixe em branco para usar o padrão do provedor.",
      },
      "api.urgentLane": {
        label: "Canal extra para imagens na tela",
        hint: "Adiciona um canal de solicitações reservado às imagens que você está vendo.",
      },
      "api.maxInFlight": {
        label: "Máximo de solicitações simultâneas",
        hint: "Limite rígido, canal extra incluído. Nunca menor que as solicitações de tradução em paralelo.",
      },
      "api.firstByteTimeoutMs": {
        label: "Espera pela primeira resposta (segundos)",
        hint: "Desiste se o endpoint não enviar nada por esse tempo.",
      },
      "api.idleTimeoutMs": {
        label: "Tempo limite de resposta parada (segundos)",
        hint: "Desiste se uma resposta parar de ser transmitida por esse tempo.",
      },
      "api.totalTimeoutMs": {
        label: "Tempo máximo de solicitação (segundos)",
        hint: "Desiste de qualquer solicitação após esse tempo.",
      },
      "api.healthTimeoutMs": {
        label: "Tempo limite da verificação de conexão (segundos)",
        hint: "Usado na verificação do endpoint e em “Testar conexão”.",
      },
      "translate.boxBudget": {
        label: "Áreas de texto por solicitação",
        hint: "Deixe em branco para usar o perfil do modelo (12, 16 ou 20).",
      },
      "translate.packWaitMs": {
        label: "Espera para agrupar imagens (ms)",
        hint: "Quanto o texto de uma imagem espera as próximas imagens da página para compartilhar uma solicitação. 0 envia cada imagem na hora.",
      },
      "translate.urgentPackMax": {
        label: "Balões na primeira solicitação na tela",
        hint: "A primeira solicitação de uma imagem na tela leva no máximo esta quantidade de balões, para que apareçam antes. 0 = sem limite próprio.",
      },
      "translate.jpegQuality": {
        label: "Qualidade JPEG",
        hint: "Qualidade da imagem composta enviada para a IA.",
      },
      "translate.requestBodyCapMb": {
        label: "Tamanho máximo da solicitação (MB)",
        hint: "Imagens compostas maiores são mais comprimidas e depois divididas.",
      },
      "translate.promptCharCap": {
        label: "Tamanho máximo do prompt (caracteres)",
        hint: "Quando uma solicitação é mais longa, o contexto é encurtado primeiro.",
      },
      "translate.maxLadderRequestsPerPack": {
        label: "Solicitações extras para recuperar texto perdido",
        hint: "Pergunta de novo e divide a solicitação quando a IA pula áreas de texto.",
      },
      "translate.maxHttpRetriesPerRequest": {
        label: "Novas tentativas após erros de rede",
        hint: "Por solicitação, para falhas temporárias de HTTP e de rede.",
      },
      "translate.engine": {
        label: "Mecanismo de tradução",
        hint: "O modo offline é experimental: veja Modo offline mais acima.",
      },
      "translate.offlineModel": {
        label: "Modelo de tradução offline",
        hint: "Usado apenas no modo offline.",
      },
      "translate.splitOnRefusal": {
        label: "Dividir solicitações recusadas",
        hint: "Quando a IA se recusa, tenta as duas metades separadamente em vez de desistir.",
      },
      "detector.backend": {
        label: "Hardware de detecção",
        hint: "Automático usa a GPU quando ela passa em um autoteste; caso contrário, a CPU.",
      },
      "detector.scoreMin": {
        label: "Pontuação mínima de detecção",
        hint: "Valores menores encontram mais texto, e também mais falsos positivos.",
      },
      "detector.sliceTriggerRatio": {
        label: "Fatiar imagens mais longas que (proporção)",
        hint: "Imagens e tiras de webtoon cujo lado maior excede este múltiplo do lado menor são cortadas em fatias.",
      },
      "detector.sliceHeightRatio": {
        label: "Comprimento da fatia (× lado menor)",
        hint: "Comprimento de cada fatia como múltiplo do lado menor da imagem.",
      },
      "detector.sliceOverlap": {
        label: "Sobreposição das fatias (fração)",
        hint: "Sobreposição entre fatias vizinhas, como fração de uma fatia.",
      },
      "detector.sliceOverlapMinPx": {
        label: "Sobreposição mínima das fatias (pixels)",
        hint: "Fatias vizinhas sempre compartilham pelo menos essa quantidade de pixels.",
      },
      "detector.quietRows": {
        label: "Cortar fatias entre linhas de texto",
        hint: "Experimental: move os cortes das fatias para linhas sem tinta.",
      },
      "engine.idleCloseMin": {
        label: "Fechar o mecanismo ocioso após (minutos)",
        hint: "Libera memória quando nenhuma página usa o mecanismo por esse tempo.",
      },
      "engine.detectorReleaseMin": {
        label: "Descarregar a detecção de texto após (minutos)",
        hint: "Libera da memória o modelo de detecção quando ele não é usado por esse tempo.",
      },
      "engine.portIdleMin": {
        label: "Desconectar páginas ociosas após (minutos)",
        hint: "Uma página se desconecta do mecanismo após esse tempo sem atividade.",
      },
      "discovery.minNaturalSide": {
        label: "Ignorar imagens menores que (pixels)",
        hint: "Tamanho real do lado menor. Pula ícones, avatares e anúncios.",
      },
      "discovery.minDisplayedSide": {
        label: "Ignorar imagens exibidas menores que (pixels)",
        hint: "Tamanho na tela do lado menor.",
      },
      "discovery.secondsPerScreenDefault": {
        label: "Velocidade de leitura inicial (segundos por tela)",
        hint: "Estimativa inicial até que sua velocidade de leitura seja medida.",
      },
      "discovery.lookaheadMinScreens": {
        label: "Tradução antecipada, mínimo (telas)",
        hint: "Imagens a esta distância abaixo da visualização são sempre traduzidas antes de você chegar.",
      },
      "discovery.lookaheadMaxScreens": {
        label: "Tradução antecipada, máximo (telas)",
        hint: "Limite superior quando você lê rápido ou a IA está lenta.",
      },
      "discovery.lookaheadMaxScreensStrip": {
        label: "Tradução antecipada em tiras webtoon, máximo (telas)",
        hint: "Limite superior para tiras verticais longas.",
      },
      "discovery.detectAheadMinScreens": {
        label: "Detecção antecipada, mínimo (telas)",
        hint: "Imagens que a página ainda não carregou são detectadas com esta antecedência (sem envio).",
      },
      "discovery.detectAheadMaxScreens": {
        label: "Detecção antecipada, máximo (telas)",
        hint: "Limite superior para quem lê rápido.",
      },
      "discovery.detectMaxImages": {
        label: "Imagens detectadas antecipadamente, no máximo",
        hint: "Conta cada imagem à sua frente, carregada ou não.",
      },
      "discovery.fetchPerHostConcurrency": {
        label: "Downloads de imagens em paralelo por servidor",
        hint: "Downloads simultâneos do mesmo servidor de imagens.",
      },
      "discovery.prefetchSpacingMs": {
        label: "Pausa entre downloads de imagens (ms)",
        hint: "Tempo mínimo entre dois downloads do mesmo servidor.",
      },
      "discovery.scrollDebounceMs": {
        label: "Atraso de reação à rolagem (ms)",
        hint: "Espera esse tempo após a rolagem antes de reordenar o trabalho.",
      },
      "discovery.mutationDebounceMs": {
        label: "Atraso de reação a mudanças na página (ms)",
        hint: "Espera esse tempo após a página mudar (carregamento sob demanda, apps de leitura) antes de procurar novas imagens.",
      },
      "discovery.stripGapPx": {
        label: "Espaço máximo dentro de uma tira de webtoon (pixels)",
        hint: "Imagens mais próximas que isso formam uma única tira contínua.",
      },
      "discovery.translateHiddenTabs": {
        label: "Traduzir em abas em segundo plano",
        hint: "Desativado: o modo automático espera até a aba ser exibida.",
      },
      "render.font": {
        label: "Fonte dos diálogos",
        hint: "Fonte do texto traduzido nos balões de fala.",
      },
      "render.verticalText": {
        label: "Letreiramento vertical",
        hint: "Traduções para japonês ou chinês tradicional são escritas de cima para baixo em balões verticais. “Nunca” deixa todas as traduções na horizontal.",
      },
      "render.minFontPx": {
        label: "Menor tamanho de texto (pixels)",
        hint: "O texto que não cabe nesse tamanho é encurtado com “…”.",
      },
      "render.maxFontPx": {
        label: "Maior tamanho de texto (pixels)",
        hint: "O texto também fica próximo do tamanho do letreiramento original.",
      },
      "render.eraseSfx": {
        label: "Apagar onomatopeias",
        hint: "Remove as onomatopeias da imagem em vez de rotulá-las.",
      },
      "render.sfxLabels": {
        label: "Rotular onomatopeias",
        hint: "Mostra a tradução das onomatopeias em pequenos rótulos.",
      },
      "render.showDoneBadge": {
        label: "Marcar imagens traduzidas",
        hint: "Mostra um pequeno selo em cada imagem traduzida.",
      },
      "render.peekKey": {
        label: "Segurar para ver o original (código de tecla)",
        hint: "Um código de tecla como Backquote ou KeyH. Deixe em branco para desativar.",
      },
      "render.peekWithAlt": {
        label: "Também mostrar o original enquanto Alt estiver pressionada",
        hint: "Segurar só a tecla Alt também oculta a tradução.",
      },
      "render.popupWithAltClick": {
        label: "Alt+clique abre a janela do balão",
        hint: "A janela mostra o original e permite editar a tradução. Um toque longo sempre a abre.",
      },
      "memory.enabled": {
        label: "Usar a memória da série",
        hint: "Envia o glossário, falas anteriores e um resumo da história em cada solicitação, e aprende nomes com as respostas.",
      },
      "memory.glossaryInPrompt": {
        label: "Entradas do glossário por solicitação",
        hint: "Primeiro as suas entradas, depois as confirmadas e então as aprendidas.",
      },
      "memory.termMinSightings": {
        label: "Ocorrências antes de aprender um termo",
        hint: "Solicitações diferentes que precisam citar um termo antes que ele seja enviado.",
      },
      "memory.historyMaxLines": {
        label: "Falas anteriores enviadas como contexto",
        hint: "Falas do mesmo capítulo. 0 não envia nenhuma.",
      },
      "memory.historyMaxTokens": {
        label: "Orçamento de tokens para falas anteriores",
        hint: "As falas mais antigas são descartadas primeiro.",
      },
      "memory.summaryMaxWords": {
        label: "Tamanho do resumo da história (palavras)",
        hint: "0 desativa o resumo contínuo.",
      },
      "cache.translationTtlDays": {
        label: "Manter traduções não usadas por (dias)",
        hint: "Suas próprias edições nunca expiram.",
      },
      "cache.encodedBytesLruMb": {
        label: "Cache de imagens baixadas (MB)",
        hint: "Memória que o mecanismo usa para guardar imagens baixadas.",
      },
      "privacy.maxImageBytes": {
        label: "Tamanho máximo do arquivo de imagem (MiB)",
        hint: "Arquivos de imagem maiores são ignorados.",
      },
      "privacy.maxImagePixels": {
        label: "Resolução máxima da imagem (megapixels)",
        hint: "Imagens com mais pixels são ignoradas.",
      },
      "debug.logCapacity": {
        label: "Entradas mantidas no log",
        hint: "Tamanho do log de depuração que o mecanismo armazena.",
      },
    },
    site: {
      settings: "Configurações",
      settingsFor: (site: string): string => `Configurações de ${site}`,
      layout: "Layout e sentido de leitura",
      layouts: {
        auto: "Detectar automaticamente",
        webtoon: "Webtoon (tira vertical)",
        "paged-rtl": "Páginas, da direita para a esquerda (mangá)",
        "paged-ltr": "Páginas, da esquerda para a direita (quadrinhos)",
      },
      sourceLangHint:
        "Seleciona as instruções específicas do idioma para a IA e o quanto os recortes de texto são ampliados.",
      referer: "Referer para downloads de imagens",
      referers: {
        auto: "Automático",
        "page-url": "Endereço completo da página",
        origin: "Apenas o endereço do site",
      },
      refererHint:
        "Automático segue a página e, se o servidor de imagens recusar, tenta de novo com o endereço completo da " +
        "página. Altere só quando as imagens não carregarem.",
      subdomains: "Também em subdomínios",
      subdomainsHint: "Traduzir em todos os subdomínios deste site com as mesmas configurações.",
      prefetch: "Preparar imagens com antecedência",
      prefetchHint:
        "Detecta imagens abaixo da visualização que a página ainda não carregou, para que estejam prontas quando você chegar. Nada é enviado até que estejam perto.",
      frames: "Frames de leitores de outros sites",
      framesHint:
        "Uma origem por linha, por exemplo https://viewer.example.com, quando as páginas são exibidas dentro de " +
        "um frame servido por outro site.",
      framesInvalid: (lines: string): string => `Não é uma origem http(s): ${lines}`,
    },
    transfer: {
      heading: "Backup e restauração",
      hint:
        "Salve suas configurações e sua lista de sites em um arquivo JSON, ou carregue-as a partir de um. A " +
        "confirmação de privacidade nunca é exportada.",
      includeKey: "Incluir a chave de API",
      includeKeyHint:
        "Deixe desativado antes de compartilhar o arquivo: qualquer pessoa poderia ler a chave nele.",
      export: "Exportar configurações",
      import: "Importar configurações",
      importConfirm:
        "Substituir suas configurações pelas do arquivo? Os sites do arquivo serão adicionados ou atualizados.",
      notJson: "Este arquivo não é um JSON válido.",
      notSettings: "Este arquivo não é uma exportação de configurações do Panelingo.",
      tooNew: "Este arquivo foi criado por uma versão mais recente do Panelingo.",
      imported: (settings: number, sites: number): string =>
        `Importado. Configurações alteradas: ${settings}. Sites: ${sites}.`,
      keyImported: "A chave de API do arquivo foi importada.",
      keyKept: "Sua chave de API foi mantida (o arquivo não tem nenhuma).",
    },
  },
  offline: {
    heading: "Modo offline (experimental)",
    intro:
      "Traduza sem nenhum endpoint de IA: modelos de código aberto de reconhecimento de texto (PaddleOCR) e de tradução rodam neste dispositivo. A qualidade é bem inferior à de um modelo de visão: sem contexto entre os balões, sem nomes de personagens, letreiros estilizados costumam ser lidos errado e efeitos sonoros ficam sem tradução.",
    download:
      "Os modelos são baixados uma única vez do Hugging Face quando necessários, verificados e mantidos neste dispositivo; depois disso, a tradução não precisa de rede. Tamanhos: reconhecimento de texto de 8 a 17 MB por idioma, Opus-MT cerca de 115 MB por par de idiomas (o dobro passando pelo inglês), NLLB-200 cerca de 910 MB.",
    engine: "Mecanismo de tradução",
    engineChoices: {
      api: "Endpoint de IA (compatível com OpenAI)",
      offline: "Offline neste dispositivo (experimental)",
    },
    model: "Modelo de tradução offline",
    modelChoices: {
      "opus-mt": "Opus-MT: pequeno, um modelo por par de idiomas",
      "nllb-600m": "NLLB-200 600M: todos os pares, grande, não comercial",
    },
    pairs:
      "O Opus-MT traduz coreano, japonês, chinês e espanhol para o inglês, e o inglês para vietnamita, espanhol, francês, alemão, italiano e indonésio; os outros pares passam pelo inglês. O NLLB-200 traduz entre todos os idiomas listados aqui.",
    license:
      "Licenças: PaddleOCR e a maioria dos modelos Opus-MT Apache-2.0, dois modelos Opus-MT CC-BY-4.0, NLLB-200 CC-BY-NC-4.0 (somente uso não comercial).",
    stored: (mb: number): string => `Modelos baixados neste dispositivo: ${Math.round(mb)} MB`,
    deleteModels: "Excluir os modelos baixados",
    deleteConfirm: "Excluir os modelos offline baixados? Eles serão baixados de novo quando necessário.",
    deleted: "Os modelos baixados foram excluídos.",
  },
  manifest: {
    description:
      "Traduza quadrinhos, mangás e webtoons na própria página enquanto lê, com qualquer IA compatível com OpenAI.",
    commands: {
      "toggle-overlay": "Mostrar ou ocultar a camada de tradução",
      "translate-visible": "Traduzir imagens visíveis",
      "toggle-site": "Ativar ou desativar a tradução automática neste site",
      "open-side-panel": "Abrir o painel lateral de transcrição",
    },
  },
};
