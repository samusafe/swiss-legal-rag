import { Button, Modal, ModalBody, ModalContent, ModalHeader, Progress } from "@heroui/react";
import type { IngestProgress } from "../hooks/useIngest";
import type { IngestStatus } from "../lib/api";

export function CorpusModal({
  isOpen,
  onClose,
  status,
  progress,
  running,
  error,
  onStart,
}: {
  isOpen: boolean;
  onClose: () => void;
  status: IngestStatus | null;
  progress: IngestProgress | null;
  running: boolean;
  error: string | null;
  onStart: () => void;
}) {
  const percent =
    progress !== null && progress.total > 0
      ? Math.round((100 * progress.done) / progress.total)
      : 0;
  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <ModalContent>
        <ModalHeader>Corpus</ModalHeader>
        <ModalBody className="gap-3 pb-6">
          {status !== null && (
            <p className="text-sm">{`${status.acts} acts · ${status.chunksTotal} articles · ${
              progress !== null && progress.phase === "embed"
                ? progress.done
                : status.chunksEmbedded
            } embedded`}</p>
          )}
          {progress !== null && (
            <Progress
              aria-label="Ingest progress"
              value={percent}
              label={`${progress.phase} · ${percent}%`}
              size="sm"
            />
          )}
          {error !== null && <p className="text-sm text-danger">{error}</p>}
          <Button color="primary" isDisabled={running} onPress={onStart}>
            Update corpus
          </Button>
          <p className="text-xs text-foreground-400">
            Chat stays usable — results may be incomplete while embedding.
          </p>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
