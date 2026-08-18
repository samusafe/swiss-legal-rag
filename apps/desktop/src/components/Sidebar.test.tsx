import { HeroUIProvider } from "@heroui/react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Conversation } from "../lib/db";
import { Sidebar } from "./Sidebar";

const CONVERSATIONS: Conversation[] = [
  { id: "c1", title: "First chat", createdAt: "t1", updatedAt: "t1" },
  { id: "c2", title: "", createdAt: "t2", updatedAt: "t2" },
];

function renderSidebar(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const props = {
    collapsed: false,
    onToggle: vi.fn(),
    conversations: CONVERSATIONS,
    activeId: null,
    generatingId: null,
    unreadOutcomes: {},
    onNew: vi.fn(),
    onResume: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  render(
    <HeroUIProvider>
      <Sidebar {...props} />
    </HeroUIProvider>,
  );
  return props;
}

describe("Sidebar (expanded)", () => {
  it("renders the conversations section heading and list from t()", () => {
    renderSidebar();

    expect(screen.getAllByText("Conversations").length).toBeGreaterThan(0);
    expect(screen.getByText("First chat")).toBeInTheDocument();
    expect(screen.getByText("Untitled conversation")).toBeInTheDocument();
  });

  it("shares one top row between the section heading and the + / collapse buttons", () => {
    renderSidebar();

    const heading = screen.getByRole("heading", { name: "Conversations" });
    const newButton = screen.getByRole("button", { name: "New conversation" });
    const collapseButton = screen.getByRole("button", { name: "Conversations" });

    expect(heading.parentElement).toBe(newButton.closest("div")?.parentElement);
    expect(newButton.closest("div")?.parentElement).toBe(collapseButton.closest("div")?.parentElement);
  });

  it("calls onNew when the new-conversation button is pressed", async () => {
    const user = userEvent.setup();
    const props = renderSidebar();

    await user.click(screen.getByRole("button", { name: "New conversation" }));

    expect(props.onNew).toHaveBeenCalledOnce();
  });

  it("calls onToggle when the collapse button is pressed", async () => {
    const user = userEvent.setup();
    const props = renderSidebar();

    await user.click(screen.getByRole("button", { name: "Conversations" }));

    expect(props.onToggle).toHaveBeenCalledOnce();
  });

  it("marks the active conversation with the primary left border", () => {
    renderSidebar({ activeId: "c1" });

    const active = screen.getByText("First chat").closest("li");
    const inactive = screen.getByText("Untitled conversation").closest("li");

    expect(active).toHaveClass("border-l-3", "border-primary");
    expect(inactive).toHaveClass("border-l-3", "border-transparent");
  });

  it("shows a pulsing status dot only on the conversation currently generating", () => {
    renderSidebar({ generatingId: "c2" });

    const generatingRow = screen.getByText("Untitled conversation").closest("li");
    const otherRow = screen.getByText("First chat").closest("li");
    if (generatingRow === null || otherRow === null) throw new Error("row not found");

    expect(within(generatingRow).getByRole("status", { name: "Generating…" })).toBeInTheDocument();
    expect(within(otherRow).queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the generating dot when generation starts AFTER the initial render", () => {
    // Runtime regression: the sidebar is already mounted when a send() flips
    // generatingId from null to an id — the dot must appear on that
    // re-render, not only when the prop is set at mount (the cases above).
    const props = {
      collapsed: false,
      onToggle: vi.fn(),
      conversations: CONVERSATIONS,
      activeId: null,
      generatingId: null as string | null,
      unreadOutcomes: {},
      onNew: vi.fn(),
      onResume: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
    };
    const view = render(
      <HeroUIProvider>
        <Sidebar {...props} />
      </HeroUIProvider>,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    view.rerender(
      <HeroUIProvider>
        <Sidebar {...props} generatingId="c1" />
      </HeroUIProvider>,
    );

    const row = screen.getByText("First chat").closest("li");
    if (row === null) throw new Error("row not found");
    expect(within(row).getByRole("status", { name: "Generating…" })).toBeInTheDocument();
  });

  it("shows a warning-colored pulsing dot on the generating conversation", () => {
    renderSidebar({ generatingId: "c1" });

    const dot = screen.getByRole("status", { name: "Generating…" });

    expect(dot).toHaveClass("bg-warning", "animate-pulse");
  });

  it("shows a static success dot for a conversation whose answer completed while the user was elsewhere", () => {
    renderSidebar({ unreadOutcomes: { c1: "done" } });

    const row = screen.getByText("First chat").closest("li");
    if (row === null) throw new Error("row not found");
    const dot = within(row).getByRole("status", { name: "Answer ready" });

    expect(dot).toHaveClass("bg-success");
    expect(dot).not.toHaveClass("animate-pulse");
  });

  it("shows a static danger dot for a conversation whose answer errored while the user was elsewhere", () => {
    renderSidebar({ unreadOutcomes: { c1: "error" } });

    const row = screen.getByText("First chat").closest("li");
    if (row === null) throw new Error("row not found");
    const dot = within(row).getByRole("status", { name: "Answer failed" });

    expect(dot).toHaveClass("bg-danger");
    expect(dot).not.toHaveClass("animate-pulse");
  });

  it("the generating dot wins over an unread outcome for the same conversation", () => {
    renderSidebar({ generatingId: "c1", unreadOutcomes: { c1: "done" } });

    const row = screen.getByText("First chat").closest("li");
    if (row === null) throw new Error("row not found");

    expect(within(row).getByRole("status", { name: "Generating…" })).toBeInTheDocument();
    expect(within(row).queryByRole("status", { name: "Answer ready" })).not.toBeInTheDocument();
  });

  it("resumes a conversation when its row is pressed", async () => {
    const user = userEvent.setup();
    const props = renderSidebar();

    await user.click(screen.getByText("First chat"));

    expect(props.onResume).toHaveBeenCalledWith("c1");
  });

  it("deletes a conversation through the Popover confirm", async () => {
    const user = userEvent.setup();
    const props = renderSidebar();

    const row = screen.getByText("First chat").closest("li");
    if (row === null) throw new Error("row not found");
    await user.click(within(row).getByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete this conversation? This cannot be undone.")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(props.onDelete).toHaveBeenCalledWith("c1");
    expect(props.onResume).not.toHaveBeenCalled();
  });

  it("renames a conversation through the Popover input", async () => {
    const user = userEvent.setup();
    const props = renderSidebar();

    const row = screen.getByText("First chat").closest("li");
    if (row === null) throw new Error("row not found");
    await user.click(within(row).getByRole("button", { name: "Rename" }));

    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByDisplayValue("First chat");
    await user.clear(input);
    await user.type(input, "Renamed chat");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));

    expect(props.onRename).toHaveBeenCalledWith("c1", "Renamed chat");
    expect(props.onResume).not.toHaveBeenCalled();
  });
});

describe("Sidebar (collapsed)", () => {
  it("hides the conversation list, showing only the icon rail (+ and expand — search moved to the header palette)", () => {
    renderSidebar({ collapsed: true });

    expect(screen.queryByText("First chat")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New conversation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Conversations" })).toBeInTheDocument();
    // Only the two rail buttons remain — no third (search) button.
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("calls onToggle from the rail's expand button", async () => {
    const user = userEvent.setup();
    const props = renderSidebar({ collapsed: true });

    await user.click(screen.getByRole("button", { name: "Conversations" }));

    expect(props.onToggle).toHaveBeenCalledOnce();
  });

  it("calls onNew from the rail without expanding first", async () => {
    const user = userEvent.setup();
    const props = renderSidebar({ collapsed: true });

    await user.click(screen.getByRole("button", { name: "New conversation" }));

    expect(props.onNew).toHaveBeenCalledOnce();
  });
});
