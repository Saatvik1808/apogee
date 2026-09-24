/**
 * LEARNING NOTE: A tiny worker pool
 *
 * We spread patch requests over a couple of workers round-robin and route each
 * reply back to its callback by id. Workers load the same terrain data the main
 * thread uses for physics, so meshes and collisions agree exactly.
 *
 * Key concepts: thread pools, request/response correlation
 */
import type { PatchRequest, PatchResult } from './PatchBuilder';
import type { TerrainWorkerPool } from './PlanetTerrain';
import type { FlatSiteSpec, TerrainUrls } from '../../world/Terrain';

export class WorkerPool implements TerrainWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly callbacks = new Map<number, (r: PatchResult) => void>();
  private next = 0;
  private readyCount = 0;
  readonly ready: Promise<void>;

  constructor(count: number, urls: TerrainUrls, radii: { earth: number; moon: number; mars: number }, sites: FlatSiteSpec[]) {
    let resolveReady: () => void = () => undefined;
    let rejectReady: (e: Error) => void = () => undefined;
    this.ready = new Promise((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('./TerrainWorker.ts', import.meta.url), { type: 'module' });
      // A worker that fails to start (script 404, unsupported module workers, an
      // exception before it reports 'ready') would otherwise leave the loading
      // screen waiting forever: surface it as a startup error instead.
      w.onerror = (e: ErrorEvent) => rejectReady(new Error(`Terrain worker failed: ${e.message || 'unknown error'}`));
      w.onmessageerror = () => rejectReady(new Error('Terrain worker failed: message could not be deserialised'));
      w.onmessage = (e: MessageEvent<{ type: string; res?: PatchResult; error?: string }>) => {
        if (e.data.type === 'ready') {
          this.readyCount++;
          if (this.readyCount === count) resolveReady();
          return;
        }
        if (e.data.type === 'error') {
          rejectReady(new Error(`Terrain worker failed: ${e.data.error ?? 'unknown error'}`));
          return;
        }
        const res = e.data.res;
        if (!res) return;
        const cb = this.callbacks.get(res.id);
        this.callbacks.delete(res.id);
        if (cb) cb(res);
      };
      w.postMessage({ type: 'init', urls, radii, sites });
      this.workers.push(w);
    }
  }

  request(req: PatchRequest, cb: (res: PatchResult) => void): void {
    this.callbacks.set(req.id, cb);
    const w = this.workers[this.next++ % this.workers.length]!;
    w.postMessage({ type: 'build', req });
  }

  cancel(ids: number[]): void {
    for (const w of this.workers) w.postMessage({ type: 'cancel', ids });
    for (const id of ids) this.callbacks.delete(id);
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
  }
}
