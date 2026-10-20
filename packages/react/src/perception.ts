import type {
  FaceLandmarker,
  GestureRecognizer,
} from "@mediapipe/tasks-vision";

export type PerceptionSignal = {
  signal: "attention" | "gesture";
  value: string;
  score?: number;
};

const wasmBase =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const faceModel =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const gestureModel =
  "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";
const sampleIntervalMs = 500;
const eyesClosedThreshold = 0.5;

function blendshape(
  result: ReturnType<FaceLandmarker["detectForVideo"]>,
  name: string
): number {
  return (
    result.faceBlendshapes[0]?.categories.find((c) => c.categoryName === name)
      ?.score ?? 0
  );
}

// Client-side perception (P8): face and hand landmarks run in the person's own browser on their
// own camera; only the derived signal (present/away with a score, a named gesture) ever leaves
// the device. Nothing is sent while the person has it turned off.
export async function startPerception(
  video: HTMLVideoElement,
  onSignal: (signal: PerceptionSignal) => void
): Promise<() => void> {
  // Dynamic import: the vision bundle is several megabytes and only loads when a person turns
  // the signals on.
  const vision = await import("@mediapipe/tasks-vision");
  const fileset = await vision.FilesetResolver.forVisionTasks(wasmBase);
  const [face, gestures]: [FaceLandmarker, GestureRecognizer] =
    await Promise.all([
      vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: faceModel, delegate: "GPU" },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
      }),
      vision.GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: gestureModel, delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 1,
      }),
    ]);
  let lastAttention = "";
  let lastGesture = "";
  let stopped = false;
  const tick = () => {
    if (stopped) {
      return;
    }
    if (video.readyState >= 2 && video.videoWidth > 0) {
      const now = performance.now();
      const faces = face.detectForVideo(video, now);
      const present = faces.faceLandmarks.length > 0;
      const eyesOpen =
        1 -
        Math.max(
          blendshape(faces, "eyeBlinkLeft"),
          blendshape(faces, "eyeBlinkRight")
        );
      const attention = !present
        ? "away"
        : eyesOpen < eyesClosedThreshold
          ? "eyes-closed"
          : "present";
      const score = present ? Math.round(eyesOpen * 100) / 100 : 0;
      if (attention !== lastAttention) {
        lastAttention = attention;
        onSignal({ signal: "attention", value: attention, score });
      }
      const gesture = gestures.recognizeForVideo(video, now).gestures[0]?.[0];
      const name =
        gesture && gesture.categoryName !== "None" && gesture.score > 0.6
          ? gesture.categoryName
          : "";
      if (name && name !== lastGesture) {
        onSignal({ signal: "gesture", value: name, score: gesture?.score });
      }
      lastGesture = name;
    }
    setTimeout(tick, sampleIntervalMs);
  };
  tick();
  return () => {
    stopped = true;
    face.close();
    gestures.close();
  };
}
