import type { TranscriptSegment } from "./types";

export type StabilizerOptions = {
  /** A caption that has not changed for this long is considered final. */
  stableMs?: number;
  /** Milliseconds since the meeting started. */
  clock: () => number;
  onSegment: (segment: TranscriptSegment) => void;
  language?: string;
};

type Block = {
  speaker: string;
  /** Text of the block already emitted as final segments. */
  committed: string;
  /** Latest full text of the block. */
  text: string;
  sequence: number;
  pendingSince: number;
  timer?: ReturnType<typeof setTimeout>;
};

/** A sentence ended and more text follows it: the sentence will not be rewritten anymore. */
const SENTENCE_END = /[.!?…]["')\]]?\s+(?=\S)/g;

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Turns the constantly rewritten text of live captions into stable transcript segments.
 *
 * Meet rewrites a caption block in place while a person speaks: words are appended and the
 * last few are often corrected. Emitting every mutation would flood the pipeline with
 * duplicates, so each block yields `partial` updates (same segment id, latest text) and a
 * final segment when a sentence is complete or the text has stopped changing.
 */
export class CaptionStabilizer {
  private readonly blocks = new Map<string, Block>();
  private readonly stableMs: number;

  constructor(private readonly options: StabilizerOptions) {
    this.stableMs = options.stableMs ?? 1200;
  }

  /** Call with the current speaker and full text of a caption block whenever it changes. */
  update(blockKey: string, speaker: string, text: string): void {
    const clean = text.replace(/\s+/g, " ").trim();
    let block = this.blocks.get(blockKey);
    if (!block) {
      block = { speaker, committed: "", text: "", sequence: 0, pendingSince: this.options.clock() };
      this.blocks.set(blockKey, block);
    }
    if (clean === block.text && speaker === block.speaker) return;
    block.speaker = speaker || block.speaker;
    // If Meet rewrote something we already committed, keep only the part that still matches.
    if (!clean.startsWith(block.committed)) {
      block.committed = block.committed.slice(0, commonPrefix(block.committed, clean));
    }
    block.text = clean;

    this.commitSentences(blockKey, block);
    const pending = this.pending(block);
    if (pending) this.emit(blockKey, block, pending, true);

    clearTimeout(block.timer);
    block.timer = setTimeout(() => this.finalize(blockKey), this.stableMs);
  }

  /** Call when a caption block leaves the screen. */
  remove(blockKey: string): void {
    this.finalize(blockKey);
    this.blocks.delete(blockKey);
  }

  /** Finalizes everything still pending, e.g. when leaving the call. */
  flush(): void {
    for (const key of [...this.blocks.keys()]) this.finalize(key);
  }

  private pending(block: Block): string {
    return block.text.slice(block.committed.length).trim();
  }

  private commitSentences(blockKey: string, block: Block): void {
    const rest = block.text.slice(block.committed.length);
    let cut = 0;
    for (const match of rest.matchAll(SENTENCE_END)) cut = (match.index ?? 0) + match[0].length;
    if (cut === 0) return;
    const sentence = rest.slice(0, cut).trim();
    block.committed = block.text.slice(0, block.committed.length + cut);
    if (sentence) this.emit(blockKey, block, sentence, false);
  }

  private finalize(blockKey: string): void {
    const block = this.blocks.get(blockKey);
    if (!block) return;
    clearTimeout(block.timer);
    const pending = this.pending(block);
    block.committed = block.text;
    if (pending) this.emit(blockKey, block, pending, false);
  }

  private emit(blockKey: string, block: Block, text: string, partial: boolean): void {
    const now = this.options.clock();
    this.options.onSegment({
      id: `cap-${blockKey}-${block.sequence}`,
      speaker: block.speaker,
      text,
      startMs: block.pendingSince,
      endMs: now,
      source: "captions",
      ...(partial ? { partial: true } : {}),
      ...(this.options.language ? { language: this.options.language } : {}),
    });
    if (!partial) {
      block.sequence++;
      block.pendingSince = now;
    }
  }
}
