/**
 * The client-to-server half of the RFB (VNC) protocol, reduced to what a view-only viewer may send (docs/11 D2).
 * Pure: bytes in, bytes out, no I/O, so it is tested with byte fixtures. The bridge feeds it every chunk a view
 * connection sends and forwards what comes back.
 *
 * Allowed through: the handshake (version `RFB 003.008\n`, security type 1 = None, ClientInit rewritten to 1 =
 * shared, so a viewer never disconnects the person who controls the desktop), then SetPixelFormat (0), SetEncodings
 * (2) and FramebufferUpdateRequest (3). Silently dropped: KeyEvent (4), PointerEvent (5), ClientCutText (6).
 * Anything else is a violation and the caller closes the connection.
 */
export const RFB_VERSION = "RFB 003.008\n";
export const MAX_CUT_TEXT_BYTES = 1_048_576;

export interface FilterResult {
  /** Bytes to send to the VNC server; may be empty. */
  readonly forward: Buffer;
  /** Set when the stream broke the rules; the caller closes the connection (WebSocket code 1008) and may log this. */
  readonly violation?: string;
}

type Phase = "version" | "security" | "init" | "messages" | "failed";

const NONE: Buffer = Buffer.alloc(0);

export class RfbViewFilter {
  private phase: Phase = "version";
  private pending: Buffer = NONE;

  push(chunk: Buffer): FilterResult {
    if (this.phase === "failed") return { forward: NONE };
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const out: Buffer[] = [];
    for (;;) {
      const step = this.step(out);
      if (step === "more") break;
      if (step !== "continue") {
        this.phase = "failed";
        this.pending = NONE;
        return { forward: Buffer.concat(out), violation: step };
      }
    }
    return { forward: Buffer.concat(out) };
  }

  /** Consumes one unit from `pending`. "continue": more may be possible. "more": need more bytes. Anything else: a violation. */
  private step(out: Buffer[]): "continue" | "more" | string {
    const buffer = this.pending;
    if (buffer.length === 0) return "more";
    switch (this.phase) {
      case "version": {
        if (buffer.length < RFB_VERSION.length) return "more";
        if (buffer.toString("latin1", 0, RFB_VERSION.length) !== RFB_VERSION) return "handshake: client version is not RFB 003.008";
        out.push(buffer.subarray(0, RFB_VERSION.length));
        this.take(RFB_VERSION.length);
        this.phase = "security";
        return "continue";
      }
      case "security": {
        if (buffer[0] !== 1) return `handshake: security type ${buffer[0]} is not 1 (None)`;
        out.push(buffer.subarray(0, 1));
        this.take(1);
        this.phase = "init";
        return "continue";
      }
      case "init": {
        out.push(Buffer.from([1])); // whatever the client asked, the session is shared
        this.take(1);
        this.phase = "messages";
        return "continue";
      }
      case "messages":
        return this.message(buffer, out);
      case "failed":
        return "more";
    }
  }

  private message(buffer: Buffer, out: Buffer[]): "continue" | "more" | string {
    const type = buffer[0] as number;
    let size: number;
    let forward: boolean;
    switch (type) {
      case 0: // SetPixelFormat: type, 3 padding, 16 bytes pixel format
        size = 20;
        forward = true;
        break;
      case 2: {
        // SetEncodings: type, padding, u16 count, then count * i32
        if (buffer.length < 4) return "more";
        size = 4 + 4 * buffer.readUInt16BE(2);
        forward = true;
        break;
      }
      case 3: // FramebufferUpdateRequest: type, incremental, x, y, w, h
        size = 10;
        forward = true;
        break;
      case 4: // KeyEvent
        size = 8;
        forward = false;
        break;
      case 5: // PointerEvent
        size = 6;
        forward = false;
        break;
      case 6: {
        // ClientCutText: type, 3 padding, i32 length, text. A negative length is the Extended Clipboard form noVNC 1.7 sends (its capability message
        // comes first, as -8): the bytes that follow number the absolute value, and for a viewer they are dropped like plain cut text.
        if (buffer.length < 8) return "more";
        const length = Math.abs(buffer.readInt32BE(4));
        if (length > MAX_CUT_TEXT_BYTES) return `message type 6 (ClientCutText) is ${length} bytes, more than ${MAX_CUT_TEXT_BYTES}`;
        size = 8 + length;
        forward = false;
        break;
      }
      default:
        return `message type ${type} is not allowed from a view-only client`;
    }
    if (buffer.length < size) return "more";
    if (forward) out.push(buffer.subarray(0, size));
    this.take(size);
    return "continue";
  }

  private take(count: number): void {
    this.pending = count >= this.pending.length ? NONE : this.pending.subarray(count);
  }
}
