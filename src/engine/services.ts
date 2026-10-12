// The production service factories (src/engine/contracts.ts ServiceFactories); runtime.ts wires them, tests inject
// fakes instead.

import type { ServiceFactories } from "./contracts.ts";
import { createAcquirer } from "./acquire.ts";
import { createComposite } from "./composite.ts";
import { createDecoder } from "./decode.ts";
import { createDetector } from "./detector.ts";
import { createHealth } from "./health-monitor.ts";
import { createPipeline } from "./pipeline.ts";
import { createChromeGfx } from "./pixels.ts";
import { openStores } from "./store/db.ts";
import { createTranslator } from "./translator.ts";
import { createUploads } from "./uploads.ts";

export const productionFactories: ServiceFactories = {
  openStores: (deps) => openStores(deps),
  createGfx: () => createChromeGfx(),
  createHealth: (deps) => createHealth(deps),
  createAcquirer: (deps) => createAcquirer(deps),
  createDecoder: (deps) => createDecoder(deps),
  createDetector: (deps) => createDetector(deps),
  createComposite: (deps) => createComposite(deps),
  createUploads: (deps) => createUploads(deps),
  createTranslator: (deps) => createTranslator(deps),
  createPipeline: (deps) => createPipeline(deps),
};
