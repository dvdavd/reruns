// HTTP chunks can end anywhere inside a box. Append complete fragments so a
// seek never resets a browser parser halfway through a video sample.
const join = parts => {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};

export async function* mp4Fragments(reader, signal) {
  let chunk = new Uint8Array(0), offset = 0;
  const read = async (length, allowEnd = false) => {
    const parts = [];
    let remaining = length;
    while (remaining) {
      signal.throwIfAborted();
      if (offset === chunk.length) {
        const next = await reader.read();
        if (next.done) {
          if (allowEnd && remaining === length) return null;
          throw new Error('Incomplete MP4 fragment');
        }
        chunk = next.value;
        offset = 0;
      }
      const count = Math.min(remaining, chunk.length - offset);
      parts.push(chunk.subarray(offset, offset + count));
      offset += count;
      remaining -= count;
    }
    return parts.length === 1 ? parts[0] : join(parts);
  };
  let parts = [];
  while (true) {
    let header = await read(8, true);
    if (!header) {
      if (parts.length) throw new Error('Incomplete MP4 fragment');
      return;
    }
    let size = new DataView(header.buffer, header.byteOffset, header.length).getUint32(0);
    const type = String.fromCharCode(...header.subarray(4, 8));
    if (size === 1) {
      header = join([header, await read(8)]);
      size = Number(new DataView(header.buffer).getBigUint64(8));
    }
    if (size < header.length || size > 128 * 1024 * 1024) throw new Error('Invalid MP4 box size');
    const payload = await read(size - header.length);
    if (['ftyp', 'moov', 'moof', 'mdat'].includes(type)) parts.push(header, payload);
    if (type === 'moov' || type === 'mdat') {
      yield join(parts);
      parts = [];
    }
  }
}
