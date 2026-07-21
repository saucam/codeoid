// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";

const requestMock = vi.hoisted(() => vi.fn());
const authMock = vi.hoisted(() => vi.fn());
vi.mock("../state/connection", () => ({
  send: vi.fn(),
  request: requestMock,
  newRequestId: () => "r",
  refreshSessions: vi.fn(() => Promise.resolve([])),
  authIdentity: authMock,
  getClient: () => {
    throw new Error("not bootstrapped");
  },
}));

// Pack state is daemon-canonical; the modal only reads `packsState().installed`
// and fires `fetchPacks()` on open. Mock both so the installed list is
// controllable per-test without a live daemon.
const packsHolder = vi.hoisted(() => ({ installed: [] as unknown[] }));
const fetchPacksMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../state/packs", () => ({
  fetchPacks: fetchPacksMock,
  packsState: () => ({
    installed: packsHolder.installed,
    available: [],
    registries: [],
    loading: false,
    busy: false,
    loaded: true,
    error: null,
  }),
}));

import type { PackWire } from "../protocol/types";
import NewSessionModal, { openNewSessionModal } from "./NewSessionModal";
import { _resetSessionsForTest } from "../state/sessions";

/** Minimal installed PackWire for the modal's pack/role selectors. */
function pack(p: Partial<PackWire> & Pick<PackWire, "id" | "name">): PackWire {
  return {
    version: "1.0.0",
    dir: `/cache/${p.id}`,
    trusted: false,
    selected: false,
    phases: [],
    roles: [],
    gates: [],
    active: true,
    ...p,
  };
}

function authOk(providers?: string[]) {
  return {
    type: "auth.ok",
    identity: { sub: "u", type: "human" },
    scopes: [],
    ...(providers ? { providers } : {}),
  };
}

afterEach(() => {
  cleanup();
  _resetSessionsForTest();
  requestMock.mockReset();
  authMock.mockReset();
  fetchPacksMock.mockClear();
  packsHolder.installed = [];
});

describe("NewSessionModal provider picker", () => {
  it("hides the picker when the daemon advertises no providers (legacy)", () => {
    authMock.mockReturnValue(authOk());
    const { queryByText } = render(() => <NewSessionModal />);
    openNewSessionModal();
    expect(queryByText("Backend")).toBeNull();
  });

  it("defaults to the first provider and omits providerId from the create", async () => {
    authMock.mockReturnValue(authOk(["claude", "pi"]));
    requestMock.mockResolvedValue({ id: "s-new", name: "n", workdir: "/w" });
    const { getByText, getByPlaceholderText } = render(() => <NewSessionModal />);
    openNewSessionModal();

    expect(getByText("claude (default)")).toBeTruthy();
    fireEvent.input(getByPlaceholderText("e.g. shield-refactor"), {
      target: { value: "demo" },
    });
    fireEvent.click(getByText("create"));
    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    const sent = requestMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.type).toBe("session.create");
    expect("providerId" in sent).toBe(false);
  });

  it("sends the chosen non-default provider", async () => {
    authMock.mockReturnValue(authOk(["claude", "pi"]));
    requestMock.mockResolvedValue({ id: "s-new", name: "n", workdir: "/w" });
    const { getByText, getByPlaceholderText } = render(() => <NewSessionModal />);
    openNewSessionModal();

    fireEvent.click(getByText("pi"));
    fireEvent.input(getByPlaceholderText("e.g. shield-refactor"), {
      target: { value: "pi-session" },
    });
    fireEvent.click(getByText("create"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session.create", providerId: "pi" }),
      ),
    );
  });
});

describe("NewSessionModal pack + role picker", () => {
  it("fetches packs on open and degrades to a subtle note when none are installed", () => {
    authMock.mockReturnValue(authOk());
    packsHolder.installed = [];
    const { queryByLabelText, getByText } = render(() => <NewSessionModal />);
    openNewSessionModal();

    // Fetch is kicked off on open (graceful even if it rejects).
    expect(fetchPacksMock).toHaveBeenCalled();
    // No pack <select> — just the subtle freestyle note.
    expect(queryByLabelText("Pack")).toBeNull();
    expect(getByText(/No packs installed/)).toBeTruthy();
  });

  it("renders installed packs as options and reveals roles once a pack is chosen", () => {
    authMock.mockReturnValue(authOk());
    packsHolder.installed = [
      pack({ id: "aif-sdlc", name: "AI Factory SDLC", roles: ["reviewer", "builder"] }),
    ];
    const { getByLabelText, queryByLabelText, getByText, queryByText } = render(
      () => <NewSessionModal />,
    );
    openNewSessionModal();

    // Pack <select> present with None + the installed pack.
    const packSel = getByLabelText("Pack") as HTMLSelectElement;
    expect(packSel).toBeTruthy();
    expect(getByText("None (freestyle)")).toBeTruthy();
    expect(getByText("AI Factory SDLC")).toBeTruthy();

    // Role select hidden until a pack is chosen.
    expect(queryByLabelText("Pack role")).toBeNull();
    expect(queryByText("Default (no role restriction)")).toBeNull();

    // Choose the pack → its roles surface.
    fireEvent.change(packSel, { target: { value: "aif-sdlc" } });
    expect(getByLabelText("Pack role")).toBeTruthy();
    expect(getByText("Default (no role restriction)")).toBeTruthy();
    expect(getByText("reviewer")).toBeTruthy();
    expect(getByText("builder")).toBeTruthy();
  });

  it("resets the chosen role when the pack changes", () => {
    authMock.mockReturnValue(authOk());
    packsHolder.installed = [
      pack({ id: "aif-sdlc", name: "AI Factory SDLC", roles: ["reviewer", "builder"] }),
    ];
    const { getByLabelText, queryByLabelText } = render(() => <NewSessionModal />);
    openNewSessionModal();

    const packSel = getByLabelText("Pack") as HTMLSelectElement;
    fireEvent.change(packSel, { target: { value: "aif-sdlc" } });
    const roleSel = getByLabelText("Pack role") as HTMLSelectElement;
    fireEvent.change(roleSel, { target: { value: "reviewer" } });
    expect((getByLabelText("Pack role") as HTMLSelectElement).value).toBe("reviewer");

    // Back to None hides the role select…
    fireEvent.change(packSel, { target: { value: "" } });
    expect(queryByLabelText("Pack role")).toBeNull();

    // …and re-choosing the pack starts from the default (role was reset).
    fireEvent.change(packSel, { target: { value: "aif-sdlc" } });
    expect((getByLabelText("Pack role") as HTMLSelectElement).value).toBe("");
  });

  it("includes pack + packRole in the create payload only when set", async () => {
    authMock.mockReturnValue(authOk());
    requestMock.mockResolvedValue({ id: "s-new", name: "n", workdir: "/w" });
    packsHolder.installed = [
      pack({ id: "aif-sdlc", name: "AI Factory SDLC", roles: ["reviewer"] }),
    ];
    const { getByLabelText, getByText, getByPlaceholderText } = render(() => (
      <NewSessionModal />
    ));
    openNewSessionModal();

    fireEvent.input(getByPlaceholderText("e.g. shield-refactor"), {
      target: { value: "review-run" },
    });
    fireEvent.change(getByLabelText("Pack") as HTMLSelectElement, {
      target: { value: "aif-sdlc" },
    });
    fireEvent.change(getByLabelText("Pack role") as HTMLSelectElement, {
      target: { value: "reviewer" },
    });
    fireEvent.click(getByText("create"));

    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.create",
        pack: "aif-sdlc",
        packRole: "reviewer",
      }),
    );
  });

  it("omits pack + packRole from the payload when left freestyle", async () => {
    authMock.mockReturnValue(authOk());
    requestMock.mockResolvedValue({ id: "s-new", name: "n", workdir: "/w" });
    packsHolder.installed = [pack({ id: "aif-sdlc", name: "AI Factory SDLC" })];
    const { getByText, getByPlaceholderText } = render(() => <NewSessionModal />);
    openNewSessionModal();

    fireEvent.input(getByPlaceholderText("e.g. shield-refactor"), {
      target: { value: "plain" },
    });
    fireEvent.click(getByText("create"));

    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    const sent = requestMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.type).toBe("session.create");
    expect("pack" in sent).toBe(false);
    expect("packRole" in sent).toBe(false);
  });
});
