import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const output = NodePath.join(root, "dist");

await NodeFSP.rm(output, { recursive: true, force: true });
await NodeFSP.mkdir(output, { recursive: true });
await NodeFSP.cp(NodePath.join(root, "public"), output, { recursive: true });
