// Languages the translation can be written in. The prompt names the language in English; scripts the bundled overlay
// fonts cover (Latin with Vietnamese marks) are listed first, then the CJK languages, which the overlay letters with
// the system's CJK fonts (Japanese and Traditional Chinese vertically in tall tategaki balloons). PURE.

export interface TargetLanguage {
  /** Code stored in settings.translate.targetLang. */
  code: string;
  /** English name, used in the prompt ("Translate into <englishName>"). */
  englishName: string;
  /** The language's own name, shown in the picker. */
  nativeName: string;
  /** Writing system: "cjk" letters with CJK system fonts and breaks between characters. */
  script: "latin" | "cjk";
  /** Traditionally written top to bottom: lettered vertically in vertical balloons (settings.render.verticalText). */
  vertical: boolean;
}

const latin = (code: string, englishName: string, nativeName: string): TargetLanguage => ({
  code,
  englishName,
  nativeName,
  script: "latin",
  vertical: false,
});

const cjk = (code: string, englishName: string, nativeName: string, vertical: boolean): TargetLanguage => ({
  code,
  englishName,
  nativeName,
  script: "cjk",
  vertical,
});

export const TARGET_LANGUAGES: readonly TargetLanguage[] = [
  latin("en", "English", "English"),
  latin("vi", "Vietnamese", "Tiếng Việt"),
  latin("es", "Spanish", "Español"),
  latin("pt-br", "Brazilian Portuguese", "Português (Brasil)"),
  latin("fr", "French", "Français"),
  latin("de", "German", "Deutsch"),
  latin("it", "Italian", "Italiano"),
  latin("id", "Indonesian", "Bahasa Indonesia"),
  latin("tl", "Filipino", "Filipino"),
  latin("pl", "Polish", "Polski"),
  latin("tr", "Turkish", "Türkçe"),
  cjk("ja", "Japanese", "日本語", true),
  cjk("zh-cn", "Simplified Chinese", "简体中文", false),
  cjk("zh-tw", "Traditional Chinese", "繁體中文", true),
  cjk("ko", "Korean", "한국어", false),
];

export const DEFAULT_TARGET = "en";

export function targetLanguage(code: string): TargetLanguage | undefined {
  return TARGET_LANGUAGES.find((language) => language.code === code);
}

/** The target is written in a CJK script (lettered with CJK fonts, broken between characters). */
export function isCjkTarget(code: string): boolean {
  return targetLanguage(code)?.script === "cjk";
}

/** Chinese written in Traditional characters: Taiwan, Hong Kong, Macau, or an explicit Hant script subtag. */
const TRADITIONAL_CHINESE = /^zh-(?:tw|hk|mo|hant)(?:-|$)/u;

/**
 * The language to translate into: the setting when it names a supported language, else ("auto") the first of the
 * browser's languages that is supported (exact, then without region), else English.
 */
export function resolveTargetLang(setting: string, browserLanguages: readonly string[]): TargetLanguage {
  const pick = (raw: string): TargetLanguage | undefined => {
    const code = raw.toLowerCase().replace(/_/gu, "-");
    // Chinese goes by script, not by country: zh-HK and zh-Hant are Traditional, zh, zh-SG and zh-Hans Simplified.
    if (code === "zh" || code.startsWith("zh-")) {
      return targetLanguage(TRADITIONAL_CHINESE.test(code) ? "zh-tw" : "zh-cn");
    }
    return targetLanguage(code) ?? TARGET_LANGUAGES.find((l) => l.code.split("-")[0] === code.split("-")[0]);
  };
  if (setting !== "" && setting !== "auto") {
    const chosen = pick(setting);
    if (chosen !== undefined) return chosen;
  }
  for (const language of browserLanguages) {
    const found = pick(language);
    if (found !== undefined) return found;
  }
  return targetLanguage(DEFAULT_TARGET) ?? (TARGET_LANGUAGES[0] as TargetLanguage);
}

/**
 * The language translations are written in, as the engine resolves it: settings.translate.targetLang, or ("auto")
 * the interface language when one is chosen, else the browser's languages. The content script resolves it the same
 * way to pick the lettering (CJK fonts, vertical columns).
 */
export function effectiveTarget(
  setting: string,
  uiLocale: string,
  browserLanguages: readonly string[],
): TargetLanguage {
  return resolveTargetLang(setting, uiLocale !== "auto" ? [uiLocale] : browserLanguages);
}
