// Version stamps for persisted and exchanged data. Bump the matching one whenever its format changes:
// a mismatch makes readers migrate, recompute or discard (see docs/ARCHITECTURE.md).

/** IndexedDB schema version. All 12 stores exist from version 1; later phases only start using them. */
export const DB_VERSION = 1;
/** chrome.storage.local settings layout. */
export const SETTINGS_VERSION = 2;
/** Message envelope / Port protocol between content, service worker, engine and UI. */
export const PROTOCOL_VERSION = 1;
/** System prompt and output line format sent to the model. */
export const PROMPT_VERSION = 2;
/** Unit geometry derivation (detections → translation units). */
export const UNITS_VERSION = 1;
/** Erase-patch algorithm. */
export const ERASE_VERSION = 1;
