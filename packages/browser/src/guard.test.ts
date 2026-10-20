import { describe, expect, it } from "vitest";

import { addressToUrl, checkUrl, isBlockedHost } from "./index.ts";

describe("url guard", () => {
  it("blocks private, loopback, link-local and metadata hosts", () => {
    for (const host of [
      "localhost",
      "api.localhost",
      "127.0.0.1",
      "10.128.0.2",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "metadata.google.internal",
      "::1",
      "[::1]",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
    ]) {
      expect(isBlockedHost(host), host).toBe(true);
    }
    for (const host of [
      "example.com",
      "8.8.8.8",
      "172.32.0.1",
      "2606:4700::1",
    ]) {
      expect(isBlockedHost(host), host).toBe(false);
    }
  });

  it("accepts only http(s) and rejects names that resolve privately", async () => {
    const lookup = async (host: string) =>
      host === "evil.example"
        ? ["93.184.216.34", "10.0.0.5"]
        : ["93.184.216.34"];
    expect(await checkUrl("file:///etc/passwd", lookup)).toEqual({
      ok: false,
      reason: "only http and https pages can be opened",
    });
    expect(await checkUrl("http://169.254.169.254/latest", lookup)).toEqual({
      ok: false,
      reason: "private and internal addresses are blocked",
    });
    expect(await checkUrl("https://evil.example/", lookup)).toEqual({
      ok: false,
      reason: "private and internal addresses are blocked",
    });
    const ok = await checkUrl("https://example.com/path?q=1", lookup);
    expect(ok.ok && ok.url.href).toBe("https://example.com/path?q=1");
    expect(await checkUrl("not a url", lookup)).toEqual({
      ok: false,
      reason: "not a valid URL",
    });
  });

  it("reads an address bar entry as a URL, a host or a search", () => {
    expect(addressToUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(addressToUrl("wikipedia.org")).toBe("https://wikipedia.org");
    expect(addressToUrl("en.wikipedia.org/wiki/Mac")).toBe(
      "https://en.wikipedia.org/wiki/Mac"
    );
    expect(addressToUrl("example.com:8080")).toBe("https://example.com:8080");
    expect(addressToUrl("wikipedia")).toBe(
      "https://duckduckgo.com/?q=wikipedia"
    );
    expect(addressToUrl("mac dock design")).toBe(
      "https://duckduckgo.com/?q=mac%20dock%20design"
    );
  });
});
