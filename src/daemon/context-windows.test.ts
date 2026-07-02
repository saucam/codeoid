import { describe, test, expect } from "bun:test";
import {
  DEFAULT_CONTEXT_WINDOW,
  ONE_MILLION_CONTEXT,
  contextWindowForModel,
} from "./context-windows";

describe("contextWindowForModel", () => {
  test("current 1M families -> 1M", () => {
    expect(contextWindowForModel("claude-opus-4-8")).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("claude-opus-4-7")).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("claude-opus-4-6")).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("claude-sonnet-5")).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("claude-sonnet-4-6")).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("claude-fable-5")).toBe(ONE_MILLION_CONTEXT);
  });

  test("dated point releases keep the family window", () => {
    expect(contextWindowForModel("claude-opus-4-8-20260101")).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("claude-opus-4-7-20260101")).toBe(ONE_MILLION_CONTEXT);
  });

  test("opus / sonnet aliases -> 1M (Opus 4.8 / Sonnet 5)", () => {
    expect(contextWindowForModel("opus")).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("sonnet")).toBe(ONE_MILLION_CONTEXT);
  });

  test("haiku alias and full id -> 200k", () => {
    expect(contextWindowForModel("haiku")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowForModel("claude-haiku-4-5")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowForModel("claude-haiku-4-5-20251001")).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  test("explicit -1m suffix -> 1M", () => {
    expect(contextWindowForModel("claude-sonnet-4-5-1m")).toBe(ONE_MILLION_CONTEXT);
  });

  test("unknown claude model -> conservative 200k miss", () => {
    expect(contextWindowForModel("claude-sonnet-4-0")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowForModel("custom-model")).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  test("undefined / empty -> 1M (codeoid default == opus family)", () => {
    expect(contextWindowForModel(undefined)).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel(null)).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("")).toBe(ONE_MILLION_CONTEXT);
  });

  test("case-insensitive", () => {
    expect(contextWindowForModel("Claude-Opus-4-8")).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("OPUS")).toBe(ONE_MILLION_CONTEXT);
  });
});
