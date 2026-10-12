// Manual mode "Translate" button: shown while the pointer is over an image that has no state and no painted unit yet;
// a click asks the controller to translate that image.

import { msg } from "../../shared/i18n/index.ts";
import type { ImageState } from "../../shared/types.ts";
import { element, isolate } from "./dom.ts";

export interface HoverInput {
  mode: "auto" | "manual";
  /** Pointer over the image or over the button itself. */
  hovering: boolean;
  /** A request was just sent and no state has come back yet. */
  requested: boolean;
  state: ImageState | undefined;
  /** Units painted on this image. */
  painted: number;
}

export function hoverButtonVisible(input: HoverInput): boolean {
  return (
    input.mode === "manual" &&
    input.hovering &&
    !input.requested &&
    input.state === undefined &&
    input.painted === 0
  );
}

export interface HoverButtonHandle {
  readonly element: HTMLButtonElement;
  setVisible(visible: boolean): void;
}

export function createHoverButton(
  doc: Document,
  handlers: { onClick(): void; onHover(over: boolean): void },
): HoverButtonHandle {
  const button = element(doc, "button", "hover-btn");
  button.type = "button";
  button.hidden = true;
  button.textContent = msg().ui.translateImage;
  isolate(button, () => handlers.onClick());
  button.addEventListener("pointerenter", () => handlers.onHover(true));
  button.addEventListener("pointerleave", () => handlers.onHover(false));
  return {
    element: button,
    setVisible(visible) {
      button.hidden = !visible;
    },
  };
}
