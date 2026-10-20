import { createHash } from "node:crypto";
import { z } from "zod";

// A decision node answers typed questions about a block of text with calibrated probabilities and
// no prose: the harness decides, the model talks. Laya and Jev speak the same wire
// (POST /v1/systemone), so one provider covers both; a decision is allowed to have no opinion, and
// every caller treats that as "fall through", never as an answer. Nothing here throws or hangs.

export type Question =
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string>;
    }
  | {
      type: "noul";
      instructions: string;
      criteria?: { true: string; false: string };
    }
  | { type: "score"; instructions: string; levels: string[] };

export type DecideInput = {
  point?: string;
  state: string;
  questions: Record<string, Question>;
};

const choiceAnswerSchema = z.object({
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()).optional(),
});
const noulAnswerSchema = z.object({ noul: z.number() });
const scoreAnswerSchema = z.object({ score: z.number() });

export type Answer =
  | ({ type: "choice" } & z.infer<typeof choiceAnswerSchema>)
  | ({ type: "noul" } & z.infer<typeof noulAnswerSchema>)
  | ({ type: "score" } & z.infer<typeof scoreAnswerSchema>);

export type Decision = {
  provider: string;
  ms: number;
  answers: Record<string, Answer> | null;
  error?: string;
};

export type Decide = (input: DecideInput) => Promise<Decision>;

const responseSchema = z.object({ answers: z.record(z.string(), z.unknown()) });

function parseAnswer(question: Question, raw: unknown): Answer | null {
  switch (question.type) {
    case "choice": {
      const parsed = choiceAnswerSchema.safeParse(raw);
      return parsed.success ? { type: "choice", ...parsed.data } : null;
    }
    case "noul": {
      const parsed = noulAnswerSchema.safeParse(raw);
      return parsed.success ? { type: "noul", ...parsed.data } : null;
    }
    case "score": {
      const parsed = scoreAnswerSchema.safeParse(raw);
      return parsed.success ? { type: "score", ...parsed.data } : null;
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

export function systemOneProvider({
  name,
  url,
  apiKey,
  model,
  timeoutMs = 1500,
}: {
  name: string;
  url: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}): Decide {
  return async ({ state, questions }) => {
    const startedAt = performance.now();
    const done = (
      answers: Record<string, Answer> | null,
      error?: string
    ): Decision => ({
      provider: name,
      ms: Math.round(performance.now() - startedAt),
      answers,
      ...(error ? { error } : {}),
    });
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          ...(model ? { model } : {}),
          state,
          questions,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        return done(null, `${name} responded ${response.status}`);
      }
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) {
        return done(null, `${name} response did not match the wire`);
      }
      const answers: Record<string, Answer> = {};
      for (const [id, question] of Object.entries(questions)) {
        const answer = parseAnswer(question, parsed.data.answers[id]);
        if (!answer) {
          return done(null, `${name} gave no usable answer for ${id}`);
        }
        answers[id] = answer;
      }
      return done(answers);
    } catch (error) {
      return done(null, errorText(error));
    }
  };
}

export const noOpinion: Decide = async () => ({
  provider: "none",
  ms: 0,
  answers: null,
  error: "no decision provider configured",
});

function isUnsure(
  answers: Record<string, Answer>,
  belowConfidence: number
): boolean {
  return Object.values(answers).some(
    (answer) => answer.type === "choice" && answer.confidence < belowConfidence
  );
}

// The fallback is asked when the primary has no opinion, or when any of its choices sits under
// the band; an unsure primary still beats a fallback with nothing to say.
export function withFallback(
  primary: Decide,
  fallback: Decide,
  { belowConfidence = 0 }: { belowConfidence?: number } = {}
): Decide {
  return async (input) => {
    const first = await primary(input);
    if (first.answers && !isUnsure(first.answers, belowConfidence)) {
      return first;
    }
    const second = await fallback(input);
    return second.answers || !first.answers ? second : first;
  };
}

export type DecisionRecord = {
  point: string;
  stateHash: string;
  questions: Record<string, Question>;
  answers: Record<string, Answer> | null;
  provider: string;
  ms: number;
  error?: string;
};

const questionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    instructions: z.string(),
    criteria: z.record(z.string(), z.string()),
  }),
  z.object({
    type: z.literal("noul"),
    instructions: z.string(),
    criteria: z.object({ true: z.string(), false: z.string() }).optional(),
  }),
  z.object({
    type: z.literal("score"),
    instructions: z.string(),
    levels: z.array(z.string()),
  }),
]);

const answerSchema = z.discriminatedUnion("type", [
  choiceAnswerSchema.extend({ type: z.literal("choice") }),
  noulAnswerSchema.extend({ type: z.literal("noul") }),
  scoreAnswerSchema.extend({ type: z.literal("score") }),
]);

// The wire a host uses to hand its own decisions to live-server's `live_decisions`.
export const decisionRecordSchema = z.object({
  point: z.string().max(64),
  stateHash: z.string().regex(/^[0-9a-f]{64}$/),
  questions: z.record(z.string(), questionSchema),
  answers: z.record(z.string(), answerSchema).nullable(),
  provider: z.string().max(64),
  ms: z.number().int().nonnegative(),
  error: z.string().max(500).optional(),
  docName: z.string().optional(),
});

export function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

// Every decision is written down with its odds, never with the text it was about.
export function loggedDecide(
  decide: Decide,
  sink: (record: DecisionRecord) => void
): Decide {
  return async (input) => {
    const decision = await decide(input);
    sink({
      point: input.point ?? Object.keys(input.questions).join("+"),
      stateHash: hashState(input.state),
      questions: input.questions,
      answers: decision.answers,
      provider: decision.provider,
      ms: decision.ms,
      ...(decision.error ? { error: decision.error } : {}),
    });
    return decision;
  };
}
