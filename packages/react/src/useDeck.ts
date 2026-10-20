import type { JSONContent } from "@memo-air/richtext";
import type {
  DeckTheme,
  DeckView,
  PendingSlideSuggestion,
} from "@memo-air/slides";
import {
  deckElements,
  deckSlideMeta,
  deckSlides,
  deckSuggestions,
  deckTheme,
  elementBlocks,
  pendingSlideSuggestions,
  readDeck,
  readThemeState,
  resolveTheme,
} from "@memo-air/slides";
import { useEffect, useState } from "react";
import type { LiveDocSession } from "./useLiveDocSession";

export type DeckState = {
  deck: DeckView;
  theme: DeckTheme;
  // Richtext JSON per text element, suggestion marks included, for renderers.
  blocks: Map<string, JSONContent[]>;
  suggestions: PendingSlideSuggestion[];
};

function readState(session: LiveDocSession): DeckState {
  const deck = readDeck(session.ydoc);
  return {
    deck,
    theme: resolveTheme(readThemeState(session.ydoc)),
    blocks: new Map(
      deck.slides.flatMap((slide) =>
        slide.elements
          .filter((element) => element.kind === "text")
          .map((element) => [
            element.id,
            elementBlocks(session.ydoc, element.id),
          ])
      )
    ),
    suggestions: pendingSlideSuggestions(session.ydoc),
  };
}

// The deck as React state, re-read on any change to its Yjs types (text included).
export function useDeck(session: LiveDocSession | null): DeckState | null {
  const [state, setState] = useState<DeckState | null>(null);

  useEffect(() => {
    if (!session) {
      setState(null);
      return;
    }
    const { ydoc } = session;
    let frame = 0;
    // Many Yjs events land in one burst while an agent writes; read once per frame.
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setState(readState(session)));
    };
    const types = [
      deckSlides(ydoc),
      deckSlideMeta(ydoc),
      deckTheme(ydoc),
      deckSuggestions(ydoc),
    ];
    const elements = deckElements(ydoc);
    setState(readState(session));
    for (const type of types) {
      type.observe(refresh);
    }
    elements.observeDeep(refresh);
    return () => {
      cancelAnimationFrame(frame);
      for (const type of types) {
        type.unobserve(refresh);
      }
      elements.unobserveDeep(refresh);
    };
  }, [session]);

  return state;
}
