import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import { SANDBOX_DOCKER_IMAGE, SANDBOX_PROVIDER } from '@/lib/config';

/**
 * Sandboxes are addressed by a caller-chosen id so that separate workflow
 * steps, possibly in separate processes, can reattach to the same one.
 * `docker` locally, Vercel Sandbox when deployed; both return the same
 * session interface.
 */
export async function acquireSandboxSession({
  id,
  create,
}: {
  id: string;
  /** Create the sandbox if it does not exist yet (first step only). */
  create: boolean;
}): Promise<HarnessV1NetworkSandboxSession> {
  if (SANDBOX_PROVIDER === 'vercel') {
    const {
      createVercelNetworkSandboxSession,
      resumeVercelNetworkSandboxSession,
    } = await import('@ai-sdk/sandbox-vercel');
    return create
      ? createVercelNetworkSandboxSession({ sandboxId: id, runtime: 'node24' })
      : resumeVercelNetworkSandboxSession({ sandboxId: id });
  }
  const { acquireDockerSandboxSession } = await import('./docker');
  return acquireDockerSandboxSession({
    name: id,
    image: SANDBOX_DOCKER_IMAGE,
    create,
  });
}

export async function destroySandbox(id: string): Promise<void> {
  if (SANDBOX_PROVIDER === 'vercel') {
    const { resumeVercelNetworkSandboxSession } =
      await import('@ai-sdk/sandbox-vercel');
    const session = await resumeVercelNetworkSandboxSession({ sandboxId: id });
    await session.destroy();
    return;
  }
  const { destroyDockerSandbox } = await import('./docker');
  await destroyDockerSandbox(id);
}
