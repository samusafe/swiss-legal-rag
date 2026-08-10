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
