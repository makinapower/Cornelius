import { randomUUID } from 'node:crypto';
import type { SessionConfig } from 'openai/resources/live/live';
import type { ConnectClientEvent, ConnectServerEvent } from 'openai/resources/live/sideband';
import type { DiagnosticLog } from '../logs.js';
import type { LiveAudioConnection, LiveGateway, LiveHandlers } from './gateway.js';

/**
 * Conversation 100 % locale : transcription, modèle de langage et voix servis par des API
 * compatibles OpenAI sur la machine (oMLX pour le LLM, mlx-audio pour la parole, par exemple).
 */
export interface LocalConversationConfig {
  llm: { baseUrl: string; model: string | null; apiKey: string | null };
  stt: { baseUrl: string; model: string; language: string };
  tts: { baseUrl: string; model: string; voice: string; langCode: string | null; speed: number };
}

const off = (value: string | undefined) =>
  ['0', 'false', 'non', 'no'].includes((value ?? '').trim().toLowerCase());
const trimSlash = (value: string) => value.trim().replace(/\/+$/u, '');

/** Moteur choisi par CORNELIUS_CONVERSATION=local ; null pour OpenAI (par défaut). */
export function localConversationConfig(
  env: NodeJS.ProcessEnv = process.env,
): LocalConversationConfig | null {
  if ((env.CORNELIUS_CONVERSATION ?? 'openai').trim().toLowerCase() !== 'local') return null;
  const audio = trimSlash(env.CORNELIUS_LOCAL_AUDIO_URL || 'http://127.0.0.1:8001/v1');
  const speed = Number(env.CORNELIUS_LOCAL_TTS_SPEED ?? 1);
  return {
    llm: {
      baseUrl: trimSlash(env.CORNELIUS_LOCAL_LLM_URL || 'http://127.0.0.1:8000/v1'),
      model: env.CORNELIUS_LOCAL_LLM_MODEL?.trim() || null,
      apiKey: env.CORNELIUS_LOCAL_LLM_API_KEY?.trim() || null,
    },
    stt: {
      baseUrl: trimSlash(env.CORNELIUS_LOCAL_STT_URL || audio),
      model:
        env.CORNELIUS_LOCAL_STT_MODEL?.trim() || 'mlx-community/whisper-large-v3-turbo-asr-fp16',
      language: env.CORNELIUS_LOCAL_STT_LANGUAGE?.trim() || 'fr',
    },
    tts: {
      baseUrl: trimSlash(env.CORNELIUS_LOCAL_TTS_URL || audio),
      model: env.CORNELIUS_LOCAL_TTS_MODEL?.trim() || 'mlx-community/Kokoro-82M-bf16',
      voice: env.CORNELIUS_LOCAL_TTS_VOICE?.trim() || 'ff_siwis',
      langCode: off(env.CORNELIUS_LOCAL_TTS_LANG_CODE)
        ? null
        : env.CORNELIUS_LOCAL_TTS_LANG_CODE?.trim() || 'f',
      speed: Number.isFinite(speed) && speed >= 0.5 && speed <= 2 ? speed : 1,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Audio : WAV, rééchantillonnage, détection de fin de parole.

/** PCM16 mono d’un fichier WAV (PCM 16 bits ou flottant 32 bits, canaux mélangés). */
export function decodeWav(data: Buffer): { pcm: Int16Array; rate: number } {
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('Réponse de synthèse vocale : WAV attendu.');
  let offset = 12;
  let format = 0;
  let channels = 1;
  let rate = 0;
  let bits = 0;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    let size = data.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = data.readUInt16LE(body);
      channels = data.readUInt16LE(body + 2);
      rate = data.readUInt32LE(body + 4);
      bits = data.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE : le vrai format est dans le sous-type.
      if (format === 0xfffe && size >= 26) format = data.readUInt16LE(body + 24);
    } else if (id === 'data') {
      // Flux écrit avant de connaître sa longueur : taille 0 ou maximale.
      if (size === 0 || body + size > data.length) size = data.length - body;
      const bytes = bits / 8;
      if (!rate || !channels || !((format === 1 && bits === 16) || (format === 3 && bits === 32)))
        throw new Error('Format WAV non pris en charge.');
      const frames = Math.floor(size / (bytes * channels));
      const pcm = new Int16Array(frames);
      for (let frame = 0; frame < frames; frame++) {
        let sum = 0;
        for (let channel = 0; channel < channels; channel++) {
          const at = body + (frame * channels + channel) * bytes;
          sum += format === 1 ? data.readInt16LE(at) / 32768 : data.readFloatLE(at);
        }
        pcm[frame] = Math.round(Math.max(-1, Math.min(1, sum / channels)) * 32767);
      }
      return { pcm, rate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV sans données audio.');
}

export function encodeWav(pcm: Buffer, rate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Rééchantillonnage linéaire, suffisant pour une voix. */
export function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to || pcm.length === 0) return pcm;
  const length = Math.max(1, Math.round((pcm.length * to) / from));
  const output = new Int16Array(length);
  const step = from / to;
  for (let index = 0; index < length; index++) {
    const position = index * step;
    const left = Math.min(pcm.length - 1, Math.floor(position));
    const right = Math.min(pcm.length - 1, left + 1);
    const weight = position - left;
    output[index] = Math.round(pcm[left]! * (1 - weight) + pcm[right]! * weight);
  }
  return output;
}

const INPUT_RATE = 16_000;

/**
 * Découpe le micro (PCM16 16 kHz) en paroles : niveau au-dessus du bruit de fond suivi
 * lentement, 300 ms gardées avant le début, fin après un silence de `silenceMs`.
 */
export class Endpointer {
  private noise = 300;
  private preroll: Buffer[] = [];
  private prerollBytes = 0;
  private speech: Buffer[] = [];
  private speechBytes = 0;
  private voiced = 0;
  private loud = 0;
  private quiet = 0;
  private active = false;
  constructor(
    private readonly onUtterance: (pcm: Buffer) => void,
    private readonly options = { silenceMs: 800, minSpeechMs: 300, maxMs: 30_000 },
  ) {}
  reset() {
    this.preroll = [];
    this.prerollBytes = 0;
    this.speech = [];
    this.speechBytes = 0;
    this.voiced = 0;
    this.loud = 0;
    this.quiet = 0;
    this.active = false;
  }
  push(frame: Buffer) {
    if (frame.length < 2) return;
    let energy = 0;
    const samples = Math.floor(frame.length / 2);
    for (let index = 0; index < samples; index++) {
      const sample = frame.readInt16LE(index * 2);
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / samples);
    const ms = (samples / INPUT_RATE) * 1000;
    const threshold = Math.max(500, this.noise * 3);
    const loud = rms >= threshold;
    // Le plancher descend vite vers un silence et remonte lentement : la parole ne le relève pas.
    this.noise =
      rms < this.noise ? rms * 0.5 + this.noise * 0.5 : this.noise + (rms - this.noise) * 0.002;
    this.noise = Math.max(50, this.noise);
    if (!this.active) {
      this.preroll.push(frame);
      this.prerollBytes += frame.length;
      while (this.prerollBytes > INPUT_RATE * 2 * 0.3 && this.preroll.length > 1)
        this.prerollBytes -= this.preroll.shift()!.length;
      this.loud = loud ? this.loud + ms : 0;
      if (this.loud >= 60) {
        this.active = true;
        this.speech = this.preroll;
        this.speechBytes = this.prerollBytes;
        this.preroll = [];
        this.prerollBytes = 0;
        this.voiced = this.loud;
        this.quiet = 0;
      }
      return;
    }
    this.speech.push(frame);
    this.speechBytes += frame.length;
    if (loud) {
      this.voiced += ms;
      this.quiet = 0;
    } else this.quiet += ms;
    const duration = (this.speechBytes / 2 / INPUT_RATE) * 1000;
    if (this.quiet >= this.options.silenceMs || duration >= this.options.maxMs) {
      const pcm = Buffer.concat(this.speech);
      const enough = this.voiced >= this.options.minSpeechMs;
      this.reset();
      if (enough) this.onUtterance(pcm);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Modèle de langage : messages, outils et flux SSE d’une API compatible OpenAI.

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
interface ChatTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** Outils de fonction de la délégation ; web_search n’existe pas en local. */
function chatTools(session: Record<string, unknown>): ChatTool[] {
  const responses = delegationResponses(session);
  const tools = Array.isArray(responses?.tools) ? responses.tools : [];
  return tools.flatMap((tool) => {
    const value = tool as Record<string, unknown>;
    if (value.type !== 'function' || typeof value.name !== 'string') return [];
    return [
      {
        type: 'function' as const,
        function: {
          name: value.name,
          description: typeof value.description === 'string' ? value.description : '',
          parameters: (value.parameters as Record<string, unknown>) ?? { type: 'object' },
        },
      },
    ];
  });
}
function delegationResponses(session: Record<string, unknown>): Record<string, unknown> | null {
  const delegation = session.delegation as Record<string, unknown> | undefined;
  return delegation?.type === 'responses'
    ? ((delegation.responses as Record<string, unknown>) ?? null)
    : null;
}

const localRules = `

Fonctionnement local : tu es à la fois la voix de Cornelius et l’assistant qui appelle les outils. « Déléguer au backend » ou « délègue » signifie ici appeler directement l’outil qui convient, puis répondre à partir de son résultat. Ce que tu écris est lu à voix haute par une synthèse vocale : réponds en une à trois phrases courtes, en français, sans markdown, sans liste à puces, sans emoji, sans URL ni identifiant technique. N’utilise pas de formules d’attente : la réponse arrive après le résultat de l’outil.`;

/** Retire le raisonnement d’un modèle « thinking » (balises <think>). */
export function visibleText(text: string): string {
  return text
    .replace(/<think>[\s\S]*?(<\/think>|$)/gu, '')
    .replace(/[*_#`>]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Phrases complètes d’un texte en cours d’écriture ; le reste attend la suite. */
export function completeSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  const pattern = /[.!?…]+["»”)]?(?=\s)|\n+/gu;
  for (const match of text.matchAll(pattern)) {
    const end = match.index + match[0].length;
    const sentence = text.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
  }
  return { sentences, rest: text.slice(start) };
}

// Phrases que Whisper invente sur un silence ou un bruit.
const HALLUCINATIONS =
  /^(sous-titr|merci d'avoir regard|merci de votre attention|abonnez-vous|amara\.org|\.+$)/iu;

export interface LocalDependencies {
  fetch: typeof globalThis.fetch;
  now: () => number;
}

const OUTPUT_CHUNK_MS = 100;
const OUTPUT_LEAD_MS = 300;
// Lecture du navigateur ou du satellite après le dernier son envoyé : le micro reste sourd.
const ECHO_GUARD_MS = 500;

class LocalSession implements LiveAudioConnection {
  private readonly id = 'local_' + randomUUID();
  private readonly startedAt: number;
  private readonly outputRate: number;
  private readonly endpointer: Endpointer;
  private instructions: string;
  private extraInstructions: string[] = [];
  private tools: ChatTool[];
  private messages: ChatMessage[] = [];
  private closed = false;
  private readonly abort = new AbortController();
  private queue: Promise<void> = Promise.resolve();
  private delegationId: string | null = null;
  private continuation: (() => void) | null = null;
  private output: Buffer[] = [];
  private playbackEnd = 0;
  private outputTimer: ReturnType<typeof setInterval> | null = null;
  private model: Promise<string> | null = null;

  constructor(
    session: SessionConfig,
    private readonly handlers: LiveHandlers,
    private readonly config: LocalConversationConfig,
    private readonly deps: LocalDependencies,
    private readonly logs?: DiagnosticLog,
  ) {
    const record = session as unknown as Record<string, unknown>;
    const format = (record.audio as { format?: { rate?: number } } | undefined)?.format;
    this.outputRate = format?.rate ?? 24_000;
    this.startedAt = deps.now();
    this.instructions = this.composeInstructions(record);
    this.tools = chatTools(record);
    this.endpointer = new Endpointer((pcm) => this.enqueue(() => this.userTurn(pcm)));
    queueMicrotask(() => {
      if (this.closed) return;
      this.handlers.open();
      this.emit({ type: 'session.started', session: { id: this.id } });
    });
  }

  private composeInstructions(session: Record<string, unknown>): string {
    const voice = typeof session.instructions === 'string' ? session.instructions : '';
    const responses = delegationResponses(session);
    const delegation = typeof responses?.instructions === 'string' ? responses.instructions : '';
    return [voice, delegation].filter(Boolean).join('\n\n') + localRules;
  }
  private system(): string {
    return [this.instructions, ...this.extraInstructions].join('\n\n');
  }
  private emit(event: Record<string, unknown>) {
    if (this.closed && event.type !== 'session.closed') return;
    this.handlers.event(event as unknown as ConnectServerEvent);
  }
  private elapsed() {
    return Math.max(0, this.deps.now() - this.startedAt);
  }
  private enqueue(task: () => Promise<void>) {
    this.queue = this.queue
      .then(() => (this.closed ? undefined : task()))
      .catch((error: unknown) => this.fail(error));
  }
  private fail(error: unknown) {
    if (this.closed || this.abort.signal.aborted) return;
    const message = (error as Error)?.message ?? String(error);
    this.logs?.write('error', 'local', 'Conversation locale interrompue', { error: message });
    this.emit({
      type: 'error',
      error: { type: 'local_error', code: 'local_error', message: message.slice(0, 300) },
    });
  }

  // --- Micro ----------------------------------------------------------------------------------
  sendAudio(pcm: Buffer) {
    if (this.closed) return;
    // Semi-duplex : Cornelius ne s’entend pas lui-même ; la parole reprend après sa lecture.
    if (this.deps.now() < this.playbackEnd + ECHO_GUARD_MS) {
      this.endpointer.reset();
      return;
    }
    this.endpointer.push(pcm);
  }

  private async userTurn(pcm: Buffer) {
    const end = this.elapsed();
    const start = Math.max(0, end - (pcm.length / 2 / INPUT_RATE) * 1000);
    const text = (await this.transcribe(pcm)).trim();
    if (!text || text.length < 2 || HALLUCINATIONS.test(text)) return;
    this.emit({
      type: 'session.input_transcript.delta',
      event_id: 'evt_' + randomUUID(),
      item_id: 'item_' + randomUUID(),
      delta: text,
      start_ms: start,
      end_ms: end,
    });
    this.messages.push({ role: 'user', content: text });
    this.delegationId = null;
    await this.respond();
  }

  private async transcribe(pcm: Buffer): Promise<string> {
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(encodeWav(pcm, INPUT_RATE))], { type: 'audio/wav' }),
      'parole.wav',
    );
    form.append('model', this.config.stt.model);
    form.append('language', this.config.stt.language);
    form.append('response_format', 'json');
    const response = await this.deps.fetch(this.config.stt.baseUrl + '/audio/transcriptions', {
      method: 'POST',
      body: form,
      signal: this.abort.signal,
    });
    if (!response.ok)
      throw new Error('Transcription locale refusée (HTTP ' + response.status + ').');
    const body = (await response.json()) as { text?: unknown };
    return typeof body.text === 'string' ? body.text : '';
  }

  // --- Modèle de langage ----------------------------------------------------------------------
  private resolveModel(): Promise<string> {
    if (this.config.llm.model) return Promise.resolve(this.config.llm.model);
    // Sans modèle choisi : le premier que sert le LLM local.
    this.model ??= (async () => {
      const response = await this.deps.fetch(this.config.llm.baseUrl + '/models', {
        headers: this.headers(),
        signal: this.abort.signal,
      });
      if (!response.ok) throw new Error('LLM local injoignable (HTTP ' + response.status + ').');
      const body = (await response.json()) as { data?: { id?: unknown }[] };
      const id = body.data?.find((model) => typeof model.id === 'string')?.id;
      if (typeof id !== 'string')
        throw new Error('Aucun modèle chargé dans le LLM local (CORNELIUS_LOCAL_LLM_MODEL).');
      return id;
    })();
    return this.model;
  }
  private headers(): Record<string, string> {
    return this.config.llm.apiKey ? { Authorization: 'Bearer ' + this.config.llm.apiKey } : {};
  }

  /** Un tour du modèle : la voix au fil des phrases, puis les outils demandés. */
  private async respond(): Promise<void> {
    const model = await this.resolveModel();
    const response = await this.deps.fetch(this.config.llm.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers() },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 1024,
        temperature: 0.6,
        messages: [{ role: 'system', content: this.system() }, ...this.messages],
        ...(this.tools.length ? { tools: this.tools, tool_choice: 'auto' } : {}),
      }),
      signal: this.abort.signal,
    });
    if (!response.ok || !response.body)
      throw new Error('LLM local : réponse refusée (HTTP ' + response.status + ').');
    let text = '';
    // Texte reçu mais pas encore dit : il part phrase par phrase.
    let pending = '';
    const calls = new Map<number, ToolCall>();
    const speakReady = async (final: boolean) => {
      // Rien n’est dit d’un raisonnement <think> encore ouvert.
      if (!final && pending.lastIndexOf('<think>') > pending.lastIndexOf('</think>')) return;
      const { sentences, rest } = completeSentences(
        pending.replace(/<think>[\s\S]*?(<\/think>|$)/gu, ''),
      );
      if (final) sentences.push(rest);
      pending = final ? '' : rest;
      for (const sentence of sentences) {
        const spoken = visibleText(sentence);
        if (spoken) await this.speak(spoken);
      }
    };
    for await (const chunk of sse(response.body)) {
      if (this.closed) return;
      const choice = (chunk.choices as Record<string, unknown>[] | undefined)?.[0];
      const delta = (choice?.delta ?? {}) as {
        content?: unknown;
        tool_calls?: {
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }[];
      };
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        pending += delta.content;
        // Les phrases partent en synthèse sans attendre la fin du texte.
        if (!calls.size) await speakReady(false);
      }
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        const current = calls.get(index) ?? {
          id: call.id || 'call_' + randomUUID(),
          type: 'function' as const,
          function: { name: '', arguments: '' },
        };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.function.name += call.function.name;
        if (call.function?.arguments) current.function.arguments += call.function.arguments;
        calls.set(index, current);
      }
    }
    if (this.closed) return;
    const toolCalls = [...calls.values()].filter((call) => call.function.name);
    if (!toolCalls.length) {
      await speakReady(true);
      const content = visibleText(text);
      if (content) this.messages.push({ role: 'assistant', content });
      if (this.delegationId) this.responseCompleted(this.delegationId, 'resp_' + randomUUID());
      return;
    }
    this.messages.push({
      role: 'assistant',
      content: visibleText(text) || null,
      tool_calls: toolCalls,
    });
    await this.delegate(toolCalls);
  }

  /** Outils exécutés par le serveur de Cornelius, comme une délégation de l’API Live. */
  private async delegate(toolCalls: ToolCall[]) {
    if (!this.delegationId) {
      this.delegationId = 'dlg_' + randomUUID();
      this.emit({ type: 'session.delegation.created', delegation_id: this.delegationId });
    }
    const delegationId = this.delegationId;
    const responseId = 'resp_' + randomUUID();
    const continued = new Promise<void>((resolve) => {
      this.continuation = resolve;
    });
    this.responseEvent(delegationId, { type: 'response.created', response: { id: responseId } });
    for (const call of toolCalls)
      this.responseEvent(delegationId, {
        type: 'response.output_item.done',
        response_id: responseId,
        item: {
          type: 'function_call',
          id: 'item_' + randomUUID(),
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments || '{}',
        },
      });
    this.responseCompleted(delegationId, responseId, false);
    // Le serveur renvoie les résultats puis `response.create` : le modèle reprend la parole.
    await continued;
    if (!this.closed) await this.respond();
  }
  private responseEvent(delegationId: string, event: Record<string, unknown>) {
    this.emit({ type: 'response.event', delegation_id: delegationId, event });
  }
  private responseCompleted(delegationId: string, responseId: string, created = true) {
    if (created)
      this.responseEvent(delegationId, { type: 'response.created', response: { id: responseId } });
    this.responseEvent(delegationId, {
      type: 'response.completed',
      response: { id: responseId, status: 'completed', output: [] },
    });
  }

  // --- Voix -----------------------------------------------------------------------------------
  private async speak(sentence: string) {
    const text = sentence.trim();
    if (!text || this.closed) return;
    const response = await this.deps.fetch(this.config.tts.baseUrl + '/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.tts.model,
        input: text,
        voice: this.config.tts.voice,
        response_format: 'wav',
        speed: this.config.tts.speed,
        ...(this.config.tts.langCode ? { lang_code: this.config.tts.langCode } : {}),
      }),
      signal: this.abort.signal,
    });
    if (!response.ok)
      throw new Error('Synthèse vocale locale refusée (HTTP ' + response.status + ').');
    const { pcm, rate } = decodeWav(Buffer.from(await response.arrayBuffer()));
    if (this.closed) return;
    const samples = resample(pcm, rate, this.outputRate);
    const start = Math.max(this.elapsed(), this.playbackEnd - this.startedAt);
    this.emit({
      type: 'session.output_transcript.delta',
      event_id: 'evt_' + randomUUID(),
      item_id: 'item_' + randomUUID(),
      delta: text + ' ',
      start_ms: start,
      end_ms: start + (samples.length / this.outputRate) * 1000,
    });
    this.play(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  }

  /** Envoie la voix au rythme de la lecture, avec un peu d’avance. */
  private play(pcm: Buffer) {
    const chunk = Math.round((this.outputRate * OUTPUT_CHUNK_MS) / 1000) * 2;
    for (let offset = 0; offset < pcm.length; offset += chunk)
      this.output.push(pcm.subarray(offset, offset + chunk));
    const now = this.deps.now();
    this.playbackEnd = Math.max(this.playbackEnd, now) + (pcm.length / 2 / this.outputRate) * 1000;
    this.flush();
    this.outputTimer ??= setInterval(() => this.flush(), OUTPUT_CHUNK_MS / 2);
    this.outputTimer.unref?.();
  }
  private sentUntil = 0;
  private flush() {
    const now = this.deps.now();
    this.sentUntil = Math.max(this.sentUntil, now);
    while (this.output.length && this.sentUntil < now + OUTPUT_LEAD_MS) {
      const frame = this.output.shift()!;
      this.sentUntil += (frame.length / 2 / this.outputRate) * 1000;
      this.emit({ type: 'session.output_audio.delta', delta: frame.toString('base64') });
    }
    if (!this.output.length && this.outputTimer) {
      clearInterval(this.outputTimer);
      this.outputTimer = null;
    }
  }

  // --- Événements du serveur de Cornelius -----------------------------------------------------
  send(event: ConnectClientEvent) {
    if (this.closed) return;
    const record = event as unknown as Record<string, unknown>;
    switch (record.type) {
      case 'session.close':
        this.dispose();
        queueMicrotask(() => this.handlers.event({ type: 'session.closed' } as ConnectServerEvent));
        return;
      case 'session.instructions.append':
        if (typeof record.content === 'string') this.extraInstructions.push(record.content);
        return;
      case 'session.thinking.append':
        // Contexte silencieux (caméra) : il éclaire la suite sans être dit.
        if (typeof record.content === 'string')
          this.extraInstructions.push('Contexte du serveur (donnée) : ' + record.content);
        if (typeof record.event_id === 'string')
          this.emit({ type: 'session.thinking.appended', client_event_id: record.event_id });
        return;
      case 'session.commentary.append':
        // Consigne à dire maintenant (accueil, information d’une carte).
        if (typeof record.content === 'string') {
          const content = record.content;
          this.enqueue(async () => {
            this.messages.push({ role: 'user', content: '[Consigne du serveur] ' + content });
            this.delegationId = null;
            await this.respond();
          });
        }
        return;
      case 'session.update': {
        const session = (record.session ?? {}) as Record<string, unknown>;
        const responses = delegationResponses(session);
        if (Array.isArray(responses?.tools)) this.tools = chatTools(session);
        if (typeof responses?.instructions === 'string')
          this.extraInstructions.push(responses.instructions);
        return;
      }
      case 'response.item.create': {
        const item = (record.item ?? {}) as Record<string, unknown>;
        if (item.type === 'function_call_output' && typeof item.call_id === 'string') {
          this.messages.push({
            role: 'tool',
            tool_call_id: item.call_id,
            content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
          });
        }
        return;
      }
      case 'response.create': {
        const resume = this.continuation;
        this.continuation = null;
        resume?.();
        return;
      }
      default:
        return;
    }
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.continuation?.();
    this.continuation = null;
    this.output = [];
    if (this.outputTimer) clearInterval(this.outputTimer);
    this.outputTimer = null;
  }
}

/** Objets JSON d’un flux « server-sent events » (lignes `data:`, fin sur `[DONE]`). */
async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const part of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data) as Record<string, unknown>;
      } catch {
        // Ligne incomplète ou commentaire : ignorée.
      }
    }
  }
}

/**
 * Passerelle locale : même contrat que la passerelle OpenAI, mais seulement sur le serveur
 * (`connect`) ; le navigateur envoie son micro et reçoit la voix par le WebSocket /audio.
 */
export function createLocalGateway(
  config: LocalConversationConfig,
  logs?: DiagnosticLog,
  deps: LocalDependencies = { fetch: globalThis.fetch, now: Date.now },
): LiveGateway {
  return {
    local: true,
    async create() {
      throw new Error('Conversation locale : pas de session WebRTC.');
    },
    attach() {
      throw new Error('Conversation locale : pas de canal de contrôle distant.');
    },
    connect(session, handlers) {
      return new LocalSession(session, handlers, config, deps, logs);
    },
  };
}
