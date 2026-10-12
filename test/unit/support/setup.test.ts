import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { realEndpoint } from "../../support/setup.ts";

describe("test guard: real AI endpoints are never called", () => {
  test("loopback ports this process did not open are blocked (local AI servers, any loopback spelling)", () => {
    for (const url of [
      "http://127.0.0.1:11434/v1/models",
      "http://localhost:1234/v1/chat/completions",
      "http://[::1]:8000/v1",
      "http://0.0.0.0:5000/v1/models",
      "http://127.0.0.2:3000/",
      "http://localhost/v1/models",
    ]) {
      assert.equal(realEndpoint(url), new URL(url).href, url);
    }
  });

  test("loopback ports of servers this process listens on are allowed", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const { port } = server.address() as AddressInfo;
      assert.equal(realEndpoint(`http://127.0.0.1:${port}/v1/models`), null);
      assert.equal(realEndpoint(`http://localhost:${port}/v1/chat/completions`), null);
      assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "ok");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("public provider hosts are blocked, including Azure subdomains and Request inputs", () => {
    for (const url of [
      "https://api.openai.com/v1/models",
      "https://API.OpenAI.com/v1/chat/completions",
      "https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions",
      "https://openrouter.ai/api/v1/models",
      "https://generativelanguage.googleapis.com/v1beta/openai/models",
      "https://api.anthropic.com/v1/models",
    ]) {
      assert.notEqual(realEndpoint(url), null, url);
    }
    assert.notEqual(realEndpoint(new Request("https://api.openai.com/v1/models")), null);
  });

  test("remote image hosts and look-alike provider hosts are allowed", () => {
    for (const url of [
      "https://cdn.comic.example/page1.jpg",
      "https://api.openai.com.example/v1",
      "https://notopenrouter.ai/v1",
      "not a url",
    ]) {
      assert.equal(realEndpoint(url), null, url);
    }
  });

  test("fetch to a provider is rejected before any request is made", async () => {
    const exitCode = process.exitCode;
    const log = console.error;
    console.error = () => {};
    try {
      await assert.rejects(fetch("https://api.openai.com/v1/models"), /test guard/u);
    } finally {
      console.error = log;
      process.exitCode = exitCode;
    }
  });
});
