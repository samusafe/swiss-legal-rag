import { useEffect, useRef, useState } from "react";
import { Button, Textarea } from "@heroui/react";
import { t } from "../i18n";

function ArrowIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-3.5 w-3.5"
      aria-hidden="true"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function Composer({
  disabled,
  offline,
  streaming,
  onSend,
  onStop,
  focusSignal = 0,
}: {
  disabled: boolean;
  offline: boolean;
  streaming: boolean;
  onSend: (question: string) => void;
  onStop: () => void;
  // Bumped by the parent (e.g. on "+"/Ctrl+N) to move focus into the
  // composer — a plain prop change alone wouldn't otherwise trigger an
  // effect here.
  focusSignal?: number;
}) {
  const [draft, setDraft] = useState("");
  const trimmed = draft.trim();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusSignal === 0) return; // skip the initial mount
    textareaRef.current?.focus();
  }, [focusSignal]);

  function submit(): void {
    if (disabled || trimmed === "") return;
    onSend(trimmed);
    setDraft("");
  }

  return (
    <div className="p-3">
      <div className="flex items-end gap-2 rounded-sm border-2 border-foreground p-2">
        <Textarea
          ref={textareaRef}
          value={draft}
          onValueChange={setDraft}
          minRows={1}
          maxRows={6}
          placeholder={offline ? t("composer.offline") : t("composer.placeholder")}
          isDisabled={disabled}
          classNames={{ inputWrapper: "border-none bg-transparent shadow-none px-1" }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {streaming ? (
          <Button color="danger" aria-label={t("composer.stop")} onPress={onStop}>
            {"■︎"} {t("composer.stop")}
          </Button>
        ) : (
          <Button color="primary" isDisabled={disabled || trimmed === ""} onPress={submit}>
            Send
            <ArrowIcon />
          </Button>
        )}
      </div>
    </div>
  );
}
