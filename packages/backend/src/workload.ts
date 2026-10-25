import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';

/** Shared temporary role identity, including authenticated development/SSO. */
export const workloadCredentials = createAwsWorkloadCredentialProvider();
