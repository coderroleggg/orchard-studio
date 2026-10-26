// AudioWorkletProcessor wrapper around the Engine.

// must stay the first import: plugin modules may use these at load time
import './polyfills';
import { Engine } from './Engine';
import type { ToEngine } from './protocol';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

class EngineProcessor extends AudioWorkletProcessor {
  private engine: Engine;

  constructor() {
    super();
    this.engine = new Engine({
      sampleRate,
      blockSize: 128,
      post: (msg, transfer) => this.port.postMessage(msg, transfer ?? []),
    });
    this.port.onmessage = (e: MessageEvent) => {
      const data = e.data as ToEngine | ToEngine[];
      if (Array.isArray(data)) for (const m of data) this.engine.handle(m);
      else this.engine.handle(data);
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const L = out[0];
    const R = out[1] ?? out[0];
    // the audio device's input channels (empty while no input device is connected)
    const inp = inputs[0];
    this.engine.process(L, R, L.length, inp && inp.length ? inp : undefined);
    return true;
  }
}

registerProcessor('orchard-engine', EngineProcessor);
