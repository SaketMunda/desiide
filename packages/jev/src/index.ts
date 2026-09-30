import { PROTOCOL_VERSION } from '@desiide/protocol';

export const PACKAGE_NAME = '@desiide/jev';

// Proves cross-package imports resolve through workspace `exports` (FND-1 AC 4).
export const JEV_PROTOCOL_VERSION: string = PROTOCOL_VERSION;
