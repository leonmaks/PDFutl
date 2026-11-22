import 'vscode';

// Timeline is stable in the pinned Code-OSS build and newer than @types/vscode here.
declare module 'vscode' {
  export interface TimelineItem {
    id: string;
    timestamp: number;
    label: string;
    description?: string;
    tooltip?: string;
    iconPath?: ThemeIcon;
    resourceUri?: Uri;
    command?: Command;
  }

  export interface Timeline {
    readonly items: readonly TimelineItem[];
    readonly cursor?: string;
  }

  export interface TimelineOptions {
    readonly limit?: number;
    readonly cursor?: string;
  }

  export interface TimelineProvider {
    readonly onDidChangeTimeline?: Event<Uri | Uri[] | undefined>;
    provideTimeline(uri: Uri, options: TimelineOptions, token: CancellationToken): ProviderResult<Timeline>;
  }

  export namespace workspace {
    export function registerTimelineProvider(id: string, label: string, scheme: string, provider: TimelineProvider): Disposable;
  }
}
