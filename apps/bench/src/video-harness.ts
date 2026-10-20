import { connectBrowserVideo } from "@memo-air/browser/video";

// Runs inside the bench's Chrome on the browser container's own origin: joins the video the way
// the Memoair viewer does and watches every presented frame for a change, so the Node side can
// arm a sample, send a scroll on the doc socket and read when the picture moved.
const sampleWidth = 64;
const sampleHeight = 40;
// A scroll moves most of a text page's pixels; VP8 re-encoding a still page drifts a few levels.
const changeThreshold = 12;

export async function start({ url, token }: { url: string; token: string }) {
  const box = document.createElement("div");
  box.style.cssText =
    "position:relative;width:1280px;height:800px;background:#000";
  document.body.replaceChildren(box);
  const { client } = await connectBrowserVideo({ url, token, container: box });
  const video = box.querySelector("video");
  if (!video) {
    throw new Error("the transport attached no video element");
  }
  const canvas = document.createElement("canvas");
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("no 2d context");
  }
  let last: Uint8ClampedArray | null = null;
  let armedAt = 0;
  let changedAt = 0;
  let idleChanges = 0;
  const onFrame = () => {
    context.drawImage(video, 0, 0, sampleWidth, sampleHeight);
    const { data } = context.getImageData(0, 0, sampleWidth, sampleHeight);
    let diff = 0;
    if (last) {
      for (let i = 0; i < data.length; i += 4) {
        diff += Math.abs(data[i] - last[i]);
      }
      diff /= data.length / 4;
    }
    const first = last === null;
    last = data;
    if (!first && diff >= changeThreshold) {
      if (armedAt) {
        changedAt = Date.now();
        armedAt = 0;
      } else {
        idleChanges += 1;
      }
    }
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
  return {
    arm() {
      armedAt = Date.now();
      changedAt = 0;
    },
    result() {
      const quality = video.getVideoPlaybackQuality();
      return {
        changedAt,
        idleChanges,
        playing: client.state.video.playing,
        totalFrames: quality.totalVideoFrames,
        droppedFrames: quality.droppedVideoFrames,
      };
    },
  };
}
