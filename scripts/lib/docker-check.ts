/**
 * Docker daemon detection. We need a running daemon to build the
 * orchestrator image during deploy.
 */

import { spawn } from 'node:child_process';

export interface DockerStatus {
  installed: boolean;
  running: boolean;
  version?: string;
  error?: string;
}

export async function checkDocker(): Promise<DockerStatus> {
  return new Promise((resolve) => {
    const proc = spawn('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.on('error', (err) => {
      if ((err as { code?: string }).code === 'ENOENT') {
        resolve({ installed: false, running: false, error: 'docker binary not found in PATH' });
      } else {
        resolve({ installed: true, running: false, error: err.message });
      }
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ installed: true, running: true, version: stdout.trim() });
      } else {
        resolve({
          installed: true,
          running: false,
          error: stderr.trim() || `docker info exited with code ${code}`,
        });
      }
    });
  });
}
