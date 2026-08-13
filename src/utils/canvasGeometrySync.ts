export type CanvasGeometrySyncState = {
  isCurrentEditorProject: boolean;
  restoredDocument: boolean;
  forceServerGeometry?: boolean;
  documentChangeVersion: number;
  savedChangeVersion: number;
  hasQueuedDocumentSave: boolean;
  hasDocumentSaveInFlight: boolean;
};

/**
 * Existing canonical shapes temporarily own their geometry while the local
 * document has unsaved work. Business refreshes may still update their labels
 * and metadata; initial/explicit restores and clean documents use the server.
 */
export const shouldPreserveLocalCanvasGeometry = ({
  isCurrentEditorProject,
  restoredDocument,
  forceServerGeometry = false,
  documentChangeVersion,
  savedChangeVersion,
  hasQueuedDocumentSave,
  hasDocumentSaveInFlight,
}: CanvasGeometrySyncState) => isCurrentEditorProject
  && !restoredDocument
  && !forceServerGeometry
  && (
    documentChangeVersion > savedChangeVersion
    || hasQueuedDocumentSave
    || hasDocumentSaveInFlight
  );
