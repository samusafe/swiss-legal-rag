import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, StoredMessage } from "../lib/db";
import { useConversations } from "./useConversations";

vi.mock("../lib/db", () => ({
  listConversations: vi.fn(),
  createConversation: vi.fn(),
  renameConversation: vi.fn(),
  deleteConversation: vi.fn(),
  appendMessage: vi.fn(),
  getMessages: vi.fn(),
}));

import {
  appendMessage,
  createConversation,
  deleteConversation,
  getMessages,
  listConversations,
  renameConversation,
} from "../lib/db";

const listMock = vi.mocked(listConversations);
const createMock = vi.mocked(createConversation);
const renameMock = vi.mocked(renameConversation);
const deleteMock = vi.mocked(deleteConversation);
const appendMock = vi.mocked(appendMessage);
const getMessagesMock = vi.mocked(getMessages);

const CONVERSATION: Conversation = {
  id: "conv-1",
  title: "First chat",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("useConversations", () => {
  beforeEach(() => {
    listMock.mockReset();
    createMock.mockReset();
    renameMock.mockReset();
    deleteMock.mockReset();
    appendMock.mockReset();
    getMessagesMock.mockReset();
    listMock.mockResolvedValue([]);
  });

  it("loads the conversation list on mount", async () => {
    listMock.mockResolvedValue([CONVERSATION]);
    const { result } = renderHook(() => useConversations());
    await waitFor(() => expect(result.current.conversations).toEqual([CONVERSATION]));
  });

  it("create() inserts then refreshes the list, returning the new conversation", async () => {
    createMock.mockResolvedValue(CONVERSATION);
    listMock.mockResolvedValueOnce([]).mockResolvedValueOnce([CONVERSATION]);
    const { result } = renderHook(() => useConversations());
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    let created: Conversation | undefined;
    await act(async () => {
      created = await result.current.create("First chat");
    });

    expect(createMock).toHaveBeenCalledWith("First chat");
    expect(created).toEqual(CONVERSATION);
    expect(listMock).toHaveBeenCalledTimes(2); // mount + post-create refresh
    expect(result.current.conversations).toEqual([CONVERSATION]);
  });

  it("rename() updates then refreshes the list", async () => {
    const { result } = renderHook(() => useConversations());
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.rename("conv-1", "Renamed");
    });

    expect(renameMock).toHaveBeenCalledWith("conv-1", "Renamed");
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("remove() deletes then refreshes the list", async () => {
    const { result } = renderHook(() => useConversations());
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.remove("conv-1");
    });

    expect(deleteMock).toHaveBeenCalledWith("conv-1");
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("appendMessage() persists then refreshes the list", async () => {
    const message: Omit<StoredMessage, "id" | "createdAt"> = {
      conversationId: "conv-1",
      role: "user",
      content: "Hello",
      sourcesJson: null,
    };
    const { result } = renderHook(() => useConversations());
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.appendMessage(message);
    });

    expect(appendMock).toHaveBeenCalledWith(message);
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("getMessages() passes through to the store without refreshing the list", async () => {
    const stored: StoredMessage[] = [
      {
        id: "msg-1",
        conversationId: "conv-1",
        role: "assistant",
        content: "Hi",
        sourcesJson: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    getMessagesMock.mockResolvedValue(stored);
    const { result } = renderHook(() => useConversations());
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    let messages: StoredMessage[] = [];
    await act(async () => {
      messages = await result.current.getMessages("conv-1");
    });

    expect(getMessagesMock).toHaveBeenCalledWith("conv-1");
    expect(messages).toEqual(stored);
    expect(listMock).toHaveBeenCalledTimes(1); // unchanged — reads don't refresh
  });

  it("surfaces a rejected mount refresh as error state instead of an unhandled rejection", async () => {
    listMock.mockReset();
    listMock.mockRejectedValue(new Error("disk full"));
    const { result } = renderHook(() => useConversations());

    await waitFor(() => expect(result.current.error).toBe("disk full"));
    expect(result.current.conversations).toEqual([]);
  });

  it("propagates create() failures without swallowing them", async () => {
    createMock.mockRejectedValue(new Error("disk full"));
    const { result } = renderHook(() => useConversations());
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    await expect(
      act(async () => {
        await result.current.create("Doomed chat");
      }),
    ).rejects.toThrow("disk full");

    expect(listMock).toHaveBeenCalledTimes(1); // failed before the post-mutation refresh
  });
});
