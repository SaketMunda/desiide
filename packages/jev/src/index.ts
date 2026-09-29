import { PROTOCOL_VERSION } from '@mutt/protocol';

export const PACKAGE_NAME = '@mutt/jev';

// Proves cross-package imports resolve through workspace `exports` (FND-1 AC 4).
export const JEV_PROTOCOL_VERSION: string = PROTOCOL_VERSION;
