import { describe, expect, it } from "vitest";
import path from "node:path";
import { resolveOnPath } from "../src/tools/resolve-on-path.js";

describe("resolveOnPath", () => {
  it("returns the first match for a known PATH directory", () => {
    const env = { PATH: "/usr/bin:/bin:/usr/local/bin" };
    const target = path.join("/usr/bin", "foo");
    const targetBin = path.join("/bin", "foo");
    const targetLocal = path.join("/usr/local/bin", "foo");
    const exists = (p: string) => p === target || p === targetBin || p === targetLocal;
    expect(
      resolveOnPath({ token: "foo", names: ["foo"], env, pathSeparator: ":", exists })
    ).toBe(target);
  });

  it("tries names in order, picks first hit per directory", () => {
    const env = { PATH: "/usr/bin" };
    const targetFoo = path.join("/usr/bin", "foo");
    const targetFooExe = path.join("/usr/bin", "foo.exe");
    // Only the .exe name exists in /usr/bin - so the implementation falls through the first
    // name and returns the .exe hit.
    const exists = (p: string) => p === targetFooExe;
    expect(
      resolveOnPath({
        token: "foo",
        names: ["foo", "foo.exe"],
        env,
        pathSeparator: ":",
        exists
      })
    ).toBe(targetFooExe);
  });

  it("returns undefined when no candidate exists in any PATH directory", () => {
    const env = { PATH: "/usr/bin:/bin" };
    const exists = () => false;
    expect(
      resolveOnPath({ token: "totally-not-installed", names: ["totally-not-installed"], env, pathSeparator: ":", exists })
    ).toBeUndefined();
  });

  it("returns undefined for empty token", () => {
    expect(resolveOnPath({ token: "", names: [""], env: { PATH: "/x" }, pathSeparator: ":", exists: () => true })).toBeUndefined();
  });

  it("handles win32 path separator (semicolons)", () => {
    const env = { PATH: "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd" };
    const target = path.join("C:\\Program Files\\Git\\cmd", "git.exe");
    const exists = (p: string) => p === target;
    expect(
      resolveOnPath({
        token: "git",
        names: ["git.exe", "git.cmd", "git"],
        env,
        pathSeparator: ";",
        exists
      })
    ).toBe(target);
  });

  it("falls through directories to find a match further down the PATH", () => {
    const env = { PATH: "/a:/b:/c" };
    const target = path.join("/c", "foo");
    const exists = (p: string) => p === target;
    expect(
      resolveOnPath({ token: "foo", names: ["foo"], env, pathSeparator: ":", exists })
    ).toBe(target);
  });

  it("returns undefined for empty PATH", () => {
    const exists = () => true;
    expect(
      resolveOnPath({ token: "x", names: ["x"], env: { PATH: "" }, pathSeparator: ":", exists })
    ).toBeUndefined();
  });
});
