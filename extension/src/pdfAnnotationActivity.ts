import type { AnnotationRef } from '@embedpdf/react/annotation';

export interface PdfFragment {
  readonly pageIndex: number;
  readonly pageObjectNumber: number;
  readonly rect: { x: number; y: number; width: number; height: number };
}

export type PdfAnnotationActivity = { readonly fragment: PdfFragment } & (
  | { readonly kind: 'comment' | 'commentEdited'; readonly comment: string }
  | { readonly kind: 'highlight' }
);

export interface PdfAnnotationUndo {
  readonly kind: 'undo';
  readonly operationId: string;
}

type Point = { x: number; y: number };
type HighlightQuad = { upperLeft: Point; upperRight: Point; lowerLeft: Point; lowerRight: Point };

export interface PdfAttribution {
  readonly author: string | null;
  readonly createdAt: string | null;
  readonly modifiedAt: string | null;
  readonly userId: string | null;
  readonly createdBy: string | null;
  readonly modifiedBy: string | null;
}

export interface SavedPdfHighlight {
  readonly pageObjectNumber: number;
  readonly name: string;
  readonly quadPoints: HighlightQuad[];
  readonly color: string;
  readonly opacity: number;
  readonly contents: string | null;
  readonly attribution?: PdfAttribution;
}

export interface SavedPdfCommentEdit {
  readonly ref: AnnotationRef;
  readonly contents: string;
  readonly editor: string;
}

export interface PdfReadingPosition {
  readonly pageIndex: number;
  readonly zoomPercent: number;
  readonly anchor: { readonly pageIndex: number; readonly fractionX: number; readonly fractionY: number };
}

export const openAnnotationActivityCommand = 'pdfutl.openAnnotationActivity';

export function isPdfFragment(value: unknown): value is PdfFragment {
  if (!value || typeof value !== 'object') return false;
  const { pageIndex, pageObjectNumber, rect } = value as Partial<PdfFragment>;
  return typeof pageIndex === 'number' && Number.isSafeInteger(pageIndex) && pageIndex >= 0 &&
    typeof pageObjectNumber === 'number' && Number.isSafeInteger(pageObjectNumber) && pageObjectNumber > 0 &&
    !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
}

export function isPdfAnnotationActivity(value: unknown): value is PdfAnnotationActivity {
  if (!value || typeof value !== 'object') return false;
  const activity = value as Partial<PdfAnnotationActivity>;
  return isPdfFragment(activity.fragment) && (activity.kind === 'highlight' ||
    ((activity.kind === 'comment' || activity.kind === 'commentEdited') &&
      typeof activity.comment === 'string' && activity.comment.trim().length > 0));
}

export function isPdfAnnotationId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}

export function isPdfAnnotationUndo(value: unknown): value is PdfAnnotationUndo {
  if (!value || typeof value !== 'object') return false;
  const undo = value as Partial<PdfAnnotationUndo>;
  return undo.kind === 'undo' && isPdfAnnotationId(undo.operationId);
}

export function isSavedPdfHighlight(value: unknown): value is SavedPdfHighlight {
  if (!value || typeof value !== 'object') return false;
  const { pageObjectNumber, name, quadPoints, color, opacity, contents, attribution } = value as Partial<SavedPdfHighlight>;
  return typeof pageObjectNumber === 'number' && Number.isSafeInteger(pageObjectNumber) && pageObjectNumber > 0 &&
    typeof name === 'string' && name.length > 0 && typeof color === 'string' &&
    typeof opacity === 'number' && opacity >= 0 && opacity <= 1 && (contents === null || typeof contents === 'string') &&
    (attribution === undefined || (!!attribution && ['author', 'createdAt', 'modifiedAt', 'userId', 'createdBy', 'modifiedBy'].every(field => {
      const text = attribution[field as keyof PdfAttribution];
      return text === null || typeof text === 'string';
    }))) &&
    Array.isArray(quadPoints) && quadPoints.length > 0 && quadPoints.every(quad => quad &&
      [quad.upperLeft, quad.upperRight, quad.lowerLeft, quad.lowerRight]
        .every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y)));
}


export function isSavedPdfCommentEdit(value: unknown): value is SavedPdfCommentEdit {
  if (!value || typeof value !== 'object') return false;
  const { ref, contents, editor } = value as Partial<SavedPdfCommentEdit>;
  return typeof contents === 'string' && contents.trim().length > 0 && typeof editor === 'string' && !!editor &&
    !!ref && ref.page?.kind === 'objectNumber' && Number.isSafeInteger(ref.page.objectNumber) && ref.page.objectNumber > 0 &&
    (ref.kind === 'objectNumber' ? Number.isSafeInteger(ref.objectNumber) && ref.objectNumber > 0 :
      ref.kind === 'baseIndex' && Number.isSafeInteger(ref.baseIndex) && ref.baseIndex >= 0);
}

export function pdfCommentKey(ref: AnnotationRef): string {
  return `${ref.page.objectNumber}:${ref.kind}:${ref.kind === 'objectNumber' ? ref.objectNumber : ref.baseIndex}`;
}

export function isPdfReadingPosition(value: unknown): value is PdfReadingPosition {
  if (!value || typeof value !== 'object') return false;
  const position = value as PdfReadingPosition;
  return Number.isSafeInteger(position.pageIndex) && position.pageIndex >= 0 &&
    Number.isFinite(position.zoomPercent) && position.zoomPercent > 0 &&
    !!position.anchor && Number.isSafeInteger(position.anchor.pageIndex) && position.anchor.pageIndex >= 0 &&
    [position.anchor.fractionX, position.anchor.fractionY].every(Number.isFinite);
}
