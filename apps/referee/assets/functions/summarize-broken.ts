// Fault source for the summarize edge function: every invocation throws before doing any
// work, so the SDK sees a 500. Deployed by the referee's injector.
//
// The throw is inside the handler on purpose: Deno Subhosting evaluates the module when it
// deploys it, so a module-level throw fails the DEPLOYMENT (observed: "Function deployment
// failed") instead of producing a broken-but-deployed function.
export default async function (_req: Request): Promise<Response> {
  throw new Error('boom');
}
