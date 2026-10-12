// Dev/test-only diagnostics page (build info; log viewer, DNR and registration dumps).

import { applyLocale } from "../../platform/locale.ts";
import { loadSettings } from "../../platform/storage.ts";
import { msg } from "../../shared/i18n/index.ts";

async function main(): Promise<void> {
  applyLocale((await loadSettings()).ui.locale);
  const heading = document.getElementById("heading");
  if (heading) heading.textContent = msg().debug.heading;
  const build = document.getElementById("build");
  if (build) {
    build.textContent = JSON.stringify({ build: __BUILD_ID__, dev: __DEV__, test: __TEST__ }, null, 2);
  }
}

void main();
