import {
  Button,
  Input,
  Listbox,
  ListboxItem,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@heroui/react";
import { motion } from "framer-motion";
import { useState } from "react";
import type { Conversation } from "../lib/db";
import { t } from "../i18n";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";

const RAIL_WIDTH = "3rem";
const EXPANDED_WIDTH = "16rem";

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6h16z" />
    </svg>
  );
}

// Swallows the pointerdown/click before it bubbles to the ListboxItem's own
// press handling — otherwise pressing "rename" or "delete" also fires the
// item's onAction (resuming the wrong conversation).
function stopBubble(event: { stopPropagation: () => void }): void {
  event.stopPropagation();
}

function RenamePopover({
  conversation,
  onRename,
}: {
  conversation: Conversation;
  onRename: (id: string, title: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(conversation.title);

  return (
    <Popover
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setValue(conversation.title);
      }}
    >
      <PopoverTrigger>
        <button
          type="button"
          aria-label={t("convo.rename")}
          onPointerDown={stopBubble}
          onClick={stopBubble}
          className="rounded p-1 text-foreground-400 hover:text-foreground"
        >
          <PencilIcon />
        </button>
      </PopoverTrigger>
      <PopoverContent onPointerDown={stopBubble} onClick={stopBubble}>
        <form
          className="flex flex-col gap-2 p-2"
          onSubmit={(event) => {
            event.preventDefault();
            const title = value.trim();
            if (title.length > 0) onRename(conversation.id, title);
            setOpen(false);
          }}
        >
          <Input
            size="sm"
            aria-label={t("convo.rename")}
            value={value}
            onValueChange={setValue}
            autoFocus
          />
          <Button type="submit" size="sm" color="primary">
            {t("convo.rename")}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function DeletePopover({
  conversation,
  onDelete,
}: {
  conversation: Conversation;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <PopoverTrigger>
        <button
          type="button"
          aria-label={t("convo.delete")}
          onPointerDown={stopBubble}
          onClick={stopBubble}
          className="rounded p-1 text-foreground-400 hover:text-danger"
        >
          <TrashIcon />
        </button>
      </PopoverTrigger>
      <PopoverContent onPointerDown={stopBubble} onClick={stopBubble}>
        <div className="flex flex-col gap-2 p-2">
          <p className="max-w-56 text-sm">{t("convo.deleteConfirm")}</p>
          <Button
            size="sm"
            color="danger"
            className="self-end"
            onPress={() => {
              onDelete(conversation.id);
              setOpen(false);
            }}
          >
            {t("convo.delete")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  conversations: Conversation[];
  activeId: string | null;
  // The conversation currently generating an answer in the background, if
  // any — independent of `activeId` (the user may be viewing a different
  // conversation, or none, while this one keeps streaming).
  generatingId: string | null;
  // Conversations whose generation finished (successfully or with an error)
  // while the user was elsewhere — cleared once opened. See useChat's
  // UnreadOutcome doc. A row that's also `generatingId` shows the generating
  // dot instead (see the row rendering below) — it can't have a leftover
  // unread outcome from the run in progress.
  unreadOutcomes: Record<string, "done" | "error">;
  onNew: () => void;
  onResume: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

// One dot per row, in one of three states: warning/pulsing (generating),
// static success (answer ready), or static danger (answer failed). Pulsing
// is suppressed under reduced motion, matching the rest of the app.
function StatusDot({
  color,
  pulsing,
  label,
}: {
  color: "warning" | "success" | "danger";
  pulsing: boolean;
  label: string;
}) {
  const bg = { warning: "bg-warning", success: "bg-success", danger: "bg-danger" }[color];
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={`h-2 w-2 shrink-0 rounded-full ${bg} ${pulsing ? "animate-pulse" : ""}`}
    />
  );
}

export function Sidebar({
  collapsed,
  onToggle,
  conversations,
  activeId,
  generatingId,
  unreadOutcomes,
  onNew,
  onResume,
  onRename,
  onDelete,
}: SidebarProps) {
  const reducedMotion = usePrefersReducedMotion();

  return (
    <motion.nav
      aria-label={t("convo.section")}
      initial={false}
      animate={{ width: collapsed ? RAIL_WIDTH : EXPANDED_WIDTH }}
      transition={{ duration: reducedMotion ? 0 : 0.15, ease: "easeOut" }}
      // Below `lg` the sidebar overlays the chat instead of consuming grid
      // width (App.tsx's layout stacks there) — both the rail and the
      // expanded panel float above `main` on a positioned ancestor
      // (App.tsx's layout wrapper is `relative`). `lg+` reverts to the
      // original in-flow column, unchanged.
      className="absolute inset-y-0 left-0 z-20 flex flex-col overflow-hidden border-r border-divider bg-background lg:static lg:z-auto lg:bg-transparent"
    >
      {collapsed ? (
        <div className="flex flex-col items-center gap-2 py-3">
          <Button isIconOnly size="sm" variant="light" aria-label={t("convo.new")} onPress={onNew}>
            <PlusIcon />
          </Button>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label={t("convo.section")}
            onPress={onToggle}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-1">
            <h2 className="px-1 text-xs font-semibold uppercase text-foreground-500">
              {t("convo.section")}
            </h2>
            <div className="flex items-center gap-1">
              <Button isIconOnly size="sm" variant="light" aria-label={t("convo.new")} onPress={onNew}>
                <PlusIcon />
              </Button>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                aria-label={t("convo.section")}
                onPress={onToggle}
              >
                <ChevronLeftIcon />
              </Button>
            </div>
          </div>
          <Listbox
            aria-label={t("convo.section")}
            selectionMode="none"
            onAction={(key) => onResume(String(key))}
            className="min-h-0 flex-1 overflow-y-auto"
            itemClasses={{ base: "group" }}
          >
            {conversations.map((conversation) => (
              <ListboxItem
                key={conversation.id}
                textValue={conversation.title || t("convo.untitled")}
                className={
                  conversation.id === activeId
                    ? "border-l-3 border-primary"
                    : "border-l-3 border-transparent"
                }
                startContent={
                  conversation.id === generatingId ? (
                    <StatusDot color="warning" pulsing={!reducedMotion} label={t("sidebar.generating")} />
                  ) : unreadOutcomes[conversation.id] === "done" ? (
                    <StatusDot color="success" pulsing={false} label={t("sidebar.answerReady")} />
                  ) : unreadOutcomes[conversation.id] === "error" ? (
                    <StatusDot color="danger" pulsing={false} label={t("sidebar.answerFailed")} />
                  ) : undefined
                }
                endContent={
                  <div className="flex gap-0.5 opacity-0 group-hover:opacity-100">
                    <RenamePopover conversation={conversation} onRename={onRename} />
                    <DeletePopover conversation={conversation} onDelete={onDelete} />
                  </div>
                }
              >
                {conversation.title || t("convo.untitled")}
              </ListboxItem>
            ))}
          </Listbox>
        </div>
      )}
    </motion.nav>
  );
}
