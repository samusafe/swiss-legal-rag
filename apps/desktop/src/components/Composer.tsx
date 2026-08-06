import { useState } from "react";
import { Button, Textarea } from "@heroui/react";

export function Composer({
  disabled,
  offline,
  onSend,
}: {
  disabled: boolean;
  offline: boolean;
  onSend: (question: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const trimmed = draft.trim();

  function submit(): void {
    if (disabled || trimmed === "") return;
    onSend(trimmed);
    setDraft("");
  }

  return (
    <div className="flex items-end gap-2 border-t border-divider p-4">
      <Textarea
        value={draft}
        onValueChange={setDraft}
        minRows={1}
        maxRows={6}
        placeholder={
          offline ? "Start the retrieval API to ask questions" : "Ask about Swiss federal law…"
        }
        isDisabled={disabled}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <Button color="primary" isDisabled={disabled || trimmed === ""} onPress={submit}>
        Send
      </Button>
    </div>
  );
}
