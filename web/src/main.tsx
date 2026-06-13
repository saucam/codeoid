/* @refresh reload */
import { render } from "solid-js/web";
import "./index.css";
import App from "./App.tsx";

// Telegram Mini App init: when running inside Telegram, expand to full height
// (it otherwise opens as a short dialog) and disable swipe-down-to-minimize so
// scrolling the transcript doesn't accidentally close the app.
const tg = (
  window as unknown as { Telegram?: { WebApp?: Record<string, unknown> } }
).Telegram?.WebApp;
if (tg) {
  try {
    (tg.ready as (() => void) | undefined)?.();
    (tg.expand as (() => void) | undefined)?.();
    (tg.disableVerticalSwipes as (() => void) | undefined)?.();
  } catch {
    /* older Telegram clients may lack some methods — non-fatal */
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing — index.html out of sync with main.tsx");

render(() => <App />, root);
