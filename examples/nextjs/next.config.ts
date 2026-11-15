import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

const nextConfig: NextConfig = {
  // The coding sub-agent stack (Pi + sandbox adapters) is server-only and
  // ships files Turbopack cannot bundle, so it is required from node_modules
  // at runtime instead.
  serverExternalPackages: [
    '@ai-sdk/harness',
    '@ai-sdk/harness-pi',
    '@ai-sdk/sandbox-vercel',
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-ai',
    'braintrust',
  ],
};

export default withWorkflow(nextConfig);
