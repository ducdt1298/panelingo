import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { catalogFor, msg, setLocale } from "../../../src/shared/i18n/index.ts";
import { append, clear, h, replace, text } from "../../../src/ui/common/dom.ts";
import { privacyNotice } from "../../../src/ui/common/privacy-notice.ts";
import { renderStatusBlock, type StatusBlock } from "../../../src/ui/common/status-view.ts";
import { asFake, FakeText, installFakeDocument } from "./fake-dom.ts";

let uninstall: () => void = () => undefined;
before(() => {
  uninstall = installFakeDocument();
});
after(() => uninstall());

test("h(): attributes, class, live properties, listeners and text children (never markup)", () => {
  let clicks = 0;
  const el = asFake(
    h(
      "button",
      {
        class: "primary",
        type: "button",
        "aria-label": "Lưu",
        disabled: true,
        hidden: false,
        title: null,
        "data-x": undefined,
        draggable: true,
        onclick: () => {
          clicks += 1;
        },
      },
      "<b>Lưu</b>",
      2,
      null,
      false,
      undefined,
      h("span", null, "!"),
    ),
  );
  assert.equal(el.tagName, "BUTTON");
  assert.equal(el.className, "primary");
  assert.equal(el.getAttribute("type"), "button");
  assert.equal(el.getAttribute("aria-label"), "Lưu");
  assert.equal(el.getAttribute("draggable"), "", "true → empty attribute");
  assert.equal(el.getAttribute("title"), null);
  assert.equal(el.getAttribute("data-x"), null);
  assert.equal(el["disabled"], true, "disabled is a property");
  assert.equal(el["hidden"], false);
  assert.equal(el.textContent, "<b>Lưu</b>2!");
  assert.ok(el.childNodes[0] instanceof FakeText, "strings become text nodes");
  el.dispatch("click");
  assert.equal(clicks, 1);
});

test("append, text, clear and replace", () => {
  const list = asFake(h("ul"));
  append(list as unknown as Node, [h("li", null, "a"), "b", 0, null]);
  assert.equal(list.textContent, "ab0");
  const node = text("c");
  assert.ok(node instanceof FakeText);
  append(list as unknown as Node, [node]);
  assert.equal(list.textContent, "ab0c");
  replace(list as unknown as Element, h("li", null, "x"));
  assert.equal(list.textContent, "x");
  clear(list as unknown as Element);
  assert.equal(list.childNodes.length, 0);
});

test("renderStatusBlock: heading, tone pill, hint, facts and warnings", () => {
  const container = asFake(h("section"));
  const block: StatusBlock = {
    tone: "error",
    title: "AI endpoint unreachable",
    hint: "Check the base URL",
    lines: ["Model: gpt-4o-mini", "Details: Failed to fetch"],
    warnings: ['Details: model "gpt-4o-mini" is not listed by the server'],
  };
  renderStatusBlock(container as unknown as Element, "AI endpoint", block);
  const [heading, pill, hint, facts, warning] = container.children;
  assert.equal(heading?.tagName, "H2");
  assert.equal(heading?.textContent, "AI endpoint");
  assert.equal(pill?.className, "pill tone-error");
  assert.equal(pill?.textContent, "AI endpoint unreachable");
  assert.equal(hint?.textContent, "Check the base URL");
  assert.deepEqual(
    facts?.findAll("li").map((li) => li.textContent),
    ["Model: gpt-4o-mini", "Details: Failed to fetch"],
  );
  assert.equal(warning?.getAttribute("role"), "alert");
  assert.equal(warning?.textContent, 'Details: model "gpt-4o-mini" is not listed by the server');
  renderStatusBlock(container as unknown as Element, "AI endpoint", {
    ...block,
    hint: "",
    lines: [],
    warnings: [],
  });
  assert.equal(container.children.length, 2, "empty parts are omitted and the old content replaced");
});

test("privacy notice: text from msg() (English by default), accept/decline/details wired", () => {
  const calls: string[] = [];
  const notice = asFake(
    privacyNotice({
      onAccept: () => calls.push("accept"),
      onDecline: () => calls.push("decline"),
      onDetails: () => calls.push("details"),
    }),
  );
  assert.equal(notice.getAttribute("role"), "dialog");
  assert.equal(notice.getAttribute("aria-label"), msg().ui.privacyTitle);
  assert.equal(notice.findAll("h3")[0]?.textContent, "Before images are sent to the AI");
  assert.equal(notice.findAll("p")[0]?.textContent, msg().ui.privacyBody);
  assert.match(msg().ui.privacyBody, /AI provider may store what it receives/);
  const [accept, decline] = notice.findAll("button");
  assert.deepEqual(
    [accept?.textContent, decline?.textContent],
    [msg().ui.privacyAccept, msg().ui.privacyDecline],
  );
  accept?.dispatch("click");
  decline?.dispatch("click");
  const link = notice.findAll("a")[0];
  assert.equal(link?.textContent, msg().popup.privacyDetails);
  assert.equal(link?.dispatch("click"), true, "the link does not navigate");
  assert.deepEqual(calls, ["accept", "decline", "details"]);
  assert.equal(
    asFake(privacyNotice({ onAccept: () => undefined, onDecline: () => undefined })).findAll("a").length,
    0,
  );
});

test("privacy notice follows the UI locale (vi), then English again", () => {
  const handlers = { onAccept: () => undefined, onDecline: () => undefined, onDetails: () => undefined };
  const english = asFake(privacyNotice(handlers)).textContent;
  const vi = catalogFor("vi");
  try {
    setLocale("vi");
    const notice = asFake(privacyNotice(handlers));
    assert.equal(notice.getAttribute("aria-label"), vi.ui.privacyTitle);
    assert.equal(notice.findAll("h3")[0]?.textContent, vi.ui.privacyTitle);
    assert.equal(notice.findAll("p")[0]?.textContent, vi.ui.privacyBody);
    assert.deepEqual(
      notice.findAll("button").map((button) => button.textContent),
      [vi.ui.privacyAccept, vi.ui.privacyDecline],
    );
    assert.equal(notice.findAll("a")[0]?.textContent, vi.popup.privacyDetails);
    assert.notEqual(notice.textContent, english);
  } finally {
    setLocale("en");
  }
  assert.equal(asFake(privacyNotice(handlers)).textContent, english);
});
