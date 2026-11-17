// Oxlint replaces global WeakMap to track its reused SourceCode; these caches hold SDK objects.
export const IdentityMap = WeakMap;

// One proxy per node, whether it was reached as an SDK node (wrap) or as a
// compact declaration handle (wrapping.mjs). Keyed by (file path, node index):
// the SDK's own node id, "index.kind.path", is built as a new string on every
// read, and hashing it per lookup was ~100 ms per typed run. The kind in that
// id is determined by the index within a file, so (path, index) identifies
// the same node. Nodes without a path or integer index fall back to the id.
export class NodeProxies {
  constructor() {
    this.files = new Map();
    this.ids = new Map();
  }

  keyed(path, index) {
    return typeof path === "string" && Number.isInteger(index);
  }

  get(path, index, id) {
    return this.keyed(path, index)
      ? this.files.get(path)?.get(index)
      : this.ids.get(id());
  }

  set(path, index, id, proxy) {
    if (!this.keyed(path, index)) {
      this.ids.set(id(), proxy);
      return;
    }
    let file = this.files.get(path);
    if (file === undefined) {
      file = new Map();
      this.files.set(path, file);
    }
    file.set(index, proxy);
  }
}
