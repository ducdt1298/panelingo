// Japanese UI catalog. PURE.

import type { Catalog } from "./en.ts";

const errors: Catalog["errors"] = {
  "api.unreachable": {
    title: "AIエンドポイントに接続できません",
    hint: "オプションのベースURLが正しいか、サーバー（またはローカルモデル）が起動しているかを確認してください。",
  },
  "api.lna_blocked": {
    title: "ChromeがローカルAIサーバーへの接続をブロックしました",
    hint: "拡張機能の「サイトの設定」→「ローカル ネットワークへのアクセス（Local network access）」→「許可」を選択してください。",
  },
  "api.unauthorized": {
    title: "AIエンドポイントがAPIキーを拒否しました",
    hint: "オプションで有効なAPIキーを入力してください。翻訳は自動的に再開されます。",
  },
  "api.config": {
    title: "AIエンドポイントまたはモデルの設定が正しくありません",
    hint: "オプションでベースURLを確認し、画像入力（Vision）に対応したモデルを選んでください。",
  },
  "api.rate_limit": {
    title: "AIプロバイダーがリクエスト数を制限しています",
    hint: "拡張機能が自動的に間隔を空けて再試行します。",
  },
  "api.upstream": { title: "AIサーバーエラーのため再試行中", hint: "" },
  "api.context_length": { title: "リクエストが長すぎるため分割中", hint: "" },
  "api.timeout": { title: "AIの応答に時間がかかりすぎました", hint: "拡張機能がもう一度だけ再試行します。" },
  "api.truncated": { title: "応答が途中で切れたため続きを取得中", hint: "" },
  "api.partial": { title: "AIが一部の吹き出しを飛ばしたため再リクエスト中", hint: "" },
  "api.empty": { title: "AIの応答が空のため再試行中", hint: "" },
  "api.too_large": { title: "送信する画像が大きすぎるため縮小中", hint: "" },
  "api.bad_request": {
    title: "リクエストが拒否されました（不具合）",
    hint: "オプションからデバッグログをエクスポートしてください。",
  },
  "api.protocol": { title: "AIエンドポイントの応答形式が想定外です", hint: "" },
  "llm.refused": { title: "AIが翻訳を拒否しました", hint: "この吹き出しは原文のまま表示されます。" },
  "llm.missing": { title: "未翻訳", hint: "「再翻訳」で、この吹き出しだけを翻訳し直せます。" },
  "llm.format": { title: "AIの応答形式が不正なため再試行中", hint: "" },
  "image.url_blocked": { title: "安全のため画像をブロックしました", hint: "" },
  "image.http": {
    title: "画像を読み込めませんでした",
    hint: "サイトへのログインが必要な場合は、ポップアップで「画像リクエストでCookieを送信」をオンにしてください。",
  },
  "image.not_image": { title: "画像ファイルではありません", hint: "" },
  "image.too_large": { title: "画像が大きすぎます", hint: "" },
  "image.decode": { title: "画像をデコードできませんでした", hint: "" },
  "image.capture_unavailable": { title: "翻訳するには画像までスクロールしてください", hint: "" },
  "image.capture_blocked": {
    title: "この画像は画面キャプチャでしか読み取れません",
    hint: "このサイトの翻訳をオンにし、このタブを前面に表示したまま再試行してください。",
  },
  "detector.webgpu_unavailable": { title: "CPUでテキストを検出中（低速）", hint: "" },
  "detector.canary_mismatch": { title: "GPUの結果に不整合があるためCPUを使用中", hint: "" },
  "detector.model_integrity": {
    title: "テキスト検出モデルが破損しています",
    hint: "拡張機能を再インストールしてください（開発者向け：「npm run fetch-models」を実行してから「npm run build」）。",
  },
  "detector.init": {
    title: "テキスト検出を開始できませんでした",
    hint: "オプションからデバッグログをエクスポートしてください。",
  },
  "detector.run": { title: "テキスト検出に失敗しました", hint: "" },
  "offline.pair_unsupported": {
    title: "この言語の組み合わせはオフラインでは利用できません",
    hint: "オプションでオフラインモデルに NLLB-200 を選ぶか、別の翻訳先言語を選んでください。",
  },
  "offline.download": {
    title: "オフラインモデルをダウンロードできませんでした",
    hint: "huggingface.co への接続を確認してください。翻訳は自動で再試行されます。",
  },
  "offline.model_integrity": {
    title: "ダウンロードしたオフラインモデルが破損しています",
    hint: "もう一度翻訳すると、再ダウンロードされます。",
  },
  "offline.run": {
    title: "オフラインモデルでエラーが発生しました",
    hint: "オプションからデバッグログをエクスポートしてください。",
  },
  "offline.out_of_memory": {
    title: "オフラインモデルのメモリが不足しています",
    hint: "翻訳モデルを再起動しました。エンジンは動作を続けています。オプションで Opus-MT（はるかに小さいモデル）を選ぶか、ほかのタブを閉じてください。",
  },
  "engine.unavailable": {
    title: "翻訳エンジンを起動できませんでした",
    hint: "ページを再読み込みするか、拡張機能をオフにしてから再度オンにしてください。",
  },
  "engine.closing": { title: "翻訳エンジンを再起動中", hint: "" },
  "engine.overloaded": { title: "翻訳エンジンが混み合っています", hint: "" },
  "engine.protocol": {
    title: "拡張機能のバージョンが一致しません",
    hint: "ページを再読み込みしてください。",
  },
  "engine.internal": { title: "内部エラー", hint: "オプションからデバッグログをエクスポートしてください。" },
  "msg.too_large": { title: "データが大きすぎるためURLから再読み込み中", hint: "" },
  "ctx.invalidated": {
    title: "拡張機能が再読み込みされました",
    hint: "翻訳を続けるには、ページを再読み込みしてください。",
  },
  "dnr.failed": { title: "画像のRefererを設定できませんでした", hint: "" },
  "store.io": { title: "キャッシュの読み書きに失敗しました", hint: "" },
  "store.quota": {
    title: "キャッシュがいっぱいです",
    hint: "オプションでキャッシュを削除して空き容量を確保してください。",
  },
  "site.disabled": { title: "このサイトでは翻訳がオフです", hint: "" },
  "privacy.consent": {
    title: "AIへの画像送信がまだ許可されていません",
    hint: "プライバシーに関するお知らせを読み、送信を許可すると翻訳が始まります。",
  },
  cancelled: { title: "キャンセルしました", hint: "" },
};

export const JA: Catalog = {
  errors,
  readiness: {
    unknown: { label: "AIエンドポイントを確認中…", hint: "" },
    ready: { label: "AIエンドポイントの準備完了", hint: "" },
    unauthorized: { label: "APIキーが拒否されました", hint: errors["api.unauthorized"].hint },
    unreachable: { label: "AIエンドポイントに接続できません", hint: errors["api.unreachable"].hint },
    lna_blocked: {
      label: "ChromeがローカルAIサーバーをブロックしました",
      hint: errors["api.lna_blocked"].hint,
    },
    misconfigured: { label: "AIエンドポイントが未設定です", hint: errors["api.config"].hint },
  },
  imageState: {
    queued: "待機中",
    acquiring: "画像を読み込み中",
    detecting: "テキストを検出中",
    waiting: "翻訳待ち",
    translating: "翻訳中",
    done: "翻訳済み",
    "no-text": "テキストなし",
    partial: "一部のみ翻訳済み",
    refused: "AIが翻訳を拒否",
    paused: "一時停止中",
    error: "エラー",
    stale: "古い翻訳",
  },
  unitStatus: {
    pending: "待機中",
    translating: "翻訳中",
    ok: "翻訳済み",
    "keep-original": "原文のまま",
    manual: "編集済み",
    untranslated: "未翻訳",
    refused: "AIが翻訳を拒否",
    ignored: "対象外",
    error: "エラー",
    stale: "古い翻訳",
  },
  enginePhase: {
    booting: "翻訳エンジンを起動中",
    ready: "翻訳エンジン稼働中",
    closing: "翻訳エンジンを停止中",
    failed: "翻訳エンジンでエラーが発生",
  },
  detectorBackend: { webgpu: "GPU（WebGPU）", wasm: "CPU（WASM）", none: "未選択" },
  detectorState: { unloaded: "未読み込み", loading: "読み込み中", ready: "準備完了", failed: "失敗" },
  detectorCanary: {
    pass: "GPU検証済み",
    fail: "GPUの結果に不整合があったためCPUに切り替え済み",
    pending: "GPUを検証中",
    skipped: "",
  },
  offlineState: {
    idle: "モデルは初回使用時に読み込まれます",
    downloading: "モデルをダウンロード中",
    loading: "モデルを読み込み中",
    ready: "準備完了",
    failed: "失敗",
  },
  ui: {
    appName: "Panelingo",
    siteEnable: "このサイトを翻訳",
    siteDisable: "このサイトの翻訳を停止",
    modeAuto: "スクロールに合わせて自動翻訳",
    modeManual: "手動でのみ翻訳",
    translateVisible: "表示中の画像を翻訳",
    translateImage: "翻訳",
    retranslate: "再翻訳",
    showOriginal: "原文を表示",
    uploadsToday: (count: number, mb: number): string =>
      `今日AIに送信した合成画像：${count}枚（${mb.toFixed(1)} MB）`,
    progress: (done: number, total: number, etaSec?: number): string =>
      etaSec === undefined || !Number.isFinite(etaSec)
        ? `翻訳中（${done}/${total}）`
        : `翻訳中（${done}/${total}、残り約${Math.max(1, Math.round(etaSec))}秒）`,
    privacyTitle: "AIに画像を送信する前に",
    privacyBody:
      "翻訳のため、拡張機能はテキストを含むマンガのコマの合成画像を、設定したAIエンドポイントに送信します（有効にした" +
      "サイトを閲覧しているとき、または翻訳を指示したときのみ）。AIプロバイダーは、受け取った内容を独自の規約に従って" +
      "保存することがあります。ご自身にとっても、読んでいるコンテンツにとっても問題がないかをご確認ください。",
    privacyAccept: "理解したうえで送信を許可",
    privacyDecline: "送信しない",
  },
  bubble: {
    original: "原文",
    translation: "訳文",
    save: "保存",
    revert: "AIの翻訳に戻す",
    retranslate: "再翻訳",
    close: "閉じる",
    dialog: "翻訳済みのフキダシ",
    copy: "コピー",
    editLabel: "訳文を編集",
    shortened: "フキダシに収まるよう文字を短くしました。",
    saved: "保存しました。",
    retranslating: "再翻訳しています…",
  },
  menu: {
    translateImage: "この画像を翻訳",
    retranslateImage: "この画像を再翻訳",
  },
  sidepanel: {
    title: "Panelingo – セリフ一覧",
    heading: "セリフ一覧",
    empty: "このタブにはまだ翻訳されたセリフがありません。",
    emptyHint: "有効にしたサイトで漫画のページを開いてください。翻訳されたセリフが順にここに表示されます。",
    refresh: "更新",
    copy: "すべてコピー",
    copied: "クリップボードにコピーしました。",
    page: (n: number): string => `${n} ページ`,
    jump: "表示",
    jumpHint: "このフキダシまでページをスクロール",
    edit: "編集",
    save: "保存",
    cancel: "キャンセル",
    retranslate: "再翻訳",
    revert: "編集を取り消す",
    noTranslation: "翻訳なし",
    notFound: "このフキダシはもうページにありません。",
    failed: "うまくいきませんでした。もう一度お試しください。",
    types: {
      dialogue: "セリフ",
      thought: "心の声",
      narration: "ナレーション",
      sign: "看板",
      sfx: "効果音",
      ignore: "無視",
    },
    inconsistent: "用語集と異なります",
    tabs: { transcript: "セリフ一覧", glossary: "用語集" },
    glossary: {
      noSeries: "マンガのページを開くと、そのシリーズの用語集が表示されます。",
      untitled: "無題のシリーズ",
      states: {
        manual: "あなたの登録",
        confirmed: "確認済み",
        learned: "学習済み",
        candidate: "候補",
      },
      hints: {
        manual: "常に使われます。AI が変更することはありません。",
        confirmed: "承認した候補です。常に使われます。",
        learned: "AI が複数のリクエストで使った名前や用語です。毎回のリクエストで送信されます。",
        candidate: "AI が一度だけ見つけたものです。確認するか再び現れるまで送信されません。",
      },
      empty:
        "まだ登録はありません。AI が見つけた名前や用語がここに表示されます。自分で追加することもできます。",
      original: "原文",
      translation: "翻訳",
      note: "メモ（任意）",
      add: "追加",
      delete: "削除",
      confirm: "確認",
      seen: (count: number): string => `${count} 回出現`,
      incomplete: "原文と翻訳を入力してください。",
      profileHeading: "シリーズの設定",
      sourceLang: "原文の言語",
      langAuto: "自動検出",
      langs: {
        ja: "日本語",
        ko: "韓国語",
        zh: "中国語",
        en: "英語",
        es: "スペイン語",
        other: "その他",
      },
      koNames: "韓国語の名前",
      koRomanized: "ローマ字表記（Minjun）",
      koHanViet: "漢越音（ベトナム語訳のみ）",
      keepHonorifics: "日本語の敬称を残す（-san, -kun）",
      summary: "あらすじを随時送信する",
      saveProfile: "設定を保存",
      saved: "保存しました。",
      export: "エクスポート",
      import: "インポート",
      imported: (count: number): string => `${count} 件を読み込みました。`,
      importFailed: "このファイルは Panelingo の用語集ではありません。",
      address: {
        heading: "呼び方",
        hint: "各キャラクターが自分と相手をどう呼ぶか。読み進めるうちに AI が記入し、同じ呼び方を保ちます。自分で決めたルールは変更されません。",
        speaker: "話し手",
        listener: "聞き手",
        self: "自分の呼び方",
        other: "相手の呼び方",
        learned: "AI が学習",
        mine: "あなたのルール",
        keep: "固定",
        addHeading: "呼び方を追加",
        incomplete: "2人の名前と、少なくとも1つの呼び方を入力してください。",
        full: "リストがいっぱいです。先にルールを削除してください。",
        empty: "まだありません。AI が見つけた組み合わせがここに表示されます。",
      },
    },
  },
  debug: { heading: "デバッグ（開発・テストビルドのみ）" },
  duration: (ms: number): string => {
    const seconds = Math.round(Math.abs(ms) / 1000);
    if (seconds < 60) return `${seconds}秒`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}分`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}時間`;
    return `${Math.round(hours / 24)}日`;
  },
  popup: {
    siteToggle: "このサイトで翻訳する",
    progressDone: (count: number): string => `完了: このページの画像 ${count} 枚`,
    more: "このサイトのその他の設定",
    siteSettings: "このサイトのすべての設定",
    openTranscript: "セリフ一覧を開く",
    cookies: "画像の読み込み時に Cookie を送信",
    cookiesHint:
      "ログインした読者にだけ画像を表示するサイト向けです。Cookie は画像サーバーにのみ送られ、AI には送られません。",
    engineHeading: "翻訳エンジン",
    siteHeading: "このサイト",
    checking: "確認中…",
    model: (model: string): string => `モデル：${model}`,
    endpoint: (url: string): string => `エンドポイント：${url}`,
    cause: (cause: string): string => `詳細：${cause}`,
    engineStopped: "翻訳エンジンは待機中です。翻訳を始めると起動します。",
    engineUnreadable: "翻訳エンジンの状態を取得できませんでした。",
    offlineHeading: "オフラインモード（試験的）",
    offlineHint: "AIエンドポイントは使いません。文字認識と翻訳はこのデバイス上で行われます。",
    offlineDownload: (doneMb: number, totalMb: number): string =>
      `ダウンロード中 ${Math.round(doneMb)} / ${Math.round(totalMb)} MB`,
    offlineModels: (models: string): string => `モデル：${models}`,
    detectorLine: (backend: string, state: string, canary: string): string =>
      `テキスト検出：${backend}、${state}${canary === "" ? "" : `（${canary}）`}`,
    queueLine: (queued: number, inFlight: number, done: number, failed: number): string =>
      `キュー：待機中${queued}件、送信中${inFlight}件、完了${done}件、失敗${failed}件`,
    pausedBy: (title: string): string => `一時停止中：${title}`,
    siteUnsupported: "このページは翻訳できません（http/httpsのページのみ対応）。",
    modeLabel: "モード",
    visibleSent: (count: number): string =>
      count > 0 ? `${count}枚の画像を翻訳に送りました。` : "表示中のマンガの画像はありません。",
    visibleUnavailable: "このページでは拡張機能を実行できません。",
    retranslatePage: "ページを再翻訳",
    retranslateQueued: (count: number): string => `${count}個の吹き出しを再翻訳のキューに追加しました。`,
    actionFailed: (title: string): string => `実行できませんでした：${title}`,
    privacyDetails: "送信される内容を確認",
    options: "オプション",
    setupHint:
      "使い始めるには、オプションでAIエンドポイント（ベースURL、APIキー、モデル）を設定してください。",
    consentHint:
      "このサイトで翻訳をオンにする前に、Panelingoのアイコンをクリックしてプライバシーに関するお知らせをお読みください。",
    build: (id: string): string => `ビルド：${id}`,
  },
  options: {
    tabs: {
      engine: {
        label: "翻訳エンジン",
        intro: "漫画を何で翻訳するか: 接続した AI モデル、またはこの端末で動く試験的なオフラインモデル。",
      },
      display: { label: "言語と表示", intro: "読む言語、画面の言語、ページ上での翻訳の見え方。" },
      sites: {
        label: "サイト",
        intro:
          "Panelingo が翻訳するサイトです。読んでいるときにツールバーのポップアップからサイトをオンにします。",
      },
      privacy: {
        label: "プライバシーとデータ",
        intro: "AI に送られるもの、この端末に残るもの、設定のバックアップ方法。",
      },
      advanced: {
        label: "詳細",
        intro:
          "リクエスト、文字検出、画像の検出、キャッシュの細かな調整です。ほとんどの場合は既定値で十分です。変更は欄を離れたときに保存されます。",
      },
    },
    controlsHeading: "キーとクリック",
    exportLog: "デバッグログをエクスポート",
    exportFailed: "デバッグログをエクスポートできませんでした。",
    exportEmpty: "デバッグログは空です。",
    title: "オプション",
    apiHeading: "AIエンドポイント（OpenAI互換）",
    apiIntro:
      "OpenAIのChat Completions APIに対応し、画像を受け付けるサービスであれば利用できます。例：OpenAI、OpenRouter、" +
      "Azure OpenAI、Google Gemini（OpenAI互換モード）、またはOllama、LM Studio、vLLM、LiteLLMなどのローカルサーバー。",
    preset: "プリセット",
    presetCustom: "カスタム",
    baseUrl: "ベースURL",
    baseUrlHint:
      "バージョンのパスまで含めて入力します（例：https://api.openai.com/v1、http://127.0.0.1:11434/v1）。",
    baseUrlInvalid: "有効なhttp(s)のURLではありません。",
    apiKey: "APIキー",
    apiKeyHint:
      "このブラウザのプロファイルにのみ保存されます。キーが不要なローカルサーバーでは空欄のままにしてください。",
    model: "モデル",
    modelHint:
      "画像入力（Vision）に対応したモデルが必要です（例：gpt-4o-mini、gemini-2.5-flash、qwen2.5-vl）。",
    modelInvalid: "モデルIDを入力してください。",
    testConnection: "接続テスト",
    testing: "テスト中…",
    testOk: (detail: string): string => `接続できました。${detail}`,
    testFailed: (detail: string): string => `失敗しました：${detail}`,
    concurrency: "翻訳リクエストの同時実行数",
    concurrencyHint: "初期値は2、最大4です。プロバイダーのレート制限にかかる場合は下げてください。",
    concurrencyInvalid: "1〜4の数値を選んでください。",
    languageHeading: "言語",
    uiLanguage: "表示言語",
    targetLanguage: "翻訳先の言語",
    languageAuto: "ブラウザと同じ",
    save: "保存",
    saved: "保存しました。",
    saveFailed: "保存できませんでした。",
    sitesEmpty:
      "まだサイトがありません。マンガのページを開き、拡張機能のアイコンをクリックして、そのサイトの翻訳をオンにしてください。",
    siteEnabled: "有効",
    siteMode: "モード",
    siteRemove: "削除",
    privacyHeading: "プライバシー：AIに送信される内容",
    privacyPoints: [
      "翻訳のたびに、拡張機能は設定したAIエンドポイントに1枚のJPEG合成画像を送信します。内容は、テキストを含む画像" +
        "（またはウェブトゥーンの分割画像）のサムネイル、各テキスト領域を囲む番号付きの枠、それらの領域を切り抜いて拡大した画像です。",
      "あわせて送信されるテキスト：書式と言語に関するルール、作品の用語集（最大60件）、同じ話の直前のセリフ（最大20行）、" +
        "短い要約。",
      "送信しないもの：テキストのない画像、閲覧中のページのアドレス、Cookie、IPアドレス、ブラウザのヘッダー（エンドポイント" +
        "へのリクエストに通常含まれるものを除く）。",
      "AIプロバイダーは、受け取った内容を独自の規約に従って保存することがあります。送信したものはすべて保存されるものと" +
        "お考えください。",
      "スクロール中に自動で翻訳されるのは、有効にしたサイトだけです。それ以外のページは、指示したとき（右クリックメニューまたは" +
        "ショートカットキー）にのみ翻訳されます。また、初めて送信する前には必ず確認画面が表示されます。",
      "ポップアップには、今日送信した合成画像の数が表示されます。",
      "このデバイスでは、翻訳結果、吹き出しの位置、文字消し用のパッチが拡張機能のIndexedDBに保存されます。下の「キャッシュ」" +
        "から削除できます。",
    ],
    privacyAcked: (when: string): string => `画像送信に関するお知らせは${when}に確認済みです。`,
    privacyNotAcked:
      "画像送信に関するお知らせはまだ確認されていません。初めて送信する前に確認画面が表示されます。",
    cacheHeading: "キャッシュ",
    cacheHint:
      "このデバイスに保存されているすべての翻訳、吹き出しの位置、文字消し用のパッチを削除します。もう一度読むと、" +
      "再び翻訳（と画像の送信）が行われます。",
    cacheClear: "キャッシュをすべて削除",
    cacheConfirm:
      "キャッシュをすべて削除します。次に読むときは、翻訳と画像の送信がもう一度行われます。よろしいですか？",
    cacheCleared: (count: number): string => `${count}件のデータを削除しました。`,
    cacheFailed: (title: string): string => `キャッシュを削除できませんでした：${title}`,
    debugHeading: "デバッグログ",
    logLevel: "ログレベル",
    logLevels: { debug: "詳細（debug）", info: "情報", warn: "警告", error: "エラーのみ" },
  },
  optionsAdvanced: {
    search: "設定を検索",
    modifiedOnly: "変更した設定のみ",
    matches: (count: number): string => `${count} 件の設定`,
    noMatch: "検索に一致する設定はありません。",
    defaultIs: (value: string): string => `初期値：${value}`,
    range: (min: string, max: string): string => `設定範囲：${min}〜${max}`,
    automatic: "自動",
    on: "オン",
    off: "オフ",
    reset: "リセット",
    resetLabel: (label: string): string => `「${label}」を初期値に戻す`,
    resetAll: "詳細設定をすべてリセット",
    resetAllConfirm: "すべての詳細設定を初期値に戻しますか？",
    resetAllDone: "すべての詳細設定を初期値に戻しました。",
    notANumber: "数値を入力してください。",
    adjusted: (value: string): string => `設定できる最も近い値（${value}）で保存しました。`,
    badKey: "Backquote や KeyH などのキーコードを入力するか、空欄のままにしてください。",
    verticalChoices: { auto: "自動", never: "しない" },
    groups: {
      api: "AIリクエスト",
      translate: "リクエストの内容",
      detector: "テキスト検出",
      engine: "翻訳エンジン",
      discovery: "画像の探索",
      render: "訳文の表示",
      memory: "シリーズの記憶",
      cache: "キャッシュ",
      privacy: "画像サイズの上限",
      debug: "デバッグログ",
    },
    fields: {
      "api.temperature": {
        label: "温度（Temperature）",
        hint: "回答のばらつきの度合いです。空欄にするとプロバイダー側の既定値を使います。",
      },
      "api.urgentLane": {
        label: "表示中の画像用の追加枠",
        hint: "今見ている画像専用のリクエスト枠を1つ追加します。",
      },
      "api.maxInFlight": {
        label: "同時リクエスト数の上限",
        hint: "追加枠を含めた絶対的な上限です。「翻訳リクエストの同時実行数」より低くはなりません。",
      },
      "api.firstByteTimeoutMs": {
        label: "最初の応答を待つ時間（秒）",
        hint: "エンドポイントからこの時間何も届かない場合は中止します。",
      },
      "api.idleTimeoutMs": {
        label: "応答停止のタイムアウト（秒）",
        hint: "応答のストリーミングがこの時間止まった場合は中止します。",
      },
      "api.totalTimeoutMs": {
        label: "リクエストの最大時間（秒）",
        hint: "どのリクエストも、この時間を過ぎたら中止します。",
      },
      "api.healthTimeoutMs": {
        label: "接続確認のタイムアウト（秒）",
        hint: "エンドポイントの確認と「接続テスト」で使われます。",
      },
      "translate.boxBudget": {
        label: "1リクエストあたりのテキスト領域数",
        hint: "空欄にするとモデルのプロファイル（12、16、20のいずれか）に従います。",
      },
      "translate.packWaitMs": {
        label: "画像をまとめる待ち時間 (ms)",
        hint: "1 枚の画像の文字が、同じリクエストにまとめるためにページ内の次の画像を待つ時間です。0 にすると画像ごとにすぐ送信します。",
      },
      "translate.urgentPackMax": {
        label: "画面上の最初のリクエストのフキダシ数",
        hint: "表示中の画像の最初のリクエストに入れるフキダシの上限です。早く表示されます。0 = 個別の上限なし。",
      },
      "translate.jpegQuality": {
        label: "JPEGの品質",
        hint: "AIに送信する合成画像の品質です。",
      },
      "translate.requestBodyCapMb": {
        label: "リクエストの最大サイズ（MB）",
        hint: "これより大きい合成画像は圧縮を強め、それでも大きければ分割します。",
      },
      "translate.promptCharCap": {
        label: "プロンプトの最大長（文字数）",
        hint: "リクエストがこれより長い場合は、まず文脈を短くします。",
      },
      "translate.maxLadderRequestsPerPack": {
        label: "訳し漏れを補う追加リクエスト数",
        hint: "AIがテキスト領域を飛ばしたときに、再リクエストや分割を行う回数です。",
      },
      "translate.maxHttpRetriesPerRequest": {
        label: "ネットワークエラー後の再試行回数",
        hint: "リクエストごとの回数です。一時的なHTTPエラーやネットワーク障害が対象です。",
      },
      "translate.engine": {
        label: "翻訳エンジン",
        hint: "オフラインモードは試験的な機能です。上の「オフラインモード」を参照してください。",
      },
      "translate.offlineModel": {
        label: "オフライン翻訳モデル",
        hint: "オフラインモードでのみ使用されます。",
      },
      "translate.splitOnRefusal": {
        label: "拒否されたリクエストを分割",
        hint: "AIが拒否した場合、あきらめずに半分ずつ別々に試します。",
      },
      "detector.backend": {
        label: "検出に使うハードウェア",
        hint: "「自動」では、セルフテストに合格すればGPUを、そうでなければCPUを使います。",
      },
      "detector.scoreMin": {
        label: "検出スコアの最小値",
        hint: "値を下げるとより多くのテキストを検出しますが、誤検出も増えます。",
      },
      "detector.sliceTriggerRatio": {
        label: "これより細長い画像を分割（縦横比）",
        hint: "長辺が短辺のこの倍数を超える画像やウェブトゥーンの縦長画像は、分割して処理します。",
      },
      "detector.sliceHeightRatio": {
        label: "分割片の長さ（短辺の倍数）",
        hint: "各分割片の長さを、画像の短辺に対する倍数で指定します。",
      },
      "detector.sliceOverlap": {
        label: "分割片の重なり（割合）",
        hint: "隣り合う分割片の重なりを、分割片に対する割合で指定します。",
      },
      "detector.sliceOverlapMinPx": {
        label: "分割片の最小の重なり（ピクセル）",
        hint: "隣り合う分割片は、常に少なくともこのピクセル数だけ重なります。",
      },
      "detector.quietRows": {
        label: "テキストの行間で分割",
        hint: "試験的な機能：分割位置をインクのない行に移動します。",
      },
      "engine.idleCloseMin": {
        label: "アイドル状態のエンジンを閉じるまで（分）",
        hint: "どのページもこの時間エンジンを使わなかった場合、メモリーを解放します。",
      },
      "engine.detectorReleaseMin": {
        label: "テキスト検出を解放するまで（分）",
        hint: "検出モデルがこの時間実行されなかった場合、メモリーから解放します。",
      },
      "engine.portIdleMin": {
        label: "アイドル状態のページを切断するまで（分）",
        hint: "作業がない状態がこの時間続くと、ページはエンジンとの接続を解除します。",
      },
      "discovery.minNaturalSide": {
        label: "これより小さい画像を無視（ピクセル）",
        hint: "短辺の実際のサイズです。アイコン、アバター、広告を除外します。",
      },
      "discovery.minDisplayedSide": {
        label: "表示サイズがこれより小さい画像を無視（ピクセル）",
        hint: "画面上での短辺のサイズです。",
      },
      "discovery.secondsPerScreenDefault": {
        label: "読む速さの初期推定（1画面あたりの秒数）",
        hint: "実際の読む速さを計測するまで使う推定値です。",
      },
      "discovery.lookaheadMinScreens": {
        label: "先読み翻訳の最小範囲（画面数）",
        hint: "表示位置からこの画面数以内の画像は、到達する前に必ず翻訳されます。",
      },
      "discovery.lookaheadMaxScreens": {
        label: "先読み翻訳の最大範囲（画面数）",
        hint: "速く読むときや AI の応答が遅いときの上限です。",
      },
      "discovery.lookaheadMaxScreensStrip": {
        label: "Webtoon ストリップの先読み翻訳の最大範囲（画面数）",
        hint: "縦に長いストリップでの上限です。",
      },
      "discovery.detectAheadMinScreens": {
        label: "先読み検出の最小範囲（画面数）",
        hint: "ページがまだ読み込んでいない画像を、この範囲まで先に検出します（アップロードなし）。",
      },
      "discovery.detectAheadMaxScreens": {
        label: "先読み検出の最大範囲（画面数）",
        hint: "速く読む場合の上限です。",
      },
      "discovery.detectMaxImages": {
        label: "先読み検出する画像の最大数",
        hint: "読み込み済みかどうかにかかわらず、先にあるすべての画像を数えます。",
      },
      "discovery.fetchPerHostConcurrency": {
        label: "サーバーごとの画像の同時ダウンロード数",
        hint: "同じ画像サーバーから同時にダウンロードする画像の数です。",
      },
      "discovery.prefetchSpacingMs": {
        label: "画像ダウンロードの間隔（ミリ秒）",
        hint: "同じサーバーからの2回のダウンロードの間に空ける最小の時間です。",
      },
      "discovery.scrollDebounceMs": {
        label: "スクロールに反応するまでの遅延（ミリ秒）",
        hint: "スクロール後、この時間待ってから作業の順番を並べ替えます。",
      },
      "discovery.mutationDebounceMs": {
        label: "ページの変化に反応するまでの遅延（ミリ秒）",
        hint: "ページが変化した後（遅延読み込み、ビューアーアプリなど）、この時間待ってから新しい画像を探します。",
      },
      "discovery.stripGapPx": {
        label: "ウェブトゥーンの縦長画像内の最大の隙間（ピクセル）",
        hint: "これより間隔の狭い画像は、1つの連続した縦長画像として扱います。",
      },
      "discovery.translateHiddenTabs": {
        label: "バックグラウンドのタブでも翻訳",
        hint: "オフの場合、自動モードはタブが表示されるまで待機します。",
      },
      "render.font": {
        label: "セリフのフォント",
        hint: "吹き出し内の訳文に使うフォントです。",
      },
      "render.verticalText": {
        label: "縦書き",
        hint: "日本語または繁体字中国語への翻訳は、縦長の吹き出しでは縦書きで表示します。「しない」にすると常に横書きです。",
      },
      "render.minFontPx": {
        label: "最小の文字サイズ（ピクセル）",
        hint: "このサイズでも収まらないテキストは「…」で省略されます。",
      },
      "render.maxFontPx": {
        label: "最大の文字サイズ（ピクセル）",
        hint: "訳文は、原文の文字に近い大きさにも保たれます。",
      },
      "render.eraseSfx": {
        label: "効果音を消す",
        hint: "効果音にラベルを付ける代わりに、画像から消去します。",
      },
      "render.sfxLabels": {
        label: "効果音にラベルを付ける",
        hint: "効果音の翻訳を小さなラベルで表示します。",
      },
      "render.showDoneBadge": {
        label: "翻訳済みの画像に印を付ける",
        hint: "翻訳済みのすべての画像に小さなバッジを表示します。",
      },
      "render.peekKey": {
        label: "押している間、原文を表示（キーコード）",
        hint: "Backquote や KeyH などのキーコードです。空欄にするとオフになります。",
      },
      "render.peekWithAlt": {
        label: "Altキーを押している間も原文を表示",
        hint: "Altキーだけを押し続けても訳文が非表示になります。",
      },
      "render.popupWithAltClick": {
        label: "Alt+クリックで吹き出しのポップアップを開く",
        hint: "ポップアップには原文が表示され、訳文を編集できます。長押しでも常に開きます。",
      },
      "memory.enabled": {
        label: "シリーズの記憶を使う",
        hint: "各リクエストに用語集、直前のセリフ、あらすじを添えて送信し、応答から名前を学習します。",
      },
      "memory.glossaryInPrompt": {
        label: "1リクエストあたりの用語集の件数",
        hint: "あなたの登録、確認済み、学習済みの順に含めます。",
      },
      "memory.termMinSightings": {
        label: "用語を学習するまでの出現回数",
        hint: "用語が送信されるまでに、その用語が登場する必要がある別々のリクエストの数です。",
      },
      "memory.historyMaxLines": {
        label: "文脈として送る直前のセリフ数",
        hint: "同じ話のセリフです。0にすると送信しません。",
      },
      "memory.historyMaxTokens": {
        label: "直前のセリフのトークン上限",
        hint: "古いセリフから順に削除されます。",
      },
      "memory.summaryMaxWords": {
        label: "あらすじの長さ（単語数）",
        hint: "0にすると、随時更新されるあらすじをオフにします。",
      },
      "memory.warmUp": {
        label: "新しいシリーズを先に1回翻訳",
        hint: "シリーズの記憶がまだないうちは最初のリクエストだけを送り、次のページはその名前と呼び方を引き継ぎます。最初のページは少し遅くなります。",
      },
      "cache.translationTtlDays": {
        label: "未使用の翻訳を保持する期間（日）",
        hint: "自分で編集した訳文は期限切れになりません。",
      },
      "cache.encodedBytesLruMb": {
        label: "ダウンロードした画像のキャッシュ（MB）",
        hint: "ダウンロードした画像を保持するためにエンジンが使うメモリーです。",
      },
      "privacy.maxImageBytes": {
        label: "画像ファイルの最大サイズ（MiB）",
        hint: "これより大きい画像ファイルはスキップします。",
      },
      "privacy.maxImagePixels": {
        label: "画像の最大サイズ（メガピクセル）",
        hint: "これより画素数の多い画像はスキップします。",
      },
      "debug.logCapacity": {
        label: "保持するログの件数",
        hint: "エンジンが保存するデバッグログのサイズです。",
      },
    },
    site: {
      settings: "設定",
      settingsFor: (site: string): string => `${site} の設定`,
      layout: "レイアウトと読む方向",
      layouts: {
        auto: "自動検出",
        webtoon: "ウェブトゥーン（縦スクロール）",
        "paged-rtl": "ページ単位・右から左（マンガ）",
        "paged-ltr": "ページ単位・左から右（コミック）",
      },
      sourceLangHint: "AIへの言語別の指示と、テキスト切り抜き画像の拡大率がこれで決まります。",
      referer: "画像ダウンロード時のReferer",
      referers: {
        auto: "自動",
        "page-url": "ページの完全なアドレス",
        origin: "サイトのアドレスのみ",
      },
      refererHint:
        "「自動」はページに合わせ、画像サーバーに拒否されたときはページの完全なアドレスで再試行します。" +
        "画像が読み込めない場合にのみ変更してください。",
      subdomains: "サブドメインにも適用",
      subdomainsHint: "このサイトのすべてのサブドメインで、同じ設定で翻訳します。",
      prefetch: "画像を先に準備する",
      prefetchHint:
        "表示位置より下にあるまだ読み込まれていない画像を検出し、到達したときに準備できているようにします。近づくまで何もアップロードしません。",
      frames: "他サイトのビューアーのフレーム",
      framesHint:
        "ページが別のサイトから配信されるフレーム内に表示される場合に、オリジンを1行に1つずつ入力します" +
        "（例：https://viewer.example.com）。",
      framesInvalid: (lines: string): string => `http(s)のオリジンではありません：${lines}`,
    },
    transfer: {
      heading: "バックアップと復元",
      hint:
        "設定とサイト一覧をJSONファイルに保存したり、JSONファイルから読み込んだりできます。" +
        "プライバシーに関する確認状態はエクスポートされません。",
      includeKey: "APIキーを含める",
      includeKeyHint:
        "ファイルを共有する場合はオフにしてください。ファイルを開いた人は誰でもキーを読み取れます。",
      export: "設定をエクスポート",
      import: "設定をインポート",
      importConfirm:
        "現在の設定をファイルの内容で置き換えますか？ファイル内のサイトは追加または更新されます。",
      notJson: "このファイルは有効なJSONではありません。",
      notSettings: "このファイルはPanelingoの設定のエクスポートではありません。",
      tooNew: "このファイルは新しいバージョンのPanelingoで作成されています。",
      imported: (settings: number, sites: number): string =>
        `インポートしました。変更された設定：${settings}件、サイト：${sites}件。`,
      keyImported: "ファイル内のAPIキーをインポートしました。",
      keyKept: "APIキーは現在のものを保持しました（ファイルにキーが含まれていません）。",
    },
  },
  offline: {
    heading: "オフラインモード（試験的）",
    intro:
      "AIエンドポイントを使わずに翻訳します。オープンソースの文字認識（PaddleOCR）と翻訳モデルがこのデバイス上で動作します。品質はビジョンモデルより明らかに劣ります。吹き出し間の文脈やキャラクター名は考慮されず、装飾的な文字はよく誤読されます。効果音は翻訳せずそのまま残します。",
    download:
      "モデルは初めて必要になったときに Hugging Face から一度だけダウンロードされ、検証のうえこのデバイスに保存されます。その後はネットワークなしで翻訳できます。サイズ：文字認識は言語ごとに 8〜17 MB、Opus-MT は言語ペアごとに約 115 MB（英語経由ではその2倍）、NLLB-200 は約 910 MB です。",
    engine: "翻訳エンジン",
    engineChoices: { api: "AIエンドポイント（OpenAI互換）", offline: "このデバイスでオフライン（試験的）" },
    model: "オフライン翻訳モデル",
    modelChoices: {
      "opus-mt": "Opus-MT：小型、言語ペアごとに1モデル",
      "nllb-600m": "NLLB-200 600M：全ペア対応、大型、非商用",
    },
    pairs:
      "Opus-MT は韓国語・日本語・中国語・スペイン語から英語へ、英語からベトナム語・スペイン語・フランス語・ドイツ語・イタリア語・インドネシア語へ翻訳します。その他のペアは英語を経由します。NLLB-200 はここに挙げたすべての言語間で翻訳できます。",
    license:
      "ライセンス：PaddleOCR と大半の Opus-MT モデルは Apache-2.0、Opus-MT の2モデルは CC-BY-4.0、NLLB-200 は CC-BY-NC-4.0（非商用利用のみ）です。",
    stored: (mb: number): string => `このデバイスにダウンロード済みのモデル：${Math.round(mb)} MB`,
    deleteModels: "ダウンロードしたモデルを削除",
    deleteConfirm:
      "ダウンロードしたオフラインモデルを削除しますか？必要になったときに再ダウンロードされます。",
    deleted: "ダウンロードしたモデルを削除しました。",
  },
  manifest: {
    description: "OpenAI互換のAIで、コミック・マンガ・ウェブトゥーンを読みながらその場で翻訳します。",
    commands: {
      "toggle-overlay": "翻訳オーバーレイの表示を切り替え",
      "translate-visible": "表示中の画像を翻訳",
      "toggle-site": "このサイトの自動翻訳のオン/オフを切り替え",
      "open-side-panel": "セリフ一覧のサイドパネルを開く",
    },
  },
};
