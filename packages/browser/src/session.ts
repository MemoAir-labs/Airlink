// Node-only half of the package: the CDP session and the provider. The browser bundle imports
// the model from the package root and never reaches node:dns.
export type {
  BrowserSession,
  CdpClient,
  KeyInput,
  MouseInput,
  NavigateResult,
  PageInfo,
  ScreencastFrame,
  WheelInput,
} from "./cdp.ts";
export { connectCdp, createBrowserSession, parseKeyCombo } from "./cdp.ts";
export type {
  BrowserLease,
  BrowserProvider,
  BrowserVideoLease,
  NekoInstance,
} from "./provider.ts";
export {
  BrowserPoolExhausted,
  cdpEndpointProvider,
  nekoPoolProvider,
  parseNekoInstances,
} from "./provider.ts";
export { createPinningProxy } from "./proxy.ts";
