// Picks this context's UI language from the settings ("auto" = the browser's UI language and preferred languages).

import { browserLanguages, setLocale } from "../shared/i18n/index.ts";

/** The browser's languages as this context sees them. */
export function contextLanguages(): string[] {
  let uiLanguage: string | undefined;
  try {
    uiLanguage = chrome.i18n.getUILanguage();
  } catch {
    uiLanguage = undefined;
  }
  const languages = typeof navigator !== "undefined" ? navigator.languages : [];
  return browserLanguages({ uiLanguage, languages });
}

/** Applies settings.ui.locale to msg(); returns the resolved locale code. */
export function applyLocale(setting: string): string {
  return setLocale(setting, contextLanguages());
}
