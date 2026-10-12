// Offscreen engine entry. Every listener is registered synchronously, before any await or import(), so a content
// script that connects right after createDocument() never hits "Receiving end does not exist". The ReadyGate buffers
// until the runtime is ready.

import { onMessageFor } from "../platform/messaging.ts";
import { PORT_ENGINE, PORT_UI } from "../shared/protocol.ts";
import { createReadyGate } from "./ready-gate.ts";

const gate = createReadyGate({ maxMsgsPerPort: 500, maxBytesPerPort: 64 * 1024 * 1024 });

// The only onConnect listener in the extension. Other port names are ignored, never disconnected: a disconnect() by
// any receiver kills the channel.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === PORT_ENGINE || port.name === PORT_UI) gate.adopt(port);
});
onMessageFor("engine", gate.handlers, { allow: gate.allow });

void Promise.all([import("./runtime.ts"), import("./services.ts")]).then(
  ([runtime, services]) => runtime.startRuntime(gate, services.productionFactories),
  (error: unknown) => gate.fail(error),
);
