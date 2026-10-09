import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';

export interface BinaryFlagSupport {
  supportsTurbo4: boolean;
  supportsCpuMoe: boolean;
  supportsFlashAttn: boolean;
  supportsNoMmap: boolean;
  supportsMlock: boolean;
  supportsJinja: boolean;
  supportsCacheReuse: boolean;
  supportsFitOff: boolean;
  supportsReasoningFormat: boolean;
}

export class RuntimeDetector {
  /**
   * Search sensible paths for llama-server.exe
   */
  static async findLlamaServer(configuredPath?: string): Promise<string | null> {
    if (configuredPath && (await this.isExecutableValid(configuredPath))) {
      return path.resolve(configuredPath);
    }

    // 1. Environment variable override
    if (process.env.LOCODE_LLAMA_SERVER_PATH && (await this.isExecutableValid(process.env.LOCODE_LLAMA_SERVER_PATH))) {
      return path.resolve(process.env.LOCODE_LLAMA_SERVER_PATH);
    }

    // 2. Check known dedicated Windows TurboQuant build in Downloads or local dirs
    const userHome = os.homedir();
    const candidateDirs = [
      path.join(userHome, 'Downloads', 'llama-turboquant-windows-x64-cuda-12.4', 'build', 'bin'),
      path.join(userHome, 'Downloads', 'turboquant-plus-tqp-v0.4.0-windows-x64-cuda12.4'),
      path.join(userHome, 'Downloads', 'llama-server'),
      path.join(userHome, 'AppData', 'Local', 'llama.cpp'),
      path.join(userHome, '.llama.cpp'),
      path.join(process.cwd(), 'bin'),
      path.join(userHome, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages', 'ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe')
    ];

    for (const dir of candidateDirs) {
      const serverExe = path.join(dir, 'llama-server.exe');
      if (await this.isExecutableValid(serverExe)) {
        return serverExe;
      }
    }

    // 3. System PATH check via where.exe
    try {
      const { stdout } = await execa('where.exe llama-server.exe', { shell: true });
      const lines = stdout.trim().split('\r\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (await this.isExecutableValid(line)) {
          return line;
        }
      }
    } catch {}

    return null;
  }

  static async isExecutableValid(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  /**
   * Probes the discovered binary using --help to detect flag compatibility
   */
  static async checkFlagSupport(serverPath: string): Promise<BinaryFlagSupport> {
    try {
      const { stdout, stderr } = await execa(`"${serverPath}" --help`, { shell: true, timeout: 5000 });
      const text = `${stdout}\n${stderr}`;

      return {
        supportsTurbo4: /turbo4|turboquant/i.test(text),
        supportsCpuMoe: /--n-cpu-moe|-ncmoe/i.test(text),
        supportsFlashAttn: /--flash-attn|-fa/i.test(text),
        supportsNoMmap: /--no-mmap/i.test(text),
        supportsMlock: /--mlock/i.test(text),
        supportsJinja: /--jinja/i.test(text),
        supportsCacheReuse: /--cache-reuse/i.test(text),
        supportsFitOff: /--fit\b|-fit\b/i.test(text),
        supportsReasoningFormat: /--reasoning-format/i.test(text)
      };
    } catch {
      // Conservative defaults if --help inspection fails
      return {
        supportsTurbo4: true,
        supportsCpuMoe: true,
        supportsFlashAttn: true,
        supportsNoMmap: true,
        supportsMlock: true,
        supportsJinja: true,
        supportsCacheReuse: true,
        supportsFitOff: true,
        supportsReasoningFormat: true
      };
    }
  }
}
