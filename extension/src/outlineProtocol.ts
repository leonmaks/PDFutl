export interface PdfBookmark {
  readonly id: number;
  readonly parentId: number | null;
  readonly title: string;
  readonly canNavigate: boolean;
}

export type PdfOutlineRequest =
  | { readonly type: 'pdfutl.requestOutline' }
  | { readonly type: 'pdfutl.revealBookmark'; readonly id: number };

export interface PdfOutlineResponse {
  readonly type: 'pdfutl.outline';
  readonly bookmarks: readonly PdfBookmark[];
}
