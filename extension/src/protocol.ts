import type { PdfOutlineRequest, PdfOutlineResponse } from './outlineProtocol';
import type { PdfAnnotationActivity, PdfAnnotationUndo, PdfFragment, PdfReadingPosition, SavedPdfCommentEdit, SavedPdfHighlight } from './pdfAnnotationActivity';

export type ViewerMessage =
  | { type: 'ready' }
  | { type: 'opened' }
  | { type: 'toggleFullscreen' }
  | { type: 'exitFullscreen' }
  | { type: 'annotationSaved'; id: string; activity: PdfAnnotationActivity | PdfAnnotationUndo;
      highlights?: readonly SavedPdfHighlight[]; updatesHighlight?: true; commentEdit?: Omit<SavedPdfCommentEdit, 'editor'> }
  | { type: 'readingPosition'; position: PdfReadingPosition }
  | PdfOutlineResponse
  | { type: 'openError'; message: string }
  | { type: 'exportedPdf'; requestId: string; bytes: ArrayBuffer }
  | { type: 'exportFailed'; requestId: string; message: string };

export type PdfViewCommand =
  | { type: 'focusFind' | 'focusPageNumber' | 'togglePageComments' | 'undoAnnotation' | 'addComment' | 'highlightSelection' }
  | { type: 'moveSearch'; direction: 1 | -1 }
  | { type: 'zoomPdf'; action: 'in' | 'out' | 'actualSize' | 'fitPage' };

export type HostMessage =
  | { type: 'open'; name: string; bytes: ArrayBuffer; user: string; highlights: readonly SavedPdfHighlight[]; commentEdits: readonly SavedPdfCommentEdit[] }
  | PdfOutlineRequest
  | { type: 'revealFragment'; fragment: PdfFragment }
  | PdfViewCommand
  | { type: 'pdfutl.fullscreen'; active: boolean }
  | { type: 'exportPdf'; requestId: string }
  | { type: 'annotationSaveResult'; id: string; error?: string }
  | { type: 'error'; message: string }
  | { type: 'saved'; name: string };
