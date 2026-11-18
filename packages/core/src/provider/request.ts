// Request reading shared by every harness.

// The user-agent starts with "product/version". Some requests carry a runtime's
// user-agent instead (Claude Code's connectivity check sends "Bun/1.4.4"), and
// storing that as the harness version would hide which harness version sent
// the call (PLAN.md, live-run finding 1). So keep it only when the product
// name belongs to the harness (each provider folder names its products).
export function harnessVersionFrom(product: RegExp, userAgent: string | null): string | null {
  const match = userAgent?.match(/^(.+?)\/(\S+)/);
  if (!match || !product.test(match[1]!)) return null;
  return `${match[1]}/${match[2]}`;
}
