import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  Select,
  SelectItem,
  Switch,
  Tab,
  Tabs,
} from "@heroui/react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import type { Key } from "react";
import type { useIngest } from "../hooks/useIngest";
import { useConversations } from "../hooks/useConversations";
import { t, useLang } from "../i18n";
import type { Lang } from "../i18n";
import type { Conversation, StoredMessage } from "../lib/db";
import { toJson, toMarkdown } from "../lib/exporter";
import { CANTONS, COVERED_CANTONS, getJurisdiction, setJurisdiction } from "../lib/jurisdiction";
import type { Jurisdiction } from "../lib/jurisdiction";
import { prefs } from "../lib/prefs";
import { logAudit } from "../lib/audit";
import { ActivityPanel } from "./ActivityPanel";
import { CorpusPanel } from "./CorpusPanel";

export type ExportFormat = "json" | "markdown";
export type ExportOutcome = { status: "written"; path: string } | { status: "cancelled" };

// The save-dialog + fs-write half of Export tab, pulled out of the component
// so it's directly unit-testable without driving HeroUI's Select (its
// overlay can't be opened interactively in a Modal under jsdom — see
// SettingsModal.test.tsx). Throws on failure; the component catches it.
//
// The write itself goes through a Rust command (`write_export`) instead of
// @tauri-apps/plugin-fs: the frontend holds no broad filesystem write
// permission (see capabilities/default.json), so the write happens in Rust
// on the exact path this save() dialog returned — the dialog is the user's
// consent, not a standing grant.
export async function exportConversation(
  conversation: Conversation,
  messages: StoredMessage[],
  format: ExportFormat,
): Promise<ExportOutcome> {
  const extension = format === "json" ? "json" : "md";
  const content =
    format === "json" ? toJson(conversation, messages) : toMarkdown(conversation, messages);
  const path = await save({
    defaultPath: `${conversation.title || "conversation"}.${extension}`,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  });
  if (path === null) return { status: "cancelled" };
  await invoke("write_export", { path, contents: content });
  return { status: "written", path };
}

const LANGS: readonly Lang[] = ["en", "de", "fr", "it", "pt"];
const LANG_LABELS: Record<Lang, string> = {
  en: "English",
  de: "Deutsch",
  fr: "Français",
  it: "Italiano",
  pt: "Português",
};

export function isLang(value: string): value is Lang {
  return (LANGS as readonly string[]).includes(value);
}

// HeroUI's Select fires onSelectionChange with a Set<Key> (overlay listbox)
// or the raw string value (its paired native <select> fallback) depending on
// how it was driven — normalize both shapes instead of naively destructuring
// a Set (which would silently split a raw string into its first character).
// Exported for direct unit testing: this is the one piece of the language
// Select's wiring that isn't itself a HeroUI/react-aria implementation
// detail, and — like the rest of the app's Select-in-Modal instances — its
// overlay can't be driven interactively under jsdom (see SettingsModal.test.tsx).
export function firstSelectionKey(keys: "all" | Set<Key> | string): string | null {
  if (keys === "all") return null;
  if (typeof keys === "string") return keys;
  const [first] = keys;
  return typeof first === "string" ? first : null;
}

// Exported for direct unit testing — same reasoning as firstSelectionKey/isLang:
// this is the jurisdiction Select's onSelectionChange mapping, pulled out
// because its overlay (where a canton is actually picked) can't be driven
// interactively inside a Modal under jsdom (see SettingsModal.test.tsx).
export function jurisdictionFromSelection(key: string): Jurisdiction {
  return { canton: key === "none" ? null : key, commune: null };
}

// Same reasoning: the "federal only" badge lives in a SelectItem's
// `description`, which only mounts once that (jsdom-unopenable) overlay is
// open — pulled out so the mapping itself stays directly testable.
export function cantonDescription(code: string): string | undefined {
  return COVERED_CANTONS.includes(code as (typeof COVERED_CANTONS)[number])
    ? undefined
    : t("settings.jurisdictionFederalOnly");
}

// Enabling notifications asks the OS for permission right away, so the user
// finds out immediately whether the toggle will actually do anything.
// Dynamically imported — same reasoning as useChat's notifyCompletion: keeps
// jsdom out of loading the real Tauri plugin for tests that never enable it.
async function requestNotificationPermission(): Promise<void> {
  const { isPermissionGranted, requestPermission } = await import(
    "@tauri-apps/plugin-notification"
  );
  if (!(await isPermissionGranted())) await requestPermission();
}

function GeneralTab() {
  const { lang, setLang } = useLang();
  const [notify, setNotify] = useState(() => prefs.get("notify", true));
  const [jurisdiction, setJurisdictionState] = useState(getJurisdiction);

  return (
    <div className="flex flex-col gap-4 py-2">
      <Select
        label={t("settings.language")}
        selectedKeys={new Set([lang])}
        onSelectionChange={(keys) => {
          const selected = firstSelectionKey(keys);
          if (selected !== null && isLang(selected)) setLang(selected);
        }}
      >
        {LANGS.map((code) => (
          <SelectItem key={code}>{LANG_LABELS[code]}</SelectItem>
        ))}
      </Select>
      <Select
        label={t("settings.jurisdiction")}
        selectedKeys={new Set([jurisdiction.canton ?? "none"])}
        onSelectionChange={(keys) => {
          const key = firstSelectionKey(keys);
          if (key === null) return;
          setJurisdiction(jurisdictionFromSelection(key));
          setJurisdictionState(getJurisdiction());
        }}
      >
        {[
          <SelectItem key="none">{t("settings.jurisdictionNone")}</SelectItem>,
          ...CANTONS.map((c) => (
            <SelectItem key={c.code} description={cantonDescription(c.code)}>
              {c.name}
            </SelectItem>
          )),
        ]}
      </Select>
      <p className="text-xs text-foreground-400">{t("settings.jurisdictionHint")}</p>
      <Switch
        isSelected={notify}
        onValueChange={(next) => {
          setNotify(next);
          prefs.set("notify", next);
          if (next) {
            requestNotificationPermission().catch((error: unknown) =>
              console.error("failed to request notification permission", error),
            );
          }
        }}
      >
        {t("settings.notifications")}
      </Switch>
      <p className="text-xs text-foreground-400">{t("settings.notifyHint")}</p>
    </div>
  );
}

function ExportTab() {
  const conversations = useConversations();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleExport(format: ExportFormat): Promise<void> {
    setError(null);
    setDone(false);
    if (selectedId === null) return;
    const conversation = conversations.conversations.find((c) => c.id === selectedId);
    if (conversation === undefined) return;
    try {
      const messages = await conversations.getMessages(selectedId);
      const outcome = await exportConversation(conversation, messages, format);
      if (outcome.status === "written") {
        setDone(true);
        logAudit("convo.export", { conversationId: selectedId, format });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <Select
        label={t("convo.section")}
        selectedKeys={selectedId !== null ? new Set([selectedId]) : new Set()}
        onSelectionChange={(keys) => setSelectedId(firstSelectionKey(keys))}
      >
        {conversations.conversations.map((conversation) => (
          <SelectItem key={conversation.id}>
            {conversation.title || t("convo.untitled")}
          </SelectItem>
        ))}
      </Select>
      <div className="flex gap-2">
        <Button isDisabled={selectedId === null} onPress={() => void handleExport("json")}>
          {t("export.json")}
        </Button>
        <Button isDisabled={selectedId === null} onPress={() => void handleExport("markdown")}>
          {t("export.markdown")}
        </Button>
      </div>
      {done && <p className="text-sm text-success">{t("export.done")}</p>}
      {error !== null && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}

export function SettingsModal({
  isOpen,
  onClose,
  ingest,
}: {
  isOpen: boolean;
  onClose: () => void;
  ingest: ReturnType<typeof useIngest>;
}) {
  return (
    // scrollBehavior="inside" caps the modal at viewport height (HeroUI's
    // `inside` variant adds max-h-[calc(100%-8rem)] to the modal and
    // overflow-y-auto to ModalBody) so the header/tabs always stay visible
    // and only the body scrolls — required at the 800x600 window floor,
    // where the Activity tab's content is taller than the viewport.
    <Modal isOpen={isOpen} onClose={onClose} size="lg" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>{t("settings.title")}</ModalHeader>
        <ModalBody className="pb-6">
          <Tabs aria-label={t("settings.title")}>
            <Tab key="general" title={t("settings.general")}>
              <GeneralTab />
            </Tab>
            <Tab key="corpus" title={t("settings.corpus")}>
              <CorpusPanel ingest={ingest} />
            </Tab>
            <Tab key="export" title={t("settings.export")}>
              <ExportTab />
            </Tab>
            <Tab key="activity" title={t("settings.activity")}>
              <ActivityPanel />
            </Tab>
          </Tabs>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
