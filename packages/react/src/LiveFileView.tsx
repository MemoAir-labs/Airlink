import { useEffect, useState } from "react";
import type { LiveHostFile } from "./host";
import { useLiveHost } from "./host";
import { LiveObjectFrame } from "./LiveObjectFrame";
import type { LiveDocViewProps } from "./liveViewShared";
import { liveDocIcon } from "./liveViewShared";
import { Button, Icon, Spinner } from "./ui";

const maxTextPreviewBytes = 1_000_000;

const isText = (mime: string) =>
  mime.startsWith("text/") ||
  ["application/json", "application/xml", "application/x-yaml"].includes(mime);

function formatBytes(sizeBytes: number) {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

function download(file: LiveHostFile) {
  const link = document.createElement("a");
  link.href = file.url;
  link.download = file.name;
  link.click();
}

// An uploaded file, shown the way the browser itself would: images, video, audio and PDFs
// natively, text as text, anything else as a card to download. It is read-only.
export function LiveFileView(props: LiveDocViewProps) {
  const file = useLiveHost().useFile?.(props.docId) ?? null;
  return (
    <LiveObjectFrame
      {...props}
      kindLabel="file"
      showHistory={false}
      onToggleHistory={() => undefined}
      menuItems={
        file ? [{ label: "Download", onClick: () => download(file) }] : []
      }
    >
      {() =>
        file ? (
          <FileBody file={file} />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        )
      }
    </LiveObjectFrame>
  );
}

export function FileBody({ file }: { file: LiveHostFile }) {
  const { mime, url, name } = file;
  if (mime.startsWith("image/")) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-muted-background p-2">
        <img
          src={url}
          alt={name}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }
  if (mime.startsWith("video/")) {
    return <video src={url} controls className="min-h-0 flex-1 bg-black" />;
  }
  if (mime.startsWith("audio/")) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <audio src={url} controls className="w-full max-w-md" />
      </div>
    );
  }
  if (mime === "application/pdf") {
    return (
      <iframe src={url} title={name} className="min-h-0 flex-1 border-0" />
    );
  }
  if (isText(mime) && file.sizeBytes <= maxTextPreviewBytes) {
    return <TextBody url={url} />;
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <Icon
        visual={liveDocIcon("file")}
        size="md"
        className="text-muted-foreground"
      />
      <div>
        <p className="text-sm font-medium">{name}</p>
        <p className="text-xs text-muted-foreground">
          {mime} · {formatBytes(file.sizeBytes)}
        </p>
      </div>
      <Button
        variant="outline"
        label="Download"
        onClick={() => download(file)}
      />
    </div>
  );
}

function TextBody({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch(url)
      .then((response) => (response.ok ? response.text() : ""))
      .then((body) => {
        if (!cancelled) {
          setText(body);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return text === null ? (
    <div className="flex flex-1 items-center justify-center">
      <Spinner />
    </div>
  ) : (
    <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs whitespace-pre-wrap">
      {text}
    </pre>
  );
}
