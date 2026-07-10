/**
 * Subprocess fixture for canonical-sdk-compat.test.ts.
 *
 * Runs the REAL @google/generative-ai chat-history validation
 * (validateChatHistory, invoked synchronously by the ChatSession
 * constructor) against a history passed as JSON in argv[2], and prints
 * "ok" or "threw". Runs in its own process because provider-gemini.test.ts
 * installs a process-global `mock.module("@google/generative-ai", …)` —
 * inside the test runner, whether an import sees the real SDK depends on
 * test-file execution order.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

const history = JSON.parse(process.argv[2] ?? "[]");
const model = new GoogleGenerativeAI("offline-test-key").getGenerativeModel({
  model: "gemini-2.0-flash",
});

try {
  model.startChat({ history });
  console.log("ok");
} catch (err) {
  console.log(`threw: ${err instanceof Error ? err.message : String(err)}`);
}
