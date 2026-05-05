import { describe, test, expect } from "bun:test";
import {
  DEFAULT_CONTEXT_WINDOW,
  ONE_MILLION_CONTEXT,
  contextWindowForModel,
} from "./context-windows";

describe("contextWindowForModel", () => {
  test("opus-4-7 explicit -> 1M", () => {
    expect(contextWindowForModel("claude-opus-4-7")).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("claude-opus-4-7-20260101")).toBe(ONE_MILLION_CONTEXT);
  });

  test("opus alias -> 1M (codeoid default)", () => {
    expect(contextWindowForModel("opus")).toBe(ONE_MILLION_CONTEXT);
  });

  test("sonnet / haiku aliases -> 200k", () => {
    expect(contextWindowForModel("sonnet")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowForModel("haiku")).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  test("default opus 4.x family -> 200k (no -1m suffix)", () => {
    expect(contextWindowForModel("claude-opus-4-6")).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  test("sonnet / haiku full ids -> 200k", () => {
    expect(contextWindowForModel("claude-sonnet-4-6")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowForModel("claude-haiku-4-5")).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  test("explicit -1m suffix -> 1M", () => {
    expect(contextWindowForModel("claude-sonnet-4-6-1m")).toBe(ONE_MILLION_CONTEXT);
  });

  test("unknown model -> conservative 200k miss", () => {
    expect(contextWindowForModel("custom-model")).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  test("undefined / empty -> 1M (codeoid default == opus-4-7)", () => {
    expect(contextWindowForModel(undefined)).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel(null)).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("")).toBe(ONE_MILLION_CONTEXT);
  });

  test("case-insensitive", () => {
    expect(contextWindowForModel("Claude-Opus-4-7")).toBe(ONE_MILLION_CONTEXT);
    expect(contextWindowForModel("OPUS")).toBe(ONE_MILLION_CONTEXT);
  });
});
