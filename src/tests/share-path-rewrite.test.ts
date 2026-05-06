import { describe, test, expect } from "bun:test";
import {
  EXTERNAL_PREFIX,
  decodePath,
  decodePathArray,
  encodePath,
  encodePathArray,
  restoreTextPaths,
  rewriteTextPaths,
} from "../daemon/share/path-rewrite";

const wd = "/home/yash/Workspace/codeoid";
const alias = "github.com/saucam/codeoid";
const target = "/home/alice/projects/codeoid";

describe("encodePath", () => {
  test("workdir root → alias bare", () => {
    expect(encodePath(wd, wd, alias)).toBe(alias);
  });

  test("file under workdir → alias-relative", () => {
    expect(encodePath(`${wd}/src/foo.ts`, wd, alias)).toBe(`${alias}/src/foo.ts`);
  });

  test("nested directory → alias-relative", () => {
    expect(encodePath(`${wd}/src/daemon/share/pack.ts`, wd, alias)).toBe(
      `${alias}/src/daemon/share/pack.ts`,
    );
  });

  test("path that's NOT actually a prefix of workdir is treated as external", () => {
    expect(encodePath("/home/yash/Workspace/codeoid-ui/x.ts", wd, alias)).toBe(
      `${EXTERNAL_PREFIX}home/yash/Workspace/codeoid-ui/x.ts`,
    );
  });

  test("absolute path outside workdir → <external>/", () => {
    expect(encodePath("/etc/passwd", wd, alias)).toBe(`${EXTERNAL_PREFIX}etc/passwd`);
  });

  test("trailing slashes on workdir tolerated", () => {
    expect(encodePath(`${wd}/src/x.ts`, `${wd}/`, alias)).toBe(`${alias}/src/x.ts`);
  });

  test("empty input passes through", () => {
    expect(encodePath("", wd, alias)).toBe("");
  });
});

describe("decodePath", () => {
  test("alias bare → target workdir bare", () => {
    expect(decodePath(alias, alias, target)).toBe(target);
  });

  test("alias-relative → target absolute", () => {
    expect(decodePath(`${alias}/src/foo.ts`, alias, target)).toBe(`${target}/src/foo.ts`);
  });

  test("<external>/ → restored absolute", () => {
    expect(decodePath(`${EXTERNAL_PREFIX}etc/passwd`, alias, target)).toBe("/etc/passwd");
  });

  test("unrecognised passthrough", () => {
    expect(decodePath("bare-token", alias, target)).toBe("bare-token");
  });

  test("trailing slash on target tolerated", () => {
    expect(decodePath(`${alias}/src/x.ts`, alias, `${target}/`)).toBe(`${target}/src/x.ts`);
  });
});

describe("encode/decode round-trip", () => {
  test("preserves alias-relative paths exactly", () => {
    const input = `${wd}/src/daemon/share/pack.ts`;
    const encoded = encodePath(input, wd, alias);
    const restored = decodePath(encoded, alias, target);
    expect(restored).toBe(`${target}/src/daemon/share/pack.ts`);
  });

  test("preserves external paths verbatim", () => {
    const input = "/usr/local/bin/codeoid";
    const encoded = encodePath(input, wd, alias);
    const restored = decodePath(encoded, alias, target);
    expect(restored).toBe(input);
  });
});

describe("encode/decode arrays", () => {
  test("vectorised", () => {
    const inputs = [`${wd}/a.ts`, "/etc/x", `${wd}/b/c.ts`];
    const enc = encodePathArray(inputs, wd, alias);
    expect(enc).toEqual([
      `${alias}/a.ts`,
      `${EXTERNAL_PREFIX}etc/x`,
      `${alias}/b/c.ts`,
    ]);
    const dec = decodePathArray(enc, alias, target);
    expect(dec).toEqual([`${target}/a.ts`, "/etc/x", `${target}/b/c.ts`]);
  });
});

describe("rewriteTextPaths", () => {
  test("substitutes literal workdir prefix in tool output", () => {
    const text = `Read ${wd}/src/foo.ts: 42 lines`;
    expect(rewriteTextPaths(text, wd, alias)).toBe(
      `Read ${alias}/src/foo.ts: 42 lines`,
    );
  });

  test("respects word boundaries — does NOT rewrite a longer prefix match", () => {
    const text = `Read ${wd}-ui/src/foo.ts: lol`;
    expect(rewriteTextPaths(text, wd, alias)).toBe(
      `Read ${wd}-ui/src/foo.ts: lol`,
    );
  });

  test("multiple occurrences", () => {
    const text = `${wd}/a then ${wd}/b end`;
    expect(rewriteTextPaths(text, wd, alias)).toBe(
      `${alias}/a then ${alias}/b end`,
    );
  });

  test("end-of-string match", () => {
    const text = `cd ${wd}`;
    expect(rewriteTextPaths(text, wd, alias)).toBe(`cd ${alias}`);
  });

  test("empty / no-op", () => {
    expect(rewriteTextPaths("", wd, alias)).toBe("");
    expect(rewriteTextPaths("nothing here", wd, alias)).toBe("nothing here");
  });
});

describe("restoreTextPaths", () => {
  test("substitutes alias prefix back to target workdir", () => {
    const text = `Read ${alias}/src/foo.ts: 42 lines`;
    expect(restoreTextPaths(text, alias, target)).toBe(
      `Read ${target}/src/foo.ts: 42 lines`,
    );
  });

  test("respects boundaries", () => {
    const text = `mention of ${alias}-other-repo here`;
    expect(restoreTextPaths(text, alias, target)).toBe(text);
  });
});
