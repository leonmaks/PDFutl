import type { PdfOutlineRequest, PdfOutlineResponse } from './outlineProtocol';
import type { PdfAnnotationActivity, PdfFragment, PdfReadingPosition, SavedPdfCommentEdit, SavedPdfHighlight } from './pdfAnnotationActivity';

export type ViewerMessage =
  | { type: 'ready' }
  | { type: 'opened' }
  | { type: 'annotationSaved'; activity: PdfAnnotationActivity; highlights?: readonly SavedPdfHighlight[]; commentEdit?: Omit<SavedPdfCommentEdit, 'editor'> }
  | { type: 'readingPosition'; position: PdfReadingPosition }
  | PdfOutlineResponse
  | { type: 'openError'; message: string }
  | { type: 'exportedPdf'; requestId: string; bytes: ArrayBuffer }
  | { type: 'exportFailed'; requestId: string; message: string };

export type HostMessage =
  | { type: 'open'; name: string; bytes: ArrayBuffer; user: string; highlights: readonly SavedPdfHighlight[]; commentEdits: readonly SavedPdfCommentEdit[] }
  | PdfOutlineRequest
  | { type: 'revealFragment'; fragment: PdfFragment }
  | { type: 'focusFind' }
  | { type: 'togglePageComments' }
  | { type: 'exportPdf'; requestId: string }
  | { type: 'annotationSaveError'; message: string }
  | { type: 'error'; message: string }
  | { type: 'saved'; name: string };
