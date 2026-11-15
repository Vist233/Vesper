/** RFC 6455 framing, the part the bridge needs: server-to-client frames out, client-to-server frames in. Pure. */
const MAX_FRAME_BYTES = 1024 * 1024;

/** A server-to-client frame: final, unmasked. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : (() => {
            const h = Buffer.alloc(10);
            h[0] = 0x80 | opcode;
            h[1] = 127;
            h.writeBigUInt64BE(BigInt(length), 2);
            return h;
          })();
  return Buffer.concat([header, payload]);
}

interface FrameHandlers {
  binary(payload: Buffer): void;
  ping(payload: Buffer): void;
  close(): void;
  protocolError(): void;
}

/** Reads client-to-server frames (always masked) out of a byte stream. A continuation fragment is forwarded like any binary data: VNC is a stream. */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);
  private stopped = false;
  private readonly handlers: FrameHandlers;

  constructor(handlers: FrameHandlers) {
    this.handlers = handlers;
  }

  push(chunk: Buffer): void {
    if (this.stopped) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (!this.stopped && this.next()) {
      /* consume every complete frame */
    }
  }

  private fail(): false {
    this.stopped = true;
    this.handlers.protocolError();
    return false;
  }

  private next(): boolean {
    const b = this.buffer;
    if (b.length < 2) return false;
    const opcode = (b[0] as number) & 0x0f;
    const masked = ((b[1] as number) & 0x80) !== 0;
    let length = (b[1] as number) & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (b.length < 4) return false;
      length = b.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (b.length < 10) return false;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(MAX_FRAME_BYTES)) return this.fail();
      length = Number(big);
      offset = 10;
    }
    if (!masked || length > MAX_FRAME_BYTES) return this.fail(); // RFC 6455: client frames must be masked
    if (b.length < offset + 4 + length) return false;
    const mask = b.subarray(offset, offset + 4);
    const payload = Buffer.from(b.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
    this.buffer = b.subarray(offset + 4 + length);
    switch (opcode) {
      case 0x0:
      case 0x2:
        this.handlers.binary(payload);
        return true;
      case 0x8:
        this.stopped = true;
        this.handlers.close();
        return false;
      case 0x9:
        this.handlers.ping(payload);
        return true;
      case 0xa:
        return true;
      default:
        return this.fail(); // text frames and reserved opcodes are not part of the VNC stream
    }
  }
}
