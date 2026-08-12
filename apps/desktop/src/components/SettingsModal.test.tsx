import { HeroUIProvider } from "@heroui/react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { useIngest } from "../hooks/useIngest";
import { setLang } from "../i18n";
import { exportConversation, firstSelectionKey, isLang, SettingsModal } from "./SettingsModal";

vi.mock("../lib/db", () => ({
  listConversations: vi.fn(),
  createConversation: vi.fn(),
  renameConversation: vi.fn(),
  deleteConversation: vi.fn(),
  appendMessage: vi.fn(),
  getMessages: vi.fn(),
  // lib/audit.ts imports isTauri from here — handleExport's convo.export
  // logAudit() call would throw calling undefined() without this.
  isTauri: () => false,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { listConversations, getMessages } from "../lib/db";

const listConversationsMock = vi.mocked(listConversations);
const getMessagesMock = vi.mocked(getMessages);
const saveMock = vi.mocked(save);
const invokeMock = vi.mocked(invoke);
const isPermissionGrantedMock = vi.mocked(isPermissionGranted);
const requestPermissionMock = vi.mocked(requestPermission);

const IDLE_STATUS = {
  running: false,
  phase: null,
  acts: 10,
  chunksTotal: 12930,
  chunksEmbedded: 5420,
};

function makeIngest(
  overrides: Partial<ReturnType<typeof useIngest>> = {},
): ReturnType<typeof useIngest> {
  return {
    status: IDLE_STATUS,
    progress: null,
    running: false,
    error: null,
    start: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  };
}

const CONVERSATION = {
  id: "conv-1",
  title: "Kündigungsfrist?",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
};

const MESSAGES = [
  {
    id: "m1",
    conversationId: "conv-1",
    role: "user" as const,
    content: "Wie lang ist die Kündigungsfrist?",
    sourcesJson: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

function renderModal(overrides: Partial<Parameters<typeof SettingsModal>[0]> = {}) {
  const props = {
    isOpen: true,
    onClose: vi.fn(),
    ingest: makeIngest(),
    ...overrides,
  };
  render(
    <HeroUIProvider>
      <SettingsModal {...props} />
    </HeroUIProvider>,
  );
  return props;
}

// `label` is associated with both the visually-hidden native <select> and
// (via aria-labelledby) the animated trigger button — scope to the <select>.
// Note: HeroUI's Select overlay can't be opened interactively inside a Modal
// under jsdom in this dependency combination (verified with a minimal
// Select-in-Modal repro outside this suite: the listbox mounts into the DOM —
// confirmed via innerHTML — but is excluded from the accessibility tree, so
// no role="option" is ever queryable, and driving the paired native <select>
// via fireEvent/userEvent.selectOptions truncates multi-character values to
// their first character inside HeroUI's own key-normalization). That's a
// third-party/jsdom limitation, not an app defect: firstSelectionKey/isLang
// and exportConversation (the actual logic on our side of that boundary) are
// unit-tested directly below instead.
function nativeSelect(label: string): HTMLSelectElement {
  return screen.getByLabelText(label, { selector: "select" }) as HTMLSelectElement;
}

describe("SettingsModal", () => {
  beforeEach(() => {
    setLang("en");
    localStorage.clear();
    listConversationsMock.mockReset();
    getMessagesMock.mockReset();
    saveMock.mockReset();
    invokeMock.mockReset();
    isPermissionGrantedMock.mockReset();
    requestPermissionMock.mockReset();
    listConversationsMock.mockResolvedValue([CONVERSATION]);
    getMessagesMock.mockResolvedValue(MESSAGES);
    isPermissionGrantedMock.mockResolvedValue(true);
  });

  it("does not render its content while closed", () => {
    renderModal({ isOpen: false });

    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
  });

  it("renders General, Corpus and Export tabs", () => {
    renderModal();

    expect(screen.getByRole("tab", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Corpus" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Export" })).toBeInTheDocument();
  });

  // Responsiveness fix: without scrollBehavior="inside", HeroUI's Modal has
  // no max-height, so tall content (the Activity tab) can grow the modal
  // past the viewport and push its header/tabs off-screen at the 800x600
  // window floor. scrollBehavior="inside" caps the dialog at
  // max-h-[calc(100%-8rem)] and scrolls the body instead.
  it("caps the modal at the viewport height instead of growing past it", () => {
    renderModal();

    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("max-h-[calc(100%_-_8rem)]");
  });

  it("shows the Corpus tab's panel content (ported CorpusPanel behavior)", async () => {
    const user = userEvent.setup();
    renderModal({ ingest: makeIngest({ error: "`ingest fetch` failed (exit 1): BOOM" }) });

    await user.click(screen.getByRole("tab", { name: "Corpus" }));

    expect(screen.getByRole("button", { name: "Run ingestion" })).toBeInTheDocument();
    expect(screen.getByText("`ingest fetch` failed (exit 1): BOOM")).toBeInTheDocument();
  });

  it("shows the current language as selected and lists all five, including European Portuguese", () => {
    renderModal();

    const select = nativeSelect("Language");
    expect(select.value).toBe("en");
    expect([...select.options].map((option) => option.value)).toEqual([
      "",
      "en",
      "de",
      "fr",
      "it",
      "pt",
    ]);
    expect(within(select).getByText("Português")).toBeInTheDocument();
  });

  it("persists the notifications toggle and defaults it on", () => {
    renderModal();

    const toggle = screen.getByRole("switch", { name: "Notifications" });
    expect(toggle).toBeChecked();
  });

  it("requests OS notification permission when notifications are enabled", async () => {
    localStorage.setItem("slr.notify", "false");
    isPermissionGrantedMock.mockResolvedValue(false);
    const user = userEvent.setup();
    renderModal();

    const toggle = screen.getByRole("switch", { name: "Notifications" });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);

    expect(localStorage.getItem("slr.notify")).toBe("true");
    await vi.waitFor(() => expect(requestPermissionMock).toHaveBeenCalledOnce());
  });

  it("does not request permission when notifications are toggled off", async () => {
    const user = userEvent.setup();
    renderModal();

    const toggle = screen.getByRole("switch", { name: "Notifications" });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    expect(localStorage.getItem("slr.notify")).toBe("false");
    expect(requestPermissionMock).not.toHaveBeenCalled();
  });

  it("lists conversations and disables the export buttons until one is selected", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByRole("tab", { name: "Export" }));

    await screen.findByText("Kündigungsfrist?"); // conversations loaded
    expect(screen.getByRole("button", { name: "Export as JSON" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export as Markdown" })).toBeDisabled();
  });
});

describe("firstSelectionKey", () => {
  it("returns null for the 'all' selection", () => {
    expect(firstSelectionKey("all")).toBeNull();
  });

  it("returns the string as-is when driven via the native <select> fallback", () => {
    expect(firstSelectionKey("de")).toBe("de");
  });

  it("returns the first (only) key from a Set, as produced by the overlay listbox", () => {
    expect(firstSelectionKey(new Set(["conv-1"]))).toBe("conv-1");
  });

  it("returns null for an empty Set", () => {
    expect(firstSelectionKey(new Set())).toBeNull();
  });

  it("returns null when the first key is not a string", () => {
    expect(firstSelectionKey(new Set([42]))).toBeNull();
  });
});

describe("isLang", () => {
  it("accepts all five supported language codes", () => {
    for (const code of ["en", "de", "fr", "it", "pt"]) {
      expect(isLang(code)).toBe(true);
    }
  });

  it("rejects unknown codes, including a truncated first character", () => {
    expect(isLang("d")).toBe(false);
    expect(isLang("xx")).toBe(false);
    expect(isLang("")).toBe(false);
  });
});

describe("exportConversation", () => {
  beforeEach(() => {
    saveMock.mockReset();
    invokeMock.mockReset();
  });

  it("writes JSON to the chosen path and reports it", async () => {
    saveMock.mockResolvedValue("C:/Users/me/Downloads/convo.json");

    const outcome = await exportConversation(CONVERSATION, MESSAGES, "json");

    expect(outcome).toEqual({ status: "written", path: "C:/Users/me/Downloads/convo.json" });
    const [command, args] = invokeMock.mock.calls[0] as [string, { path: string; contents: string }];
    expect(command).toBe("write_export");
    expect(args.path).toBe("C:/Users/me/Downloads/convo.json");
    expect(JSON.parse(args.contents)).toEqual({ conversation: CONVERSATION, messages: MESSAGES });
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "Kündigungsfrist?.json" }),
    );
  });

  it("writes Markdown to the chosen path", async () => {
    saveMock.mockResolvedValue("C:/Users/me/Downloads/convo.md");

    const outcome = await exportConversation(CONVERSATION, MESSAGES, "markdown");

    expect(outcome).toEqual({ status: "written", path: "C:/Users/me/Downloads/convo.md" });
    const [, args] = invokeMock.mock.calls[0] as [string, { path: string; contents: string }];
    expect(args.contents).toContain("**You:** Wie lang ist die Kündigungsfrist?");
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "Kündigungsfrist?.md" }),
    );
  });

  it("writes to a path outside Downloads just as readily — the write is not assumed to be Downloads-only", async () => {
    // Regression for C1: the fs:allow-write-text-file capability used to be
    // scoped to $DOWNLOAD/*, but save() opens a free-form dialog with no
    // directory component, so it can just as easily return a Documents (or
    // any other) path. Every prior test here used a Downloads-shaped fixture
    // path, which is exactly why that scope mismatch never surfaced. The fix
    // moved the write into a Rust command with no frontend fs permission at
    // all, so this now guards against the write being silently narrowed
    // again (e.g. by scoping the Rust side to a specific directory).
    saveMock.mockResolvedValue("C:/Users/me/Documents/convo.json");

    const outcome = await exportConversation(CONVERSATION, MESSAGES, "json");

    expect(outcome).toEqual({ status: "written", path: "C:/Users/me/Documents/convo.json" });
    expect(invokeMock).toHaveBeenCalledWith("write_export", {
      path: "C:/Users/me/Documents/convo.json",
      contents: expect.any(String),
    });
  });

  it("does not write a file when the save dialog is cancelled", async () => {
    saveMock.mockResolvedValue(null);

    const outcome = await exportConversation(CONVERSATION, MESSAGES, "json");

    expect(outcome).toEqual({ status: "cancelled" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("propagates a rejected write_export invoke instead of swallowing it — this is what ExportTab.handleExport catches to set its visible error state", async () => {
    saveMock.mockResolvedValue("C:/Users/me/Downloads/convo.json");
    invokeMock.mockRejectedValue(new Error("failed to write C:/Users/me/Downloads/convo.json: Access is denied. (os error 5)"));

    await expect(exportConversation(CONVERSATION, MESSAGES, "json")).rejects.toThrow(
      "Access is denied. (os error 5)",
    );
  });
});
