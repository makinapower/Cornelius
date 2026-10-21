import { connect } from 'node:net';

/**
 * Client du protocole Wyoming (Home Assistant) : Whisper et Piper servis par wyoming-faster-
 * whisper et wyoming-piper, sur cette machine ou une autre du réseau local. Chaque événement
 * est une ligne JSON d’en-tête, suivie de ses données JSON (`data_length`) et de sa charge
 * binaire (`payload_length`).
 */
export interface WyomingEvent {
  type: string;
  data: Record<string, unknown>;
  payload: Buffer | null;
}

/** Adresse `tcp://hôte:port` (ou `wyoming://`) ; null pour une adresse HTTP. */
export function wyomingAddress(url: string): { host: string; port: number } | null {
  const match = /^(?:tcp|wyoming):\/\/\[?([^\]/]+?)\]?:(\d{1,5})\/?$/iu.exec(url.trim());
  if (!match) return null;
  const port = Number(match[2]);
  return port > 0 && port < 65536 ? { host: match[1]!, port } : null;
}

export function encodeWyomingEvent(event: {
  type: string;
  data?: Record<string, unknown>;
  payload?: Buffer;
}): Buffer {
  const header: Record<string, unknown> = { type: event.type, version: '1.5.0' };
  const data =
    event.data && Object.keys(event.data).length
      ? Buffer.from(JSON.stringify(event.data), 'utf8')
      : null;
  if (data) header.data_length = data.length;
  if (event.payload?.length) header.payload_length = event.payload.length;
  return Buffer.concat([
    Buffer.from(JSON.stringify(header) + '\n', 'utf8'),
    ...(data ? [data] : []),
    ...(event.payload?.length ? [event.payload] : []),
  ]);
}

/** Lit les événements d’un flux à mesure qu’ils arrivent, en morceaux quelconques. */
export class WyomingReader {
  private buffer: Buffer = Buffer.alloc(0);
  private pending: { header: Record<string, unknown>; data: number; payload: number } | null = null;
  push(chunk: Buffer): WyomingEvent[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const events: WyomingEvent[] = [];
    for (;;) {
      if (!this.pending) {
        const newline = this.buffer.indexOf(0x0a);
        if (newline < 0) {
          if (this.buffer.length > 1_000_000) throw new Error('En-tête Wyoming trop long.');
          return events;
        }
        const header = JSON.parse(this.buffer.subarray(0, newline).toString('utf8')) as Record<
          string,
          unknown
        >;
        this.buffer = this.buffer.subarray(newline + 1);
        const length = (value: unknown) =>
          typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
        this.pending = {
          header,
          data: length(header.data_length),
          payload: length(header.payload_length),
        };
      }
      const { header, data, payload } = this.pending;
      if (data + payload > 50_000_000) throw new Error('Événement Wyoming trop volumineux.');
      if (this.buffer.length < data + payload) return events;
      const inline =
        header.data && typeof header.data === 'object'
          ? (header.data as Record<string, unknown>)
          : {};
      const extra = data
        ? (JSON.parse(this.buffer.subarray(0, data).toString('utf8')) as Record<string, unknown>)
        : {};
      events.push({
        type: String(header.type ?? ''),
        data: { ...inline, ...extra },
        payload: payload ? Buffer.from(this.buffer.subarray(data, data + payload)) : null,
      });
      this.buffer = this.buffer.subarray(data + payload);
      this.pending = null;
    }
  }
}

/**
 * Envoie des événements, puis lit les réponses jusqu’à celui que `done` attend. Une connexion
 * par demande, comme Home Assistant ; fermée à la fin, sur erreur, délai ou abandon.
 */
export function wyomingExchange(
  address: { host: string; port: number },
  events: { type: string; data?: Record<string, unknown>; payload?: Buffer }[],
  done: (event: WyomingEvent) => boolean,
  options: { signal?: AbortSignal; timeoutMs?: number; label: string },
): Promise<WyomingEvent[]> {
  return new Promise((resolve, reject) => {
    const received: WyomingEvent[] = [];
    const reader = new WyomingReader();
    const socket = connect({ host: address.host, port: address.port });
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', aborted);
      socket.destroy();
      if (error) reject(error);
      else resolve(received);
    };
    const timer = setTimeout(
      () => finish(new Error(options.label + ' : pas de réponse de ' + address.host + '.')),
      options.timeoutMs ?? 30_000,
    );
    timer.unref?.();
    const aborted = () => finish(new Error(options.label + ' : demande interrompue.'));
    if (options.signal?.aborted) return aborted();
    options.signal?.addEventListener('abort', aborted, { once: true });
    socket.on('connect', () => {
      socket.write(Buffer.concat(events.map(encodeWyomingEvent)));
    });
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const event of reader.push(chunk)) {
          if (event.type === 'error')
            return finish(
              new Error(options.label + ' : ' + String(event.data.text ?? 'erreur du service.')),
            );
          received.push(event);
          if (done(event)) return finish(null);
        }
      } catch (error) {
        finish(error as Error);
      }
    });
    socket.on('error', (error) =>
      finish(new Error(options.label + ' injoignable (' + address.host + ') : ' + error.message)),
    );
    socket.on('close', () =>
      finish(new Error(options.label + ' : connexion fermée avant la fin.')),
    );
  });
}

const CHUNK_BYTES = 2048;

/** Whisper (wyoming-faster-whisper) : PCM16 mono 16 kHz → texte. */
export async function wyomingTranscribe(
  address: { host: string; port: number },
  pcm: Buffer,
  options: { language: string | null; model: string | null; signal?: AbortSignal },
): Promise<string> {
  const format = { rate: 16_000, width: 2, channels: 1 };
  const chunks: { type: string; data: Record<string, unknown>; payload?: Buffer }[] = [];
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES)
    chunks.push({
      type: 'audio-chunk',
      data: format,
      payload: pcm.subarray(offset, offset + CHUNK_BYTES),
    });
  const events = await wyomingExchange(
    address,
    [
      {
        type: 'transcribe',
        data: {
          ...(options.language ? { language: options.language } : {}),
          ...(options.model ? { name: options.model } : {}),
        },
      },
      { type: 'audio-start', data: format },
      ...chunks,
      { type: 'audio-stop' },
    ],
    (event) => event.type === 'transcript',
    { signal: options.signal, label: 'Transcription Wyoming' },
  );
  const text = events.at(-1)?.data.text;
  return typeof text === 'string' ? text : '';
}

/** Piper (wyoming-piper) : texte → PCM16 mono et son débit. */
export async function wyomingSynthesize(
  address: { host: string; port: number },
  text: string,
  options: { voice: string | null; signal?: AbortSignal },
): Promise<{ pcm: Int16Array; rate: number }> {
  const events = await wyomingExchange(
    address,
    [
      {
        type: 'synthesize',
        data: { text, ...(options.voice ? { voice: { name: options.voice } } : {}) },
      },
    ],
    (event) => event.type === 'audio-stop',
    { signal: options.signal, label: 'Synthèse vocale Wyoming' },
  );
  const start = events.find((event) => event.type === 'audio-start');
  let rate = Number(start?.data.rate ?? 22_050);
  let width = Number(start?.data.width ?? 2);
  let channels = Number(start?.data.channels ?? 1);
  const parts: Buffer[] = [];
  for (const event of events) {
    if (event.type !== 'audio-chunk' || !event.payload) continue;
    // Chaque trame redit son format : le dernier connu fait foi.
    rate = Number(event.data.rate ?? rate);
    width = Number(event.data.width ?? width);
    channels = Number(event.data.channels ?? channels);
    parts.push(event.payload);
  }
  if (width !== 2 || !Number.isInteger(channels) || channels < 1 || !(rate > 0))
    throw new Error('Synthèse vocale Wyoming : format audio non pris en charge.');
  const audio = Buffer.concat(parts);
  const frames = Math.floor(audio.length / (2 * channels));
  const pcm = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++)
      sum += audio.readInt16LE((frame * channels + channel) * 2);
    pcm[frame] = Math.round(sum / channels);
  }
  return { pcm, rate };
}
