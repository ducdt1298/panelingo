// Where the E2E tests find the repository and a Chrome binary.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** The unpacked extension under test: $CTV_EXTENSION_DIR (relative to the repository) or dist/. */
export function extensionDir(): string {
  const fromEnv = process.env["CTV_EXTENSION_DIR"];
  return path.resolve(ROOT, fromEnv !== undefined && fromEnv !== "" ? fromEnv : "dist");
}

const DEFAULT_CHROME: Readonly<Record<string, string>> = {
  win32: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  linux: "/usr/bin/google-chrome",
};

/** Chrome binary: $CHROME_PATH, else the platform's Chrome stable install. */
export function chromePath(): string {
  const fromEnv = process.env["CHROME_PATH"];
  const candidate =
    fromEnv !== undefined && fromEnv !== ""
      ? fromEnv
      : (DEFAULT_CHROME[process.platform] ?? DEFAULT_CHROME["linux"]);
  if (candidate === undefined || !existsSync(candidate)) {
    throw new Error(`Chrome not found at ${candidate ?? "?"}; set CHROME_PATH`);
  }
  return candidate;
}
