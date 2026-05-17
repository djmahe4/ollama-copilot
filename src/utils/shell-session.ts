import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

export class ShellSession {
  private process: ChildProcess | null = null;
  private outputBuffer: string = '';
  private resolvePromise: ((value: string) => void) | null = null;
  private rejectPromise: ((reason: any) => void) | null = null;

  constructor(private workspaceRoot: string, private osType: string) {}

  private async ensureProcess() {
    if (this.process) {
      return;
    }

    const shell = this.osType === 'win32' ? 'powershell.exe' : '/bin/zsh'; // Default to zsh for mac/linux
    
    this.process = spawn(shell, [], {
      cwd: this.workspaceRoot,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.process.stdout?.on('data', (data) => {
      this.outputBuffer += data.toString();
      this.checkDelimiter();
    });

    this.process.stderr?.on('data', (data) => {
      this.outputBuffer += data.toString();
      this.checkDelimiter();
    });

     this.process.on('exit', () => {
       this.process = null;
       if (this.rejectPromise) {
         this.rejectPromise(new Error('Shell process exited'));
       }
     });
  }

  private checkDelimiter() {
    if (!this.resolvePromise) {
      return;
    }

    const delimiter = '___SHELL_DONE___';
    if (this.outputBuffer.includes(delimiter)) {
      const output = this.outputBuffer.split(delimiter)[0];
      this.outputBuffer = this.outputBuffer.slice(this.outputBuffer.indexOf(delimiter) + delimiter.length);
      
      const resolve = this.resolvePromise;
      this.resolvePromise = null;
      this.rejectPromise = null;
      resolve?.(output);
    }
  }

  async execute(command: string): Promise<string> {
    await this.ensureProcess();

    return new Promise((resolve, reject) => {
      this.outputBuffer = '';
      this.resolvePromise = resolve;
      this.rejectPromise = reject;

      const delimiter = '___SHELL_DONE___';
      // Append delimiter to command to know when output ends
      const finalCommand = this.osType === 'win32' 
        ? `${command}; echo "${delimiter}"` 
        : `${command}; echo "${delimiter}"`;

      this.process?.stdin?.write(finalCommand + '\n');

      // Timeout to prevent hanging
      setTimeout(() => {
        if (this.resolvePromise) {
          this.resolvePromise = null;
          reject(new Error('Command timeout after 60s'));
        }
      }, 60000);
    });
  }

  dispose() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}
