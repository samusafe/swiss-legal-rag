import { useState } from "react";
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
}: {
  disabled: boolean;
  offline: boolean;
  streaming: boolean;
  onSend: (question: string) => void;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState("");
  const trimmed = draft.trim();

  function submit(): void {
    if (disabled || trimmed === "") return;
    onSend(trimmed);
    setDraft("");
  }

  return (
    <div className="p-3">
      <div className="flex items-end gap-2 rounded-sm border-2 border-foreground p-2">
        <Textarea
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
