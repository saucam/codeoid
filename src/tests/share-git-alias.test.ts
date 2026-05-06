import { describe, test, expect } from "bun:test";
import { remoteToAlias } from "../daemon/share/git-alias";

describe("remoteToAlias", () => {
  test("ssh-short github", () => {
    expect(remoteToAlias("git@github.com:saucam/codeoid.git")).toBe(
      "github.com/saucam/codeoid",
    );
  });

  test("ssh-short without .git", () => {
    expect(remoteToAlias("git@github.com:saucam/codeoid")).toBe(
      "github.com/saucam/codeoid",
    );
  });

  test("https github", () => {
    expect(remoteToAlias("https://github.com/saucam/codeoid.git")).toBe(
      "github.com/saucam/codeoid",
    );
  });

  test("https github without .git", () => {
    expect(remoteToAlias("https://github.com/saucam/codeoid")).toBe(
      "github.com/saucam/codeoid",
    );
  });

  test("ssh:// scheme", () => {
    expect(remoteToAlias("ssh://git@github.com/saucam/codeoid.git")).toBe(
      "github.com/saucam/codeoid",
    );
  });

  test("gitlab self-hosted", () => {
    expect(remoteToAlias("https://gitlab.example.com/team/repo.git")).toBe(
      "gitlab.example.com/team/repo",
    );
  });

  test("file:// remote → null (too local)", () => {
    expect(remoteToAlias("file:///home/me/repos/codeoid")).toBeNull();
  });

  test("garbage → null", () => {
    expect(remoteToAlias("not a url")).toBeNull();
    expect(remoteToAlias("")).toBeNull();
  });
});
