import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, ChildProcess } from 'node:child_process';
import {
  LlamaRuntimeConfig,
  INFERENCE_PROFILES,
  DEFAULT_QWEN_MODEL_PATH,
  DEFAULT_QWEN_MODEL_ALIAS
} from './profiles.js';
import { RuntimeDetector, BinaryFlagSupport } from './detector.js';

export interface RuntimeStatus {
  isRunning: boolean;
  isReady: boolean;
  pid?: number;
  port: number;
  apiBase: string;
  modelAlias: string;
  modelPath: string;
  config: LlamaRuntimeConfig;
  lastError?: string;
  startupTimeMs?: number;
  flagSupport?: BinaryFlagSupport;
}

export class LlamaCppRuntime {
  private config: LlamaRuntimeConfig;
  private process: ChildProcess | null = null;
  private isOwnedProcess: boolean = false;
  private logBuffer: string[] = [];
  private startupTimeMs: number = 0;
  private lastError?: string;
  private flagSupport?: BinaryFlagSupport;

  constructor(customConfig?: Partial<LlamaRuntimeConfig>) {
    const profile = INFERENCE_PROFILES.performance;
    this.config = {
      profileName: 'performance',
      modelPath: process.env.LOCODE_LOCAL_MODEL_PATH || DEFAULT_QWEN_MODEL_PATH,
      modelAlias: DEFAULT_QWEN_MODEL_ALIAS,
      serverPath: process.env.LOCODE_LLAMA_SERVER_PATH,
      host: '127.0.0.1',
      port: process.env.LOCODE_LOCAL_MODEL_PORT ? parseInt(process.env.LOCODE_LOCAL_MODEL_PORT, 10) : 8081,
      autoPort: true,
      autoStart: process.env.LOCODE_LOCAL_MODEL_AUTO_START !== 'false',
      contextSize: process.env.LOCODE_LOCAL_MODEL_CONTEXT ? parseInt(process.env.LOCODE_LOCAL_MODEL_CONTEXT, 10) : 32768,
      nCpuMoe: 24,
      nGpuLayers: 999,
      batchSize: 2048,
      ubatchSize: 512,
      flashAttention: true,
      cacheTypeK: 'turbo4',
      cacheTypeV: 'turbo4',
      noMmap: true,
      mlock: true,
      threads: 12,
      jinja: true,
      ...profile,
      ...customConfig
    };

    // Clean up child process on parent exit
    process.on('exit', () => {
      this.stop();
    });
  }

  getConfig(): LlamaRuntimeConfig {
    return this.config;
  }

  setConfig(newConfig: Partial<LlamaRuntimeConfig>) {
    this.config = { ...this.config, ...newConfig };
  }

  getApiBase(): string {
    return `http://${this.config.host}:${this.config.port}/v1`;
  }

  getStatus(): RuntimeStatus {
    return {
      isRunning: this.isOwnedProcess ? !!this.process && !this.process.killed : true,
      isReady: false,
      pid: this.process?.pid,
      port: this.config.port,
      apiBase: this.getApiBase(),
      modelAlias: this.config.modelAlias,
      modelPath: this.config.modelPath,
      config: { ...this.config },
      lastError: this.lastError,
      startupTimeMs: this.startupTimeMs,
      flagSupport: this.flagSupport
    };
  }

  getRecentLogs(lines: number = 30): string {
    return this.logBuffer.slice(-lines).join('\n');
  }

  /**
   * Finds an available port on localhost if initial port is occupied
   */
  async findAvailablePort(startPort: number): Promise<number> {
    const isPortOpen = (port: number): Promise<boolean> => {
      return new Promise(resolve => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => {
          server.close(() => resolve(true));
        });
        server.listen(port, this.config.host);
      });
    };

    for (let p = startPort; p < startPort + 50; p++) {
      if (await isPortOpen(p)) {
        return p;
      }
    }
    throw new Error(`Could not find an available localhost port in range ${startPort}-${startPort + 50}`);
  }

  /**
   * Checks if an existing server is running at the configured host:port and serving the requested model
   */
  async checkExistingServer(): Promise<boolean> {
    try {
      const url = `http://${this.config.host}:${this.config.port}/v1/models`;
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return false;
      const data: any = await res.json();
      const models = (data.data || []).map((m: any) => m.id);
      if (models.length === 0) return false;

      // Inspect running server's actual context size from /props
      try {
        const propsUrl = `http://${this.config.host}:${this.config.port}/props`;
        const propsRes = await fetch(propsUrl, { signal: AbortSignal.timeout(1500) });
        if (propsRes.ok) {
          const propsData: any = await propsRes.json();
          const serverCtx = propsData.default_generation_settings?.n_ctx;
          if (typeof serverCtx === 'number' && serverCtx > 0) {
            // If the running server has a smaller context size than requested, do NOT reuse it!
            if (this.config.contextSize && serverCtx < this.config.contextSize) {
              return false; // Force starting or switching to a server with requested context size!
            }
            // Align our runtime config with the running server's actual context size
            this.config.contextSize = serverCtx;
          }
        }
      } catch {}

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Builds the CLI arguments for llama-server.exe
   */
  buildArgs(flags: BinaryFlagSupport): string[] {
    const args: string[] = [
      '-m', this.config.modelPath,
      '--alias', this.config.modelAlias,
      '--host', this.config.host,
      '--port', this.config.port.toString(),
      '-c', this.config.contextSize.toString(),
      '-b', this.config.batchSize.toString(),
      '-ub', this.config.ubatchSize.toString(),
      '-t', this.config.threads.toString(),
      '-ngl', this.config.nGpuLayers.toString()
    ];

    if (flags.supportsCpuMoe && this.config.nCpuMoe > 0) {
      args.push('--n-cpu-moe', this.config.nCpuMoe.toString());
    }

    if (flags.supportsFlashAttn && this.config.flashAttention) {
      args.push('--flash-attn', 'on');
    }

    if (flags.supportsTurbo4) {
      args.push('--cache-type-k', this.config.cacheTypeK);
      args.push('--cache-type-v', this.config.cacheTypeV);
    }

    if (flags.supportsNoMmap && this.config.noMmap) {
      args.push('--no-mmap');
    }

    if (flags.supportsMlock && this.config.mlock) {
      args.push('--mlock');
    }

    if (flags.supportsJinja && this.config.jinja) {
      args.push('--jinja');
    }

    if (flags.supportsCacheReuse && this.config.cacheReuse && this.config.cacheReuse > 0) {
      args.push('--cache-reuse', this.config.cacheReuse.toString());
    }

    // Explicitly restrict to 1 parallel slot to prevent multi-slot KV cache splitting & cold slot thrashing
    args.push('-np', '1');

    return args;
  }

  /**
   * Starts llama-server or connects to an existing instance
   */
  async ensureReady(onProgress?: (message: string) => void): Promise<{ apiBase: string; reused: boolean }> {
    const startMs = Date.now();

    // 1. Verify model file exists
    try {
      const stat = await fs.stat(this.config.modelPath);
      if (!stat.isFile()) {
        throw new Error(`Target model path is not a file: ${this.config.modelPath}`);
      }
    } catch (err: any) {
      throw new Error(`Local model file not found at: ${this.config.modelPath}. Please verify the file path.`);
    }

    // 2. Check if already running on the configured port
    if (await this.checkExistingServer()) {
      if (onProgress) onProgress(`Existing healthy llama-server detected on port ${this.config.port}. Reusing.`);
      return { apiBase: this.getApiBase(), reused: true };
    }

    // 3. Find llama-server binary
    if (onProgress) onProgress('Locating TurboQuant-enabled llama-server binary...');
    const serverBinary = await RuntimeDetector.findLlamaServer(this.config.serverPath);
    if (!serverBinary) {
      throw new Error(
        'llama-server.exe could not be found. Please ensure it is in your PATH or set LOCODE_LLAMA_SERVER_PATH.'
      );
    }
    this.config.serverPath = serverBinary;

    // 4. Inspect flag support
    if (onProgress) onProgress('Checking llama-server binary capabilities and flags...');
    this.flagSupport = await RuntimeDetector.checkFlagSupport(serverBinary);

    // 5. Check port availability
    if (this.config.autoPort) {
      try {
        const availablePort = await this.findAvailablePort(this.config.port);
        if (availablePort !== this.config.port) {
          if (onProgress) onProgress(`Port ${this.config.port} occupied. Switching to available port ${availablePort}.`);
          this.config.port = availablePort;
        }
      } catch (err: any) {
        throw new Error(`Port allocation error: ${err.message}`);
      }
    }

    // 6. Spawn process with bounded retries for flag fallback
    const maxRetries = 2;
    let attempt = 0;
    let lastSpawnError: string = '';

    while (attempt <= maxRetries) {
      attempt++;
      const currentFlags = { ...this.flagSupport };

      // In fallback attempts, gracefully relax aggressive flags if needed
      if (attempt === 2) {
        if (onProgress) onProgress('Adjusting runtime flags for compatibility retry...');
        currentFlags.supportsNoMmap = false;
        currentFlags.supportsMlock = false;
      } else if (attempt === 3) {
        currentFlags.supportsFlashAttn = false;
      }

      const args = this.buildArgs(currentFlags);
      if (onProgress) {
        onProgress(`Launching llama-server: ${path.basename(serverBinary)} on port ${this.config.port}...`);
      }

      try {
        await this.spawnServerProcess(serverBinary, args, onProgress);
        await this.waitForReadiness(onProgress);
        this.startupTimeMs = Date.now() - startMs;
        this.isOwnedProcess = true;
        if (onProgress) onProgress(`Model loaded and server ready in ${(this.startupTimeMs / 1000).toFixed(1)}s!`);
        return { apiBase: this.getApiBase(), reused: false };
      } catch (err: any) {
        lastSpawnError = err.message;
        this.stop();
        if (attempt > maxRetries) {
          break;
        }
      }
    }

    const diagLogs = this.getRecentLogs(15);
    throw new Error(
      `Failed to start llama-server after ${maxRetries} attempts.\n${lastSpawnError}\n\nServer Diagnostics:\n${diagLogs}`
    );
  }

  private async spawnServerProcess(
    serverBinary: string,
    args: string[],
    onProgress?: (message: string) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logBuffer = [];
      const proc = spawn(serverBinary, args, {
        cwd: path.dirname(serverBinary),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });

      this.process = proc;

      let hasStarted = false;

      proc.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        this.logBuffer.push(text);
        if (this.logBuffer.length > 200) this.logBuffer.shift();
        if (!hasStarted) {
          hasStarted = true;
          resolve();
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        this.logBuffer.push(text);
        if (this.logBuffer.length > 200) this.logBuffer.shift();

        // Print progress indicators if informative
        if (onProgress && text.includes('load_tensors')) {
          onProgress('Loading model weights into memory/VRAM...');
        } else if (onProgress && text.includes('CUDA')) {
          onProgress('Initializing CUDA offload layers...');
        }

        if (!hasStarted) {
          hasStarted = true;
          resolve();
        }
      });

      proc.on('error', (err) => {
        this.lastError = err.message;
        reject(err);
      });

      proc.on('exit', (code, signal) => {
        this.lastError = `Process exited prematurely with code ${code} (signal: ${signal})`;
        if (!hasStarted) {
          reject(new Error(this.lastError));
        }
      });

      // Quick timeout check for immediate spawn failure
      setTimeout(() => {
        if (!hasStarted) {
          resolve(); // Let waitForReadiness probe the health endpoint
        }
      }, 1000);
    });
  }

  /**
   * Actively polls the /v1/models endpoint until healthy
   */
  private async waitForReadiness(onProgress?: (msg: string) => void): Promise<void> {
    const timeoutMs = 90000; // 90 seconds max for 35B model load
    const intervalMs = 1500;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (this.process && this.process.exitCode !== null) {
        throw new Error(`llama-server process exited unexpectedly with code ${this.process.exitCode}`);
      }

      try {
        const url = `http://${this.config.host}:${this.config.port}/v1/models`;
        const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          return;
        }
      } catch {}

      const elapsed = Math.round((Date.now() - start) / 1000);
      if (onProgress && elapsed % 5 === 0) {
        onProgress(`Waiting for model server to become ready... (${elapsed}s elapsed)`);
      }

      await new Promise(r => setTimeout(r, intervalMs));
    }

    throw new Error(`Timeout waiting for llama-server readiness at http://${this.config.host}:${this.config.port}/v1/models`);
  }

  stop() {
    if (this.process && !this.process.killed && this.isOwnedProcess) {
      try {
        this.process.kill('SIGTERM');
      } catch {}
      this.process = null;
      this.isOwnedProcess = false;
    }
  }
}
