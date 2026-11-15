import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import type { Experimental_SandboxSession } from 'ai';

/**
 * A local stand-in for Vercel Sandbox: one throwaway Docker container per
 * session, driven with `docker exec`. It implements the same sandbox session
 * interface as `@ai-sdk/sandbox-vercel`, so the coding agent cannot tell the
 * two apart.
 */

const WORKDIR = '/workspace';
const LABEL = 'durable-ai-sdk.sandbox=1';
const SANDBOX_TTL_SECONDS = 60 * 60;

interface ExecOptions {
  workingDirectory?: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
  stdin?: boolean;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function collect(stream: NodeJS.ReadableStream | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream?.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream?.on('error', reject);
    stream?.on('end', () => resolve(Buffer.concat(chunks)));
    if (!stream) resolve(Buffer.alloc(0));
  });
}

function exitCodeOf(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function docker(
  args: string[],
  options: { input?: Uint8Array; abortSignal?: AbortSignal } = {},
): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
  const child = spawn('docker', args, {
    stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    signal: options.abortSignal,
  });
  if (options.input) child.stdin?.end(options.input);
  const [exitCode, stdout, stderr] = await Promise.all([
    exitCodeOf(child),
    collect(child.stdout),
    collect(child.stderr),
  ]);
  return { exitCode, stdout, stderr: stderr.toString('utf8') };
}

function createSession(container: string): HarnessV1NetworkSandboxSession {
  /** Spawns `bash -c <command>` inside the container. */
  const execChild = (command: string, options: ExecOptions = {}) => {
    const env = options.env ?? {};
    return spawn(
      'docker',
      [
        'exec',
        ...(options.stdin ? ['-i'] : []),
        '-w',
        options.workingDirectory ?? WORKDIR,
        // Name-only `-e` reads the value from this client's environment, so
        // secrets never appear in a process listing.
        ...Object.keys(env).flatMap((name) => ['-e', name]),
        container,
        'bash',
        '-c',
        command,
      ],
      {
        env: { ...process.env, ...env },
        stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        signal: options.abortSignal,
      },
    );
  };

  const sh = async (
    command: string,
    options: { input?: Uint8Array; abortSignal?: AbortSignal } = {},
  ) => {
    const child = execChild(command, {
      stdin: options.input != null,
      abortSignal: options.abortSignal,
    });
    if (options.input) child.stdin?.end(options.input);
    const [exitCode, stdout, stderr] = await Promise.all([
      exitCodeOf(child),
      collect(child.stdout),
      collect(child.stderr),
    ]);
    return { exitCode, stdout, stderr: stderr.toString('utf8') };
  };

  const readBinaryFile: Experimental_SandboxSession['readBinaryFile'] = async ({
    path,
    abortSignal,
  }) => {
    const result = await sh(`test -f ${quote(path)} && cat ${quote(path)}`, {
      abortSignal,
    });
    return result.exitCode === 0 ? new Uint8Array(result.stdout) : null;
  };

  const writeBinaryFile: Experimental_SandboxSession['writeBinaryFile'] =
    async ({ path, content, abortSignal }) => {
      const result = await sh(
        `mkdir -p "$(dirname ${quote(path)})" && cat > ${quote(path)}`,
        { input: content, abortSignal },
      );
      if (result.exitCode !== 0) {
        throw new Error(`Failed to write ${path}: ${result.stderr.trim()}`);
      }
    };

  const base: Experimental_SandboxSession = {
    description: `Docker container running Debian with Node.js and bash. Working directory: ${WORKDIR}.`,

    readBinaryFile,
    readFile: async (options) => {
      const bytes = await readBinaryFile(options);
      return bytes == null ? null : new Blob([bytes as BlobPart]).stream();
    },
    readTextFile: async ({
      path,
      encoding,
      startLine,
      endLine,
      abortSignal,
    }) => {
      const bytes = await readBinaryFile({ path, abortSignal });
      if (bytes == null) return null;
      const text = new TextDecoder(encoding ?? 'utf-8').decode(bytes);
      if (startLine == null && endLine == null) return text;
      return text
        .split('\n')
        .slice((startLine ?? 1) - 1, endLine)
        .join('\n');
    },

    writeBinaryFile,
    writeFile: async ({ path, content, abortSignal }) =>
      writeBinaryFile({
        path,
        content: new Uint8Array(await new Response(content).arrayBuffer()),
        abortSignal,
      }),
    writeTextFile: async ({ path, content, abortSignal }) =>
      writeBinaryFile({
        path,
        content: new TextEncoder().encode(content),
        abortSignal,
      }),

    stat: async ({ path, abortSignal }) => {
      const result = await sh(`stat -L -c '%F|%s' ${quote(path)}`, {
        abortSignal,
      });
      if (result.exitCode !== 0) return null;
      const [kind, size] = result.stdout.toString('utf8').trim().split('|');
      return {
        type: kind.includes('directory')
          ? 'directory'
          : kind.includes('regular')
            ? 'file'
            : 'other',
        size: Number(size),
      };
    },

    listDirectory: async ({ path, abortSignal }) => {
      const result = await sh(
        `test -d ${quote(path)} && find ${quote(path)} -mindepth 1 -maxdepth 1 -printf '%y\\t%f\\n'`,
        { abortSignal },
      );
      if (result.exitCode !== 0) return null;
      const types = { f: 'file', d: 'directory', l: 'symlink' } as const;
      return result.stdout
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [kind, ...name] = line.split('\t');
          return {
            name: name.join('\t'),
            type: types[kind as keyof typeof types] ?? ('other' as const),
          };
        });
    },

    deleteFile: async ({ path, abortSignal }) => {
      const result = await sh(
        `test -e ${quote(path)} && rm -f ${quote(path)}`,
        { abortSignal },
      );
      return result.exitCode === 0;
    },

    run: async ({ command, workingDirectory, env, abortSignal }) => {
      const child = execChild(command, { workingDirectory, env, abortSignal });
      const [exitCode, stdout, stderr] = await Promise.all([
        exitCodeOf(child),
        collect(child.stdout),
        collect(child.stderr),
      ]);
      return {
        exitCode,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
      };
    },

    spawn: (async (options: {
      command: string;
      workingDirectory?: string;
      env?: Record<string, string>;
      abortSignal?: AbortSignal;
      stdin?: boolean;
    }) => {
      const child = execChild(options.command, options);
      const exit = exitCodeOf(child);
      // Avoid an unhandled rejection when nobody awaits `wait()`.
      exit.catch(() => {});
      return {
        pid: child.pid,
        stdout: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
        ...(options.stdin
          ? {
              stdin: Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
            }
          : {}),
        wait: async () => ({ exitCode: await exit }),
        // Ends the `docker exec` client. The container is removed with the
        // session, which reaps anything the command left behind.
        kill: async () => {
          child.kill('SIGKILL');
        },
      };
    }) as Experimental_SandboxSession['spawn'],
  };

  const stop = async () => {
    await docker(['rm', '-f', container]);
  };
  const noPorts = async (): Promise<never> => {
    throw new Error('The local Docker sandbox does not expose ports.');
  };

  return {
    ...base,
    id: container,
    defaultWorkingDirectory: WORKDIR,
    ports: [],
    getPortEndpoint: noPorts,
    getPortUrl: noPorts,
    stop,
    destroy: stop,
    restricted: () => base,
  };
}

async function isRunning(container: string): Promise<boolean> {
  const result = await docker([
    'inspect',
    '--format',
    '{{.State.Running}}',
    container,
  ]);
  return result.exitCode === 0 && result.stdout.toString().trim() === 'true';
}

/**
 * Attaches to the named sandbox container, optionally creating it.
 *
 * A sandbox outlives any one workflow step, so it is addressed by name: every
 * step of a sub-agent run reattaches to the same container. `create` is
 * get-or-create, so a retried first step reuses the container its earlier
 * attempt started. Without `create`, a missing container is an error rather
 * than a silently empty replacement.
 */
export async function acquireDockerSandboxSession({
  name,
  image,
  create,
}: {
  name: string;
  image: string;
  create: boolean;
}): Promise<HarnessV1NetworkSandboxSession> {
  if (await isRunning(name)) return createSession(name);
  if (!create) {
    throw new Error(
      `Sandbox ${name} is gone (it is removed after ${SANDBOX_TTL_SECONDS / 60} minutes, or when Docker restarts), so this run cannot continue.`,
    );
  }
  const result = await docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--label',
    LABEL,
    '--workdir',
    WORKDIR,
    image,
    // Bounded, so a sandbox orphaned by an abandoned run removes itself.
    'sleep',
    String(SANDBOX_TTL_SECONDS),
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not start the Docker sandbox (is Docker running?): ${result.stderr.trim()}`,
    );
  }
  return createSession(name);
}

/** Idempotent: removing a sandbox that is already gone is not an error. */
export async function destroyDockerSandbox(name: string): Promise<void> {
  await docker(['rm', '-f', name]);
}
