import {
  assetPath,
  deleteFunction,
  deployFunctionOrThrow,
  functionCode,
  functionExists,
  victimFunctionPath,
} from './helpers.js';
import type { Injector } from './types.js';

/** The poison line in the broken summarize source (see assets/functions/). */
const HANDLER_THROW = /throw new Error\(['"]boom['"]\)/;

/** F04 Dead Function: summarize redeployed with a handler that throws on every call. */
export const F04: Injector = {
  id: 'F04',
  async inject(ctx) {
    await deployFunctionOrThrow(ctx, 'summarize', assetPath('functions', 'summarize-broken.ts'));
  },
  async referenceFix(ctx) {
    await deployFunctionOrThrow(ctx, 'summarize', victimFunctionPath(ctx, 'summarize'));
  },
  async artifactPresent(ctx) {
    const code = await functionCode(ctx, 'summarize');
    if (code === undefined) return true; // function missing is not a working function either
    return HANDLER_THROW.test(code);
  },
};

/** The `legacy-ping` half of decoy D01 (the audit_log half lives in decoys.ts). */
export async function deployLegacyPing(ctx: Parameters<Injector['inject']>[0]): Promise<void> {
  await deployFunctionOrThrow(ctx, 'legacy-ping', assetPath('functions', 'legacy-ping.ts'));
}

export async function removeLegacyPing(ctx: Parameters<Injector['inject']>[0]): Promise<void> {
  await deleteFunction(ctx, 'legacy-ping');
}

export async function legacyPingPresent(ctx: Parameters<Injector['inject']>[0]): Promise<boolean> {
  return functionExists(ctx, 'legacy-ping');
}
