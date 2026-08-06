import { Button, Chip } from "@heroui/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Citation } from "../lib/api";

export function CitationChip({ citation }: { citation: Citation }) {
  if (!citation.resolved || citation.eli === null) {
    return (
      <Chip size="sm" variant="flat" className="mx-0.5 align-baseline">
        {citation.raw}
      </Chip>
    );
  }
  const eli = citation.eli;
  return (
    <Button
      size="sm"
      variant="flat"
      color="primary"
      className="mx-0.5 h-6 min-w-0 px-2 align-baseline"
      onPress={() =>
        openUrl(eli).catch((error: unknown) => console.error("failed to open URL", error))
      }
    >
      {citation.raw}
    </Button>
  );
}
