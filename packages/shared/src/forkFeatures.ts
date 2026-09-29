/**
 * Control Plane feature switches. Upstream T3 Code features stay in the tree
 * behind these, gated at their entry points, so upstream merges stay cheap.
 */

/**
 * T3 Connect: Clerk sign-in and the managed relay. Off in Control Plane, where
 * devices reach each other over Tailscale and tailnet pairing links. Gates the
 * desktop Clerk bridge, the web and mobile Connect UI, and the server's relay
 * link, tunnel, and agent activity publishing.
 */
export const T3_CONNECT_ENABLED: boolean = false;
