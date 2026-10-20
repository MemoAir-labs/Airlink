export type FloorRequest = {
  agentId: string;
  kind: "reply" | "news";
  speak: () => Promise<void>;
};

export type FloorClock = {
  nowMs(): number;
  after(ms: number, run: () => void): () => void;
};

export const newsSilenceMs = 700;

const realClock: FloorClock = {
  nowMs: () => Date.now(),
  after: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

// Who may speak next in a call: people whenever they like, agents one at a time and only while no
// person is talking; an agent's own news waits for a quiet moment as well.
export function createFloor(clock: FloorClock = realClock) {
  const peopleTalking = new Set<string>();
  let queue: FloorRequest[] = [];
  let speaking: string | null = null;
  let quietSinceMs = clock.nowMs();
  let wake: (() => void) | null = null;

  const next = () => {
    wake?.();
    wake = null;
    if (speaking || peopleTalking.size > 0) {
      return;
    }
    const head = queue[0];
    if (!head) {
      return;
    }
    const quietForMs = clock.nowMs() - quietSinceMs;
    if (head.kind === "news" && quietForMs < newsSilenceMs) {
      wake = clock.after(newsSilenceMs - quietForMs, next);
      return;
    }
    queue = queue.slice(1);
    speaking = head.agentId;
    // Callers report their own failures; a rejection here must still free the floor.
    void head
      .speak()
      .catch(() => {})
      .finally(() => {
        speaking = null;
        quietSinceMs = clock.nowMs();
        next();
      });
  };

  return {
    personStarted(personId: string) {
      peopleTalking.add(personId);
    },
    personStopped(personId: string) {
      peopleTalking.delete(personId);
      quietSinceMs = clock.nowMs();
      next();
    },
    // A newer request replaces this agent's pending request of the same kind.
    request(request: FloorRequest) {
      queue = [
        ...queue.filter(
          (each) =>
            each.agentId !== request.agentId || each.kind !== request.kind
        ),
        request,
      ];
      next();
    },
    cancel(agentId: string) {
      queue = queue.filter((each) => each.agentId !== agentId);
    },
    speakingAgent: () => speaking,
  };
}

export type Floor = ReturnType<typeof createFloor>;
