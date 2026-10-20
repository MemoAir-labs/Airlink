import { useLiveHost } from "../host";
import { LiveBrowserView } from "../LiveBrowserView";
import { LiveCanvasView } from "../LiveCanvasView";
import { LiveDesktopView } from "../LiveDesktopView";
import { LiveDocView } from "../LiveDocView";
import { LiveFileView } from "../LiveFileView";
import { LiveMediaView } from "../LiveMediaView";
import { LiveRunnerView } from "../LiveRunnerView";
import { LiveSheetView } from "../LiveSheetView";
import { LiveSlidesView } from "../LiveSlidesView";
import { LiveSpaceView } from "../LiveSpaceView";
import type { LiveDocViewProps } from "../liveViewShared";

// Any object, drawn by its kind: what a host that opens every kind renders. It imports every view,
// so it needs every optional peer; import one view's subpath to pay for less.
export function LiveObjectView(props: LiveDocViewProps) {
  const { connection } = useLiveHost().useConnection({ docId: props.docId });
  switch (connection?.liveDoc.kind) {
    case "sheet":
      return <LiveSheetView {...props} />;
    case "canvas":
      return <LiveCanvasView {...props} />;
    case "slides":
      return <LiveSlidesView {...props} />;
    case "browser":
      return <LiveBrowserView {...props} />;
    case "desktop":
      return <LiveDesktopView {...props} />;
    case "media":
      return <LiveMediaView {...props} />;
    case "file":
      return <LiveFileView {...props} />;
    case "runner":
      return <LiveRunnerView {...props} />;
    case "space":
      return (
        <LiveSpaceView
          {...props}
          renderObject={(object) => <LiveObjectView {...object} />}
        />
      );
    default:
      return <LiveDocView {...props} />;
  }
}
