/**
 * Cut streamed text into speakable sentences. A sentence ends at . ! ? followed
 * by whitespace, or at a newline. A trailing fragment without a boundary is held
 * until more text arrives or `flush()` is called, so nothing is lost.
 */
export class SentenceSplitter {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    const boundary = /[.!?]+\s+|\n+/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(this.buffer)) !== null) {
      const sentence = this.buffer.slice(last, match.index + match[0].length).trim();
      if (sentence) out.push(sentence);
      last = match.index + match[0].length;
    }
    this.buffer = this.buffer.slice(last);
    return out;
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }
}
