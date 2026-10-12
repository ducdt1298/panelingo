// Preloaded by every `node --test` run (package.json --import): the esbuild defines that bundled code reads
// directly (src/types/globals.d.ts). Production code keeps using the bare identifiers so esbuild can drop
// __TEST__-only code (test hooks, open shadow roots) from dev and prod bundles.

import net from "node:net";

const globals = globalThis as Record<string, unknown>;
globals.__BUILD_ID__ ??= "0.0.0+node-test";
globals.__DEV__ ??= true;
globals.__TEST__ ??= true;

// Tests never reach a real AI endpoint: they use the mock OpenAI server on an ephemeral port or a fake fetch. A global
// fetch to a loopback port this test process did not open itself (a developer's local AI server, whatever its port) or
// to a public AI provider (the default base URL is https://api.openai.com/v1) is refused here and fails the test file,
// even when the code under test swallows the rejection: such a request would send data or spend the developer's quota.

/** Ports of the servers this process listens on (mock servers, fixture servers); only these loopback ports are open. */
const ownPorts = new Set<number>();
// eslint-disable-next-line @typescript-eslint/unbound-method -- called below with Reflect.apply on the server itself
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]): net.Server {
  this.once("listening", () => {
    const address = this.address();
    if (address !== null && typeof address === "object") ownPorts.add(address.port);
  });
  return Reflect.apply(listen, this, args) as net.Server;
};

/** Public AI provider hosts (exact names, or any subdomain of the entries starting with "."). */
const PROVIDER_HOSTS: readonly string[] = [
  "api.openai.com",
  ".openai.azure.com",
  "openrouter.ai",
  "generativelanguage.googleapis.com",
  "api.anthropic.com",
  "api.groq.com",
  "api.mistral.ai",
  "api.together.xyz",
  "api.deepseek.com",
  "api.x.ai",
];
const realFetch = globalThis.fetch;

function isProviderHost(host: string): boolean {
  return PROVIDER_HOSTS.some((entry) => (entry.startsWith(".") ? host.endsWith(entry) : host === entry));
}

/** The URL when `input` may reach a real AI endpoint (a provider, or a loopback port this process did not open). */
export function realEndpoint(input: string | URL | Request): string | null {
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "[::1]" || host === "0.0.0.0" || host.startsWith("127.");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (loopback && !ownPorts.has(port)) return url.href;
  return isProviderHost(host) ? url.href : null;
}

globalThis.fetch = (input, init) => {
  const blocked = realEndpoint(input);
  if (blocked !== null) {
    process.exitCode = 1;
    console.error(`[test guard] blocked a request to a real AI endpoint: ${blocked}`);
    return Promise.reject(
      new TypeError(`test guard: ${blocked} is a real AI endpoint and must never be called from tests`),
    );
  }
  return realFetch(input, init);
};
